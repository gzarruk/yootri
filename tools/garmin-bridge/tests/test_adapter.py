"""The workout gateway, against a fake client — Garmin is never called."""

import pytest

from garmin_bridge.adapter import GarminConnectGateway
from garmin_bridge.errors import AuthRequired, GarminError, RateLimited, WorkoutRejected


class FakeWorkoutClient:
    def __init__(self, *, upload=None, schedule=None, unschedule=None, delete=None):
        self.upload = upload if upload is not None else {"workoutId": 77}
        self.schedule = schedule if schedule is not None else {"workoutScheduleId": 88}
        self.unschedule = unschedule
        self.delete = delete
        self.calls = []

    def _go(self, name, value, *args):
        self.calls.append((name, args))
        if isinstance(value, Exception):
            raise value
        return value

    def upload_workout(self, body):
        return self._go("upload", self.upload, body)

    def schedule_workout(self, workout_id, date_iso):
        return self._go("schedule", self.schedule, workout_id, date_iso)

    def unschedule_workout(self, schedule_id):
        return self._go("unschedule", self.unschedule, schedule_id)

    def delete_workout(self, workout_id):
        return self._go("delete", self.delete, workout_id)


def names(client):
    return [name for name, _ in client.calls]


def test_a_workout_is_uploaded_then_scheduled_on_its_date():
    client = FakeWorkoutClient()
    sent = GarminConnectGateway(client).send({"workoutName": "x"}, "2026-10-13")
    assert (sent.workout_id, sent.schedule_id, sent.date) == (77, 88, "2026-10-13")
    assert client.calls == [("upload", ({"workoutName": "x"},)), ("schedule", (77, "2026-10-13"))]


def test_a_refused_upload_is_reported_as_a_rejected_workout():
    client = FakeWorkoutClient(upload=GarminError("400 bad payload"))
    with pytest.raises(WorkoutRejected):
        GarminConnectGateway(client).send({}, "2026-10-13")
    assert names(client) == ["upload"]


def test_an_answer_without_a_workout_id_is_a_rejection_not_a_crash():
    with pytest.raises(WorkoutRejected):
        GarminConnectGateway(FakeWorkoutClient(upload={"unexpected": True})).send({}, "2026-10-13")


def test_a_refused_schedule_removes_the_orphaned_workout():
    client = FakeWorkoutClient(schedule=GarminError("404"))
    with pytest.raises(WorkoutRejected):
        GarminConnectGateway(client).send({}, "2026-10-13")
    assert names(client) == ["upload", "schedule", "delete"]


@pytest.mark.parametrize("error", [AuthRequired(), RateLimited()])
def test_a_lost_session_or_rate_limit_keeps_its_own_code(error):
    with pytest.raises(type(error)):
        GarminConnectGateway(FakeWorkoutClient(upload=error)).send({}, "2026-10-13")


def test_remove_unschedules_then_deletes():
    client = FakeWorkoutClient()
    GarminConnectGateway(client).remove(77, 88)
    assert client.calls == [("unschedule", (88,)), ("delete", (77,))]


def test_remove_still_deletes_when_the_calendar_entry_is_already_gone():
    client = FakeWorkoutClient(unschedule=GarminError("404"))
    GarminConnectGateway(client).remove(77, 88)
    assert names(client) == ["unschedule", "delete"]


def test_remove_without_a_schedule_id_only_deletes():
    client = FakeWorkoutClient()
    GarminConnectGateway(client).remove(77, None)
    assert names(client) == ["delete"]
