import io
import json

from garminconnect import GarminConnectAuthenticationError

from garmin_bridge.cli import default_origins, main
from garmin_bridge.store import Store
from tests.fakes import FakeGarmin

PASSWORD = "correct horse battery staple"
EMAIL = "jane@example.com"


def run(argv, tmp_path, *, inputs=(EMAIL,), api_factory=None, run_server=None):
    out = io.StringIO()
    answers = iter(inputs)
    asked = {"getpass": 0}

    def fake_getpass(prompt):
        asked["getpass"] += 1
        return PASSWORD

    code = main(
        argv,
        store=Store(tmp_path),
        api_factory=api_factory or (lambda **kw: FakeGarmin(**kw)),
        input_fn=lambda prompt: next(answers),
        getpass_fn=fake_getpass,
        out=out,
        run_server=run_server or (lambda server: None),
    )
    return code, out.getvalue(), asked


def test_login_reads_the_password_without_echo_and_saves_only_the_session(tmp_path):
    code, text, asked = run(["login"], tmp_path)
    assert code == 0
    assert asked["getpass"] == 1
    assert PASSWORD not in text and EMAIL not in text
    assert json.loads(Store(tmp_path).read_tokens()) == FakeGarmin.VALID_TOKENS


def test_login_asks_for_a_verification_code_when_garmin_does(tmp_path):
    factory = lambda **kw: FakeGarmin(mfa_code="424242", **kw)  # noqa: E731
    code, _, _ = run(["login"], tmp_path, inputs=(EMAIL, "424242"), api_factory=factory)
    assert code == 0


def test_a_failed_login_says_why_and_exits_non_zero(tmp_path):
    factory = lambda **kw: FakeGarmin(fail_login=GarminConnectAuthenticationError("bad"), **kw)  # noqa: E731
    code, text, _ = run(["login"], tmp_path, api_factory=factory)
    assert code == 1
    assert "make garmin-login" in text or "Garmin" in text
    assert PASSWORD not in text


def test_logout(tmp_path):
    Store(tmp_path).write_tokens("{}")
    code, text, _ = run(["logout"], tmp_path)
    assert code == 0
    assert Store(tmp_path).read_tokens() is None
    assert "Signed out" in text


def test_status(tmp_path):
    _, before, _ = run(["status"], tmp_path)
    assert "Not signed in" in before
    Store(tmp_path).write_tokens("{}")
    _, after, _ = run(["status"], tmp_path)
    assert "Signed in" in after


def test_serve_prints_how_to_pair_and_listens_on_loopback(tmp_path):
    seen = {}

    def capture(server):
        seen["address"] = server.server_address
        seen["origins"] = server.cfg.origins

    code, text, _ = run(["serve", "--port", "0", "--allow-origin", "https://other.example"],
                        tmp_path, run_server=capture)
    token = Store(tmp_path).pairing_token(create=False)
    assert code == 0
    assert seen["address"][0] == "127.0.0.1"
    assert "https://other.example" in seen["origins"]
    assert token in text
    assert "?garmin=setup" in text
    assert "make garmin-login" in text  # not signed in yet


def test_pair_prints_and_rotates(tmp_path):
    _, first, _ = run(["pair"], tmp_path)
    _, again, _ = run(["pair"], tmp_path)
    _, rotated, _ = run(["pair", "--rotate"], tmp_path)
    assert first == again
    assert rotated != first


def test_default_origins_read_the_repo_cname(tmp_path):
    cname = tmp_path / "CNAME"
    cname.write_text("yootri.example\n")
    assert default_origins(cname) == ("http://localhost:8000", "https://yootri.example")
    assert default_origins(tmp_path / "missing") == ("http://localhost:8000",)
