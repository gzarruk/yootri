"""Garmin activity payloads → the bridge's wire shape.

Adapted from GARMIN-CLAUDE's ``map_activity`` and ``_flatten_activity``, cut
down to what the planner uses. The output is an explicit allowlist
(``WIRE_KEYS``): anything Garmin sends that is not named here — calories, the
device, the GPS fix, the owner's name, Garmin's own scores — never leaves this
process, whatever the endpoint grows to include later.

Heart rate crosses as ``hr: {avg, max}`` and nowhere else, so the page has one
key to split off before anything is stored on a plan.

Pure: no I/O, no clock.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from garmin_bridge.sports import classify

WIRE_KEYS = frozenset(
    {
        "id",
        "date",
        "time",
        "sport",
        "disc",
        "name",
        "durationS",
        "movingS",
        "elapsedS",
        "distanceM",
        "avgPowerW",
        "normPowerW",
        "rpe",
        "race",
        "parentId",
        "hr",
    }
)

NAME_MAX = 80

# A race's container carries no training of its own (its legs do) and a
# changeover is not a session anyone planned.
_LEFT_OUT = {"Multisport", "Transition"}

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class Skip(ValueError):
    """An activity that cannot be mapped, with a short machine-readable reason."""

    def __init__(self, reason: str, activity_id: str | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.activity_id = activity_id


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None  # NaN guard


def _positive_int(value: Any) -> int | None:
    """Garmin reports 0 for an absent sensor (no strap, no power meter)."""
    result = _num(value)
    return round(result) if result is not None and result > 0 else None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def _parse(value: Any) -> datetime | None:
    raw = _text(value)
    if raw is None:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "").replace(" ", "T")).replace(tzinfo=None)
    except ValueError:
        return None


_DETAIL_ALIASES = {"averagePower": "avgPower", "normalizedPower": "normPower"}


def _flatten(raw: dict[str, Any]) -> dict[str, Any]:
    """Accept both list items and ``get_activity`` detail payloads."""
    flat = dict(raw)
    summary = raw.get("summaryDTO")
    if isinstance(summary, dict):
        for key, value in summary.items():
            flat.setdefault(key, value)
        for detail_key, list_key in _DETAIL_ALIASES.items():
            if summary.get(detail_key) is not None:
                flat.setdefault(list_key, summary[detail_key])
    if "activityType" not in flat and isinstance(raw.get("activityTypeDTO"), dict):
        flat["activityType"] = raw["activityTypeDTO"]
    if "eventType" not in flat and isinstance(raw.get("eventTypeDTO"), dict):
        flat["eventType"] = raw["eventTypeDTO"]
    metadata = raw.get("metadataDTO")
    if isinstance(metadata, dict):
        flat.setdefault("parentId", metadata.get("parentId"))
        flat.setdefault("childIds", metadata.get("childIds"))
    return flat


def _rpe(value: Any) -> float | int | None:
    rpe = _num(value)
    if rpe is None:
        return None
    if rpe > 10:
        rpe = rpe / 10.0
    if not 1 <= rpe <= 10:
        return None
    rpe = round(rpe, 1)
    return int(rpe) if rpe == int(rpe) else rpe


def _name(value: Any) -> str | None:
    raw = _text(value)
    if raw is None:
        return None
    return _CONTROL.sub("", raw).strip()[:NAME_MAX] or None


def discipline_of(raw: dict[str, Any]) -> str:
    type_info = _flatten(raw).get("activityType")
    return classify(type_info.get("typeKey") if isinstance(type_info, dict) else None)


def map_activity(raw: dict[str, Any]) -> dict[str, Any]:
    a = _flatten(raw)
    activity_id = _text(a.get("activityId"))
    if activity_id is None:
        raise Skip("no-id")
    type_info = a.get("activityType")
    sport = (type_info.get("typeKey") if isinstance(type_info, dict) else None) or ""
    start = _parse(a.get("startTimeLocal")) or _parse(a.get("startTimeGMT"))
    if start is None:
        raise Skip("no-start-time", activity_id)
    event = a.get("eventType")
    avg_hr = _positive_int(a.get("averageHR"))
    max_hr = _positive_int(a.get("maxHR"))
    return {
        "id": activity_id,
        "date": start.date().isoformat(),
        "time": start.strftime("%H:%M"),
        "sport": sport.strip().lower(),
        "disc": classify(sport),
        "name": _name(a.get("activityName")),
        "durationS": _positive_int(a.get("duration")),
        "movingS": _positive_int(a.get("movingDuration")),
        "elapsedS": _positive_int(a.get("elapsedDuration")),
        "distanceM": _positive_int(a.get("distance")),
        "avgPowerW": _positive_int(a.get("avgPower")),
        "normPowerW": _positive_int(a.get("normPower")),
        "rpe": _rpe(a.get("directWorkoutRpe")),
        "race": isinstance(event, dict) and event.get("typeKey") == "race",
        "parentId": _text(a.get("parentId")),
        "hr": {"avg": avg_hr, "max": max_hr} if avg_hr or max_hr else None,
    }


def map_activities(raws: list[Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Map a page of payloads. One bad item is reported and skipped, never fatal."""
    out: dict[str, dict[str, Any]] = {}
    skipped: list[dict[str, Any]] = []
    for raw in raws:
        if not isinstance(raw, dict):
            skipped.append({"id": None, "reason": "not-an-object"})
            continue
        try:
            activity = map_activity(raw)
        except Skip as skip:
            skipped.append({"id": skip.activity_id, "reason": skip.reason})
            continue
        if activity["disc"] in _LEFT_OUT:
            continue
        out.setdefault(activity["id"], activity)
    ordered = sorted(out.values(), key=lambda x: (x["date"], x["time"], x["id"]))
    return ordered, skipped
