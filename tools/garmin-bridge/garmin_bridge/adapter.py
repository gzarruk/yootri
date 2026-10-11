"""The only place the bridge puts a workout on Garmin Connect.

Garmin has no public API for this. ``upload_workout`` and ``schedule_workout``
are reverse-engineered endpoints that Garmin can change without notice, so
everything that touches them is here, behind ``WorkoutGateway``: if they break,
this is the one module to repair or replace, and the rest of the bridge — and
the app — carry on. A refusal is reported as ``WorkoutRejected``, distinct from
a lost session, a rate limit or an outage, so the page can say "Garmin did not
accept this" rather than "something went wrong".

Failures are logged on ``garmin_bridge.workouts`` with the error code only —
never the workout, a token or a message from Garmin.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

from garmin_bridge.errors import BridgeError, GarminError, WorkoutRejected

log = logging.getLogger("garmin_bridge.workouts")


@dataclass(frozen=True)
class SentWorkout:
    workout_id: int
    schedule_id: int | None
    date: str


class WorkoutGateway(Protocol):
    def send(self, workout_json: dict[str, Any], date_iso: str) -> SentWorkout: ...

    def remove(self, workout_id: int, schedule_id: int | None) -> None: ...


def _id(response: Any, key: str) -> int | None:
    value = response.get(key) if isinstance(response, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _rejected(error: BridgeError, step: str) -> BridgeError:
    # A 4xx from these endpoints means Garmin did not like the payload or the
    # endpoint moved. A lost session, a rate limit and an outage keep their codes.
    log.error("workout_export_failed step=%s code=%s", step, error.code)
    return WorkoutRejected() if isinstance(error, GarminError) else error


class GarminConnectGateway:
    """Talks to Garmin through ``GarminClient`` (pacing, token saving, redaction)."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def send(self, workout_json: dict[str, Any], date_iso: str) -> SentWorkout:
        try:
            workout_id = _id(self._client.upload_workout(workout_json), "workoutId")
        except BridgeError as error:
            raise _rejected(error, "upload") from error
        if workout_id is None:
            log.error("workout_export_failed step=upload code=no_workout_id")
            raise WorkoutRejected("Garmin answered, but not with a workout id.")
        try:
            schedule_id = _id(self._client.schedule_workout(workout_id, date_iso), "workoutScheduleId")
        except BridgeError as error:
            self._discard(workout_id)
            raise _rejected(error, "schedule") from error
        return SentWorkout(workout_id, schedule_id, date_iso)

    def remove(self, workout_id: int, schedule_id: int | None) -> None:
        # Take it off the calendar first, then out of the library. A calendar
        # entry that is already gone is not worth failing the whole removal for.
        if schedule_id is not None:
            try:
                self._client.unschedule_workout(schedule_id)
            except BridgeError as error:
                log.warning("workout_export_failed step=unschedule code=%s", error.code)
        try:
            self._client.delete_workout(workout_id)
        except BridgeError as error:
            raise _rejected(error, "delete") from error

    def _discard(self, workout_id: int) -> None:
        """Don't leave a workout in the library that never reached the calendar."""
        try:
            self._client.delete_workout(workout_id)
        except BridgeError as error:
            log.warning("workout_export_failed step=cleanup code=%s", error.code)
