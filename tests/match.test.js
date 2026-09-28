import test from 'node:test';
import assert from 'node:assert/strict';

import { MATCH, matchActivities } from '../assets/coach/match.js';
import { newPlan } from '../assets/coach/plan.js';
import { setActual, weekCompliance } from '../assets/coach/actuals.js';

/* Matching synced activities to the sessions they were.

   A proposal, never a write: the athlete sees "9 of these match planned
   sessions" and decides. Same date, same discipline, one activity per session,
   the closest duration first. A session the athlete already logged is theirs —
   an activity never overwrites it. */

// Week 0 starts Monday 2026-01-05, so Tue = 01-06, Wed = 01-07, Sat = 01-10.
const plan = (over = {}) => {
  const p = newPlan({ name: 'Match', startISO: '2026-01-05', now: 1 });
  p.weeks.w0 = [
    { id: 'rest', day: 'Mon', disc: 'Rest', focus: '', dur: '—', zone: '—' },
    { id: 'run', day: 'Tue', disc: 'Run', focus: '', dur: '1:00', zone: 'Z2' },
    { id: 'swim', day: 'Tue', disc: 'Swim', focus: '', dur: '0:45', zone: 'Z2' },
    { id: 'ride', day: 'Wed', disc: 'Bike', focus: '', dur: '2:00', zone: 'Z2' },
    { id: 'short', day: 'Sat', disc: 'Run', focus: '', dur: '0:40', zone: 'Z2' },
    { id: 'long', day: 'Sat', disc: 'Run', focus: '', dur: '1:30', zone: 'Z2' },
  ];
  return { ...p, ...over };
};

const act = (id, date, disc, minutes, extra = {}) => ({
  id: `garmin:${id}`, source: 'garmin', date, disc, durationS: minutes * 60, ...extra,
});

const ids = (proposals) => proposals.map((p) => [p.sessionId, p.activityId]);

test('same day, same discipline: proposed as done, with the minutes and the effort', () => {
  const { proposals, extra } = matchActivities(plan(), [act(1, '2026-01-06', 'Run', 58, { rpe: 6 })]);
  assert.deepEqual(extra, []);
  assert.deepEqual(proposals, [{
    sessionId: 'run', absWeek: 0, date: '2026-01-06', disc: 'Run', plannedMin: 60, activityId: 'garmin:1',
    actual: { status: 'done', min: 58, rpe: 6, note: '', activityId: 'garmin:1' },
  }]);
});

test('under four fifths of the planned time is partial', () => {
  const at = (m) => matchActivities(plan(), [act(1, '2026-01-06', 'Run', m)]).proposals[0].actual.status;
  assert.equal(MATCH.doneRatio, 0.8);
  assert.equal(at(48), 'done');
  assert.equal(at(47), 'partial');
});

test('another discipline on the same day is not a match', () => {
  const { proposals, extra } = matchActivities(plan(), [act(1, '2026-01-07', 'Run', 60)]);
  assert.deepEqual(proposals, []);
  assert.deepEqual(extra.map((x) => [x.activityId, x.reason]), [['garmin:1', 'no-session']]);
});

test('two runs on a day with two run sessions pair by closest duration', () => {
  const { proposals } = matchActivities(plan(), [
    act(1, '2026-01-10', 'Run', 85),
    act(2, '2026-01-10', 'Run', 42),
  ]);
  assert.deepEqual(ids(proposals), [['short', 'garmin:2'], ['long', 'garmin:1']]);
});

test('a session the athlete already logged is theirs', () => {
  const p = setActual(plan(), 'run', { status: 'partial', min: 30 });
  const { proposals, extra } = matchActivities(p, [act(1, '2026-01-06', 'Run', 60)]);
  assert.deepEqual(proposals, []);
  assert.deepEqual(extra.map((x) => x.reason), ['session-logged']);
});

test('a session that is only ticked is still proposed, so its minutes can be filled in', () => {
  const p = plan({ done: { run: true } });
  const { proposals } = matchActivities(p, [act(1, '2026-01-06', 'Run', 60)]);
  assert.deepEqual(ids(proposals), [['run', 'garmin:1']]);
});

test('an activity already logged against a session is not proposed twice', () => {
  const p = setActual(plan(), 'run', { status: 'done', min: 60, activityId: 'garmin:1' });
  const { proposals, extra } = matchActivities(p, [act(1, '2026-01-06', 'Run', 60)]);
  assert.deepEqual(proposals, []);
  assert.deepEqual(extra.map((x) => x.reason), ['already-linked']);
});

test('what cannot be matched says why', () => {
  const { proposals, extra } = matchActivities(plan(), [
    act(1, '2025-12-30', 'Run', 60),
    act(2, '2026-01-06', 'Run', 5),
    act(3, '2026-01-06', 'Other', 60),
    act(4, '2026-01-05', 'Run', 60),
  ]);
  assert.deepEqual(proposals, []);
  assert.deepEqual(extra.map((x) => [x.activityId, x.reason]), [
    ['garmin:1', 'outside-plan'],
    ['garmin:4', 'no-session'],
    ['garmin:2', 'too-short'],
    ['garmin:3', 'not-matchable'],
  ]);
  assert.equal(MATCH.minMinutes, 10);
});

test('extras carry what the review panel shows', () => {
  const { extra } = matchActivities(plan(), [act(9, '2026-01-07', 'Swim', 30)]);
  assert.deepEqual(extra, [{ activityId: 'garmin:9', date: '2026-01-07', disc: 'Swim', min: 30, reason: 'no-session' }]);
});

test('a window limits which activities are considered at all', () => {
  const all = [act(1, '2026-01-06', 'Run', 60), act(2, '2026-01-07', 'Bike', 120)];
  const { proposals, extra } = matchActivities(plan(), all, { from: '2026-01-07', to: '2026-01-07' });
  assert.deepEqual(ids(proposals), [['ride', 'garmin:2']]);
  assert.deepEqual(extra, []);
});

test('matching does not mutate the plan and does not depend on input order', () => {
  const p = plan();
  const snapshot = structuredClone(p);
  const list = [act(1, '2026-01-10', 'Run', 85), act(2, '2026-01-10', 'Run', 42), act(3, '2026-01-06', 'Run', 60)];
  const a = matchActivities(p, list);
  const b = matchActivities(p, [...list].reverse());
  assert.deepEqual(p, snapshot);
  assert.deepEqual(a, b);
});

test('applying the proposals logs the week', () => {
  let p = plan();
  const { proposals } = matchActivities(p, [act(1, '2026-01-06', 'Run', 58), act(2, '2026-01-07', 'Bike', 90)]);
  for (const x of proposals) p = setActual(p, x.sessionId, x.actual);
  assert.equal(p.done.run, true);
  assert.equal(p.done.ride, true);
  assert.equal(p.actuals.ride.status, 'partial');
  assert.equal(p.actuals.ride.activityId, 'garmin:2');
  assert.equal(weekCompliance(p, 0).actualMinutes, 58 + 90);
});
