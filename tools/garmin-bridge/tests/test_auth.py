import json

import pytest
from garminconnect import GarminConnectAuthenticationError, GarminConnectTooManyRequestsError

from garmin_bridge.auth import login, open_api
from garmin_bridge.errors import AuthRequired, MfaRequired, RateLimited
from garmin_bridge.store import Store
from tests.fakes import FakeGarmin

PASSWORD = "correct horse battery staple"


def factory(**defaults):
    made = []

    def make(**kwargs):
        api = FakeGarmin(**{**defaults, **kwargs})
        made.append(api)
        return api

    make.made = made
    return make


def everything_on_disk(store):
    return "".join(p.read_text() for p in store.dir.iterdir() if p.is_file())


def test_login_saves_the_session_and_nothing_else(tmp_path):
    store = Store(tmp_path)
    name = login(store, "jane@example.com", PASSWORD, prompt_mfa=None, api_factory=factory())
    assert name == "fake-athlete"
    assert json.loads(store.read_tokens()) == FakeGarmin.VALID_TOKENS
    on_disk = everything_on_disk(store)
    assert PASSWORD not in on_disk
    assert "jane@example.com" not in on_disk


def test_login_asks_for_the_verification_code(tmp_path):
    store = Store(tmp_path)
    make = factory(mfa_code="123456")
    login(store, "jane@example.com", PASSWORD, prompt_mfa=lambda: "123456", api_factory=make)
    assert store.read_tokens() is not None


def test_a_wrong_code_saves_nothing(tmp_path):
    store = Store(tmp_path)
    make = factory(mfa_code="123456")
    with pytest.raises(MfaRequired):
        login(store, "jane@example.com", PASSWORD, prompt_mfa=lambda: "000000", api_factory=make)
    assert store.read_tokens() is None


def test_a_rate_limited_login_is_reported_as_such(tmp_path):
    make = factory(fail_login=GarminConnectTooManyRequestsError("Too many login attempts"))
    with pytest.raises(RateLimited):
        login(Store(tmp_path), "jane@example.com", PASSWORD, prompt_mfa=None, api_factory=make)


def test_open_api_needs_a_saved_session(tmp_path):
    with pytest.raises(AuthRequired):
        open_api(Store(tmp_path), api_factory=factory())


def test_open_api_resumes_from_the_saved_session(tmp_path):
    store = Store(tmp_path)
    store.write_tokens(json.dumps(FakeGarmin.VALID_TOKENS))
    make = factory()
    api = open_api(store, api_factory=make)
    assert api.client.tokens == FakeGarmin.VALID_TOKENS
    # Resumed without credentials: the saved session is the only input.
    assert make.made[0].email is None


def test_a_refresh_during_resume_is_saved(tmp_path):
    store = Store(tmp_path)
    store.write_tokens(json.dumps(FakeGarmin.VALID_TOKENS))
    open_api(store, api_factory=factory(refresh_on_login=True))
    assert json.loads(store.read_tokens())["di_token"] == "access-2"


def test_a_rejected_session_asks_for_a_new_login(tmp_path):
    store = Store(tmp_path)
    store.write_tokens(json.dumps(FakeGarmin.VALID_TOKENS))
    make = factory(fail_login=GarminConnectAuthenticationError("expired"))
    with pytest.raises(AuthRequired):
        open_api(store, api_factory=make)
