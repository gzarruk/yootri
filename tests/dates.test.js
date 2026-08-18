import test from 'node:test';
import assert from 'node:assert/strict';

import { parseISO, toISO, addDays, mondayOf, weeksUntil } from '../assets/coach/dates.js';

/* Week counting decides how long a season is, so it has to be exact. All of it
   is done in UTC day-numbers rather than local Date arithmetic: a season that
   crosses a daylight-saving boundary must not gain or lose a week. */

test('parseISO and toISO round-trip', () => {
  assert.equal(toISO(parseISO('2026-08-18')), '2026-08-18');
  assert.equal(toISO(parseISO('2027-01-01')), '2027-01-01');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(toISO(addDays(parseISO('2026-01-31'), 1)), '2026-02-01');
  assert.equal(toISO(addDays(parseISO('2026-12-31'), 1)), '2027-01-01');
  assert.equal(toISO(addDays(parseISO('2026-03-01'), -1)), '2026-02-28');
});

test('mondayOf snaps any day back to its own Monday', () => {
  // 2026-08-18 is a Tuesday.
  assert.equal(mondayOf('2026-08-18'), '2026-08-17');
  assert.equal(mondayOf('2026-08-17'), '2026-08-17', 'a Monday is its own Monday');
  assert.equal(mondayOf('2026-08-23'), '2026-08-17', 'Sunday belongs to the week that began');
});

test('a race in the same week is a one-week season', () => {
  assert.equal(weeksUntil('2026-08-17', '2026-08-20'), 1);
});

test('weeksUntil counts the race week itself', () => {
  assert.equal(weeksUntil('2026-08-17', '2026-08-24'), 2);
  assert.equal(weeksUntil('2026-08-17', '2026-09-07'), 4);
});

test('weeksUntil works from any day of the start week', () => {
  // Starting Wednesday should give the same answer as starting that Monday.
  assert.equal(weeksUntil('2026-08-19', '2026-09-07'), weeksUntil('2026-08-17', '2026-09-07'));
});

test('a season crossing daylight saving does not gain or lose a week', () => {
  // UK clocks go back on 2026-10-25 and forward on 2027-03-28.
  assert.equal(weeksUntil('2026-10-19', '2026-11-02'), 3);
  assert.equal(weeksUntil('2027-03-22', '2027-04-05'), 3);
});

test('a long build reaches the expected length', () => {
  // 2026-08-17 to 2027-06-14 inclusive.
  assert.equal(weeksUntil('2026-08-17', '2027-06-14'), 44);
});

test('a race in the past is not a negative season', () => {
  assert.equal(weeksUntil('2026-08-17', '2026-07-01'), 1);
});

test('a missing race date has no answer rather than a wrong one', () => {
  assert.equal(weeksUntil('2026-08-17', null), null);
  assert.equal(weeksUntil('2026-08-17', ''), null);
  assert.equal(weeksUntil(null, '2026-09-07'), null);
});
