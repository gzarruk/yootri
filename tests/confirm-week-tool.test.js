import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmFromScheduled } from '../tools/sync/confirm-week.mjs';
import { newPlan } from '../assets/coach/plan.js';

const S = (type, end, value) => ({ stepType: { stepTypeKey: type }, endCondition: { conditionTypeKey: end },
  endConditionValue: value, targetType: { workoutTargetTypeKey: 'no.target' } });
const workout = (name, ...steps) => ({ workoutId: 5, workoutName: name, sportType: { sportTypeKey: 'running' },
  workoutSegments: [{ workoutSteps: steps }] });
const plan = () => newPlan({ name: 'T', startISO: '2026-11-02', now: 1 });

test('runs in the plan are confirmed by week; nothing published means no change', () => {
  const p = plan();
  const r = confirmFromScheduled(p, { runs: [
    { date: '2026-11-03', scheduleId: 11, title: 'A', workout: workout('A', S('warmup', 'time', 600), S('interval', 'time', 1800)) },
  ] });
  assert.equal(r.weeks.length, 1);
  assert.equal(r.weeks[0].week, 0);
  assert.ok(r.plan.weeks.w0.some((s) => s.garminId === '11' && s.status === 'confirmed'));
  assert.deepEqual(confirmFromScheduled(p, { runs: [] }).weeks, []);
});

test('unreadable workouts and dates outside the plan are reported or skipped, never thrown', () => {
  const r = confirmFromScheduled(plan(), { runs: [
    { date: '2026-11-04', scheduleId: 1, title: 'Odd', workout: { sportType: { sportTypeKey: 'cycling' } } },
    { date: '2020-01-01', scheduleId: 2, title: 'Old', workout: workout('Old', S('warmup', 'time', 600)) },
  ] });
  assert.deepEqual(r.unreadable, [{ date: '2026-11-04', title: 'Odd' }]);
  assert.deepEqual(r.weeks, []);
});

test('the input plan is not mutated', () => {
  const p = plan();
  const before = JSON.stringify(p);
  confirmFromScheduled(p, { runs: [{ date: '2026-11-03', scheduleId: 11, title: 'A', workout: workout('A', S('warmup', 'time', 600)) }] });
  assert.equal(JSON.stringify(p), before);
});
