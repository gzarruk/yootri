import test from 'node:test';
import assert from 'node:assert/strict';

import { PREP, racePreparation } from '../assets/coach/preparation.js';
import { fitnessSeries, PLANNED } from '../assets/coach/fitness.js';

/* Race preparation: a checklist of plain facts about the weeks behind the athlete
   and the race ahead — fitness against an illustrative range, long sessions
   per discipline, steady weeks, form on the day. It says where each figure
   sits, never whether the athlete is good to go: no score, no verdict.
   Derived on read and never stored. */

const START = '2026-09-07';                 // a Monday
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayISO = (n) => new Date(Date.UTC(2026, 8, 7 + n)).toISOString().slice(0, 10);
const TODAY = dayISO(23);                   // Wednesday of week 4
const T = { ftpW: 250 };

const plan = (extra = {}) => ({
  start: START,
  profile: { raceDate: '2026-10-17', raceType: '70.3' },
  season: Array.from({ length: 6 }, () => ({ block: 'Base', hours: 7 })),
  weeks: Object.fromEntries(Array.from({ length: 6 }, (_, w) => [`w${w}`,
    DAYS.map((day) => ({ id: `b-${w}-${day}`, disc: 'Bike', day, dur: '1:00', zone: 'Z2' }))])),
  ...extra,
});
const act = (n, disc, minutes, extra = {}) => ({
  id: `garmin:${disc}:${n}`, date: dayISO(n), disc, durationS: minutes * 60, movingS: minutes * 60,
  normPowerW: 175, ...extra,
});
const SYNC = { source: 'garmin', from: START, through: TODAY };
const daily = (minutes = 60) => Array.from({ length: 24 }, (_, n) => act(n, 'Bike', minutes));

const run = (extra = {}, options = {}) => {
  const p = plan({ activities: daily(), activitySync: SYNC, ...extra });
  return racePreparation(p, { today: TODAY, fitness: fitnessSeries(p, { today: TODAY, thresholds: T }), ...options });
};
const item = (r, key) => r.items.find((i) => i.key === key);

test('a 70.3 reads fitness, long sessions in each discipline, steady weeks and form on the day', () => {
  const r = run();
  assert.equal(r.available, true);
  assert.deepEqual(r.items.map((i) => i.key), ['fitness', 'long-Bike', 'long-Run', 'long-Swim', 'steady', 'form']);
  assert.deepEqual(item(r, 'fitness').reference, { lo: 60, hi: 90 });
});

test('long sessions count only what reaches the length for the distance, inside the last 42 days', () => {
  const special = new Map([[22, 180], [21, 179], [5, 200], [-18, 200], [-19, 200]]);   // today is day 23
  const filler = Array.from({ length: 24 }, (_, n) => n).filter((n) => !special.has(n)).map((n) => act(n, 'Bike', 30));
  const acts = [...special].map(([n, m]) => act(n, 'Bike', m));
  const r = run({ activities: [...filler, ...acts, act(20, 'Run', PREP.long['70.3'].Run.min)] });
  const bike = item(r, 'long-Bike');
  assert.equal(bike.reference, PREP.long['70.3'].Bike.count);
  // Day 22 is exactly long enough, day 21 a minute short, day -18 the oldest day inside, day -19 one outside.
  assert.equal(bike.value, 3);
  assert.equal(item(r, 'long-Run').value, 1);
  assert.equal(item(r, 'long-Swim').value, 0);
});

test('an Ironman asks for longer sessions than a 70.3', () => {
  assert.ok(PREP.long.ironman.Bike.min > PREP.long['70.3'].Bike.min);
  const r = run({ profile: { raceDate: '2026-10-17', raceType: 'ironman' } });
  assert.deepEqual(item(r, 'fitness').reference, { lo: 80, hi: 115 });
  assert.equal(item(r, 'long-Bike').reference, PREP.long.ironman.Bike.count);
});

test('a season already built for a retired distance is still read, not dropped', () => {
  const r = run({ profile: { raceDate: '2026-10-17', raceType: 'sprint' } });
  assert.equal(r.available, true);
  assert.equal(r.raceType, 'sprint');
});

test('steady weeks counts weeks with at least three sessions, only over weeks the sync covered', () => {
  const r = run();
  const steady = item(r, 'steady');
  assert.equal(steady.reference, 3, 'three covered weeks before this one');
  assert.equal(steady.value, 3);
  // Sync began a week later: week one is not a week off, it is a week unknown.
  const later = run({ activitySync: { ...SYNC, from: dayISO(7) } }, {});
  assert.equal(later.available, false);
});

test('a week with fewer than three sessions is not a steady week', () => {
  const acts = [...Array.from({ length: 24 }, (_, n) => n)].filter((n) => n < 7 ? n % 7 < 2 : true).map((n) => act(n, 'Bike', 60));
  const r = run({ activities: acts });
  assert.equal(item(r, 'steady').value, 2);
});

test('form on the day is the plan followed, set against the range often used on the day', () => {
  const r = run();
  const form = item(r, 'form');
  assert.equal(form.value, fitnessSeries(plan({ activities: daily(), activitySync: SYNC }), { today: TODAY, thresholds: T }).race.form);
  assert.deepEqual(form.reference, { lo: PLANNED.raceForm.low, hi: PLANNED.raceForm.high });
  assert.ok(['below', 'within', 'above'].includes(form.against));
});

test('with fewer than three covered weeks, no race or no synced history, there is nothing to show and it says why', () => {
  assert.deepEqual(run({ activitySync: { ...SYNC, from: dayISO(14) } }).reason, 'little-history');
  assert.equal(run({ profile: { raceType: '70.3' } }).available, true, 'no date means the end of the season');
  const none = plan();
  const r = racePreparation(none, { today: TODAY, fitness: fitnessSeries(none, { today: TODAY, thresholds: T }) });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'little-history');
  const LATE = '2026-10-25';
  const after = plan({ activities: daily(), activitySync: { ...SYNC, through: LATE } });
  assert.equal(racePreparation(after, { today: LATE, fitness: fitnessSeries(after, { today: LATE, thresholds: T }) }).reason, 'no-race');
  assert.deepEqual(run({ profile: { raceDate: '2026-10-17', raceType: 'marathon' } }).items, []);
});

test('it carries no score and no verdict, and writes nothing into the plan', () => {
  const p = plan({ activities: daily(), activitySync: SYNC });
  const before = JSON.stringify(p);
  const r = racePreparation(p, { today: TODAY, fitness: fitnessSeries(p, { today: TODAY, thresholds: T }) });
  assert.equal(JSON.stringify(p), before);
  const text = JSON.stringify(r);
  for (const k of ['score', 'verdict', 'pass', 'grade', 'percent']) assert.equal(text.includes(`"${k}"`), false, k);
  for (const i of r.items) assert.deepEqual(Object.keys(i).filter((k) => !['key', 'label', 'value', 'reference', 'detail', 'against'].includes(k)), []);
});

test('garbage in is an empty answer, not a throw', () => {
  for (const bad of [null, undefined, {}, { start: 'x' }]) {
    const r = racePreparation(bad, { today: TODAY, fitness: null });
    assert.equal(r.available, false);
    assert.deepEqual(r.items, []);
  }
});
