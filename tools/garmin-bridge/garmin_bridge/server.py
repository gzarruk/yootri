"""The bridge's HTTP surface: a few endpoints on 127.0.0.1.

    GET  /v1/status                        is there a saved Garmin session?
    GET  /v1/activities?since=…&until=…    activity summaries in that window

and, only when the bridge was started with workout export switched on
(``YOOTRI_GARMIN_WORKOUTS=1``):

    POST /v1/workouts                      put a bike workout in the library and on a date
    POST /v1/workouts/remove               take one back off the calendar and out of the library
    POST /v1/workouts/fit                  the same workout as a FIT file; Garmin is not called

Who may ask, checked in this order:

1. **Host** must be ``127.0.0.1:<port>`` or ``localhost:<port>``. A web page
   can point a name it controls at 127.0.0.1 (DNS rebinding); the browser then
   sends that name as the Host header, and the request stops here.
2. **Origin**, when a browser sends one, must be on the allowlist. Allowed
   origins get their own origin echoed back (never ``*``, never credentials);
   anything else gets a 403 with no CORS headers, so its script cannot read the
   answer even if it guessed the token.
3. **Authorization: Bearer <pairing token>**, compared in constant time.

Preflights answer ``Access-Control-Allow-Private-Network`` so Chrome lets a
public page ask a loopback address once the athlete allows it. Only the routes
above are served. A request body is read only for the workout routes, only as
JSON, and only up to ``MAX_BODY`` bytes; every other method is refused.

The server is single-threaded on purpose: one athlete, one button, and no
chance of two requests signing in to Garmin at the same time.
"""

from __future__ import annotations

import hmac
import json
import logging
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

from garmin_bridge import API_VERSION, __version__
from garmin_bridge.adapter import GarminConnectGateway
from garmin_bridge.client import fetch_activities
from garmin_bridge.errors import (
    AuthRequired,
    BadHost,
    BadRequest,
    BadWorkout,
    BridgeError,
    ForbiddenOrigin,
    MethodNotAllowed,
    NotFound,
    RateLimited,
    Unauthorized,
    WorkoutsDisabled,
)
from garmin_bridge.store import Store
from garmin_bridge.workouts import to_fit, to_garmin_json, validate_workout

log = logging.getLogger("garmin_bridge")

DEFAULT_PORT = 8765

# The page never asks for more than this (synced.js MAX_RANGE_DAYS agrees).
MAX_RANGE_DAYS = 400

# A workout is a few dozen small steps; anything bigger is not one.
MAX_BODY = 32 * 1024

# How far from today a workout may be scheduled.
MAX_SCHEDULE_DAYS = 400

# Garmin's own advice after "too many requests" is to wait 15–60 minutes.
RETRY_AFTER_S = 900


@dataclass
class Config:
    token: str
    origins: tuple[str, ...]
    store: Store
    client_provider: Callable[[], Any]
    today: Callable[[], date] = date.today
    workouts: bool = False


def parse_range(query: str, *, today: date) -> tuple[date, date]:
    params = parse_qs(query, keep_blank_values=True)

    def one(name: str) -> str | None:
        values = params.get(name)
        return values[0] if values else None

    def as_date(name: str, raw: str) -> date:
        try:
            return date.fromisoformat(raw)
        except ValueError as exc:
            raise BadRequest(f"`{name}` must be a date like 2026-09-01.") from exc

    raw_since = one("since")
    if not raw_since:
        raise BadRequest("`since` is required.")
    since = as_date("since", raw_since)
    raw_until = one("until")
    until = as_date("until", raw_until) if raw_until else today
    if since > until:
        raise BadRequest("`since` is after `until`.")
    if (until - since).days > MAX_RANGE_DAYS:
        raise BadRequest(f"Ask for at most {MAX_RANGE_DAYS} days at a time.")
    return since, until


class BridgeServer(HTTPServer):
    def __init__(self, cfg: Config, host: str, port: int) -> None:
        self.cfg = cfg
        self._client: Any = None
        super().__init__((host, port), Handler)

    def client(self) -> Any:
        if self._client is None:
            self._client = self.cfg.client_provider()
        return self._client

    def forget_client(self) -> None:
        self._client = None

    def gateway(self) -> GarminConnectGateway:
        return GarminConnectGateway(self.client())

    def with_session(self, action: Callable[[], Any]) -> Any:
        """Run a Garmin action, reopening a replaced session once, like ``activities``."""
        try:
            return action()
        except AuthRequired:
            self.forget_client()
            return action()

    def activities(self, since: date, until: date) -> tuple[list, list]:
        try:
            return fetch_activities(self.client(), since, until)
        except AuthRequired:
            # The saved session may have been replaced by a fresh
            # `make garmin-login` since this client was opened. Try it once.
            self.forget_client()
            return fetch_activities(self.client(), since, until)


class Handler(BaseHTTPRequestHandler):
    server: BridgeServer
    server_version = "yootri-garmin-bridge"
    sys_version = ""

    # ---- plumbing ---------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        # The request line holds a path and a date range, never a header.
        sys.stderr.write("bridge: " + (format % args) + "\n")

    def _allowed_origin(self) -> str | None:
        origin = self.headers.get("Origin")
        return origin if origin in self.server.cfg.origins else None

    def _send(self, status: int, body: dict[str, Any] | None, extra: dict[str, str] | None = None) -> None:
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        origin = self._allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _send_file(self, data: bytes, content_type: str, filename: str) -> None:
        self.send_response(200)
        origin = self._allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _fail(self, error: BridgeError) -> None:
        extra = {"Retry-After": str(RETRY_AFTER_S)} if isinstance(error, RateLimited) else None
        self._send(error.status, {"ok": False, "error": {"code": error.code, "message": error.message}}, extra)

    def _check_host(self) -> None:
        port = self.server.server_address[1]
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            raise BadHost()

    def _check_origin(self) -> None:
        if self.headers.get("Origin") is not None and self._allowed_origin() is None:
            raise ForbiddenOrigin()

    def _check_token(self) -> None:
        header = self.headers.get("Authorization") or ""
        scheme, _, given = header.partition(" ")
        expected = self.server.cfg.token
        if scheme.lower() != "bearer" or not hmac.compare_digest(given.encode(), expected.encode()):
            raise Unauthorized()

    # ---- methods ----------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib naming
        try:
            self._check_host()
            if self._allowed_origin() is None:
                raise ForbiddenOrigin()
        except BridgeError as error:
            self._fail(error)
            return
        extra = {
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Max-Age": "600",
        }
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            extra["Access-Control-Allow-Private-Network"] = "true"
        self._send(204, None, extra)

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        try:
            self._check_host()
            self._check_origin()
            self._check_token()
            url = urlsplit(self.path)
            if url.path == "/v1/status":
                self._send(200, self._status())
            elif url.path == "/v1/activities":
                self._send(200, self._activities(url.query))
            else:
                raise NotFound()
        except BridgeError as error:
            self._fail(error)
        except Exception as exc:  # noqa: BLE001 - never leak internals to the page
            log.error("bridge: unexpected %s", type(exc).__name__)
            self._fail(BridgeError())

    def _refuse(self) -> None:
        try:
            self._check_host()
            self._check_origin()
            raise MethodNotAllowed()
        except BridgeError as error:
            self.close_connection = True
            self._fail(error)

    do_PUT = do_PATCH = do_DELETE = do_HEAD = _refuse  # noqa: N815

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        routes = {
            "/v1/workouts": self._send_workout,
            "/v1/workouts/remove": self._remove_workout,
            "/v1/workouts/fit": self._workout_fit,
        }
        route = routes.get(urlsplit(self.path).path)
        if route is None:
            self._refuse()
            return
        try:
            self._check_host()
            self._check_origin()
            self._check_token()
            if not self.server.cfg.workouts:
                raise WorkoutsDisabled()
            route(self._read_json())
        except BridgeError as error:
            self._fail(error)
        except Exception as exc:  # noqa: BLE001 - never leak internals to the page
            log.error("bridge: unexpected %s", type(exc).__name__)
            self._fail(BridgeError())

    def _read_json(self) -> dict[str, Any]:
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            raise BadRequest("Send the workout as application/json.")
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError as exc:
            raise BadRequest("A Content-Length is required.") from exc
        if not 0 < length <= MAX_BODY:
            raise BadRequest(f"The request body must be 1–{MAX_BODY} bytes.")
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError as exc:
            raise BadRequest("The request body is not JSON.") from exc
        if not isinstance(body, dict):
            raise BadRequest("The request body must be an object.")
        return body

    # ---- endpoints --------------------------------------------------------

    def _status(self) -> dict[str, Any]:
        store = self.server.cfg.store
        return {
            "ok": True,
            "api": API_VERSION,
            "version": __version__,
            "connected": store.read_tokens() is not None,
            "tokensSavedAt": store.tokens_saved_at(),
            "workouts": self.server.cfg.workouts,
        }

    def _schedule_date(self, raw: Any) -> str:
        try:
            day = date.fromisoformat(raw) if isinstance(raw, str) else None
        except ValueError:
            day = None
        if day is None:
            raise BadWorkout("`date` must be a date like 2026-10-13.")
        if abs((day - self.server.cfg.today()).days) > MAX_SCHEDULE_DAYS:
            raise BadWorkout("`date` is too far from today.")
        return day.isoformat()

    def _send_workout(self, body: dict[str, Any]) -> None:
        workout = to_garmin_json(body.get("workout"))
        day = self._schedule_date(body.get("date"))
        sent = self.server.with_session(lambda: self.server.gateway().send(workout, day))
        self._send(200, {
            "ok": True,
            "api": API_VERSION,
            "workoutId": sent.workout_id,
            "scheduleId": sent.schedule_id,
            "date": sent.date,
        })

    def _remove_workout(self, body: dict[str, Any]) -> None:
        def positive(key: str, *, required: bool) -> int | None:
            value = body.get(key)
            if value is None and not required:
                return None
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise BadWorkout(f"`{key}` must be a whole number.")
            return value

        workout_id = positive("workoutId", required=True)
        schedule_id = positive("scheduleId", required=False)
        self.server.with_session(lambda: self.server.gateway().remove(workout_id, schedule_id))
        self._send(200, {"ok": True, "api": API_VERSION})

    def _workout_fit(self, body: dict[str, Any]) -> None:
        workout = validate_workout(body.get("workout"))
        self._send_file(to_fit(workout), "application/octet-stream", "yootri-workout.fit")

    def _activities(self, query: str) -> dict[str, Any]:
        since, until = parse_range(query, today=self.server.cfg.today())
        activities, skipped = self.server.activities(since, until)
        return {
            "ok": True,
            "api": API_VERSION,
            "since": since.isoformat(),
            "until": until.isoformat(),
            "fetchedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "activities": activities,
            "skipped": skipped,
        }


def make_server(cfg: Config, *, port: int = DEFAULT_PORT, host: str = "127.0.0.1") -> BridgeServer:
    return BridgeServer(cfg, host, port)
