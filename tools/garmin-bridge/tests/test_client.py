from datetime import date

import pytest
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

from garmin_bridge.client import GarminClient, fetch_activities
from garmin_bridge.errors import AuthRequired, RateLimited, Unavailable
from tests import payloads
from tests.fakes import ALLOWED_CALLS, FakeGarmin


class Sleeper:
    def __init__(self):
        self.slept = []

    def __call__(self, seconds):
        self.slept.append(seconds)


class Bucket:
    def acquire(self):
        return 0.0


def client_for(api, **kw):
    kw.setdefault("sleep", Sleeper())
    kw.setdefault("rng", lambda: 1.0)
    return GarminClient(api, bucket=Bucket(), **kw)


def test_ranges_are_fetched_in_thirty_day_chunks_oldest_first():
    api = FakeGarmin(responses={"get_activities_by_date": []})
    client_for(api).list_activities(date(2026, 1, 1), date(2026, 3, 15))
    windows = [(args[0], args[1], kw["sortorder"]) for name, args, kw in api.calls]
    assert windows == [
        ("2026-01-01", "2026-01-30", "asc"),
        ("2026-01-31", "2026-03-01", "asc"),
        ("2026-03-02", "2026-03-15", "asc"),
    ]


def test_a_rate_limit_is_reported_at_once_not_retried():
    # A person pressed a button. Retrying a 429 for minutes only extends
    # Garmin's limit and outlasts the page's timeout, which would then report
    # "the bridge did not answer" instead of "wait".
    def limited(*_a, **_k):
        raise GarminConnectTooManyRequestsError("429")

    sleeper = Sleeper()
    api = FakeGarmin(responses={"get_activities_by_date": limited})
    with pytest.raises(RateLimited):
        client_for(api, sleep=sleeper).list_activities(date(2026, 9, 1), date(2026, 9, 2))
    assert len(api.calls) == 1
    assert sleeper.slept == []


def test_an_outage_is_retried_after_a_backoff():
    attempts = []

    def flaky(*_a, **_k):
        attempts.append(1)
        if len(attempts) == 1:
            raise GarminConnectConnectionError("API Error 503")
        return [payloads.run()]

    sleeper = Sleeper()
    api = FakeGarmin(responses={"get_activities_by_date": flaky})
    result = client_for(api, sleep=sleeper).list_activities(date(2026, 9, 1), date(2026, 9, 2))
    assert [r["activityId"] for r in result] == [1001]
    assert sleeper.slept == [2.0]


def test_an_auth_failure_is_not_retried():
    def denied(*_a, **_k):
        raise GarminConnectAuthenticationError("expired")

    api = FakeGarmin(responses={"get_activities_by_date": denied})
    with pytest.raises(AuthRequired):
        client_for(api).list_activities(date(2026, 9, 1), date(2026, 9, 2))
    assert len(api.calls) == 1


def test_retries_run_out():
    def down(*_a, **_k):
        raise GarminConnectConnectionError("API Error 503")

    api = FakeGarmin(responses={"get_activities_by_date": down})
    with pytest.raises(Unavailable):
        client_for(api, retries=2).list_activities(date(2026, 9, 1), date(2026, 9, 2))
    assert len(api.calls) == 3


def test_refreshed_tokens_are_handed_back_for_saving():
    saved = []
    api = FakeGarmin(responses={"get_activities_by_date": []}, refresh_on_call=True)
    api.client.tokens = dict(FakeGarmin.VALID_TOKENS)
    client_for(api, on_tokens_changed=saved.append).list_activities(date(2026, 9, 1), date(2026, 9, 1))
    assert len(saved) == 1
    assert '"access-call-1"' in saved[0]


def test_unchanged_tokens_are_not_saved_again():
    saved = []
    api = FakeGarmin(responses={"get_activities_by_date": []})
    api.client.tokens = dict(FakeGarmin.VALID_TOKENS)
    client_for(api, on_tokens_changed=saved.append).list_activities(date(2026, 9, 1), date(2026, 9, 1))
    assert saved == []


def test_fetch_maps_and_splits_off_nothing_itself():
    api = FakeGarmin(responses={"get_activities_by_date": [payloads.run(), payloads.bike()]})
    activities, skipped = fetch_activities(client_for(api), date(2026, 9, 1), date(2026, 9, 2))
    assert [a["id"] for a in activities] == ["1001", "2001"]
    assert activities[0]["hr"] == {"avg": 173, "max": 187}
    assert skipped == []


def test_multisport_legs_missing_from_the_list_are_fetched_one_by_one():
    parent, *legs = payloads.triathlon()
    by_id = {str(leg["activityId"]): {k: v for k, v in leg.items() if k != "parentId"} for leg in legs}
    api = FakeGarmin(responses={
        "get_activities_by_date": [parent],
        "get_activity": lambda aid: by_id[str(aid)],
    })
    activities, _ = fetch_activities(client_for(api), date(2026, 9, 6), date(2026, 9, 6))
    assert [a["id"] for a in activities] == ["5001", "5003", "5005"]
    # A detail payload may not name its parent; the container's id is kept.
    assert {a["parentId"] for a in activities} == {"5000"}


def test_legs_already_in_the_list_are_not_fetched_again():
    api = FakeGarmin(responses={"get_activities_by_date": payloads.triathlon()})
    fetch_activities(client_for(api), date(2026, 9, 6), date(2026, 9, 6))
    assert "get_activity" not in api.called()


def test_a_leg_that_cannot_be_fetched_is_reported_not_fatal():
    parent = payloads.triathlon()[0]

    def missing(_aid):
        raise GarminConnectConnectionError("API Error 500")

    api = FakeGarmin(responses={"get_activities_by_date": [parent], "get_activity": missing})
    activities, skipped = fetch_activities(client_for(api, retries=0), date(2026, 9, 6), date(2026, 9, 6))
    assert activities == []
    assert {s["reason"] for s in skipped} == {"leg-unavailable"}


def test_leg_fetches_are_bounded():
    parent = dict(payloads.triathlon()[0], childIds=list(range(100, 200)))
    api = FakeGarmin(responses={"get_activities_by_date": [parent], "get_activity": lambda aid: {}})
    fetch_activities(client_for(api), date(2026, 9, 6), date(2026, 9, 6), max_legs=5)
    assert sum(1 for name, _, _ in api.calls if name == "get_activity") == 5


def test_the_bridge_asks_garmin_for_activities_and_nothing_else():
    parent = payloads.triathlon()[0]
    api = FakeGarmin(responses={
        "get_activities_by_date": [parent, payloads.run()],
        "get_activity": lambda aid: {},
    })
    fetch_activities(client_for(api), date(2026, 9, 1), date(2026, 9, 6))
    assert api.called() <= ALLOWED_CALLS


def test_a_rate_limit_while_fetching_legs_stops_the_fetch():
    parent = payloads.triathlon()[0]

    def limited(_aid):
        raise GarminConnectTooManyRequestsError("429")

    api = FakeGarmin(responses={"get_activities_by_date": [parent], "get_activity": limited})
    with pytest.raises(RateLimited):
        fetch_activities(client_for(api), date(2026, 9, 6), date(2026, 9, 6))
    assert sum(1 for name, _, _ in api.calls if name == "get_activity") == 1
