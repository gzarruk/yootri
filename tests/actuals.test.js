import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUSES, normalizeActual, setActual, getActual,
  actualMinutes, weekCompliance, seasonActuals, trailingCompliance,
} from '../assets/coach/actuals.js';
import { loadPlan, sessionsAt } from '../assets/coach/plan.js';
import { durToMin } from '../assets/coach/duration.js';

const base = () => loadPlan({
  id: 'p-1', name: 'T', start: '2026-01-05', weeks: {}, done: {}, view: { phase: 'Base', week: 0 },
});
const firstWorkout = (plan, w = 0) => sessionsAt(plan, w).find((s) => durToMin(s.dur) > 0);

test('the four statuses are the ones a training week actually produces', () => {
  assert.deepEqual(STATUSES, ['done', 'partial', 'missed', 'sick']);
});

test('normalizeActual clamps RPE to the Borg-style 1-10 range', () => {
  assert.equal(normalizeActual({ status: 'done', rpe: 42 }).rpe, 10);
  assert.equal(normalizeActual({ status: 'done', rpe: -3 }).rpe, 1);
  assert.equal(normalizeActual({ status: 'done', rpe: 'hard' }).rpe, null);
});

test('normalizeActual rejects a status it does not understand', () => {
  assert.equal(normalizeActual({ status: 'vibes' }), null);
  assert.equal(normalizeActual(null), null);
});

test('normalizeActual keeps minutes as a non-negative whole number', () => {
  assert.equal(normalizeActual({ status: 'partial', min: 47.6 }).min, 48);
  assert.equal(normalizeActual({ status: 'partial', min: -5 }).min, 0);
});

/* Logging one session. */

test('setActual records what happened without touching the plan it was given', () => {
  const p = base();
  const snap = JSON.parse(JSON.stringify(p));
  const s = firstWorkout(p);
  const next = setActual(p, s.id, { status: 'done', min: 50, rpe: 6 });
  assert.equal(getActual(next, s.id).min, 50);
  assert.deepEqual(p, snap, 'the source plan must be untouched');
});

test('logging a session keeps the existing done flag in step', () => {
  // The board, the completion percentage and the chart all still read `done`.
  // Actuals enrich that rather than forking a second source of truth.
  const p = base();
  const s = firstWorkout(p);
  assert.equal(setActual(p, s.id, { status: 'done' }).done[s.id], true);
  assert.equal(setActual(p, s.id, { status: 'partial', min: 20 }).done[s.id], true);
  assert.equal(setActual(p, s.id, { status: 'missed' }).done[s.id], undefined);
  assert.equal(setActual(p, s.id, { status: 'sick' }).done[s.id], undefined);
});

test('clearing an actual removes it and unmarks the session', () => {
  const p = base();
  const s = firstWorkout(p);
  const logged = setActual(p, s.id, { status: 'done' });
  const cleared = setActual(logged, s.id, null);
  assert.equal(getActual(cleared, s.id), null);
  assert.equal(cleared.done[s.id], undefined);
});

/* Turning a log into minutes. */

test('a session marked done with no number counts as the time planned', () => {
  const p = base();
  const s = firstWorkout(p);
  const next = setActual(p, s.id, { status: 'done' });
  assert.equal(actualMinutes(next, s), durToMin(s.dur));
});

test('an explicit number always wins over the plan', () => {
  const p = base();
  const s = firstWorkout(p);
  const next = setActual(p, s.id, { status: 'partial', min: 25 });
  assert.equal(actualMinutes(next, s), 25);
});

test('missed and sick sessions count as no training, whatever else was typed', () => {
  const p = base();
  const s = firstWorkout(p);
  for (const status of ['missed', 'sick']) {
    assert.equal(actualMinutes(setActual(p, s.id, { status, min: 90 }), s), 0, status);
  }
});

test('an unlogged session counts as nothing', () => {
  const p = base();
  assert.equal(actualMinutes(p, firstWorkout(p)), 0);
});

test('a plan predating actuals still reads its old done flags as completed', () => {
  // Existing plans have `done` and no `actuals`; their history must not vanish.
  const p = base();
  const s = firstWorkout(p);
  const legacy = { ...p, done: { [s.id]: true }, actuals: {} };
  assert.equal(actualMinutes(legacy, s), durToMin(s.dur));
});

/* Rolling it up. */

test('weekCompliance compares what happened against what was planned', () => {
  const p = base();
  const week = sessionsAt(p, 0).filter((s) => durToMin(s.dur) > 0);
  let next = p;
  for (const s of week) next = setActual(next, s.id, { status: 'done' });

  const c = weekCompliance(next, 0);
  assert.equal(c.plannedMinutes, week.reduce((a, s) => a + durToMin(s.dur), 0));
  assert.equal(c.actualMinutes, c.plannedMinutes);
  assert.equal(c.ratio, 1);
  assert.equal(c.logged, week.length);
});

test('a half-completed week reports a ratio below one', () => {
  const p = base();
  const week = sessionsAt(p, 0).filter((s) => durToMin(s.dur) > 0);
  const next = setActual(p, week[0].id, { status: 'done' });
  const c = weekCompliance(next, 0);
  assert.ok(c.ratio > 0 && c.ratio < 1, `expected a partial ratio, got ${c.ratio}`);
  assert.equal(c.logged, 1);
});

test('an untouched week has a ratio of zero rather than a divide by zero', () => {
  const c = weekCompliance(base(), 3);
  assert.equal(c.actualMinutes, 0);
  assert.equal(c.ratio, 0);
  assert.ok(Number.isFinite(c.ratio));
});

test('seasonActuals returns one entry per week, in order', () => {
  const p = base();
  const rows = seasonActuals(p);
  assert.equal(rows.length, p.season.length);
  assert.deepEqual(rows.map((r) => r.absWeek), p.season.map((w) => w.absWeek));
  assert.ok(rows.every((r) => r.plannedMinutes > 0));
});

test('seasonActuals marks which weeks have been logged at all', () => {
  const p = base();
  const s = firstWorkout(p, 2);
  const rows = seasonActuals(setActual(p, s.id, { status: 'done' }));
  assert.equal(rows[2].logged, 1);
  assert.equal(rows[0].logged, 0);
});

/* What the adaptation rules will read. */

test('trailingCompliance averages the weeks leading up to a point', () => {
  const p = base();
  let next = p;
  for (const s of sessionsAt(p, 0).filter((x) => durToMin(x.dur) > 0)) {
    next = setActual(next, s.id, { status: 'done' });
  }
  // Week 0 fully done, week 1 untouched -> averaged over both, well under 1.
  const c = trailingCompliance(next, 2, 2);
  assert.ok(c.ratio > 0 && c.ratio < 1, `got ${c.ratio}`);
  assert.equal(c.weeks, 2);
});

test('trailingCompliance ignores weeks nobody has reached yet', () => {
  const p = base();
  const c = trailingCompliance(p, 0, 4);
  assert.equal(c.weeks, 0, 'nothing before week 0 to average');
  assert.equal(c.ratio, 0);
});

test('trailingCompliance reports mean RPE where it was recorded', () => {
  const p = base();
  const week = sessionsAt(p, 0).filter((s) => durToMin(s.dur) > 0);
  let next = p;
  next = setActual(next, week[0].id, { status: 'done', rpe: 4 });
  next = setActual(next, week[1].id, { status: 'done', rpe: 8 });
  assert.equal(trailingCompliance(next, 1, 1).meanRpe, 6);
});

test('mean RPE is null rather than zero when nobody recorded any', () => {
  const p = base();
  const s = firstWorkout(p);
  assert.equal(trailingCompliance(setActual(p, s.id, { status: 'done' }), 1, 1).meanRpe, null);
});

test('a week with nothing planned reports zero, not NaN', () => {
  // A rest-only or not-yet-generated week has no planned minutes at all, so the
  // ratio is a genuine 0/0. It must not leak NaN into the chart or the
  // adaptation rules, where it would poison every average downstream.
  const p = base();
  const empty = { ...p, weeks: { ...p.weeks, w0: [] } };
  const c = weekCompliance(empty, 0);
  assert.equal(c.plannedMinutes, 0);
  assert.equal(c.ratio, 0);
  assert.ok(Number.isFinite(c.ratio), 'ratio must stay a real number');
  assert.ok(Number.isFinite(trailingCompliance(empty, 1, 1).ratio));
});

test('a missed or sick session stores no duration, whatever was typed', () => {
  // The compliance maths already treats these as zero, but storing a number on
  // a session that did not happen leaves a record that reads as a lie to
  // anything reading actuals directly — a later export, or the coach agent.
  for (const status of ['missed', 'sick']) {
    assert.equal(normalizeActual({ status, min: 135 }).min, null, status);
  }
  assert.equal(normalizeActual({ status: 'partial', min: 135 }).min, 135);
});

test('a missed session keeps its RPE and note, which can still be meaningful', () => {
  const a = normalizeActual({ status: 'sick', min: 60, rpe: 9, note: 'flu' });
  assert.equal(a.min, null);
  assert.equal(a.rpe, 9);
  assert.equal(a.note, 'flu');
});
