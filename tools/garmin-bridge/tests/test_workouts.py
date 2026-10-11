"""Workout JSON and FIT: pure conversion, no network."""

import copy

import pytest
from fit_tool.fit_file import FitFile

from garmin_bridge.errors import BadWorkout
from garmin_bridge.workouts import to_fit, to_garmin_json, total_seconds, validate_workout

WITH_WATTS = {
    "name": "Yootri Threshold intervals 1:30",
    "ftpW": 250,
    "steps": [
        {"type": "warmup", "durationS": 840, "pct": [50, 65], "watts": [125, 163]},
        {
            "type": "repeat",
            "count": 6,
            "steps": [
                {"type": "interval", "durationS": 480, "pct": [91, 105], "watts": [228, 263]},
                {"type": "recovery", "durationS": 180, "pct": [50, 60], "watts": [125, 150]},
            ],
        },
        {"type": "cooldown", "durationS": 540, "pct": [45, 55], "watts": [113, 138]},
    ],
}
NO_FTP = copy.deepcopy(WITH_WATTS)
NO_FTP["ftpW"] = None
for _s in NO_FTP["steps"]:
    for _leaf in _s.get("steps", [_s]):
        _leaf["watts"] = None


def fit_steps(data: bytes):
    messages = [r.message for r in FitFile.from_bytes(data).records]
    return [m for m in messages if getattr(m, "NAME", "") == "workout_step"]


def test_the_connect_json_has_warmup_repeat_and_cooldown_in_order():
    out = to_garmin_json(WITH_WATTS)
    assert out["sportType"]["sportTypeKey"] == "cycling"
    assert out["estimatedDurationInSecs"] == 840 + 6 * 660 + 540
    steps = out["workoutSegments"][0]["workoutSteps"]
    assert [s["stepType"]["stepTypeKey"] for s in steps] == ["warmup", "repeat", "cooldown"]
    assert [s["stepOrder"] for s in steps] == [1, 2, 5]
    group = steps[1]
    assert group["type"] == "RepeatGroupDTO" and group["numberOfIterations"] == 6
    assert [s["stepType"]["stepTypeKey"] for s in group["workoutSteps"]] == ["interval", "recovery"]


def test_watts_become_a_power_target():
    work = to_garmin_json(WITH_WATTS)["workoutSegments"][0]["workoutSteps"][1]["workoutSteps"][0]
    assert work["targetType"]["workoutTargetTypeKey"] == "power.zone"
    assert (work["targetValueOne"], work["targetValueTwo"]) == (228, 263)
    assert work["endCondition"]["conditionTypeKey"] == "time" and work["endConditionValue"] == 480.0


def test_without_an_ftp_the_json_has_no_target_and_names_the_percentage():
    step = to_garmin_json(NO_FTP)["workoutSegments"][0]["workoutSteps"][0]
    assert step["targetType"]["workoutTargetTypeKey"] == "no.target"
    assert "targetValueOne" not in step
    assert step["description"] == "50–65% FTP"


def test_the_fit_file_round_trips():
    steps = fit_steps(to_fit(WITH_WATTS))
    assert len(steps) == 5  # warmup, interval, recovery, repeat, cooldown
    assert [s.message_index for s in steps] == [0, 1, 2, 3, 4]
    warm, work = steps[0], steps[1]
    assert warm.duration_time == 840
    # watts ride above 1000 in FIT's power fields
    assert (work.custom_target_power_low, work.custom_target_power_high) == (1228, 1263)
    repeat = steps[3]
    assert repeat.duration_value == 1  # back to the interval
    assert repeat.target_value == 6


def test_the_fit_file_keeps_percent_ftp_when_there_are_no_watts():
    work = fit_steps(to_fit(NO_FTP))[1]
    assert (work.custom_target_power_low, work.custom_target_power_high) == (91, 105)


def test_the_fit_workout_header():
    messages = [r.message for r in FitFile.from_bytes(to_fit(WITH_WATTS)).records]
    head = next(m for m in messages if getattr(m, "NAME", "") == "workout")
    assert head.workout_name == "Yootri Threshold intervals 1:30"
    assert head.num_valid_steps == 5


def test_total_seconds_expands_repeats():
    assert total_seconds(validate_workout(WITH_WATTS)) == 840 + 6 * 660 + 540


def bad(**change):
    out = copy.deepcopy(WITH_WATTS)
    out.update(change)
    return out


@pytest.mark.parametrize(
    "workout",
    [
        None,
        [],
        bad(name=""),
        bad(name=5),
        bad(steps=[]),
        bad(steps=[{"type": "sprint", "durationS": 10, "pct": [50, 60], "watts": None}]),
        bad(steps=[{"type": "interval", "durationS": 0, "pct": [50, 60], "watts": None}]),
        bad(steps=[{"type": "interval", "durationS": 60, "pct": [90, 50], "watts": None}]),
        bad(steps=[{"type": "interval", "durationS": 60, "pct": [50, 60], "watts": [5000, 6000]}]),
        bad(steps=[{"type": "repeat", "count": 0, "steps": [WITH_WATTS["steps"][0]]}]),
        bad(steps=[{"type": "repeat", "count": 2, "steps": []}]),
        bad(steps=[{"type": "repeat", "count": 2, "steps": [{"type": "repeat", "count": 2, "steps": []}]}]),
        bad(steps=[{"type": "interval", "durationS": 12 * 3600, "pct": [50, 60], "watts": None}] * 2),
        bad(ftpW=9000),
        bad(ftpW=True),
    ],
)
def test_a_workout_that_is_not_one_is_refused(workout):
    with pytest.raises(BadWorkout):
        to_garmin_json(workout)
    with pytest.raises(BadWorkout):
        to_fit(workout)
