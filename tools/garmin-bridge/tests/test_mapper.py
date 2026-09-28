import json
from pathlib import Path

import pytest

from garmin_bridge.mapper import WIRE_KEYS, Skip, map_activities, map_activity
from tests import payloads

GOLDEN = Path(__file__).parent / "golden" / "activities-v1.json"

# Fields the list endpoint sends that must never cross the bridge. Some are
# identifying (owner, device, GPS); the rest are Garmin's own scores, which the
# planner does not use.
NEVER = {
    "calories",
    "deviceId",
    "startLatitude",
    "startLongitude",
    "hasPolyline",
    "ownerFullName",
    "vO2MaxValue",
    "aerobicTrainingEffect",
    "activityTrainingLoad",
    "trainingEffectLabel",
    "averageRunningCadenceInStepsPerMinute",
    "elevationGain",
    "averageSpeed",
    "maxPower",
    "strokes",
    "poolLength",
}


def test_run_maps_to_the_wire_shape():
    a = map_activity(payloads.run())
    assert a == {
        "id": "1001",
        "date": "2026-09-01",
        "time": "07:30",
        "sport": "running",
        "disc": "Run",
        "name": "Morning Run",
        "durationS": 3600,
        "movingS": 3550,
        "elapsedS": 3700,
        "distanceM": 12000,
        "avgPowerW": None,
        "normPowerW": None,
        "rpe": 6,
        "race": False,
        "parentId": None,
        "hr": {"avg": 173, "max": 187},
    }


def test_every_key_is_on_the_allowlist():
    for raw in payloads.everything():
        try:
            a = map_activity(raw)
        except Skip:
            continue
        assert set(a) == WIRE_KEYS


def test_nothing_outside_the_allowlist_survives():
    a = map_activity(payloads.run())
    text = json.dumps(a)
    for key in NEVER:
        assert key not in text
    # Values too, not just keys: the owner's name, the device, the GPS fix.
    for value in ("Some Athlete", "3456789", "59.91", "10.75", "TEMPO", "820"):
        assert value not in text


def test_bike_keeps_power():
    a = map_activity(payloads.bike())
    assert (a["disc"], a["avgPowerW"], a["normPowerW"]) == ("Bike", 190, 205)
    assert a["hr"] == {"avg": 135, "max": 160}


def test_a_zero_heart_rate_is_absent_not_zero():
    a = map_activity(payloads.swim())
    assert a["hr"] is None


def test_rpe_on_the_hundred_scale_is_brought_to_ten():
    assert map_activity(payloads.run(directWorkoutRpe=85))["rpe"] == 8.5
    assert map_activity(payloads.strength())["rpe"] == 7


def test_rpe_outside_one_to_ten_is_dropped():
    assert map_activity(payloads.run(directWorkoutRpe=0))["rpe"] is None
    assert map_activity(payloads.run(directWorkoutRpe=250))["rpe"] is None


def test_strength_without_distance_is_kept():
    a = map_activity(payloads.strength())
    assert (a["disc"], a["distanceM"], a["durationS"]) == ("Strength", None, 2700)


def test_race_flag():
    assert map_activity(payloads.run(eventType={"typeKey": "race"}))["race"] is True


def test_names_are_trimmed_and_bounded():
    a = map_activity(payloads.run(activityName="  x\u0000" + "y" * 300 + "  "))
    assert a["name"].startswith("xy")
    assert len(a["name"]) == 80
    assert "\u0000" not in a["name"]


def test_missing_id_is_skipped_with_a_reason():
    raw = payloads.run()
    del raw["activityId"]
    with pytest.raises(Skip) as info:
        map_activity(raw)
    assert info.value.reason == "no-id"


def test_missing_start_time_is_skipped_with_a_reason():
    raw = payloads.run(startTimeLocal=None, startTimeGMT=None)
    with pytest.raises(Skip) as info:
        map_activity(raw)
    assert info.value.reason == "no-start-time"


def test_local_time_wins_over_gmt():
    a = map_activity(payloads.run(startTimeLocal="2026-09-01 00:30:00",
                                  startTimeGMT="2026-08-31 22:30:00"))
    assert (a["date"], a["time"]) == ("2026-09-01", "00:30")


def test_gmt_is_the_fallback_when_local_is_missing():
    a = map_activity(payloads.run(startTimeLocal=None))
    assert (a["date"], a["time"]) == ("2026-09-01", "05:30")


def test_detail_payloads_are_flattened():
    detail = {
        "activityId": 9,
        "activityName": "Detail",
        "activityTypeDTO": {"typeKey": "road_biking"},
        "summaryDTO": {
            "startTimeLocal": "2026-09-20T12:00:00.0",
            "startTimeGMT": "2026-09-20T10:00:00.0",
            "duration": 3600.0,
            "averagePower": 200.0,
            "normalizedPower": 210.0,
            "averageHR": 140.0,
        },
    }
    a = map_activity(detail)
    assert (a["disc"], a["date"], a["avgPowerW"], a["normPowerW"]) == ("Bike", "2026-09-20", 200, 210)
    assert a["hr"] == {"avg": 140, "max": None}


def test_multisport_keeps_the_legs_and_drops_container_and_transitions():
    activities, skipped = map_activities(payloads.triathlon())
    assert [a["id"] for a in activities] == ["5001", "5003", "5005"]
    assert [a["disc"] for a in activities] == ["Swim", "Bike", "Run"]
    assert all(a["parentId"] == "5000" and a["race"] for a in activities)
    assert skipped == []


def test_one_bad_item_does_not_sink_the_rest():
    bad = payloads.run(activity_id=7)
    del bad["startTimeGMT"]
    del bad["startTimeLocal"]
    activities, skipped = map_activities([payloads.bike(), bad, "not a dict", payloads.swim()])
    assert [a["id"] for a in activities] == ["2001", "3001"]
    assert skipped == [{"id": "7", "reason": "no-start-time"}, {"id": None, "reason": "not-an-object"}]


def test_duplicates_are_removed_and_order_is_by_start():
    activities, _ = map_activities([payloads.bike(), payloads.run(), payloads.bike()])
    assert [a["id"] for a in activities] == ["1001", "2001"]


def test_output_matches_the_golden_contract():
    # The same file is read by tests/synced.test.js on the JavaScript side, so
    # the two halves of the bridge cannot drift apart silently.
    activities, skipped = map_activities(payloads.everything())
    golden = json.loads(GOLDEN.read_text())
    assert {"activities": activities, "skipped": skipped} == golden
