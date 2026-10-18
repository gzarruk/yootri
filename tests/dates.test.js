import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseISO, toISO, addDays, mondayOf, weeksUntil, nextMonday, snapToMonday, sayDate,
} from '../assets/coach/dates.js';

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

/* Where a new plan starts. `mondayOf(today)` is the Monday *before* today, which
   starts a plan in the past on six days of seven; a plan starts on a Monday that
   has not happened yet. */

test('nextMonday is the first Monday on or after tomorrow', () => {
  assert.equal(nextMonday('2026-10-18'), '2026-10-19', 'Sunday: tomorrow is a Monday');
  assert.equal(nextMonday('2026-10-17'), '2026-10-19', 'Saturday');
  assert.equal(nextMonday('2026-10-14'), '2026-10-19', 'Wednesday');
  assert.equal(nextMonday('2026-10-19'), '2026-10-26', 'on a Monday, the next one: today is already under way');
  assert.equal(nextMonday('2026-10-20'), '2026-10-26', 'Tuesday');
});

test('nextMonday is never today, never in the past, and always a Monday', () => {
  for (let i = 0; i < 400; i++) {
    const today = toISO(addDays(parseISO('2026-01-01'), i));
    const start = nextMonday(today);
    assert.ok(start > today, `${today} -> ${start}`);
    assert.equal(parseISO(start).getUTCDay(), 1, `${start} is a Monday`);
    assert.ok(start <= toISO(addDays(parseISO(today), 7)), 'and no later than a week out');
  }
});

test('nextMonday crosses a daylight-saving change and a year end', () => {
  assert.equal(nextMonday('2026-10-24'), '2026-10-26');
  assert.equal(nextMonday('2026-12-30'), '2027-01-04');
});

test('nextMonday answers null for a date it cannot read', () => {
  assert.equal(nextMonday(''), null);
  assert.equal(nextMonday(undefined), null);
  assert.equal(nextMonday('soon'), null);
});

test('a chosen start snaps forward to a Monday', () => {
  const today = '2026-10-14'; // a Wednesday
  assert.equal(snapToMonday('2026-10-19', { today }), '2026-10-19', 'a Monday stays put');
  assert.equal(snapToMonday('2026-10-20', { today }), '2026-10-26', 'Tuesday goes forward, not back');
  assert.equal(snapToMonday('2026-10-25', { today }), '2026-10-26', 'Sunday goes forward to the Monday after');
});

test('a chosen start is never in the past', () => {
  const today = '2026-10-14'; // a Wednesday
  assert.equal(snapToMonday('2026-09-01', { today }), '2026-10-19', 'long ago: the next Monday');
  assert.equal(snapToMonday('2026-10-12', { today }), '2026-10-19', 'this week\'s own Monday has passed');
  assert.equal(snapToMonday(today, { today }), '2026-10-19', 'today, not a Monday: forward');
});

test('a chosen start may be today when today is a Monday', () => {
  assert.equal(snapToMonday('2026-10-19', { today: '2026-10-19' }), '2026-10-19');
  assert.equal(snapToMonday('2026-10-19', { today: '2026-10-20' }), '2026-10-26');
});

test('an unreadable chosen start falls back to the default', () => {
  assert.equal(snapToMonday('', { today: '2026-10-14' }), nextMonday('2026-10-14'));
  assert.equal(snapToMonday(undefined, { today: '2026-10-14' }), nextMonday('2026-10-14'));
  assert.equal(snapToMonday('nonsense', { today: '2026-10-14' }), nextMonday('2026-10-14'));
});

test('snapToMonday with no today only snaps forward', () => {
  assert.equal(snapToMonday('2026-10-14'), '2026-10-19');
  assert.equal(snapToMonday('2026-10-19'), '2026-10-19');
});

test('sayDate writes a date as words, in English, whatever the locale', () => {
  assert.equal(sayDate('2026-10-19'), '19 Oct 2026');
  assert.equal(sayDate('2027-01-05'), '5 Jan 2027');
  assert.equal(sayDate('2026-12-31'), '31 Dec 2026');
  assert.equal(sayDate('nonsense'), 'nonsense');
  assert.equal(sayDate(undefined), 'undefined');
});
