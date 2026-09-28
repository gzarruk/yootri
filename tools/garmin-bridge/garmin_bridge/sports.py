"""Garmin activity type keys → yootri disciplines.

Adapted from GARMIN-CLAUDE's ``domain/sports.py``. Garmin's ``typeKey`` values
drift between app versions, so an unknown key falls back to substring matching
and finally to ``Other`` — it is never dropped. yootri plans Swim, Bike, Run and
Strength; everything else is kept as history but never matched to a session.

``Multisport`` and ``Transition`` exist only so the mapper can recognise a
race's container and its changeovers and leave them out.
"""

from __future__ import annotations

_EXACT: dict[str, str] = {
    "lap_swimming": "Swim",
    "open_water_swimming": "Swim",
    "swimming": "Swim",
    "cycling": "Bike",
    "road_biking": "Bike",
    "mountain_biking": "Bike",
    "gravel_cycling": "Bike",
    "indoor_cycling": "Bike",
    "virtual_ride": "Bike",
    "cyclocross": "Bike",
    "track_cycling": "Bike",
    "recumbent_cycling": "Bike",
    "e_bike_fitness": "Bike",
    "e_bike_mountain": "Bike",
    "bmx": "Bike",
    "running": "Run",
    "trail_running": "Run",
    "treadmill_running": "Run",
    "track_running": "Run",
    "indoor_running": "Run",
    "virtual_run": "Run",
    "street_running": "Run",
    "ultra_run": "Run",
    "obstacle_run": "Run",
    "strength_training": "Strength",
    "multi_sport": "Multisport",
    "triathlon": "Multisport",
    "duathlon": "Multisport",
    "transition": "Transition",
    "transition_v2": "Transition",
    "swimtobiketransition": "Transition",
    "biketoruntransition": "Transition",
}


def classify(type_key: str | None) -> str:
    key = (type_key or "").strip().lower()
    if key in _EXACT:
        return _EXACT[key]
    if "transition" in key:
        return "Transition"
    if "swim" in key:
        return "Swim"
    if "cycl" in key or "bik" in key or "ride" in key:
        return "Bike"
    if "run" in key:
        return "Run"
    if "strength" in key:
        return "Strength"
    return "Other"
