"""Coach runs from the calendar, against a fake — Garmin is never called."""

import datetime as dt
import io
import json

import pytest

from garmin_bridge.cli import main
from garmin_bridge.errors import RateLimited
from garmin_bridge.scheduled import fetch_scheduled_runs
from garmin_bridge.store import Store
from tests.fakes import FakeGarmin


class CalendarFake(FakeGarmin):
    items = [
        {"id": 1, "itemType": "workout", "sportTypeKey": "running", "date": "2026-11-05", "title": "Magic Mile"},
        {"id": 2, "itemType": "workout", "sportTypeKey": "running", "date": "2026-12-02", "title": "Next month"},
        {"id": 3, "itemType": "workout", "sportTypeKey": "cycling", "date": "2026-11-06", "title": "Ride"},
        {"id": 4, "itemType": "activity", "sportTypeKey": None, "date": "2026-11-05", "title": "Done"},
        {"id": 5, "itemType": "workout", "sportTypeKey": "running", "date": "2026-10-01", "title": "Past"},
    ]

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.asked = []

    def get_scheduled_workouts(self, year, month):
        self.asked.append((year, month))
        return {"calendarItems": [i for i in self.items if i["date"].startswith(f"{year}-{month:02d}")]}

    def get_scheduled_workout_by_id(self, sid):
        return {"workout": {"workoutId": 100 + sid}}

    def get_workout_by_id(self, wid):
        return {"workoutId": wid, "workoutName": f"W{wid}"}


def test_only_runs_in_range_with_detail():
    api = CalendarFake()
    runs = fetch_scheduled_runs(api, dt.date(2026, 11, 2), dt.date(2026, 12, 6))
    assert [r["scheduleId"] for r in runs] == [1, 2]
    assert runs[0]["workout"]["workoutName"] == "W101"
    assert api.asked == [(2026, 11), (2026, 12)]


def test_nothing_published_is_an_empty_list_not_an_error():
    assert fetch_scheduled_runs(CalendarFake(), dt.date(2027, 1, 4), dt.date(2027, 1, 10)) == []
    assert fetch_scheduled_runs(CalendarFake(), dt.date(2026, 11, 10), dt.date(2026, 11, 2)) == []


def test_garmin_errors_are_translated():
    class Limited(CalendarFake):
        def get_scheduled_workouts(self, year, month):
            from garminconnect import GarminConnectTooManyRequestsError
            raise GarminConnectTooManyRequestsError("429")

    with pytest.raises(RateLimited):
        fetch_scheduled_runs(Limited(), dt.date(2026, 11, 2), dt.date(2026, 11, 8))


def test_cli_prints_json(tmp_path):
    store = Store(tmp_path)
    store.write_tokens(json.dumps(FakeGarmin.VALID_TOKENS))
    out = io.StringIO()
    code = main(["scheduled", "--from", "2026-11-02", "--to", "2026-11-08"], store=store,
                api_factory=lambda **kw: CalendarFake(**kw), out=out)
    body = json.loads(out.getvalue())
    assert code == 0 and [r["scheduleId"] for r in body["runs"]] == [1]


def test_cli_rejects_bad_dates(tmp_path):
    out = io.StringIO()
    assert main(["scheduled", "--from", "x", "--to", "y"], store=Store(tmp_path), out=out) == 2
