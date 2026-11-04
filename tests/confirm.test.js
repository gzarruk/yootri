import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmWeek, zoneFromSteps } from '../assets/coach/confirm.js';
import { newPlan } from '../assets/coach/plan.js';
import { plannedLoad } from '../assets/coach/fitness.js';

// w0 of a fresh plan: w0-1 Tue Run 1:00, w0-4 Fri Run 0:30; w0-5 Sat Bike. Ids are the generator's,
// because "edited" and "revert" are judged against what the generator would make.
const mk = () => {
  const p = newPlan({ name: 'C', startISO: '2026-01-05', now: 1 });
  p.weeks.w0 = p.weeks.w0.map((s) => ({ ...s }));
  p.weeks.w0.push({ id: 'w0-x', day: 'Thu', disc: 'Run', focus: 'Easy', dur: '0:40', zone: 'Z2' });
  p.done = {}; p.actuals = {};
  return p;
};
const g = (id, day, min, extra = {}) => ({ garminId: id, day, name: `R${id}`, durationS: min * 60, ...extra });
const get = (r, id) => r.sessions.find((s) => s.id === id);

test('empty list is "not published": nothing changes', () => {
  const p = mk();
  const r = confirmWeek(p, 0, []);
  assert.equal(r.published, false);
  assert.deepEqual(r.sessions, p.weeks.w0);
});

test('same-day runs replace placeholders and are marked confirmed', () => {
  const r = confirmWeek(mk(), 0, [g(1, 'Tue', 45), g(2, 'Thu', 30), g(3, 'Fri', 80)]);
  assert.equal(get(r, 'w0-1').dur, '0:45');
  assert.equal(get(r, 'w0-1').status, 'confirmed');
  assert.equal(get(r, 'w0-1').garminId, 1);
  assert.equal(get(r, 'w0-4').dur, '1:20');
  assert.equal(get(r, 'w0-2').status, undefined); // the bike is untouched
});

test('a run on another weekday: the longest takes the longest placeholder, id kept', () => {
  const r = confirmWeek(mk(), 0, [g(1, 'Mon', 40), g(2, 'Wed', 90)]);
  const long = r.sessions.find((s) => s.garminId === 2);
  assert.equal(long.id, 'w0-1'); // the 1:00 placeholder
  assert.equal(long.day, 'Wed');
  assert.equal(r.sessions.find((s) => s.garminId === 1).day, 'Mon');
  assert.equal(r.unmatched.length, 1);
});

test('more runs than placeholders adds one', () => {
  const r = confirmWeek(mk(), 0, [g(1, 'Tue', 30), g(2, 'Wed', 30), g(3, 'Thu', 30), g(4, 'Sun', 30)]);
  assert.equal(r.changes.filter((c) => c.kind === 'added').length, 1);
  assert.equal(r.sessions.filter((s) => s.disc === 'Run').length, 4);
});

test('done, logged and edited sessions are never overwritten', () => {
  const p = mk();
  p.done['w0-1'] = true;
  p.actuals['w0-x'] = { status: 'done' };
  p.weeks.w0[4] = { ...p.weeks.w0[4], dur: '2:00' }; // w0-4, edited by the athlete
  const r = confirmWeek(p, 0, [g(1, 'Tue', 45), g(2, 'Thu', 45), g(3, 'Fri', 45)]);
  assert.equal(get(r, 'w0-1').dur, '1:00');
  assert.equal(get(r, 'w0-x').dur, '0:40');
  assert.equal(get(r, 'w0-4').dur, '2:00');
  assert.equal(r.sessions.filter((s) => s.status === 'confirmed').length, 0 + r.changes.filter((c) => c.kind === 'added').length);
});

test('a re-sync updates in place; a removed run reverts to its placeholder', () => {
  const first = confirmWeek(mk(), 0, [g(1, 'Tue', 45), g(2, 'Fri', 30)]);
  const p = mk(); p.weeks.w0 = first.sessions;
  const again = confirmWeek(p, 0, [g(1, 'Tue', 50), g(2, 'Fri', 30)]);
  assert.equal(get(again, 'w0-1').dur, '0:50');
  assert.equal(again.sessions.length, first.sessions.length);
  const gone = confirmWeek(p, 0, [g(1, 'Tue', 45)]);
  assert.equal(get(gone, 'w0-4').status, undefined);
  assert.equal(get(gone, 'w0-4').dur, '0:30');
});

test('run-walk steps drive zone and planned load', () => {
  const steps = [
    { kind: 'warmup', sec: 600, zone: 'Z1' },
    { kind: 'run', sec: 300, zone: 'Z3' }, { kind: 'walk', sec: 60 },
    { kind: 'run', sec: 300, zone: 'Z3' }, { kind: 'walk', sec: 60 },
    { kind: 'cooldown', sec: 600, zone: 'Z1' },
  ];
  assert.equal(zoneFromSteps(steps), 'Z3');
  const r = confirmWeek(mk(), 0, [g(1, 'Tue', 48, { steps })]);
  const s = get(r, 'w0-1');
  assert.deepEqual(s.steps, steps);
  const load = plannedLoad(s);
  assert.ok(load > 0 && load < plannedLoad({ ...s, steps: undefined, dur: '0:48', zone: 'Z3' }));
});
