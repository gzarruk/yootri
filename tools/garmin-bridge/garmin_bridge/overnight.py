"""Garmin's overnight figures → the bridge's wire shape, one row per night.

Read only when the bridge was started with ``YOOTRI_GARMIN_OVERNIGHT=1``. Each
night comes out as at most three numbers, all the athlete's own measurements as
Garmin reports them::

    {"date": "2026-10-05", "sleepMin": 437, "hrvMs": 61, "restingHr": 47}

``sleepMin`` is minutes asleep, ``hrvMs`` the overnight HRV average in
milliseconds, ``restingHr`` the day's resting heart rate. A night is dated the
way Garmin dates it: by the morning it ended on.

The output is an allowlist (``NIGHT_KEYS``). Garmin's own reading of these
numbers — its scores, statuses, baselines and feedback phrases — stops here,
and so do the sleep stages, SpO2, respiration and the rest of what the same
answers carry. yootri compares the athlete with their own recent nights and
says nothing about what that means; Garmin's labels would say more.

A value outside a plausible range is a sensor fault or a watch left on a
table, so it is dropped rather than clamped, and a night with nothing left has
no row. Pure: no I/O, no clock.
"""

from __future__ import annotations

from datetime import date
from typing import Any

NIGHT_KEYS = frozenset({"date", "sleepMin", "hrvMs", "restingHr"})

# Plausible ranges. Unfitted: wide enough for any adult athlete, narrow enough
# to drop a nap logged as a night or an HRV reading taken off the wrist.
SLEEP_MIN = (60, 1200)
HRV_MS = (5, 250)
RESTING_HR = (25, 120)

# The daily sleep-stats rows are not documented; these are the two names Garmin
# is known to use for the same figure (the stats rows' totalSleepTimeInSeconds,
# the per-night DTO's sleepTimeSeconds). A row with neither has no sleep figure.
_SLEEP_SECONDS_KEYS = ("totalSleepTimeInSeconds", "sleepTimeSeconds")


def _day(value: Any, since: date, until: date) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        day = date.fromisoformat(value)
    except ValueError:
        return None
    return day.isoformat() if since <= day <= until else None


def _number(value: Any, bounds: tuple[int, int]) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    lo, hi = bounds
    rounded = round(value)
    return rounded if lo <= rounded <= hi else None


def _rows(value: Any) -> list[dict[str, Any]]:
    return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []


def _sleep_seconds(row: dict[str, Any]) -> Any:
    inner = row.get("values") if isinstance(row.get("values"), dict) else {}
    for source in (inner, row):
        for key in _SLEEP_SECONDS_KEYS:
            if source.get(key) is not None:
                return source[key]
    return None


def map_overnight(
    sleep_rows: Any, hrv_payloads: Any, rhr_rows: Any, *, since: date, until: date
) -> list[dict[str, Any]]:
    """The three range answers, merged by date, oldest first."""
    nights: dict[str, dict[str, Any]] = {}

    def put(day: str | None, key: str, value: int | None) -> None:
        if day is not None and value is not None:
            nights.setdefault(day, {"date": day})[key] = value

    for row in _rows(sleep_rows):
        seconds = _sleep_seconds(row)
        minutes = seconds / 60 if isinstance(seconds, int | float) and not isinstance(seconds, bool) else None
        put(_day(row.get("calendarDate"), since, until), "sleepMin", _number(minutes, SLEEP_MIN))

    for payload in hrv_payloads if isinstance(hrv_payloads, list) else []:
        summaries = payload.get("hrvSummaries") if isinstance(payload, dict) else payload
        for row in _rows(summaries):
            put(_day(row.get("calendarDate"), since, until), "hrvMs", _number(row.get("lastNightAvg"), HRV_MS))

    for row in _rows(rhr_rows):
        put(_day(row.get("calendarDate"), since, until), "restingHr", _number(row.get("value"), RESTING_HR))

    return [nights[day] for day in sorted(nights)]
