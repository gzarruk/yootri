"""Typed errors, and how the Garmin library's exceptions map onto them.

The mapping is adapted from GARMIN-CLAUDE's ``translate_error`` and was checked
against garminconnect 0.3.16: 401/403 mean the session is gone, 429 is a rate
limit the library never retries, 5xx and network failures are transient, and
other 4xx are Garmin refusing the request.

Every error carries a ``code`` the page turns into a sentence, and an HTTP
status the bridge answers with. Messages are redacted before they are stored,
because the library's exception text can carry the account e-mail or a token.
"""

from __future__ import annotations

import re
from typing import Any

import requests
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)
from garminconnect.exceptions import GarminConnectNotFoundError

MESSAGE_MAX = 300


class BridgeError(Exception):
    code = "internal"
    status = 500
    default = "Something went wrong inside the bridge."

    def __init__(self, message: str | None = None) -> None:
        self.message = redact(message)[:MESSAGE_MAX] if message else self.default
        super().__init__(self.message)


class AuthRequired(BridgeError):
    code, status = "auth_required", 409
    default = "Not signed in to Garmin. Run `make garmin-login` in a terminal."


class MfaRequired(BridgeError):
    code, status = "mfa_required", 409
    default = "Garmin asked for a verification code. Run `make garmin-login` in a terminal."


class RateLimited(BridgeError):
    code, status = "rate_limited", 429
    default = "Garmin is limiting requests. Wait a while and try again."


class Unavailable(BridgeError):
    code, status = "unavailable", 503
    default = "Garmin Connect could not be reached."


class GarminError(BridgeError):
    code, status = "garmin_error", 502
    default = "Garmin Connect refused the request."


class BadRequest(BridgeError):
    code, status = "bad_request", 400
    default = "The request was not understood."


class Unauthorized(BridgeError):
    code, status = "unauthorized", 401
    default = "Missing or wrong pairing token."


class ForbiddenOrigin(BridgeError):
    code, status = "forbidden_origin", 403
    default = "This page is not allowed to use the bridge."


class BadHost(BridgeError):
    code, status = "bad_host", 421
    default = "The bridge only answers on 127.0.0.1 and localhost."


class NotFound(BridgeError):
    code, status = "not_found", 404
    default = "No such endpoint."


class MethodNotAllowed(BridgeError):
    code, status = "method_not_allowed", 405
    default = "The bridge only answers GET."


_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)\b(bearer|basic)\s+[\w\-.=:+/]{8,}"), r"\1 [REDACTED]"),
    (
        re.compile(
            r"(?i)(\"?(?:password|token|refresh_token|access_token|di_token|di_refresh_token|"
            r"di_client_id|ticket|mfa_code)\"?\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,&}]+)"
        ),
        r'\1"[REDACTED]"',
    ),
    (re.compile(r"eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}"), "[REDACTED]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[EMAIL]"),
    (re.compile(r"\bST-[\w-]{10,}"), "[REDACTED]"),
)


def redact(text: str | None) -> str:
    out = str(text or "")
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def _status(exc: BaseException) -> int | None:
    response: Any = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if isinstance(status, int):
        return status
    cause = exc.__cause__
    if cause is not None and cause is not exc:
        return _status(cause)
    return None


def translate_error(exc: BaseException) -> BridgeError:
    if isinstance(exc, BridgeError):
        return exc
    message = str(exc)
    if isinstance(exc, GarminConnectAuthenticationError):
        if "mfa" in message.lower():
            return MfaRequired(message)
        return AuthRequired(message)
    if isinstance(exc, GarminConnectTooManyRequestsError):
        return RateLimited(message)
    if isinstance(exc, GarminConnectNotFoundError):
        return GarminError(message)
    if isinstance(exc, GarminConnectConnectionError):
        status = _status(exc)
        if status in (401, 403):
            return AuthRequired(message)
        if status == 429:
            return RateLimited(message)
        if status is not None and 400 <= status < 500:
            return GarminError(message)
        return Unavailable(message)
    if isinstance(exc, requests.ConnectionError | requests.Timeout | TimeoutError):
        return Unavailable(message)
    return GarminError(f"{type(exc).__name__}: {message}")
