"""Garmin activity-list payloads shaped like garminconnect 0.3.16 responses.

Adapted from GARMIN-CLAUDE's ``tests/garmin_payloads.py``. They carry every field
the real list endpoint sends that the bridge must *not* pass on (calories,
device, GPS, training effect...), so the allowlist tests have something to catch.

The heart-rate values on the run are deliberately distinctive (173 / 187): the
JavaScript tests look for those exact numbers to prove heart rate never reaches
a stored plan.
"""

from __future__ import annotations

from typing import Any


def run(activity_id: int = 1001, day: str = "2026-09-01", **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "activityId": activity_id,
        "activityName": "Morning Run",
        "startTimeLocal": f"{day} 07:30:00",
        "startTimeGMT": f"{day} 05:30:00",
        "activityType": {"typeKey": "running", "parentTypeId": 17},
        "eventType": {"typeKey": "training"},
        "duration": 3600.0,
        "movingDuration": 3550.4,
        "elapsedDuration": 3700.0,
        "distance": 12000.0,
        "elevationGain": 120.0,
        "averageSpeed": 3.333,
        "averageHR": 173.0,
        "maxHR": 187.0,
        "calories": 820.0,
        "averageRunningCadenceInStepsPerMinute": 172.0,
        "aerobicTrainingEffect": 3.4,
        "activityTrainingLoad": 95.3,
        "trainingEffectLabel": "TEMPO",
        "vO2MaxValue": 55.0,
        "directWorkoutRpe": 60,
        "deviceId": 3456789,
        "ownerFullName": "Some Athlete",
        "manualActivity": False,
        "hasPolyline": True,
        "startLatitude": 59.91,
        "startLongitude": 10.75,
    }
    payload.update(overrides)
    return payload


def bike(activity_id: int = 2001, day: str = "2026-09-02") -> dict[str, Any]:
    return {
        "activityId": activity_id,
        "activityName": "Z2 ride",
        "startTimeLocal": f"{day} 09:00:00",
        "startTimeGMT": f"{day} 07:00:00",
        "activityType": {"typeKey": "road_biking"},
        "duration": 7200.0,
        "movingDuration": 7000.0,
        "distance": 60000.0,
        "averageHR": 135.0,
        "maxHR": 160.0,
        "avgPower": 190.0,
        "maxPower": 620.0,
        "normPower": 205.0,
        "deviceId": 3456789,
        "hasPolyline": True,
    }


def swim(activity_id: int = 3001, day: str = "2026-09-03") -> dict[str, Any]:
    # No heart rate strap in the pool: Garmin sends 0, which means "absent".
    return {
        "activityId": activity_id,
        "activityName": "Pool",
        "startTimeLocal": f"{day} 19:00:00",
        "startTimeGMT": f"{day} 17:00:00",
        "activityType": {"typeKey": "lap_swimming"},
        "duration": 2400.0,
        "movingDuration": 2000.0,
        "distance": 2000.0,
        "averageHR": 0,
        "maxHR": 0,
        "poolLength": 25.0,
        "strokes": 1400,
    }


def strength(activity_id: int = 4001, day: str = "2026-09-04") -> dict[str, Any]:
    return {
        "activityId": activity_id,
        "activityName": "Gym",
        "startTimeLocal": f"{day} 18:00:00",
        "startTimeGMT": f"{day} 16:00:00",
        "activityType": {"typeKey": "strength_training"},
        "duration": 2700.0,
        "directWorkoutRpe": 7,
    }


def triathlon(day: str = "2026-09-06") -> list[dict[str, Any]]:
    """A multisport race: one container, three legs, two transitions."""
    parent = {
        "activityId": 5000,
        "activityName": "Sprint tri",
        "startTimeLocal": f"{day} 08:00:00",
        "startTimeGMT": f"{day} 06:00:00",
        "activityType": {"typeKey": "multi_sport"},
        "eventType": {"typeKey": "race"},
        "duration": 5400.0,
        "childIds": [5001, 5002, 5003, 5004, 5005],
    }

    def leg(aid: int, key: str, start: str, dur: float, dist: float) -> dict[str, Any]:
        return {
            "activityId": aid,
            "activityName": "Sprint tri",
            "startTimeLocal": f"{day} {start}",
            "startTimeGMT": f"{day} {start}",
            "activityType": {"typeKey": key},
            "eventType": {"typeKey": "race"},
            "duration": dur,
            "distance": dist,
            "parentId": 5000,
        }

    return [
        parent,
        leg(5001, "open_water_swimming", "08:00:00", 900.0, 750.0),
        leg(5002, "transition_v2", "08:15:00", 120.0, 0.0),
        leg(5003, "road_biking", "08:17:00", 2400.0, 20000.0),
        leg(5004, "transition_v2", "08:57:00", 60.0, 0.0),
        leg(5005, "running", "08:58:00", 1320.0, 5000.0),
    ]


def everything() -> list[dict[str, Any]]:
    """The fixed set the golden file is generated from."""
    return [run(), bike(), swim(), strength(), *triathlon()]


# ---- overnight figures (YOOTRI_GARMIN_OVERNIGHT=1 only) ---------------------
#
# Shaped like the three range calls the bridge makes. Each carries what Garmin
# sends beside the one number the bridge keeps — its own scores, statuses,
# baselines and feedback, sleep stages, SpO2, respiration — so the allowlist
# tests have something to catch. The kept values for 2026-10-05 are distinctive
# (437 min asleep, HRV 61 ms, resting heart rate 47): the JavaScript tests look
# for those numbers to prove none of them reaches a stored plan.


def sleep_daily() -> list[dict[str, Any]]:
    """``get_sleep_daily``: the sleep-stats rows, one per night."""
    def row(day: str, seconds: int | None, score: int) -> dict[str, Any]:
        return {
            "calendarDate": day,
            "values": {
                "totalSleepTimeInSeconds": seconds,
                "remTime": 5400,
                "deepTime": 4800,
                "lightTime": 14000,
                "awakeTime": 600,
                "sleepScore": score,
                "sleepScoreQuality": "GOOD",
                "sleepNeed": 480,
                "spO2": 95,
                "respiration": 14.2,
                "restingHeartRate": 99,
                "bodyBatteryChange": 55,
                "hrvStatus": "BALANCED",
                "skinTempF": 0.4,
                "localSleepStartTimeInMillis": 1759617600000,
                "localSleepEndTimeInMillis": 1759643820000,
            },
        }

    return [
        row("2026-10-03", 25200, 81),
        row("2026-10-04", None, 0),          # the watch was off
        row("2026-10-05", 26220, 77),        # 437 min
        row("2026-10-06", 900, 12),          # 15 min: not a night's sleep
    ]


def hrv_range() -> dict[str, Any]:
    """``get_hrv_data_range``: Garmin's summaries, with its own reading of them."""
    def summary(day: str, avg: float | None) -> dict[str, Any]:
        return {
            "calendarDate": day,
            "weeklyAvg": 58,
            "lastNightAvg": avg,
            "lastNight5MinHigh": 92,
            "baseline": {"lowUpper": 49, "balancedLow": 53, "balancedUpper": 66, "markerValue": 0.4},
            "status": "BALANCED",
            "feedbackPhrase": "HRV_BALANCED_2",
            "createTimeStamp": f"{day}T06:01:00.0",
        }

    return {
        "userProfilePk": 123456,
        "hrvSummaries": [summary("2026-10-03", 55.0), summary("2026-10-05", 61.0), summary("2026-10-06", 900.0)],
    }


def rhr_daily() -> list[dict[str, Any]]:
    """``get_rhr_daily``: already reduced by the library to date and value."""
    return [
        {"calendarDate": "2026-10-03", "value": 49},
        {"calendarDate": "2026-10-05", "value": 47},
        {"calendarDate": "2026-10-06", "value": 52},
        {"calendarDate": "2026-10-07", "value": 3},     # not a resting heart rate
        {"calendarDate": "2026-09-30", "value": 50},    # outside the window asked for
    ]
