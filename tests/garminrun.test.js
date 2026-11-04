import test from 'node:test';
import assert from 'node:assert/strict';
import { runFromGarmin, DEFAULT_MPS } from '../assets/coach/garminrun.js';
import { confirmWeek } from '../assets/coach/confirm.js';
import { newPlan } from '../assets/coach/plan.js';
import { plannedLoad } from '../assets/coach/fitness.js';

/* Fixtures follow the shape of a real Garmin Coach week (spike, 4 Nov 2026):
   no total duration from Garmin, repeat groups, lap-button steps, pace in m/s. */
const S = (type, end, value, target = 'no.target', lo = null, hi = null) => ({
  stepType: { stepTypeKey: type }, endCondition: { conditionTypeKey: end }, endConditionValue: value,
  targetType: { workoutTargetTypeKey: target }, targetValueOne: lo, targetValueTwo: hi,
});
const R = (n, ...kids) => ({ stepType: { stepTypeKey: 'repeat' }, numberOfIterations: n, endConditionValue: n, workoutSteps: kids });
const wk = (name, steps) => ({ workoutId: 7, workoutName: name, sportType: { sportTypeKey: 'running' },
  workoutSegments: [{ workoutSteps: steps }] });
const drills = [
  S('other', 'lap.button', null),
  R(4, S('interval', 'time', 30, 'cadence', 150, 200), S('recovery', 'time', 30)),
  S('other', 'lap.button', null),
  R(4, S('interval', 'time', 30)),
];

const speed = wk('Speed Repeats', [S('warmup', 'time', 300), ...drills, S('other', 'lap.button', null),
  R(8, S('interval', 'distance', 800, 'pace.zone', 3.1604597, 3.0410192), S('recovery', 'time', 180)),
  S('cooldown', 'time', 300)]);
const mile = wk('Magic Mile', [S('warmup', 'time', 300), ...drills, S('interval', 'distance', 1609), S('cooldown', 'time', 300)]);

test('repeats expand, distance steps are timed from the pace target, open steps have no length', () => {
  const r = runFromGarmin(speed, { date: '2026-11-07', scheduleId: 99 });
  assert.equal(r.day, 'Sat');
  assert.equal(r.garminId, '99');
  assert.equal(r.distanceM, 6400);
  const reps = r.steps.filter((s) => s.meters === 800);
  assert.equal(reps.length, 8);
  assert.equal(reps[0].sec, Math.round(800 / ((3.1604597 + 3.0410192) / 2)));
  assert.equal(reps[0].zone, 'Z3');
  assert.equal(r.steps.filter((s) => s.kind === 'open').length, 3);
  assert.ok(r.steps.filter((s) => s.kind === 'open').every((s) => s.sec === 0));
  assert.equal(r.durationS, r.steps.reduce((a, s) => a + s.sec, 0));
});

test('a distance step with no pace target is timed at the default speed', () => {
  const r = runFromGarmin(mile, { date: '2026-11-05', scheduleId: 1 });
  const m = r.steps.find((s) => s.meters === 1609);
  assert.equal(m.sec, Math.round(1609 / DEFAULT_MPS));
  assert.equal(m.zone, 'Z2');
  assert.equal(r.day, 'Thu');
});

test('not a run, unknown step or bad date comes back null, never a throw', () => {
  assert.equal(runFromGarmin({ ...mile, sportType: { sportTypeKey: 'cycling' } }, { date: '2026-11-05' }), null);
  assert.equal(runFromGarmin(wk('x', [S('mystery', 'time', 10)]), { date: '2026-11-05' }), null);
  assert.equal(runFromGarmin(mile, { date: 'nope' }), null);
  assert.equal(runFromGarmin(null, { date: '2026-11-05' }), null);
  assert.equal(runFromGarmin(wk('x', [S('warmup', 'time', 0)]), { date: '2026-11-05' }), null);
});

test('it feeds confirmWeek and scores as a planned load', () => {
  const p = newPlan({ name: 'G', startISO: '2026-11-02', now: 1 });
  const g = runFromGarmin(speed, { date: '2026-11-07', scheduleId: 99 });
  const r = confirmWeek(p, 0, [g]);
  assert.equal(r.published, true);
  const s = r.sessions.find((x) => x.garminId === '99');
  assert.equal(s.status, 'confirmed');
  assert.equal(s.day, 'Sat');
  const load = plannedLoad(s);
  assert.ok(load > 0);
  assert.equal(plannedLoad({ ...s, steps: s.steps.map((x) => ({ ...x })) }), load);
});
