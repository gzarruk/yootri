import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeRebalance, applyProposals, REBALANCE } from '../assets/coach/rebalance.js';
import { newPlan } from '../assets/coach/plan.js';
import { plannedLoad } from '../assets/coach/fitness.js';
import { durToMin } from '../assets/coach/duration.js';

// Week 0 starts Mon 2026-01-05. w0-1 is the generator's Tue run, w0-4 its Fri run.
const run = (id, day, dur, zone, extra = {}) => ({ id, day, disc: 'Run', focus: 'Garmin', dur, zone,
  status: 'confirmed', source: 'garmin', garminId: id, ...extra });
const mk = (runs, more = []) => {
  const p = newPlan({ name: 'R', startISO: '2026-01-05', now: 1 });
  p.weeks.w0 = [
    ...runs,
    { id: 'fb', day: 'Fri', disc: 'Bike', focus: 'Threshold', dur: '1:30', zone: 'Z4' },
    { id: 'wb', day: 'Wed', disc: 'Bike', focus: 'Tempo', dur: '1:00', zone: 'Z3' },
    { id: 'sw', day: 'Thu', disc: 'Swim', focus: 'Easy', dur: '0:45', zone: 'Z2' },
    { id: 'lb', day: 'Sun', disc: 'Bike', focus: 'Long', dur: '3:00', zone: 'Z2' },
    ...more,
  ];
  p.done = {}; p.actuals = {};
  return p;
};
const bigRun = () => run('w0-1', 'Tue', '1:30', 'Z4');
const ids = (r) => r.proposals.map((p) => p.id);

test('no confirmed run, no proposals', () => {
  const p = mk([{ id: 'w0-1', day: 'Tue', disc: 'Run', focus: 'Easy', dur: '1:00', zone: 'Z2' }]);
  assert.deepEqual(proposeRebalance(p, 0).proposals, []);
});

test('a harder confirmed run eases Friday\'s bike, with the load numbers as the reason', () => {
  const r = proposeRebalance(mk([bigRun()]), 0);
  const ease = r.proposals.find((x) => x.kind === 'ease');
  assert.ok(ease);
  assert.equal(ease.sessionId, 'fb');
  assert.ok(ease.loadAfter < ease.loadBefore);
  assert.match(ease.reason, /Friday/);
});

test('Wednesday is kept the lightest day', () => {
  const r = proposeRebalance(mk([bigRun()]), 0);
  const kl = r.proposals.find((x) => x.kind === 'keep-light');
  assert.equal(kl?.sessionId, 'wb');
});

test('a week over the ceiling shortens Friday\'s bike within the cap', () => {
  const p = mk([bigRun(), run('w0-4', 'Sat', '2:30', 'Z2')], [{ id: 'x', day: 'Mon', disc: 'Strength', focus: 'S', dur: '1:00', zone: 'Z2' }]);
  p.weeks.w0.find((x) => x.id === 'lb').dur = '6:00';
  const total = p.weeks.w0.reduce((a, s) => a + durToMin(s.dur), 0);
  assert.ok(total > REBALANCE.maxHours * 60);
  const sh = proposeRebalance(p, 0).proposals.find((x) => x.kind === 'shorten');
  assert.ok(sh);
  assert.ok(durToMin(sh.change.dur) >= 45); // at most half of 1:30 is cut
});

test('past days, done and logged sessions are never proposed', () => {
  const p = mk([bigRun()]);
  p.done.fb = true;
  assert.ok(!ids(proposeRebalance(p, 0)).some((i) => i.startsWith('fb')));
  const q = mk([bigRun()]);
  q.actuals.wb = { status: 'done' };
  assert.ok(!ids(proposeRebalance(q, 0)).some((i) => i.startsWith('wb')));
  // today is Sat 2026-01-10: Wed and Fri are in the past
  const past = proposeRebalance(mk([bigRun()]), 0, { today: '2026-01-10' });
  assert.deepEqual(past.proposals, []);
});

test('accepting a subset applies only that subset, without touching the input', () => {
  const p = mk([bigRun()]);
  const before = JSON.stringify(p);
  const { proposals } = proposeRebalance(p, 0);
  const ease = proposals.find((x) => x.kind === 'ease');
  const draft = applyProposals(p, 0, proposals, [ease.id]);
  const fb = draft.weeks.w0.find((s) => s.id === 'fb');
  const wb = draft.weeks.w0.find((s) => s.id === 'wb');
  assert.ok(plannedLoad(fb) < plannedLoad(p.weeks.w0.find((s) => s.id === 'fb')));
  assert.equal(wb.zone, 'Z3'); // not accepted, unchanged
  assert.equal(fb.dur, '1:30');
  assert.equal(JSON.stringify(p), before);
});
