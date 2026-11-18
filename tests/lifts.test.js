import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFT_SESSIONS, ROTATION, liftSessionById, normalizeLifts, tickBoxes, sessionTicks,
  sessionProgress, trackedLifts, liftLog, topSetSeries, lastKg, nextInRotation,
} from '../assets/coach/lifts.js';
import { normalizeActual, setActual } from '../assets/coach/actuals.js';
import { loadPlan } from '../assets/coach/plan.js';

const plan = () => loadPlan({
  id: 'p-1', name: 'T', schema: 3, start: '2026-01-05', done: {}, view: { phase: 'Base', week: 0 },
  weeks: {
    w0: [{ id: 'w0-1', day: 'Tue', disc: 'Strength', focus: 'Strength', dur: '0:55', zone: 'Z2', desc: '' }],
    w1: [{ id: 'w1-1', day: 'Tue', disc: 'Strength', focus: 'Strength', dur: '0:55', zone: 'Z2', desc: '' }],
    w2: [{ id: 'w2-1', day: 'Thu', disc: 'Strength', focus: 'Strength', dur: '0:55', zone: 'Z2', desc: '' }],
  },
});
const log = (p, id, session, kg) => setActual(p, id, { status: 'done', min: 55, lifts: { session, kg } });

test('there are six sessions, in a rotation that names each once', () => {
  assert.equal(LIFT_SESSIONS.length, 6);
  assert.deepEqual([...ROTATION].sort(), LIFT_SESSIONS.map((s) => s.id).sort());
});

test('every weighted lift has sets, and every exercise id is unique inside its session', () => {
  for (const s of LIFT_SESSIONS) {
    const ids = s.sections.flatMap((sec) => (sec.items || []).map((i) => i.id).filter(Boolean));
    assert.equal(new Set(ids).size, ids.length, s.id);
    for (const sec of s.sections) for (const i of sec.items || []) if (i.weighted) assert.ok(i.sets > 0, i.id);
  }
});

test('only the leg sessions take weights', () => {
  const lifts = trackedLifts();
  assert.deepEqual(lifts.map((l) => l.id).sort(), ['bss', 'calf', 'carry', 'hip', 'ramp', 'scalf', 'slrdl', 'step', 'tbdl']);
  for (const l of lifts) for (const id of l.sessions) assert.equal(liftSessionById(id).kind, 'legs');
});

test('normalizeLifts keeps positive weights to a tenth and drops the rest', () => {
  const out = normalizeLifts({ session: 'l1', kg: { 'tbdl-1': '72.54', 'tbdl-2': 0, 'tbdl-3': -5, 'bss-1': 'heavy', 'ramp-1': 501, 'bad key': 4, 'calf-1': 40 } });
  assert.deepEqual(out, { session: 'l1', kg: { 'tbdl-1': 72.5, 'calf-1': 40 } });
});

test('normalizeLifts refuses an unknown session and a non-object', () => {
  assert.equal(normalizeLifts({ session: 'zz', kg: {} }), null);
  assert.equal(normalizeLifts(null), null);
  assert.equal(normalizeLifts('l1'), null);
  assert.deepEqual(normalizeLifts({ session: 'c1' }), { session: 'c1', kg: {} });
});

test('tick boxes: two per set for a one-sided lift, one otherwise', () => {
  const l1 = liftSessionById('l1');
  const bss = l1.sections.flatMap((s) => s.items || []).find((i) => i.id === 'bss');
  assert.equal(tickBoxes(bss).length, bss.sets * 2);
  assert.deepEqual(tickBoxes(bss).slice(0, 2).map((t) => t.label), ['Right', 'Left']);
  assert.equal(new Set(sessionTicks(l1)).size, sessionTicks(l1).length);
});

test('sessionProgress counts the ticks that are set', () => {
  const l1 = liftSessionById('l1');
  const keys = sessionTicks(l1);
  const p = sessionProgress(l1, { [keys[0]]: true, [keys[1]]: true, nonsense: true });
  assert.deepEqual(p, { done: 2, total: keys.length });
});

test('an actual carries its lifts, and only for a session that happened', () => {
  const a = normalizeActual({ status: 'done', min: 50, lifts: { session: 'l1', kg: { 'tbdl-1': 80 } } });
  assert.deepEqual(a.lifts, { session: 'l1', kg: { 'tbdl-1': 80 } });
  assert.equal('lifts' in normalizeActual({ status: 'done', min: 50 }), false);
  assert.equal('lifts' in normalizeActual({ status: 'done', lifts: { session: 'zz', kg: {} } }), false);
  assert.equal('lifts' in normalizeActual({ status: 'missed', lifts: { session: 'l1', kg: { 'tbdl-1': 80 } } }), false);
});

test('liftLog lists logged sessions oldest first, dated from the plan', () => {
  let p = plan();
  p = log(p, 'w2-1', 'l2', { 'step-1': 30 });
  p = log(p, 'w0-1', 'l1', { 'tbdl-1': 70 });
  assert.deepEqual(liftLog(p).map((e) => [e.date, e.session]), [['2026-01-06', 'l1'], ['2026-01-22', 'l2']]);
});

test('topSetSeries is the heaviest set per session, newest last', () => {
  let p = plan();
  p = log(p, 'w0-1', 'l1', { 'tbdl-1': 70, 'tbdl-2': 75, 'tbdl-3': 72.5 });
  p = log(p, 'w1-1', 'l1', { 'tbdl-1': 72.5, 'tbdl-2': 80 });
  assert.deepEqual(topSetSeries(p, 'tbdl').map((r) => r.kg), [75, 80]);
  assert.deepEqual(topSetSeries(p, 'tbdl', 1).map((r) => r.kg), [80]);
  assert.deepEqual(topSetSeries(p, 'calf'), []);
});

test('lastKg is the most recent weight of that set, or 0', () => {
  let p = plan();
  p = log(p, 'w0-1', 'l1', { 'tbdl-1': 70 });
  p = log(p, 'w1-1', 'l1', { 'tbdl-1': 72.5 });
  assert.equal(lastKg(p, 'tbdl', 1), 72.5);
  assert.equal(lastKg(p, 'tbdl', 1, { before: '2026-01-13' }), 70);
  assert.equal(lastKg(p, 'tbdl', 2), 0);
});

test('nextInRotation starts at C1 and follows the last session logged', () => {
  let p = plan();
  assert.equal(nextInRotation(p), 'c1');
  p = log(p, 'w0-1', 'c1', {});
  assert.equal(nextInRotation(p), 'l1');
  p = log(p, 'w1-1', 'c4', {});
  assert.equal(nextInRotation(p), 'c1');
});

test('a plan file that carries lifts survives load with only allowed fields', () => {
  let p = plan();
  p = log(p, 'w0-1', 'l1', { 'tbdl-1': 70 });
  p.actuals['w0-1'].lifts.kg.evil = 99;
  p.actuals['w0-1'].lifts.heartRate = 150;
  const again = loadPlan(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(again.actuals['w0-1'].lifts, { session: 'l1', kg: { 'tbdl-1': 70 } });
});
