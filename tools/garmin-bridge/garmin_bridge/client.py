"""The two Garmin calls the bridge makes, paced and retried.

Adapted from GARMIN-CLAUDE's ``GarminDataSource``. The bridge asks Garmin for
activity summaries (and, for a multisport race whose legs are missing from the
list, for those legs one at a time) and for nothing else — no daily data, no
files, no profile.

Every call goes through ``_call``: wait for the token bucket, call, translate
any failure into a ``BridgeError``, retry only an outage, and hand refreshed
session tokens back so they can be saved.

A rate limit is *not* retried, unlike in GARMIN-CLAUDE, whose scheduler could
afford to wait. Here a person pressed a button: retrying a 429 for minutes only
extends Garmin's limit, and outlasts the page's timeout, which would then say
the bridge did not answer instead of saying to wait.
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

from garmin_bridge.errors import AuthRequired, BridgeError, RateLimited, Unavailable, translate_error
from garmin_bridge.mapper import discipline_of, map_activities
from garmin_bridge.resilience import TokenBucket, backoff

log = logging.getLogger("garmin_bridge")

CHUNK_DAYS = 30
MAX_LEGS = 20


class GarminClient:
    def __init__(
        self,
        api: Any,
        *,
        bucket: TokenBucket | None = None,
        sleep: Callable[[float], None] = time.sleep,
        rng: Callable[[], float] = random.random,
        retries: int = 4,
        chunk_days: int = CHUNK_DAYS,
        on_tokens_changed: Callable[[str], None] | None = None,
    ) -> None:
        self._api = api
        self._bucket = bucket or TokenBucket()
        self._sleep = sleep
        self._rng = rng
        self._retries = retries
        self._chunk_days = chunk_days
        self._on_tokens_changed = on_tokens_changed
        self._tokens = self._dump_tokens()

    def _dump_tokens(self) -> str | None:
        dumps = getattr(getattr(self._api, "client", None), "dumps", None)
        if dumps is None:
            return None
        try:
            value = dumps()
        except Exception:  # noqa: BLE001 - a failed dump must never fail a fetch
            return None
        return value if isinstance(value, str) else None

    def _save_tokens_if_changed(self) -> None:
        current = self._dump_tokens()
        if current and current != self._tokens:
            if self._on_tokens_changed is not None:
                self._on_tokens_changed(current)
            self._tokens = current

    def _call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        method = getattr(self._api, name)
        for attempt in range(self._retries + 1):
            self._bucket.acquire()
            try:
                result = method(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001 - every failure is translated
                error = translate_error(exc)
                if not isinstance(error, Unavailable) or attempt >= self._retries:
                    raise error from exc
                delay = backoff(attempt, rng=self._rng)
                log.warning("Garmin %s: %s, retrying in %.0fs", name, error.code, delay)
                self._sleep(delay)
                continue
            self._save_tokens_if_changed()
            return result
        raise Unavailable(f"{name}: retries exhausted")  # pragma: no cover - loop always returns

    def list_activities(self, since: date, until: date) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        start = since
        while start <= until:
            end = min(until, start + timedelta(days=self._chunk_days - 1))
            page = self._call(
                "get_activities_by_date", start.isoformat(), end.isoformat(), sortorder="asc"
            )
            out.extend(page or [])
            start = end + timedelta(days=1)
        return out

    def get_activity(self, activity_id: str) -> dict[str, Any]:
        return dict(self._call("get_activity", activity_id) or {})


def fetch_activities(
    client: GarminClient, since: date, until: date, *, max_legs: int = MAX_LEGS
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Activities in the window, mapped to the wire shape, plus what was skipped.

    A multisport race comes back from the list as a container whose legs may or
    may not be listed beside it. Missing legs are fetched individually, up to
    ``max_legs`` per request; a leg that cannot be fetched is reported, never
    fatal.
    """
    raws = client.list_activities(since, until)
    listed = {str(r.get("activityId")) for r in raws if isinstance(r, dict)}
    extra: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    budget = max_legs
    for raw in raws:
        if not isinstance(raw, dict) or discipline_of(raw) != "Multisport":
            continue
        parent_id = str(raw.get("activityId"))
        for child in raw.get("childIds") or []:
            child_id = str(child)
            if child_id in listed or budget <= 0:
                continue
            budget -= 1
            try:
                detail = client.get_activity(child_id)
            except BridgeError as error:
                # A lost session or a rate limit applies to every leg alike:
                # stop rather than ask again for each one.
                if isinstance(error, AuthRequired | RateLimited):
                    raise
                skipped.append({"id": child_id, "reason": "leg-unavailable"})
                continue
            if isinstance(detail, dict) and detail:
                detail.setdefault("parentId", parent_id)
            extra.append(detail)
            listed.add(child_id)
    activities, unmapped = map_activities([*raws, *extra])
    return activities, [*skipped, *unmapped]
