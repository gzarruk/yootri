import test from 'node:test';
import assert from 'node:assert/strict';

import { weeklyHistory, summarizeHistory, trainingHistory } from '../assets/coach/history.js';

/* What was actually trained, week by week, from synced activities.

   The rules that read this must be able to tell "trained nothing" from "we do
   not know": a week is `covered` only when every day of it was inside a sync.
   Averages only ever use covered, finished weeks. */

const act = (id, date, disc, minutes) => ({ id: `garmin:${id}`, source: 'garmin', date, disc, durationS: minutes * 60 });

// Mondays: 2026-08-31, 09-07, 09-14, 09-21, 09-28.
const SYNC = { source: 'garmin', from: '2026-08-01', through: '2026-09-27', at: 1 };
const ACTS = [
  act(1, '2026-08-31', 'Run', 45),
  act(2, '2026-09-06', 'Bike', 120),        // Sunday: still week of 08-31
  act(3, '2026-09-07', 'Run', 60),          // Monday: next week
  act(4, '2026-09-09', 'Swim', 40),
  act(5, '2026-09-12', 'Bike', 150),
  act(6, '2026-09-13', 'Run', 90),
  act(7, '2026-09-15', 'Other', 30),
  act(8, '2026-09-16', 'Strength', 30),
];

test('weeks run Monday to Sunday', () => {
  const rows = weeklyHistory(ACTS, { from: '2026-08-31', weeks: 2, sync: SYNC });
  assert.deepEqual(rows.map((r) => [r.monday, r.minutes, r.sessions]), [
    ['2026-08-31', 165, 2],
    ['2026-09-07', 340, 4],
  ]);
});

test('each discipline carries its minutes, sessions and longest session', () => {
  const [, week] = weeklyHistory(ACTS, { from: '2026-08-31', weeks: 2, sync: SYNC });
  assert.deepEqual(week.byDisc.Run, { minutes: 150, sessions: 2, longest: 90 });
  assert.deepEqual(week.byDisc.Bike, { minutes: 150, sessions: 1, longest: 150 });
  assert.deepEqual(week.byDisc.Swim, { minutes: 40, sessions: 1, longest: 40 });
  assert.deepEqual(week.byDisc.Strength, { minutes: 0, sessions: 0, longest: 0 });
});

test('other activities count as sessions but not as training volume', () => {
  const [row] = weeklyHistory(ACTS, { from: '2026-09-14', weeks: 1, sync: SYNC });
  assert.equal(row.sessions, 2);
  assert.equal(row.minutes, 30, 'the strength session only');
});

test('a from date that is not a Monday is brought back to one', () => {
  const [row] = weeklyHistory(ACTS, { from: '2026-09-03', weeks: 1, sync: SYNC });
  assert.equal(row.monday, '2026-08-31');
});

test('a week is covered only when every day of it was synced', () => {
  const rows = weeklyHistory(ACTS, { from: '2026-09-14', weeks: 3, sync: SYNC });
  assert.deepEqual(rows.map((r) => r.covered), [true, true, false]);
  const partial = { ...SYNC, from: '2026-09-02' };
  assert.equal(weeklyHistory(ACTS, { from: '2026-08-31', weeks: 1, sync: partial })[0].covered, false);
  assert.equal(weeklyHistory(ACTS, { from: '2026-08-31', weeks: 1, sync: null })[0].covered, false);
});

test('the week in progress is not complete', () => {
  const rows = weeklyHistory(ACTS, { from: '2026-09-14', weeks: 3, sync: SYNC, today: '2026-09-30' });
  assert.deepEqual(rows.map((r) => r.complete), [true, true, false]);
});

test('an empty history is zeros, never NaN', () => {
  const rows = weeklyHistory([], { from: '2026-09-14', weeks: 2, sync: SYNC });
  assert.deepEqual(rows.map((r) => r.minutes), [0, 0]);
  const s = summarizeHistory(rows);
  assert.equal(s.coveredWeeks, 2);
  assert.equal(s.avgMinutes, 0);
  assert.deepEqual(s.share, { Swim: 0, Bike: 0, Run: 0, Strength: 0 });
  assert.equal(JSON.stringify(s).includes('NaN'), false);
  assert.equal(JSON.stringify(summarizeHistory([])).includes('NaN'), false);
});

test('the summary averages covered weeks only', () => {
  const rows = weeklyHistory(ACTS, { from: '2026-08-31', weeks: 4, sync: SYNC });
  const s = summarizeHistory(rows);
  assert.equal(s.coveredWeeks, 4);
  assert.equal(s.totalMinutes, 165 + 340 + 30 + 0);
  assert.equal(s.avgMinutes, Math.round((165 + 340 + 30) / 4));
  const short = summarizeHistory(weeklyHistory(ACTS, { from: '2026-08-31', weeks: 4, sync: { ...SYNC, through: '2026-09-13' } }));
  assert.equal(short.coveredWeeks, 2);
  assert.equal(short.avgMinutes, Math.round((165 + 340) / 2));
});

test('shares are of the recorded training time, by discipline', () => {
  const s = summarizeHistory(weeklyHistory(ACTS, { from: '2026-08-31', weeks: 2, sync: SYNC }));
  const total = 165 + 340;
  assert.equal(s.share.Bike, Math.round((270 / total) * 1000) / 1000);
  assert.equal(s.share.Run, Math.round((195 / total) * 1000) / 1000);
  assert.equal(s.share.Swim, Math.round((40 / total) * 1000) / 1000);
});

test('the longest session per discipline names the day it happened', () => {
  const s = summarizeHistory(weeklyHistory(ACTS, { from: '2026-08-31', weeks: 2, sync: SYNC }));
  assert.deepEqual(s.longest.Bike, { minutes: 150, date: '2026-09-12', id: 'garmin:5' });
  assert.deepEqual(s.longest.Run, { minutes: 90, date: '2026-09-13', id: 'garmin:6' });
  assert.equal(s.longest.Strength, null);
});

test('trainingHistory looks at the weeks before the current one', () => {
  const h = trainingHistory(ACTS, { today: '2026-09-23', weeks: 3, sync: SYNC });
  assert.deepEqual(h.weeks.map((r) => r.monday), ['2026-08-31', '2026-09-07', '2026-09-14']);
  assert.deepEqual(h.coverage, { from: '2026-08-01', through: '2026-09-27' });
  assert.equal(h.summary.coveredWeeks, 3);
});

test('trainingHistory without a sync says nothing is covered', () => {
  const h = trainingHistory([], { today: '2026-09-23', weeks: 3, sync: null });
  assert.equal(h.coverage, null);
  assert.equal(h.summary.coveredWeeks, 0);
});

test('the week count is bounded', () => {
  assert.equal(trainingHistory([], { today: '2026-09-23', weeks: 500, sync: SYNC }).weeks.length, 26);
  assert.equal(trainingHistory([], { today: '2026-09-23', weeks: 0, sync: SYNC }).weeks.length, 1);
});
