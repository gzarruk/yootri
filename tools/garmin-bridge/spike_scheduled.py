"""Phase 0a spike: can Garmin Coach sessions be read? Read-only, run locally.

    cd tools/garmin-bridge && uv run python spike_scheduled.py [YYYY-MM]

Uses the session `make garmin-login` already saved. Prints the SHAPE of what
Garmin returns (keys, types, counts) and, per calendar item, only sport, date and
title — no ids, no tokens. Paste the output back; nothing is written to disk.
"""
from __future__ import annotations

import datetime as dt
import json
import sys

from garmin_bridge.auth import open_api
from garmin_bridge.store import Store


def shape(x, depth=0):
    if isinstance(x, dict):
        return {k: shape(v, depth + 1) if depth < 3 else type(v).__name__ for k, v in list(x.items())[:40]}
    if isinstance(x, list):
        return [f"list[{len(x)}]", shape(x[0], depth + 1) if x else None]
    return type(x).__name__


def attempt(label, fn):
    print(f"\n=== {label}")
    try:
        out = fn()
    except Exception as exc:  # noqa: BLE001 - this is a probe
        print("ERROR:", type(exc).__name__, str(exc)[:200])
        return None
    print(json.dumps(shape(out), indent=1, default=str)[:3000])
    return out


def print_steps(detail, indent="  "):
    """Print only step types and conditions, no ids."""
    if not isinstance(detail, dict):
        return
    for seg in detail.get("workoutSegments", []) or []:
        for st in seg.get("workoutSteps", []) or []:
            walk(st, indent)


def walk(st, indent):
    key = (st.get("stepType") or {}).get("stepTypeKey")
    end = (st.get("endCondition") or {}).get("conditionTypeKey")
    tgt = (st.get("targetType") or {}).get("workoutTargetTypeKey")
    print(f"{indent}{key} | end={end} {st.get('endConditionValue')} | target={tgt} {st.get('targetValueOne')}-{st.get('targetValueTwo')} | iterations={st.get('numberOfIterations')}")
    for child in st.get("workoutSteps", []) or []:
        walk(child, indent + "  ")


def main() -> None:
    api = open_api(Store())
    today = dt.date.today()
    ym = sys.argv[1] if len(sys.argv) > 1 else today.strftime("%Y-%m")
    year, month = map(int, ym.split("-"))
    cal = attempt(f"get_scheduled_workouts({year},{month})", lambda: api.get_scheduled_workouts(year, month))
    items = (cal or {}).get("calendarItems", []) if isinstance(cal, dict) else []
    print(f"\ncalendar items: {len(items)}")
    for it in items:
        print(" ", it.get("itemType"), it.get("date"), "|", it.get("sportTypeKey") or it.get("sportType"), "|", (it.get("title") or "")[:40])
    upcoming = [it for it in items if it.get("itemType") == "workout"
                and (it.get("sportTypeKey") or "") == "running" and (it.get("date") or "") >= today.isoformat()][:3]
    for it in upcoming:
        print(f"\n##### {it.get('date')} | {it.get('title')} (trainingPlanId present: {it.get('trainingPlanId') is not None})")
        sched = attempt("get_scheduled_workout_by_id", lambda: api.get_scheduled_workout_by_id(it["id"]))
        wid = None
        if isinstance(sched, dict):
            w = sched.get("workout") or {}
            wid = sched.get("workoutId") or w.get("workoutId")
            print("  workoutId found:", wid is not None, "| top-level keys:", sorted(sched)[:30])
        if wid:
            detail = attempt("get_workout_by_id", lambda: api.get_workout_by_id(wid))
            print_steps(detail)
        elif isinstance(sched, dict):
            print_steps(sched)
    plans = attempt("get_training_plans()", api.get_training_plans)
    for p in (plans or {}).get("trainingPlanList", []) if isinstance(plans, dict) else []:
        print("  plan:", p.get("trainingPlanCategory"), "|", p.get("name"), "|", p.get("trainingStatus") or p.get("status"))
    print("\nNext: for a Coach plan id, rerun with get_adaptive_training_plan_by_id(<id>) — tell me which plan "
          "types appear above and I will extend this.")


if __name__ == "__main__":
    main()
