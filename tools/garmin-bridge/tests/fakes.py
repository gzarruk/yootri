"""A stand-in for ``garminconnect.Garmin`` — no network, ever.

Adapted from GARMIN-CLAUDE's ``tests/fakes.py``. It records every method the
bridge calls, so a test can assert the bridge asks Garmin for activities and
nothing else.
"""

from __future__ import annotations

import json
from typing import Any

from garminconnect import GarminConnectAuthenticationError

# The only library methods the bridge is allowed to use.
ALLOWED_CALLS = {"login", "get_activities_by_date", "get_activity"}


class FakeClient:
    def __init__(self) -> None:
        self.tokens: dict[str, Any] = {}

    def dumps(self) -> str:
        return json.dumps(self.tokens, sort_keys=True)


class FakeGarmin:
    VALID_TOKENS = {"di_token": "access-1", "di_refresh_token": "refresh-1", "di_client_id": "cid"}

    def __init__(
        self,
        email: str | None = None,
        password: str | None = None,
        *,
        prompt_mfa=None,
        responses: dict[str, Any] | None = None,
        mfa_code: str | None = None,
        refresh_on_login: bool = False,
        refresh_on_call: bool = False,
        fail_login: Exception | None = None,
        **_: Any,
    ) -> None:
        self.email = email
        self.password = password
        self.prompt_mfa = prompt_mfa
        self.client = FakeClient()
        self.display_name: str | None = None
        self.responses = responses or {}
        self.mfa_code = mfa_code
        self.refresh_on_login = refresh_on_login
        self.refresh_on_call = refresh_on_call
        self.fail_login = fail_login
        self.calls: list[tuple[str, tuple, dict]] = []

    def _record(self, name: str, args: tuple, kwargs: dict) -> None:
        self.calls.append((name, args, kwargs))

    def called(self) -> set[str]:
        return {name for name, _, _ in self.calls}

    def login(self, tokenstore: str | None = None):
        self._record("login", (tokenstore,), {})
        if self.fail_login is not None:
            raise self.fail_login
        if tokenstore:
            self.client.tokens = json.loads(tokenstore)
            if self.refresh_on_login:
                self.client.tokens = {**self.client.tokens, "di_token": "access-2"}
        elif self.email and self.password:
            if self.mfa_code is not None:
                code = self.prompt_mfa() if self.prompt_mfa else None
                if code != self.mfa_code:
                    raise GarminConnectAuthenticationError("Invalid MFA code")
            self.client.tokens = dict(self.VALID_TOKENS)
        else:
            raise GarminConnectAuthenticationError("Username and password are required")
        self.display_name = "fake-athlete"
        self.password = None
        return None, None

    def _respond(self, name: str, *args: Any, **kwargs: Any) -> Any:
        self._record(name, args, kwargs)
        if self.refresh_on_call:
            self.client.tokens = {**self.client.tokens, "di_token": f"access-call-{len(self.calls)}"}
        value = self.responses.get(name)
        if callable(value):
            return value(*args, **kwargs)
        return value

    def get_activities_by_date(self, startdate, enddate=None, activitytype=None, sortorder=None):
        return self._respond("get_activities_by_date", startdate, enddate, sortorder=sortorder)

    def get_activity(self, activity_id):
        return self._respond("get_activity", activity_id)

    # Present on the real class; the bridge must never call them.
    def get_sleep_data(self, *_a, **_k):  # pragma: no cover - guarded by ALLOWED_CALLS
        return self._respond("get_sleep_data")

    def get_hrv_data(self, *_a, **_k):  # pragma: no cover
        return self._respond("get_hrv_data")
