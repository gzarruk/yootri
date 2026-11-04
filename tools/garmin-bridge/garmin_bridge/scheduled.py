"""Garmin Coach runs scheduled in a date range, read-only.

The calendar lists each Coach run with a title and a date only; the steps are
one call further (the scheduled workout, then the workout it points at). This
returns, per upcoming run, what the engine's `runFromGarmin` needs:
``{date, scheduleId, title, workout}``. It is a command-line read for a job on
the athlete's own machine or runner — it is not part of the page-facing HTTP
server, which still answers only the routes in ``server.py``.

Only running workouts are returned. A day with none is simply absent: an empty
list means "not published yet", which the caller must not treat as an error.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from garmin_bridge.errors import translate_error


def _months(start: dt.date, end: dt.date) -> list[tuple[int, int]]:
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def fetch_scheduled_runs(api: Any, start: dt.date, end: dt.date) -> list[dict[str, Any]]:
    """Coach runs dated start..end inclusive, each with its workout detail."""
    if end < start:
        return []
    try:
        found: dict[str, dict[str, Any]] = {}
        for year, month in _months(start, end):
            calendar = api.get_scheduled_workouts(year, month) or {}
            for item in calendar.get("calendarItems") or []:
                date = str(item.get("date") or "")
                if (item.get("itemType") != "workout" or item.get("sportTypeKey") != "running"
                        or not (start.isoformat() <= date <= end.isoformat()) or item.get("id") is None):
                    continue
                found[str(item["id"])] = item
        runs = []
        for item in sorted(found.values(), key=lambda i: (i["date"], i["id"])):
            scheduled = api.get_scheduled_workout_by_id(item["id"]) or {}
            workout_id = (scheduled.get("workout") or {}).get("workoutId")
            if workout_id is None:
                continue
            runs.append({
                "date": item["date"],
                "scheduleId": item["id"],
                "title": str(item.get("title") or "")[:80],
                "workout": api.get_workout_by_id(workout_id),
            })
        return runs
    except Exception as exc:  # noqa: BLE001 - translated for the caller
        raise translate_error(exc) from exc
