"""Keep the bridge running: a macOS LaunchAgent.

`make garmin` runs the bridge in a terminal for as long as you leave it open.
This installs it as a per-user LaunchAgent instead, so it starts when you log
in and comes back if it stops, and the page's Garmin item just works.

Nothing about the bridge changes. It is the same program on the same loopback
address, with the same pairing token and the same list of pages allowed to use
it. The agent is started with `serve --quiet`, so the log file it writes never
holds the token or a pairing link. Pair a browser the way you always did
(`make garmin-pair`); the token is the one already on disk.

The flags that switch on workout export and overnight figures are carried into
the agent only if they were set when it was installed, and only those two (and
a custom store directory): the agent does not inherit your shell.

macOS only. `launchctl` and the filesystem are passed in, so the tests never
touch either.
"""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from collections.abc import Callable, Mapping
from pathlib import Path

LABEL = "com.yootri.garmin-bridge"
CARRIED_ENV = ("YOOTRI_GARMIN_WORKOUTS", "YOOTRI_GARMIN_OVERNIGHT", "YOOTRI_GARMIN_HOME")
_ON = ("1", "true", "yes")

Run = Callable[[list[str]], "subprocess.CompletedProcess[str]"]


def _launchctl(argv: list[str]) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(argv, capture_output=True, text=True, check=False)


def plist_for(
    *, uv_path: str, project_dir: str, port: int, origins: tuple[str, ...] | list[str],
    env: Mapping[str, str], log: str,
) -> dict:
    """The LaunchAgent: run `serve --quiet` at login and keep it running."""
    argv = [uv_path, "run", "--directory", project_dir, "python", "-m", "garmin_bridge", "serve",
            "--port", str(port), "--quiet"]
    for origin in origins:
        argv += ["--allow-origin", origin]
    plist: dict = {
        "Label": LABEL,
        "ProgramArguments": argv,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
        "StandardOutPath": log,
        "StandardErrorPath": log,
    }
    carried = {k: env[k] for k in CARRIED_ENV
               if k in env and (k == "YOOTRI_GARMIN_HOME" or env[k].strip() in _ON)}
    if carried:
        plist["EnvironmentVariables"] = carried
    return plist


class Agent:
    def __init__(
        self, *, home: Path | None = None, project_dir: str | None = None, platform: str | None = None,
        uid: int | None = None, run: Run | None = None, which: Callable[[str], str | None] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self.home = Path(home) if home is not None else Path.home()
        self.project_dir = project_dir or str(Path(__file__).resolve().parents[1])
        self.platform = platform or sys.platform
        self.uid = uid if uid is not None else os.getuid()
        self.run = run or _launchctl
        # Not resolved: Homebrew's `uv` is a symlink into a versioned directory
        # that an upgrade removes, and the link is what keeps working.
        self.which = which or shutil.which
        self.env = env if env is not None else os.environ

    @property
    def plist_path(self) -> Path:
        return self.home / "Library" / "LaunchAgents" / f"{LABEL}.plist"

    @property
    def log_path(self) -> Path:
        return self.home / "Library" / "Logs" / "yootri-garmin-bridge.log"

    @property
    def _domain(self) -> str:
        return f"gui/{self.uid}"

    def _require_mac(self) -> None:
        if self.platform != "darwin":
            raise SystemExit("The always-on agent is for macOS (it uses launchd). "
                             "Elsewhere, run `make garmin` in a terminal while you sync.")

    def _loaded(self) -> bool:
        return self.run(["launchctl", "print", f"{self._domain}/{LABEL}"]).returncode == 0

    def install(self, *, port: int, origins: tuple[str, ...] | list[str]) -> str:
        self._require_mac()
        uv = self.which("uv")
        if not uv:
            raise SystemExit("uv was not found on your PATH. Install it from "
                             "https://docs.astral.sh/uv/getting-started/installation/ and try again.")
        plist = plist_for(uv_path=os.path.abspath(uv), project_dir=self.project_dir, port=port,
                          origins=tuple(origins), env=self.env, log=str(self.log_path))
        self.plist_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        if self._loaded():
            self.run(["launchctl", "bootout", f"{self._domain}/{LABEL}"])
        self.plist_path.write_bytes(plistlib.dumps(plist))
        done = self.run(["launchctl", "bootstrap", self._domain, str(self.plist_path)])
        if done.returncode != 0:
            raise SystemExit("launchctl would not load the agent: " + (done.stderr or "").strip())
        return (f"Installed. The bridge now starts when you log in, on 127.0.0.1:{port}, and restarts if it stops.\n"
                "Pair a browser with `make garmin-pair`. Sign in to Garmin once with `make garmin-login`.\n"
                f"Log: {self.log_path}")

    def uninstall(self) -> str:
        self._require_mac()
        existed = self.plist_path.exists()
        was_loaded = self._loaded()
        if was_loaded:
            self.run(["launchctl", "bootout", f"{self._domain}/{LABEL}"])
        if existed:
            self.plist_path.unlink()
        if not existed and not was_loaded:
            return "Nothing to remove: the agent is not installed."
        return "Removed. The bridge no longer starts at login. `make garmin` still runs it by hand."

    def status(self) -> str:
        self._require_mac()
        if not self.plist_path.exists():
            return "The agent is not installed. `make garmin-install` installs it."
        try:
            args = plistlib.loads(self.plist_path.read_bytes())["ProgramArguments"]
            port = args[args.index("--port") + 1]
        except (OSError, ValueError, KeyError, IndexError):
            port = "?"
        if self._loaded():
            return f"The agent is installed and running on 127.0.0.1:{port}."
        return f"The agent is installed but not loaded (port {port}). Log in again or run `make garmin-install`."
