"""A structured bike workout, in the two shapes Garmin takes.

The page works the workout out (``assets/coach/workout.js``) and sends it here
as plain JSON::

    {"name": "...", "ftpW": 250 | null, "steps": [step | repeat, ...]}
    step    = {"type": "warmup|interval|recovery|cooldown", "durationS": 480,
               "pct": [91, 105], "watts": [228, 263] | null}
    repeat  = {"type": "repeat", "count": 6, "steps": [step, ...]}

This module checks that shape, then writes it out as

* the JSON workout Garmin Connect's workout library accepts, and
* a FIT workout file (``fit-tool``), for loading onto a device by hand.

Both are pure functions: no network, no files, no tokens. Anything the page
sends is checked here, because the bridge answers a web page and must not trust
what it is handed — see ``BadWorkout``.

A step with watts targets those watts. A step without them (the athlete has not
set an FTP) has no power target in the Connect JSON, which has nowhere to put a
percentage; its range is written into the step's description instead. FIT has a
native %FTP target, so the file keeps it.
"""

from __future__ import annotations

from typing import Any

from fit_tool.fit_file_builder import FitFileBuilder
from fit_tool.profile.messages.file_id_message import FileIdMessage
from fit_tool.profile.messages.workout_message import WorkoutMessage
from fit_tool.profile.messages.workout_step_message import WorkoutStepMessage
from fit_tool.profile.profile_type import (
    FileType,
    Intensity,
    Manufacturer,
    Sport,
    SubSport,
    WorkoutStepDuration,
    WorkoutStepTarget,
)

from garmin_bridge.errors import BadWorkout

MAX_NAME = 80
MAX_TOP_STEPS = 40
MAX_REPEAT_STEPS = 10
MAX_REPEATS = 50
MAX_STEP_S = 12 * 3600
MAX_TOTAL_S = 12 * 3600

LEAF_TYPES = ("warmup", "interval", "recovery", "cooldown")

# Garmin Connect's ids, as listed by /workout-service/workout/types and used by
# garminconnect.workout.
STEP_TYPE = {"warmup": 1, "cooldown": 2, "interval": 3, "recovery": 4, "repeat": 6}
SPORT_CYCLING = {"sportTypeId": 2, "sportTypeKey": "cycling", "displayOrder": 2}
END_TIME = {"conditionTypeId": 2, "conditionTypeKey": "time", "displayOrder": 2, "displayable": True}
END_ITERATIONS = {"conditionTypeId": 7, "conditionTypeKey": "iterations", "displayOrder": 7, "displayable": False}
TARGET_NONE = {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target", "displayOrder": 1}
TARGET_POWER = {"workoutTargetTypeId": 2, "workoutTargetTypeKey": "power.zone", "displayOrder": 2}

FIT_INTENSITY = {
    "warmup": Intensity.WARMUP,
    "interval": Intensity.ACTIVE,
    "recovery": Intensity.RECOVERY,
    "cooldown": Intensity.COOLDOWN,
}

PCT_RANGE = (10, 300)
WATTS_RANGE = (10, 3000)


# ---- validation --------------------------------------------------------------


def _range(raw: Any, bounds: tuple[int, int], what: str) -> list[int]:
    if (
        not isinstance(raw, list | tuple)
        or len(raw) != 2
        or not all(isinstance(v, int | float) and not isinstance(v, bool) for v in raw)
    ):
        raise BadWorkout(f"{what} must be two numbers.")
    low, high = round(raw[0]), round(raw[1])
    if not (bounds[0] <= low <= high <= bounds[1]):
        raise BadWorkout(f"{what} is outside {bounds[0]}–{bounds[1]}.")
    return [low, high]


def _leaf(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("type") not in LEAF_TYPES:
        raise BadWorkout("A step has an unknown type.")
    seconds = raw.get("durationS")
    if isinstance(seconds, bool) or not isinstance(seconds, int | float) or not (1 <= seconds <= MAX_STEP_S):
        raise BadWorkout("A step has no usable duration.")
    watts = raw.get("watts")
    return {
        "type": raw["type"],
        "durationS": round(seconds),
        "pct": _range(raw.get("pct"), PCT_RANGE, "A step's % of FTP"),
        "watts": None if watts is None else _range(watts, WATTS_RANGE, "A step's watts"),
    }


def _seconds(steps: list[dict[str, Any]]) -> int:
    return sum(s["count"] * _seconds(s["steps"]) if s["type"] == "repeat" else s["durationS"] for s in steps)


def validate_workout(raw: Any) -> dict[str, Any]:
    """The workout as sent, checked and reduced to the fields this module uses."""
    if not isinstance(raw, dict):
        raise BadWorkout("The workout must be an object.")
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise BadWorkout("The workout needs a name.")
    steps_raw = raw.get("steps")
    if not isinstance(steps_raw, list) or not (1 <= len(steps_raw) <= MAX_TOP_STEPS):
        raise BadWorkout(f"A workout has 1–{MAX_TOP_STEPS} steps.")

    steps: list[dict[str, Any]] = []
    for item in steps_raw:
        if isinstance(item, dict) and item.get("type") == "repeat":
            count, inner = item.get("count"), item.get("steps")
            if isinstance(count, bool) or not isinstance(count, int) or not (1 <= count <= MAX_REPEATS):
                raise BadWorkout(f"A repeat runs 1–{MAX_REPEATS} times.")
            if not isinstance(inner, list) or not (1 <= len(inner) <= MAX_REPEAT_STEPS):
                raise BadWorkout(f"A repeat holds 1–{MAX_REPEAT_STEPS} steps.")
            steps.append({"type": "repeat", "count": count, "steps": [_leaf(s) for s in inner]})
        else:
            steps.append(_leaf(item))

    if _seconds(steps) > MAX_TOTAL_S:
        raise BadWorkout("The workout is longer than 12 hours.")
    ftp = raw.get("ftpW")
    if ftp is not None and (isinstance(ftp, bool) or not isinstance(ftp, int | float) or not (50 <= ftp <= 600)):
        raise BadWorkout("FTP must be between 50 and 600 watts.")
    return {"name": name.strip()[:MAX_NAME], "ftpW": None if ftp is None else round(ftp), "steps": steps}


def total_seconds(workout: dict[str, Any]) -> int:
    return _seconds(workout["steps"])


# ---- Garmin Connect JSON -------------------------------------------------------


def _leaf_json(step: dict[str, Any], order: int) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": "ExecutableStepDTO",
        "stepOrder": order,
        "stepType": {"stepTypeId": STEP_TYPE[step["type"]], "stepTypeKey": step["type"]},
        "endCondition": dict(END_TIME),
        "endConditionValue": float(step["durationS"]),
    }
    if step["watts"] is not None:
        out["targetType"] = dict(TARGET_POWER)
        out["targetValueOne"], out["targetValueTwo"] = step["watts"]
    else:
        out["targetType"] = dict(TARGET_NONE)
        out["description"] = f"{step['pct'][0]}–{step['pct'][1]}% FTP"
    return out


def to_garmin_json(workout: Any) -> dict[str, Any]:
    """The JSON body for Connect's workout library (``upload_workout``)."""
    w = validate_workout(workout)
    order = 0

    def build(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
        nonlocal order
        out: list[dict[str, Any]] = []
        for step in steps:
            order += 1
            if step["type"] == "repeat":
                group: dict[str, Any] = {
                    "type": "RepeatGroupDTO",
                    "stepOrder": order,
                    "stepType": {"stepTypeId": STEP_TYPE["repeat"], "stepTypeKey": "repeat"},
                    "numberOfIterations": step["count"],
                    "endCondition": dict(END_ITERATIONS),
                    "endConditionValue": float(step["count"]),
                    "smartRepeat": False,
                }
                group["workoutSteps"] = build(step["steps"])
                out.append(group)
            else:
                out.append(_leaf_json(step, order))
        return out

    return {
        "workoutName": w["name"],
        "sportType": dict(SPORT_CYCLING),
        "estimatedDurationInSecs": total_seconds(w),
        "workoutSegments": [
            {"segmentOrder": 1, "sportType": dict(SPORT_CYCLING), "workoutSteps": build(w["steps"])}
        ],
    }


# ---- FIT -------------------------------------------------------------------------


def _fit_leaf(step: dict[str, Any], index: int) -> WorkoutStepMessage:
    msg = WorkoutStepMessage()
    msg.message_index = index
    msg.intensity = FIT_INTENSITY[step["type"]]
    msg.duration_type = WorkoutStepDuration.TIME
    msg.duration_time = float(step["durationS"])
    msg.target_type = WorkoutStepTarget.POWER
    msg.target_value = 0  # 0 = a custom range, given by the low/high below
    # FIT: power below 1000 is % of FTP; 1000 and over is watts + 1000.
    if step["watts"] is not None:
        msg.custom_target_power_low = step["watts"][0] + 1000
        msg.custom_target_power_high = step["watts"][1] + 1000
    else:
        msg.custom_target_power_low, msg.custom_target_power_high = step["pct"]
    return msg


def to_fit(workout: Any) -> bytes:
    """A FIT workout file (cycling) holding the workout."""
    w = validate_workout(workout)
    steps: list[WorkoutStepMessage] = []
    for step in w["steps"]:
        if step["type"] == "repeat":
            first = len(steps)
            steps.extend([_fit_leaf(inner, first + i) for i, inner in enumerate(step["steps"])])
            end = WorkoutStepMessage()
            end.message_index = len(steps)
            end.duration_type = WorkoutStepDuration.REPEAT_UNTIL_STEPS_CMPLT
            end.duration_value = first  # the step to go back to
            end.target_type = WorkoutStepTarget.OPEN
            end.target_value = step["count"]  # how many times in all
            steps.append(end)
        else:
            steps.append(_fit_leaf(step, len(steps)))

    file_id = FileIdMessage()
    file_id.type = FileType.WORKOUT
    file_id.manufacturer = Manufacturer.DEVELOPMENT.value
    file_id.product = 0
    file_id.serial_number = 1

    head = WorkoutMessage()
    head.sport = Sport.CYCLING
    head.sub_sport = SubSport.INDOOR_CYCLING
    head.workout_name = w["name"]
    head.num_valid_steps = len(steps)

    builder = FitFileBuilder(auto_define=True)
    builder.add(file_id)
    builder.add(head)
    builder.add_all(steps)
    return builder.build().to_bytes()
