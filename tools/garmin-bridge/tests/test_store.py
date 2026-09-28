import stat
from pathlib import Path

from garmin_bridge.store import Store, default_dir


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_default_dir_prefers_the_explicit_override(tmp_path):
    env = {"YOOTRI_GARMIN_HOME": str(tmp_path / "x"), "XDG_CONFIG_HOME": str(tmp_path / "y")}
    assert default_dir(env) == tmp_path / "x"


def test_default_dir_follows_xdg_then_home(tmp_path):
    assert default_dir({"XDG_CONFIG_HOME": str(tmp_path)}) == tmp_path / "yootri"
    assert default_dir({"HOME": str(tmp_path)}) == tmp_path / ".config" / "yootri"


def test_tokens_round_trip_and_are_private(tmp_path):
    store = Store(tmp_path / "cfg")
    assert store.read_tokens() is None
    store.write_tokens('{"di_token": "a"}')
    assert store.read_tokens() == '{"di_token": "a"}'
    assert mode(store.dir) == 0o700
    assert mode(store.tokens_path) == 0o600


def test_rewriting_keeps_the_file_private(tmp_path):
    store = Store(tmp_path)
    store.write_tokens("one")
    store.tokens_path.chmod(0o644)
    store.write_tokens("two")
    assert store.read_tokens() == "two"
    assert mode(store.tokens_path) == 0o600


def test_delete_tokens(tmp_path):
    store = Store(tmp_path)
    assert store.delete_tokens() is False
    store.write_tokens("x")
    assert store.delete_tokens() is True
    assert store.read_tokens() is None


def test_tokens_saved_at(tmp_path):
    store = Store(tmp_path)
    assert store.tokens_saved_at() is None
    store.write_tokens("x")
    assert store.tokens_saved_at().endswith("Z")


def test_pairing_token_is_created_once_and_reused(tmp_path):
    store = Store(tmp_path)
    first = store.pairing_token()
    assert len(first) >= 32
    assert store.pairing_token() == first
    assert mode(store.pairing_path) == 0o600


def test_pairing_token_can_be_rotated(tmp_path):
    store = Store(tmp_path)
    first = store.pairing_token()
    assert store.pairing_token(rotate=True) != first


def test_pairing_token_without_create(tmp_path):
    assert Store(tmp_path).pairing_token(create=False) is None
