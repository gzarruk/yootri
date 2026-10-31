import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProfile } from '../assets/coach/profile.js';
import {
  resolveCounts, patternSlots, nextDrop, recoveryDropCount, DROP_ORDER,
} from '../assets/coach/pattern.js';

const WEEK = { Mon: 0, Tue: 90, Wed: 90, Thu: 120, Fri: 75, Sat: 240, Sun: 240 };
const profile = (extra = {}) => normalizeProfile({
  availability: WEEK,
  weekPattern: {
    Run: ['Tue', 'Thu', 'Sat'], Bike: ['Wed', 'Thu', 'Sun'],
    Strength: ['Wed', 'Tue', 'Fri'], Swim: ['Fri', 'Sat', 'Sun'],
  },
  sessionCounts: {
    Base: { Run: 3, Bike: 3, Strength: 3, Swim: 1 },
    'Base 3': { Strength: 2, Swim: 2 },
    Build: { Run: 3, Bike: 3, Strength: 1, Swim: 2 },
    Peak: { Run: 3, Bike: 3, Strength: 1, Swim: 2 },
  },
  ...extra,
});

/* ---- counts resolve like splits: exact block, then family ---- */

test('an exact block beats its family, per discipline', () => {
  const p = profile();
  assert.deepEqual(resolveCounts('Base 1', 'Base', p), { Swim: 1, Bike: 3, Run: 3, Strength: 3 });
  // Base 3 overrides only strength and swim; the rest still come from Base.
  assert.deepEqual(resolveCounts('Base 3', 'Base', p), { Swim: 2, Bike: 3, Run: 3, Strength: 2 });
});

test('a taper week takes the Peak counts, and its own when it has them', () => {
  const p = profile();
  assert.deepEqual(resolveCounts('Taper', 'Peak', p), resolveCounts('Peak', 'Peak', p));
  const own = profile({ sessionCounts: { Peak: { Swim: 2 }, Taper: { Swim: 1 } } });
  assert.equal(resolveCounts('Taper', 'Peak', own).Swim, 1);
  assert.equal(resolveCounts('Peak', 'Peak', own).Swim, 2);
});

test('Prep, Race and a profile with no counts resolve to nothing', () => {
  const p = profile();
  assert.deepEqual(resolveCounts('Prep', 'Prep', p), {});
  assert.deepEqual(resolveCounts('Race', 'Race', p), {});
  assert.deepEqual(resolveCounts('Base 1', 'Base', normalizeProfile({})), {});
});

/* ---- slots: the first N listed days that can be used ---- */

test('a discipline takes the first N days of its list', () => {
  const p = profile();
  assert.deepEqual(patternSlots(p, 'Run', 3).days, ['Tue', 'Thu', 'Sat']);
  assert.deepEqual(patternSlots(p, 'Run', 2).days, ['Tue', 'Thu']);
  assert.deepEqual(patternSlots(p, 'Run', 0).days, []);
});

test('a closed day is skipped and the next listed day takes the slot', () => {
  const p = profile();
  const r = patternSlots(p, 'Swim', 2, { closedDays: ['Sat', 'Sun'] });
  assert.deepEqual(r.days, ['Fri']);          // the list ran out: the slot is dropped
  assert.equal(r.lost, 1);
  const r2 = patternSlots(p, 'Swim', 2, { closedDays: ['Sat'] });
  assert.deepEqual(r2.days, ['Fri', 'Sun']);  // Sun takes Sat's slot
  assert.deepEqual(r2.displaced, ['Sat']);
});

test('a day with no time, or ruled out by a constraint, is skipped', () => {
  const noTime = profile({ availability: { ...WEEK, Thu: 0 } });
  assert.deepEqual(patternSlots(noTime, 'Run', 3).days, ['Tue', 'Sat']);
  const ruledOut = profile({ constraints: [{ disc: 'Run', rule: 'avoidDays', value: ['Thu'] }] });
  assert.deepEqual(patternSlots(ruledOut, 'Run', 3).days, ['Tue', 'Sat']);
  assert.deepEqual(patternSlots(ruledOut, 'Run', 2).days, ['Tue', 'Sat']);
});

test('maxPerWeek caps the slots silently, keeping the earliest days', () => {
  const capped = profile({ constraints: [{ disc: 'Swim', rule: 'maxPerWeek', value: 2 }] });
  assert.deepEqual(patternSlots(capped, 'Swim', 3).days, ['Fri', 'Sat']);
  assert.equal(patternSlots(capped, 'Swim', 3).lost, 0);
});

test('a day too short for a session of that discipline is not a slot', () => {
  const p = profile({ availability: { ...WEEK, Fri: 20 } });
  assert.deepEqual(patternSlots(p, 'Swim', 1, { floor: 25 }).days, ['Sat']);
  assert.deepEqual(patternSlots(p, 'Swim', 1).days, ['Fri']);
});

test('a discipline with no list has no slots', () => {
  assert.deepEqual(patternSlots(normalizeProfile({}), 'Run', 3).days, []);
});

/* ---- the drop order for small weeks and recovery weeks ---- */

const sess = (disc, day, minutes, rank, isLong = false) => ({ disc, day, minutes, rank, isLong });

test('the drop order is documented: extra strength, extra swim, then easy bike and run', () => {
  assert.deepEqual(DROP_ORDER, ['extra strength', 'extra swim', 'easy bike or run']);
});

test('extra strength goes first, last slot first, then extra swim, then the smallest easy ride or run', () => {
  let left = [
    sess('Strength', 'Wed', 45, 0), sess('Strength', 'Tue', 45, 1), sess('Swim', 'Fri', 40, 0), sess('Swim', 'Sat', 40, 1),
    sess('Bike', 'Wed', 60, 1), sess('Bike', 'Sun', 150, 0, true), sess('Run', 'Tue', 35, 1), sess('Run', 'Sat', 90, 0, true),
  ];
  const order = [];
  for (let s; (s = nextDrop(left)); ) { order.push(`${s.disc}-${s.day}`); left = left.filter((x) => x !== s); }
  assert.deepEqual(order, ['Strength-Tue', 'Swim-Sat', 'Run-Tue', 'Bike-Wed']);
  // What is left is each discipline's only session, and the long ride and run.
  assert.deepEqual(left.map((s) => `${s.disc}-${s.day}`).sort(), ['Bike-Sun', 'Run-Sat', 'Strength-Wed', 'Swim-Fri']);
});

test('nothing droppable means null', () => {
  assert.equal(nextDrop([sess('Bike', 'Sun', 150, 0, true), sess('Swim', 'Fri', 40, 0)]), null);
  assert.equal(nextDrop([]), null);
});

test('a recovery week turns one slot into a day off under eight slots, two from eight', () => {
  assert.equal(recoveryDropCount(7), 1);
  assert.equal(recoveryDropCount(8), 2);
  assert.equal(recoveryDropCount(12), 2);
  assert.equal(recoveryDropCount(1), 1);
});
