import pytest
import requests
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)
from garminconnect.exceptions import GarminConnectNotFoundError

from garmin_bridge.errors import (
    AuthRequired,
    BridgeError,
    GarminError,
    MfaRequired,
    RateLimited,
    Unavailable,
    redact,
    translate_error,
)


def with_status(status):
    exc = GarminConnectConnectionError(f"API Error {status}")

    class Response:
        status_code = status

    exc.response = Response()
    return exc


@pytest.mark.parametrize(
    ("exc", "kind"),
    [
        (GarminConnectAuthenticationError("bad password"), AuthRequired),
        (GarminConnectAuthenticationError("MFA code required"), MfaRequired),
        (GarminConnectTooManyRequestsError("slow down"), RateLimited),
        (GarminConnectNotFoundError("gone"), GarminError),
        (with_status(401), AuthRequired),
        (with_status(403), AuthRequired),
        (with_status(429), RateLimited),
        (with_status(400), GarminError),
        (with_status(503), Unavailable),
        (GarminConnectConnectionError("no status"), Unavailable),
        (requests.ConnectionError("dns"), Unavailable),
        (requests.Timeout("slow"), Unavailable),
        (TimeoutError("slow"), Unavailable),
        (RuntimeError("surprise"), GarminError),
    ],
)
def test_library_errors_become_bridge_errors(exc, kind):
    assert isinstance(translate_error(exc), kind)


def test_bridge_errors_pass_through():
    err = RateLimited("already mapped")
    assert translate_error(err) is err


def test_codes_and_statuses():
    assert (AuthRequired().code, AuthRequired().status) == ("auth_required", 409)
    assert (RateLimited().code, RateLimited().status) == ("rate_limited", 429)
    assert (Unavailable().code, Unavailable().status) == ("unavailable", 503)
    assert (GarminError().code, GarminError().status) == ("garmin_error", 502)
    assert isinstance(AuthRequired(), BridgeError)


def test_every_error_has_a_plain_default_message():
    for kind in (AuthRequired, MfaRequired, RateLimited, Unavailable, GarminError):
        assert kind().message


def test_redact_removes_credentials_and_identifiers():
    text = (
        'login for jane.doe+tri@example.com failed; Authorization: Bearer abcdefghijklmnop '
        '{"di_token": "tok-123456789", "di_refresh_token": "ref-987654321"} '
        "ticket ST-0123456789-abcdef-sso"
    )
    out = redact(text)
    for secret in ("jane.doe", "example.com", "abcdefghijklmnop", "tok-123456789",
                   "ref-987654321", "ST-0123456789"):
        assert secret not in out


def test_translated_messages_are_redacted_and_bounded():
    err = translate_error(RuntimeError("jane@example.com " + "x" * 2000))
    assert "jane@example.com" not in err.message
    assert len(err.message) <= 300
