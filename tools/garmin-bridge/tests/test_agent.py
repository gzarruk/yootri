import io
import plistlib
import subprocess
from pathlib import Path

import pytest

from garmin_bridge.agent import LABEL, Agent, plist_for
from garmin_bridge.cli import main
from garmin_bridge.store import Store

UV = "/opt/homebrew/bin/uv"
PROJECT = "/Users/jane/yootri/tools/garmin-bridge"


class FakeLaunchctl:
    """Records what would have been run, and answers like launchctl does."""

    def __init__(self, loaded=False):
        self.calls = []
        self.loaded = loaded

    def __call__(self, argv):
        self.calls.append(argv)
        verb = argv[1]
        if verb == "print":
            return subprocess.CompletedProcess(argv, 0 if self.loaded else 113, "", "")
        if verb == "bootstrap":
            self.loaded = True
        if verb == "bootout":
            was, self.loaded = self.loaded, False
            return subprocess.CompletedProcess(argv, 0 if was else 3, "", "")
        return subprocess.CompletedProcess(argv, 0, "", "")


def agent(tmp_path, *, platform="darwin", loaded=False, env=None, which=lambda name: UV):
    return Agent(home=tmp_path, project_dir=PROJECT, platform=platform, uid=501,
                 run=(fake := FakeLaunchctl(loaded)), which=which, env=env or {}), fake


def read_plist(tmp_path):
    return plistlib.loads((tmp_path / "Library/LaunchAgents" / f"{LABEL}.plist").read_bytes())


# ---- the property list ------------------------------------------------------

def test_the_plist_runs_serve_quietly_with_absolute_paths_and_stays_up():
    p = plist_for(uv_path=UV, project_dir=PROJECT, port=8765, origins=("http://localhost:8000",),
                  env={}, log="/Users/jane/Library/Logs/yootri-garmin-bridge.log")
    assert p["Label"] == LABEL
    assert p["RunAtLoad"] is True and p["KeepAlive"] is True
    argv = p["ProgramArguments"]
    assert argv[0] == UV and all(a.startswith("/") for a in (argv[0], argv[argv.index("--directory") + 1]))
    assert argv[argv.index("serve") - 2:argv.index("serve") + 1] == ["-m", "garmin_bridge", "serve"]
    assert "--quiet" in argv
    assert argv[argv.index("--port") + 1] == "8765"
    assert argv[argv.index("--allow-origin") + 1] == "http://localhost:8000"
    assert p["StandardOutPath"] == p["StandardErrorPath"] == "/Users/jane/Library/Logs/yootri-garmin-bridge.log"


def test_the_plist_carries_only_the_flags_that_were_set_when_it_was_installed():
    base = dict(uv_path=UV, project_dir=PROJECT, port=8765, origins=(), log="/x.log")
    assert "EnvironmentVariables" not in plist_for(env={}, **base)
    p = plist_for(env={"YOOTRI_GARMIN_WORKOUTS": "1", "YOOTRI_GARMIN_OVERNIGHT": "0", "SECRET": "x",
                       "YOOTRI_GARMIN_HOME": "/data/g"}, **base)
    assert p["EnvironmentVariables"] == {"YOOTRI_GARMIN_WORKOUTS": "1", "YOOTRI_GARMIN_HOME": "/data/g"}


def test_the_plist_never_contains_the_pairing_token_or_a_password(tmp_path):
    Store(tmp_path / "gh").pairing_token()
    token = Store(tmp_path / "gh").pairing_token(create=False)
    a, _ = agent(tmp_path)
    a.install(port=8765, origins=("http://localhost:8000",))
    assert token.encode() not in (tmp_path / "Library/LaunchAgents" / f"{LABEL}.plist").read_bytes()


# ---- install, status, uninstall --------------------------------------------

def test_install_writes_the_plist_and_loads_it_for_this_user(tmp_path):
    a, fake = agent(tmp_path)
    msg = a.install(port=8765, origins=("http://localhost:8000",))
    path = tmp_path / "Library/LaunchAgents" / f"{LABEL}.plist"
    assert path.exists()
    assert read_plist(tmp_path)["ProgramArguments"][0] == UV
    assert ["launchctl", "bootstrap", "gui/501", str(path)] in fake.calls
    assert "make garmin-pair" in msg


def test_installing_again_replaces_the_loaded_one_rather_than_failing(tmp_path):
    a, fake = agent(tmp_path, loaded=True)
    a.install(port=9001, origins=())
    verbs = [c[1] for c in fake.calls]
    assert verbs.index("bootout") < verbs.index("bootstrap")
    assert read_plist(tmp_path)["ProgramArguments"][read_plist(tmp_path)["ProgramArguments"].index("--port") + 1] == "9001"


def test_status_says_whether_it_is_installed_and_loaded(tmp_path):
    a, fake = agent(tmp_path)
    assert "not installed" in a.status().lower()
    a.install(port=8765, origins=())
    assert "running" in a.status().lower() and "8765" in a.status()
    fake.loaded = False
    assert "not loaded" in a.status().lower()


def test_uninstall_unloads_and_removes_the_file_and_is_safe_to_repeat(tmp_path):
    a, fake = agent(tmp_path)
    a.install(port=8765, origins=())
    path = tmp_path / "Library/LaunchAgents" / f"{LABEL}.plist"
    a.uninstall()
    assert not path.exists()
    assert ["launchctl", "bootout", f"gui/501/{LABEL}"] in fake.calls
    assert "nothing to remove" in a.uninstall().lower()


def test_it_refuses_to_install_without_uv_or_off_a_mac(tmp_path):
    a, fake = agent(tmp_path, platform="linux")
    with pytest.raises(SystemExit) as e:
        a.install(port=8765, origins=())
    assert "macOS" in str(e.value) and fake.calls == []
    b, fake2 = agent(tmp_path, which=lambda name: None)
    with pytest.raises(SystemExit) as e:
        b.install(port=8765, origins=())
    assert "uv" in str(e.value) and fake2.calls == []


# ---- the command line ------------------------------------------------------

def run_cli(argv, tmp_path, ag):
    out = io.StringIO()
    code = main(argv, store=Store(tmp_path / "gh"), out=out, agent=ag, run_server=lambda s: None)
    return code, out.getvalue()


def test_the_cli_installs_reports_and_removes(tmp_path):
    ag, _ = agent(tmp_path)
    assert run_cli(["agent", "install", "--port", "8765"], tmp_path, ag)[0] == 0
    assert "running" in run_cli(["agent", "status"], tmp_path, ag)[1].lower()
    assert run_cli(["agent", "uninstall"], tmp_path, ag)[0] == 0


def test_a_quiet_serve_prints_no_token_and_no_link(tmp_path):
    out = io.StringIO()
    main(["serve", "--port", "0", "--quiet"], store=Store(tmp_path), out=out, run_server=lambda s: None)
    token = Store(tmp_path).pairing_token(create=False)
    text = out.getvalue()
    assert "listening on" in text
    assert token not in text and "garmin=setup" not in text
