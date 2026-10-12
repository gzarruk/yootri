import http.client
import json
import threading
from datetime import date

import pytest

from garmin_bridge import API_VERSION
from garmin_bridge.errors import AuthRequired, RateLimited, Unavailable
from garmin_bridge.server import MAX_RANGE_DAYS, Config, make_server, parse_range
from garmin_bridge.store import Store
from tests import payloads

TOKEN = "pairing-token-for-tests-0123456789"
ORIGIN = "http://localhost:8000"


class StubClient:
    """What the server asks for activities. Behaviour set per test."""

    def __init__(self, result=None, error=None):
        self.result = result if result is not None else [payloads.run()]
        self.error = error
        self.windows = []

    def list_activities(self, since, until):
        self.windows.append((since, until))
        if self.error is not None:
            raise self.error
        return self.result

    def get_activity(self, activity_id):  # pragma: no cover - not used here
        return {}


@pytest.fixture
def bridge(tmp_path):
    state = {"clients": [], "make": lambda: StubClient()}

    def provider():
        client = state["make"]()
        state["clients"].append(client)
        return client

    cfg = Config(
        token=TOKEN,
        origins=(ORIGIN, "https://yootri.example"),
        store=Store(tmp_path),
        client_provider=provider,
        today=lambda: date(2026, 9, 27),
    )
    server = make_server(cfg, port=0)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    state["server"] = server
    state["port"] = server.server_address[1]
    state["store"] = cfg.store
    yield state
    server.shutdown()
    server.server_close()


def request(bridge, method, path, *, token=TOKEN, origin=None, host=None, extra=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", bridge["port"], timeout=5)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if origin is not None:
        headers["Origin"] = origin
    if host is not None:
        headers["Host"] = host
    headers.update(extra or {})
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    payload = json.loads(raw) if raw else None
    return resp.status, {k.lower(): v for k, v in resp.getheaders()}, payload


def test_listens_on_loopback_only(bridge):
    assert bridge["server"].server_address[0] == "127.0.0.1"


def test_status(bridge):
    status, headers, body = request(bridge, "GET", "/v1/status")
    assert status == 200
    assert body["ok"] is True and body["api"] == API_VERSION
    assert body["connected"] is False
    assert headers["cache-control"] == "no-store"
    assert headers["x-content-type-options"] == "nosniff"


def test_status_reports_a_saved_session_without_calling_garmin(bridge):
    bridge["store"].write_tokens("{}")
    _, _, body = request(bridge, "GET", "/v1/status")
    assert body["connected"] is True
    assert body["tokensSavedAt"]
    assert bridge["clients"] == []


@pytest.mark.parametrize("token", [None, "wrong", TOKEN + "x"])
def test_the_pairing_token_is_required(bridge, token):
    status, _, body = request(bridge, "GET", "/v1/status", token=token)
    assert status == 401
    assert body["error"]["code"] == "unauthorized"


def test_a_foreign_host_header_is_refused_before_anything_else(bridge):
    # DNS rebinding: evil.test resolving to 127.0.0.1 still sends Host: evil.test.
    status, _, body = request(bridge, "GET", "/v1/status", token=None,
                              host=f"evil.test:{bridge['port']}")
    assert status == 421
    assert body["error"]["code"] == "bad_host"


def test_localhost_is_an_accepted_host(bridge):
    status, _, _ = request(bridge, "GET", "/v1/status", host=f"localhost:{bridge['port']}")
    assert status == 200


def test_an_unlisted_origin_is_refused_and_gets_no_cors_headers(bridge):
    status, headers, body = request(bridge, "GET", "/v1/status", origin="https://evil.test")
    assert status == 403
    assert body["error"]["code"] == "forbidden_origin"
    assert "access-control-allow-origin" not in headers


def test_a_listed_origin_gets_its_own_origin_echoed(bridge):
    status, headers, _ = request(bridge, "GET", "/v1/status", origin=ORIGIN)
    assert status == 200
    assert headers["access-control-allow-origin"] == ORIGIN
    assert "origin" in headers["vary"].lower()
    assert "access-control-allow-credentials" not in headers


def test_errors_to_a_listed_origin_stay_readable(bridge):
    status, headers, _ = request(bridge, "GET", "/v1/status", origin=ORIGIN, token="wrong")
    assert status == 401
    assert headers["access-control-allow-origin"] == ORIGIN


def test_preflight(bridge):
    status, headers, _ = request(bridge, "OPTIONS", "/v1/activities", token=None, origin=ORIGIN,
                                 extra={"Access-Control-Request-Method": "GET",
                                        "Access-Control-Request-Headers": "authorization",
                                        "Access-Control-Request-Private-Network": "true"})
    assert status == 204
    assert headers["access-control-allow-origin"] == ORIGIN
    assert headers["access-control-allow-methods"] == "GET, POST"
    assert headers["access-control-allow-headers"].lower() == "authorization, content-type"
    assert headers["access-control-allow-private-network"] == "true"


def test_preflight_from_an_unlisted_origin(bridge):
    status, headers, _ = request(bridge, "OPTIONS", "/v1/activities", token=None,
                                 origin="https://evil.test",
                                 extra={"Access-Control-Request-Method": "GET"})
    assert status == 403
    assert "access-control-allow-origin" not in headers


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_only_get_on_the_read_routes(bridge, method):
    status, _, body = request(bridge, method, "/v1/activities", body=b'{"x": 1}')
    assert status == 405
    assert body["error"]["code"] == "method_not_allowed"


def test_unknown_path(bridge):
    status, _, body = request(bridge, "GET", "/v1/sleep")
    assert status == 404
    assert body["error"]["code"] == "not_found"


def test_activities(bridge):
    status, _, body = request(bridge, "GET", "/v1/activities?since=2026-09-01&until=2026-09-27")
    assert status == 200
    assert body["ok"] is True and body["api"] == API_VERSION
    assert (body["since"], body["until"]) == ("2026-09-01", "2026-09-27")
    assert body["fetchedAt"].endswith("Z")
    assert [a["id"] for a in body["activities"]] == ["1001"]
    assert body["activities"][0]["hr"] == {"avg": 173, "max": 187}
    assert body["skipped"] == []
    assert bridge["clients"][0].windows == [(date(2026, 9, 1), date(2026, 9, 27))]


def test_until_defaults_to_today(bridge):
    request(bridge, "GET", "/v1/activities?since=2026-09-20")
    assert bridge["clients"][0].windows == [(date(2026, 9, 20), date(2026, 9, 27))]


def test_the_signed_in_client_is_reused(bridge):
    request(bridge, "GET", "/v1/activities?since=2026-09-20")
    request(bridge, "GET", "/v1/activities?since=2026-09-21")
    assert len(bridge["clients"]) == 1


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (AuthRequired(), 409, "auth_required"),
        (RateLimited(), 429, "rate_limited"),
        (Unavailable(), 503, "unavailable"),
    ],
)
def test_garmin_failures_become_json_errors(bridge, error, status, code):
    bridge["make"] = lambda: StubClient(error=error)
    got, headers, body = request(bridge, "GET", "/v1/activities?since=2026-09-20")
    assert got == status
    assert body == {"ok": False, "error": {"code": code, "message": error.message}}
    if code == "rate_limited":
        assert int(headers["retry-after"]) > 0


def test_a_lost_session_is_reopened_once_from_the_saved_tokens(bridge):
    made = []

    def make():
        made.append(1)
        return StubClient(error=AuthRequired()) if len(made) == 1 else StubClient()

    bridge["make"] = make
    status, _, _ = request(bridge, "GET", "/v1/activities?since=2026-09-20")
    assert status == 200
    assert len(made) == 2


def test_an_unexpected_failure_says_nothing_about_itself(bridge):
    bridge["make"] = lambda: StubClient(error=RuntimeError("secret internals jane@example.com"))
    status, _, body = request(bridge, "GET", "/v1/activities?since=2026-09-20")
    assert status == 500
    assert body["error"]["code"] == "internal"
    assert "jane" not in body["error"]["message"]


@pytest.mark.parametrize(
    "query",
    [
        "",
        "?since=yesterday",
        "?since=2026-09-20&until=2026-09-01",
        "?since=2026-09-20&until=not-a-date",
        f"?since=2024-01-01&until=2026-09-27",
    ],
)
def test_bad_ranges(bridge, query):
    status, _, body = request(bridge, "GET", "/v1/activities" + query)
    assert status == 400
    assert body["error"]["code"] == "bad_request"


def test_parse_range_limit():
    today = date(2026, 9, 27)
    since, until = parse_range(f"since=2025-08-23&until=2026-09-27", today=today)
    assert (until - since).days == MAX_RANGE_DAYS


# ---- workout export ---------------------------------------------------------

WORKOUT = {
    "name": "Yootri Long ride 2:00",
    "ftpW": 250,
    "steps": [
        {"type": "warmup", "durationS": 900, "pct": [50, 65], "watts": [125, 163]},
        {"type": "interval", "durationS": 5700, "pct": [56, 75], "watts": [140, 188]},
        {"type": "cooldown", "durationS": 600, "pct": [45, 55], "watts": None},
    ],
}
JSON_HEADERS = {"Content-Type": "application/json"}


class WorkoutStub(StubClient):
    def __init__(self, error=None):
        super().__init__()
        self.sent = []
        self.removed = []
        self.workout_error = error

    def upload_workout(self, body):
        if self.workout_error:
            raise self.workout_error
        self.sent.append(body)
        return {"workoutId": 77}

    def schedule_workout(self, workout_id, date_iso):
        self.sent.append((workout_id, date_iso))
        return {"workoutScheduleId": 88}

    def unschedule_workout(self, schedule_id):
        self.removed.append(("unschedule", schedule_id))

    def delete_workout(self, workout_id):
        self.removed.append(("delete", workout_id))


def post(bridge, path, payload, **kw):
    headers = dict(JSON_HEADERS)
    headers.update(kw.pop("extra", {}) or {})
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return request(bridge, "POST", path, body=body, extra=headers, **kw)


@pytest.fixture
def workouts(bridge):
    bridge["server"].cfg.workouts = True
    stub = WorkoutStub()
    bridge["make"] = lambda: stub
    bridge["stub"] = stub
    return bridge


def test_status_says_whether_workout_export_is_on(bridge):
    assert request(bridge, "GET", "/v1/status")[2]["workouts"] is False
    bridge["server"].cfg.workouts = True
    assert request(bridge, "GET", "/v1/status")[2]["workouts"] is True


@pytest.mark.parametrize("path", ["/v1/workouts", "/v1/workouts/remove", "/v1/workouts/fit"])
def test_workout_routes_are_off_by_default(bridge, path):
    status, _, body = post(bridge, path, {"workout": WORKOUT, "date": "2026-10-13"})
    assert status == 403
    assert body["error"]["code"] == "workouts_disabled"
    assert bridge["clients"] == []


def test_a_workout_is_sent_and_scheduled(workouts):
    status, _, body = post(workouts, "/v1/workouts", {"workout": WORKOUT, "date": "2026-10-13"})
    assert status == 200
    assert (body["workoutId"], body["scheduleId"], body["date"]) == (77, 88, "2026-10-13")
    uploaded, scheduled = workouts["stub"].sent
    assert uploaded["workoutName"] == WORKOUT["name"]
    assert scheduled == (77, "2026-10-13")


def test_a_sent_workout_can_be_removed(workouts):
    status, _, body = post(workouts, "/v1/workouts/remove", {"workoutId": 77, "scheduleId": 88})
    assert status == 200 and body["ok"] is True
    assert workouts["stub"].removed == [("unschedule", 88), ("delete", 77)]


def test_the_fit_file_comes_back_without_calling_garmin(workouts):
    conn = http.client.HTTPConnection("127.0.0.1", workouts["port"], timeout=5)
    conn.request("POST", "/v1/workouts/fit", body=json.dumps({"workout": WORKOUT}),
                 headers={"Authorization": f"Bearer {TOKEN}", **JSON_HEADERS})
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    assert resp.status == 200
    assert resp.getheader("Content-Type") == "application/octet-stream"
    assert data[8:12] == b".FIT"
    assert workouts["clients"] == []


@pytest.mark.parametrize(
    "payload",
    [
        {"workout": WORKOUT},
        {"workout": WORKOUT, "date": "next tuesday"},
        {"workout": WORKOUT, "date": "2031-01-01"},
        {"workout": {"name": "x", "steps": []}, "date": "2026-10-13"},
        {"workout": "nope", "date": "2026-10-13"},
    ],
)
def test_a_bad_workout_is_a_400_and_garmin_is_not_called(workouts, payload):
    status, _, body = post(workouts, "/v1/workouts", payload)
    assert status == 400
    assert body["error"]["code"] == "bad_workout"
    assert workouts["stub"].sent == []


def test_remove_wants_whole_numbers(workouts):
    assert post(workouts, "/v1/workouts/remove", {"workoutId": "77"})[0] == 400
    assert post(workouts, "/v1/workouts/remove", {})[0] == 400
    assert workouts["stub"].removed == []


def test_the_body_must_be_json_and_small(workouts):
    plain = request(workouts, "POST", "/v1/workouts", body=b"{}", extra={"Content-Type": "text/plain"})
    assert plain[0] == 400
    assert post(workouts, "/v1/workouts", b"not json")[0] == 400
    assert post(workouts, "/v1/workouts", b"[]")[0] == 400
    big = post(workouts, "/v1/workouts", b'{"x": "' + b"a" * 40000 + b'"}')
    assert big[0] == 400


def test_workout_posts_need_the_token_host_and_origin(workouts):
    payload = {"workout": WORKOUT, "date": "2026-10-13"}
    assert post(workouts, "/v1/workouts", payload, token=None)[0] == 401
    assert post(workouts, "/v1/workouts", payload, token="wrong")[0] == 401
    assert post(workouts, "/v1/workouts", payload, origin="https://evil.test")[0] == 403
    assert post(workouts, "/v1/workouts", payload, host="evil.test")[0] == 421
    assert workouts["stub"].sent == []


def test_a_listed_origin_can_read_the_answer(workouts):
    status, headers, _ = post(workouts, "/v1/workouts", {"workout": WORKOUT, "date": "2026-10-13"}, origin=ORIGIN)
    assert status == 200
    assert headers["access-control-allow-origin"] == ORIGIN


def test_garmins_refusal_is_its_own_error(workouts):
    from garmin_bridge.errors import GarminError

    workouts["make"] = lambda: WorkoutStub(error=GarminError("400"))
    workouts["server"].forget_client()
    status, _, body = post(workouts, "/v1/workouts", {"workout": WORKOUT, "date": "2026-10-13"})
    assert status == 502
    assert body["error"]["code"] == "workout_rejected"


def test_a_lost_session_is_reopened_once_for_a_workout(workouts):
    calls = {"n": 0}

    def make():
        calls["n"] += 1
        return WorkoutStub(error=AuthRequired()) if calls["n"] == 1 else WorkoutStub()

    workouts["make"] = make
    workouts["server"].forget_client()
    status, _, body = post(workouts, "/v1/workouts", {"workout": WORKOUT, "date": "2026-10-13"})
    assert status == 200 and body["workoutId"] == 77
    assert calls["n"] == 2


def test_other_methods_and_paths_are_still_refused(workouts):
    assert request(workouts, "PUT", "/v1/workouts", body=b"{}")[0] == 405
    assert request(workouts, "DELETE", "/v1/workouts/remove")[0] == 405
    assert post(workouts, "/v1/sleep", {})[0] == 405


# ---- overnight figures (YOOTRI_GARMIN_OVERNIGHT=1 only) -----------------------


class OvernightStub(StubClient):
    """Answers the three overnight series from the shared payloads."""

    def __init__(self, error=None):
        super().__init__()
        self.ranges = []
        self.overnight_error = error

    def overnight_range(self, series, start, end):
        self.ranges.append((series, start, end))
        if self.overnight_error is not None:
            raise self.overnight_error
        return {"sleep": payloads.sleep_daily(), "hrv": payloads.hrv_range(), "restingHr": payloads.rhr_daily()}[series]


@pytest.fixture
def overnight(bridge):
    bridge["server"].cfg.overnight = True
    stub = OvernightStub()
    bridge["make"] = lambda: stub
    bridge["stub"] = stub
    return bridge


def test_status_says_whether_overnight_figures_are_on(bridge):
    assert request(bridge, "GET", "/v1/status")[2]["overnight"] is False
    bridge["server"].cfg.overnight = True
    assert request(bridge, "GET", "/v1/status")[2]["overnight"] is True


def test_overnight_figures_are_off_by_default(bridge):
    status, _, body = request(bridge, "GET", "/v1/overnight?since=2026-09-01&until=2026-09-27")
    assert status == 403
    assert body["error"]["code"] == "overnight_disabled"
    assert bridge["clients"] == []


def test_overnight_figures_when_switched_on(overnight):
    status, _, body = request(overnight, "GET", "/v1/overnight?since=2026-10-01&until=2026-10-07")
    assert status == 200
    assert body["ok"] is True and body["api"] == API_VERSION
    assert (body["since"], body["until"]) == ("2026-10-01", "2026-10-07")
    assert body["nights"][1] == {"date": "2026-10-05", "sleepMin": 437, "hrvMs": 61, "restingHr": 47}
    assert body["missing"] == []
    assert {series for series, _, _ in overnight["stub"].ranges} == {"sleep", "hrv", "restingHr"}


def test_switching_overnight_on_changes_nothing_about_activities(overnight):
    status, _, body = request(overnight, "GET", "/v1/activities?since=2026-09-01&until=2026-09-27")
    assert status == 200
    assert "nights" not in body
    assert overnight["stub"].ranges == []


def test_overnight_history_is_capped_tighter_than_activities(overnight):
    status, _, body = request(overnight, "GET", "/v1/overnight?since=2026-01-01&until=2026-09-27")
    assert status == 400
    assert body["error"]["code"] == "bad_request"
    assert overnight["stub"].ranges == []


def test_overnight_needs_the_token_host_and_origin(overnight):
    path = "/v1/overnight?since=2026-10-01&until=2026-10-07"
    assert request(overnight, "GET", path, token=None)[0] == 401
    assert request(overnight, "GET", path, origin="https://evil.test")[0] == 403
    assert request(overnight, "GET", path, host="evil.test")[0] == 421
    assert overnight["stub"].ranges == []


def test_overnight_is_read_only(overnight):
    assert request(overnight, "POST", "/v1/overnight", body=b"{}")[0] == 405
    assert request(overnight, "DELETE", "/v1/overnight")[0] == 405


def test_a_rate_limit_on_overnight_figures_says_so(overnight):
    overnight["make"] = lambda: OvernightStub(error=RateLimited())
    overnight["server"].forget_client()
    status, headers, body = request(overnight, "GET", "/v1/overnight?since=2026-10-01&until=2026-10-07")
    assert status == 429
    assert body["error"]["code"] == "rate_limited"
    assert headers["retry-after"] == "900"
