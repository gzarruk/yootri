import json
from datetime import date
from pathlib import Path

import pytest
from garminconnect import GarminConnectTooManyRequestsError
from garminconnect.exceptions import GarminConnectNotFoundError

from garmin_bridge.client import OVERNIGHT_CHUNK_DAYS, GarminClient, fetch_overnight
from garmin_bridge.errors import RateLimited
from garmin_bridge.overnight import NIGHT_KEYS, map_overnight
from tests import payloads
from tests.fakes import ALLOWED_CALLS, OVERNIGHT_CALLS, FakeGarmin

GOLDEN = Path(__file__).parent / "golden" / "overnight-v1.json"
SINCE, UNTIL = date(2026, 10, 1), date(2026, 10, 7)


class Bucket:
    def acquire(self):
        return 0.0


def client_for(api):
    return GarminClient(api, bucket=Bucket(), sleep=lambda _s: None, rng=lambda: 1.0)


def garmin(**overrides):
    responses = {
        "get_sleep_daily": payloads.sleep_daily(),
        "get_hrv_data_range": payloads.hrv_range(),
        "get_rhr_daily": payloads.rhr_daily(),
    }
    responses.update(overrides)
    return FakeGarmin(responses=responses)


def mapped():
    return map_overnight(payloads.sleep_daily(), [payloads.hrv_range()], payloads.rhr_daily(),
                         since=SINCE, until=UNTIL)


# ---- the mapper --------------------------------------------------------------


def test_one_row_per_night_with_three_numbers_at_most():
    nights = mapped()
    assert [n["date"] for n in nights] == ["2026-10-03", "2026-10-05", "2026-10-06"]
    assert nights[1] == {"date": "2026-10-05", "sleepMin": 437, "hrvMs": 61, "restingHr": 47}
    for night in nights:
        assert set(night) <= NIGHT_KEYS


def test_garmins_own_readings_never_leave_the_bridge():
    # Its scores, statuses, baselines and feedback are Garmin's interpretation,
    # and the stages, SpO2 and respiration are more than anything here uses.
    text = json.dumps(mapped())
    for word in ("score", "status", "baseline", "feedback", "BALANCED", "spO2", "respiration",
                 "remTime", "deepTime", "bodyBattery", "weeklyAvg", "5MinHigh", "skinTemp"):
        assert word.lower() not in text.lower(), word


def test_resting_heart_rate_comes_from_its_own_series_not_the_sleep_row():
    # The sleep row carries a restingHeartRate of 99; the series says 49.
    assert mapped()[0]["restingHr"] == 49


def test_implausible_values_are_dropped_not_clamped():
    nights = {n["date"]: n for n in mapped()}
    # 15 minutes asleep and an HRV of 900 ms are not readings; 52 bpm is.
    assert nights["2026-10-06"] == {"date": "2026-10-06", "restingHr": 52}
    # 3 bpm is the only figure for 7 October, so there is no row for it at all.
    assert "2026-10-07" not in nights


def test_a_night_with_nothing_readable_has_no_row():
    assert "2026-10-04" not in {n["date"] for n in mapped()}


def test_only_the_window_asked_for_comes_back():
    assert all("2026-10-01" <= n["date"] <= "2026-10-07" for n in mapped())


@pytest.mark.parametrize(
    "rows",
    [None, "nope", [None, 7, {"calendarDate": "not a date", "value": 50}], [{"value": 50}]],
)
def test_odd_payloads_give_nothing_rather_than_failing(rows):
    assert map_overnight(rows, [rows], rows, since=SINCE, until=UNTIL) == []


def test_the_per_night_sleep_name_is_read_too():
    # The per-night DTO calls the same figure sleepTimeSeconds.
    rows = [{"calendarDate": "2026-10-02", "sleepTimeSeconds": 27000}]
    assert map_overnight(rows, [], [], since=SINCE, until=UNTIL) == [{"date": "2026-10-02", "sleepMin": 450}]


def test_output_matches_the_golden_contract():
    # The JavaScript tests read the same file: change it deliberately, never to make this pass.
    assert mapped() == json.loads(GOLDEN.read_text())


# ---- fetching ----------------------------------------------------------------


def test_three_range_calls_and_nothing_else():
    api = garmin()
    nights, missing = fetch_overnight(client_for(api), SINCE, UNTIL)
    assert missing == []
    assert len(nights) == 3
    assert api.called() == OVERNIGHT_CALLS
    # Never the per-night endpoints, which carry minute-by-minute series.
    assert not api.called() & {"get_sleep_data", "get_hrv_data", "get_heart_rates"}


def test_the_activity_calls_and_the_overnight_calls_do_not_overlap():
    assert not ALLOWED_CALLS & OVERNIGHT_CALLS


def test_a_long_window_is_asked_for_in_chunks():
    api = garmin(get_sleep_daily=[], get_hrv_data_range={}, get_rhr_daily=[])
    fetch_overnight(client_for(api), date(2026, 8, 1), date(2026, 10, 7))
    sleeps = [args for name, args, _ in api.calls if name == "get_sleep_daily"]
    assert sleeps[0] == ("2026-08-01", "2026-08-28")
    assert sleeps[-1][1] == "2026-10-07"
    for start, end in sleeps:
        assert (date.fromisoformat(end) - date.fromisoformat(start)).days < OVERNIGHT_CHUNK_DAYS
    assert {name for name, _, _ in api.calls} == OVERNIGHT_CALLS


def test_a_figure_garmin_does_not_have_is_reported_not_fatal():
    # A watch that does not record HRV: Garmin answers 404 for it.
    def no_hrv(*_a):
        raise GarminConnectNotFoundError("404")

    nights, missing = fetch_overnight(client_for(garmin(get_hrv_data_range=no_hrv)), SINCE, UNTIL)
    assert missing == ["hrv"]
    assert all("hrvMs" not in n for n in nights)
    assert any("sleepMin" in n for n in nights)


def test_a_rate_limit_stops_the_fetch():
    def limited(*_a):
        raise GarminConnectTooManyRequestsError("429")

    with pytest.raises(RateLimited):
        fetch_overnight(client_for(garmin(get_sleep_daily=limited)), SINCE, UNTIL)
