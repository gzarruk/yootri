import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingWeeks, weekSuggestions, draftForWeek } from '../assets/coach/syncweek.js';
import { newPlan, applyDraft } from '../assets/coach/plan.js';

const S = (type, end, value, target = 'no.target') => ({ stepType: { stepTypeKey: type }, endCondition: { conditionTypeKey: end },
  endConditionValue: value, targetType: { workoutTargetTypeKey: target } });
const workout = (name, ...steps) => ({ workoutId: 5, workoutName: name, sportType: { sportTypeKey: 'running' },
  workoutSegments: [{ workoutSteps: steps }] });
const plan = () => newPlan({ name: 'T', startISO: '2026-11-02', now: 1 });
const feed = () => ({ runs: [
  { date: '2026-11-03', scheduleId: 11, title: 'A', workout: workout('Hard', S('warmup', 'time', 600), S('interval', 'time', 3600, 'pace.zone')) },
] });

test('a feed with a new run makes its week pending; once applied it is quiet', () => {
  const p = plan();
  assert.deepEqual(pendingWeeks(p, feed()), [0]);
  const draft = draftForWeek(p, feed(), 0, { confirm: true });
  assert.ok(draft.weeks.w0.some((s) => s.status === 'confirmed'));
  assert.deepEqual(pendingWeeks(draft, feed()), []);
});

test('declining the runs leaves the plan as it was, and proposals need the runs', () => {
  const p = plan();
  assert.equal(draftForWeek(p, feed(), 0, { confirm: false, accepted: ['x'] }), p);
});

test('only accepted proposals are applied, and the draft survives applyDraft', () => {
  const p = plan();
  const r = weekSuggestions(p, feed(), 0);
  const ids = r.proposals.map((x) => x.id);
  const none = draftForWeek(p, feed(), 0, { accepted: [] });
  const all = draftForWeek(p, feed(), 0, { accepted: ids });
  assert.equal(none.weeks.w0.length, all.weeks.w0.length);
  const kept = applyDraft(p, none).weeks.w0.find((s) => s.status === 'confirmed');
  assert.ok(kept && kept.steps?.length, 'applyDraft kept the confirmed run and its steps');
});

test('an empty feed is not an error and changes nothing', () => {
  assert.deepEqual(pendingWeeks(plan(), { runs: [] }), []);
  assert.deepEqual(pendingWeeks(plan(), null), []);
});
