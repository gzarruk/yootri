"""Signing in to Garmin, and resuming the saved session.

Adapted from GARMIN-CLAUDE's ``GarminAuth``. A login asks for your e-mail and
password once (and a verification code, if your account has one), hands them
to the Garmin library, and saves only the session the library returns. After
that, every fetch resumes from the saved session; the library refreshes it
when it is about to expire, and a refreshed session is saved over the old one.

The password is passed straight to the library and never stored or logged.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from garmin_bridge.errors import AuthRequired, translate_error
from garmin_bridge.store import Store

ApiFactory = Callable[..., Any]


def _default_factory(**kwargs: Any) -> Any:
    from garminconnect import Garmin  # imported late: tests never need it

    return Garmin(**kwargs)


def quiet_library() -> None:
    """At DEBUG the library logs whole response bodies. Never let it."""
    logging.getLogger("garminconnect").setLevel(logging.WARNING)


def login(
    store: Store,
    email: str,
    password: str,
    prompt_mfa: Callable[[], str] | None,
    *,
    api_factory: ApiFactory | None = None,
) -> str | None:
    """Sign in with credentials; save the session. Returns Garmin's display name."""
    quiet_library()
    api = (api_factory or _default_factory)(email=email, password=password, prompt_mfa=prompt_mfa)
    try:
        api.login()
    except Exception as exc:  # noqa: BLE001 - translated for the caller
        raise translate_error(exc) from exc
    store.write_tokens(api.client.dumps())
    return getattr(api, "display_name", None)


def open_api(store: Store, *, api_factory: ApiFactory | None = None) -> Any:
    """A signed-in library object, resumed from the saved session."""
    quiet_library()
    tokens = store.read_tokens()
    if tokens is None:
        raise AuthRequired()
    api = (api_factory or _default_factory)()
    try:
        api.login(tokens)
    except Exception as exc:  # noqa: BLE001 - translated for the caller
        raise translate_error(exc) from exc
    refreshed = api.client.dumps()
    if refreshed and refreshed != tokens:
        store.write_tokens(refreshed)
    return api
