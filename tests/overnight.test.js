import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OVERNIGHT, normalizeNight, mergeOvernight, overnightNights, overnightSyncWindow, compareNights,
} from '../assets/coach/overnight.js';
import { toISO, addDays, parseISO } from '../assets/coach/dates.js';

// The bridge's own output for the same payloads its tests use. 437 / 61 / 47
// are distinctive on purpose: other tests look for them where they must not be.
const GOLDEN = JSON.parse(readFileSync(
  new URL('../tools/garmin-bridge/tests/golden/overnight-v1.json', import.meta.url), 'utf8'));

const TODAY = '2026-10-12';
const day = (n) => toISO(addDays(parseISO(TODAY), n));   // day(0) is today, day(-1) yesterday

/** A store with `fn(offset)` → night for every day from `from` to `to` days from today. */
function storeOf(fn, { from = -34, to = 0 } = {}) {
  const nights = [];
  for (let i = from; i <= to; i++) {
    const n = fn(i);
    if (n) nights.push({ date: day(i), ...n });
  }
  return mergeOvernight(null, nights, { today: TODAY, until: TODAY });
}

// A usual month with a little day-to-day spread in every figure.
const wobble = (i, a, b) => (i % 2 ? a : b);
const usual = (i) => ({ sleepMin: wobble(i, 440, 460), hrvMs: wobble(i, 58, 62), restingHr: wobble(i, 47, 49) });

/* ---- one night ---- */

test('a night is at most three numbers and a date', () => {
  assert.deepEqual(
    normalizeNight({ date: '2026-10-05', sleepMin: 437, hrvMs: 61, restingHr: 47, sleepScore: 77, status: 'BALANCED', hr: { avg: 173 } }),
    { date: '2026-10-05', sleepMin: 437, hrvMs: 61, restingHr: 47 },
  );
});

test('an implausible figure is dropped, not clamped, and a night with none left is nothing', () => {
  assert.deepEqual(normalizeNight({ date: '2026-10-05', sleepMin: 15, hrvMs: 61, restingHr: 300 }), { date: '2026-10-05', hrvMs: 61 });
  assert.equal(normalizeNight({ date: '2026-10-05', sleepMin: 15 }), null);
  for (const bad of [null, 'x', {}, { date: '2026-13-01', hrvMs: 50 }, { date: '2026-10-05', hrvMs: '50' }]) {
    assert.equal(normalizeNight(bad), null, JSON.stringify(bad));
  }
});

test('the bridge’s golden output is read exactly as it was written', () => {
  assert.deepEqual(GOLDEN.map(normalizeNight), GOLDEN);
});

/* ---- the store in this browser ---- */

test('a later sync of the same night wins, figure by figure', () => {
  let store = mergeOvernight(null, [{ date: day(-1), sleepMin: 400, hrvMs: 50 }], { today: TODAY, until: day(-1) });
  // The watch synced late: sleep is revised and resting heart rate arrives;
  // HRV did not come this time and the one already held is kept.
  store = mergeOvernight(store, [{ date: day(-1), sleepMin: 420, restingHr: 48 }], { today: TODAY, until: TODAY });
  assert.deepEqual(overnightNights(store), [{ date: day(-1), sleepMin: 420, hrvMs: 50, restingHr: 48 }]);
  assert.equal(store.through, TODAY);
});

test('the store keeps what a baseline needs and lets older nights go', () => {
  const store = mergeOvernight(null, [
    { date: day(-200), sleepMin: 400 },
    { date: day(-OVERNIGHT.keepDays + 1), sleepMin: 410 },
  ], { today: TODAY, until: TODAY });
  assert.deepEqual(overnightNights(store).map((n) => n.date), [day(-OVERNIGHT.keepDays + 1)]);
});

test('merging never changes the store it was given', () => {
  const held = mergeOvernight(null, [{ date: day(-2), sleepMin: 400 }], { today: TODAY, until: TODAY });
  const copy = structuredClone(held);
  mergeOvernight(held, [{ date: day(-2), sleepMin: 300 }], { today: TODAY, until: TODAY });
  assert.deepEqual(held, copy);
});

test('a hand-edited store gives back only what a night may hold', () => {
  const store = { v: 1, through: TODAY, byDate: { [day(-1)]: { s: 430, h: 55, r: 50, weight: 72, hr: 173 }, nope: { s: 400 } } };
  assert.deepEqual(overnightNights(store), [{ date: day(-1), sleepMin: 430, hrvMs: 55, restingHr: 50 }]);
  assert.deepEqual(overnightNights(null), []);
});

/* ---- what to ask the bridge for ---- */

test('the first sync reaches back far enough for a baseline; later ones overlap the last', () => {
  assert.deepEqual(overnightSyncWindow(null, { today: TODAY }), { since: day(-OVERNIGHT.firstSyncDays), until: TODAY });
  const store = mergeOvernight(null, [], { today: TODAY, until: day(-5) });
  assert.deepEqual(overnightSyncWindow(store, { today: TODAY }), { since: day(-5 - OVERNIGHT.overlapDays), until: TODAY });
});

test('a long gap asks for no more than the bridge allows', () => {
  const store = mergeOvernight(null, [], { today: day(-400), until: day(-400) });
  const w = overnightSyncWindow(store, { today: TODAY });
  assert.equal(w.since, day(-OVERNIGHT.maxRangeDays));
  assert.equal(overnightSyncWindow(null, { today: 'not a date' }), null);
});

/* ---- this week against the athlete's own usual ---- */

test('with too few nights nothing is said', () => {
  const c = compareNights(storeOf(usual, { from: -5 }), { today: TODAY });
  for (const f of Object.values(c.figures)) assert.equal(f.enough, false);
  assert.deepEqual(c.outside, []);
  assert.equal(c.offer, false);
});

test('a usual week is inside the usual range', () => {
  const c = compareNights(storeOf(usual), { today: TODAY });
  assert.equal(c.figures.sleepMin.enough, true);
  assert.deepEqual(c.outside, []);
  assert.equal(c.offer, false);
  assert.equal(c.from, day(-OVERNIGHT.recentDays + 1));
  assert.equal(c.to, TODAY);
});

test('two figures outside the usual range together make an offer', () => {
  const store = storeOf((i) => (i > -OVERNIGHT.recentDays
    ? { sleepMin: 380, hrvMs: 48, restingHr: 48 }
    : usual(i)));
  const c = compareNights(store, { today: TODAY });
  assert.deepEqual(c.outside, ['sleepMin', 'hrvMs']);
  assert.equal(c.figures.sleepMin.direction, 'below');
  assert.equal(c.figures.sleepMin.recent.mean, 380);
  assert.ok(c.figures.sleepMin.usual.lo > 380);
  assert.equal(c.offer, true);
});

test('one figure on its own is not enough to offer anything', () => {
  const store = storeOf((i) => (i > -OVERNIGHT.recentDays ? { ...usual(i), sleepMin: 380 } : usual(i)));
  const c = compareNights(store, { today: TODAY });
  assert.deepEqual(c.outside, ['sleepMin']);
  assert.equal(c.offer, false);
});

test('only the direction that counts counts: more sleep, a higher HRV and a lower resting heart rate are not flagged', () => {
  const store = storeOf((i) => (i > -OVERNIGHT.recentDays
    ? { sleepMin: 520, hrvMs: 75, restingHr: 42 }
    : usual(i)));
  const c = compareNights(store, { today: TODAY });
  assert.deepEqual(c.outside, []);
  assert.equal(c.figures.hrvMs.direction, null);
});

test('a resting heart rate above the usual range counts', () => {
  const store = storeOf((i) => (i > -OVERNIGHT.recentDays
    ? { sleepMin: 380, hrvMs: 60, restingHr: 55 }
    : usual(i)));
  assert.deepEqual(compareNights(store, { today: TODAY }).outside, ['sleepMin', 'restingHr']);
});

test('a perfectly flat month gives no range to be outside of', () => {
  const store = storeOf((i) => (i > -OVERNIGHT.recentDays ? { restingHr: 52 } : { restingHr: 48 }));
  const c = compareNights(store, { today: TODAY });
  assert.equal(c.figures.restingHr.usual, null);
  assert.deepEqual(c.outside, []);
});

test('a figure the watch does not record is simply absent', () => {
  const store = storeOf((i) => ({ sleepMin: usual(i).sleepMin }));
  const c = compareNights(store, { today: TODAY });
  assert.equal(c.figures.hrvMs.enough, false);
  assert.equal(c.figures.hrvMs.recent.n, 0);
});

test('the usual range is the four weeks before the last seven nights, not including them', () => {
  // A month of short sleep, then a usual week: the week is *above* that month,
  // which is not something to flag.
  const store = storeOf((i) => (i > -OVERNIGHT.recentDays ? usual(i) : { ...usual(i), sleepMin: wobble(i, 370, 390) }));
  const c = compareNights(store, { today: TODAY });
  assert.equal(c.figures.sleepMin.usual.n, OVERNIGHT.baselineDays);
  assert.equal(c.figures.sleepMin.recent.n, OVERNIGHT.recentDays);
  assert.deepEqual(c.outside, []);
});
