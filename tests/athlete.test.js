import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAthlete, mergeAthletes, athleteGaps, wattsPerKg, isEmptyAthlete,
  SEXES, LEVELS, ATHLETE_FIELDS,
} from '../assets/coach/athlete.js';
import { fitToRace } from '../assets/coach/season.js';
import { newPlan } from '../assets/coach/plan.js';

const full = () => ({
  birthYear: 1984, sex: 'female', heightCm: 168, weightKg: 61.25,
  yearsInSport: 4, levels: { Swim: 'some', Bike: 'strong', Run: 'new' },
  recentWeeklyHours: 8.5, longestRideMin: 180, longestRunMin: 95,
  equipment: { pool: true, openWater: false, indoorTrainer: true, powerMeter: true },
  goal: 'time', goalTime: 330, updatedAt: 1700000000000,
});

/* ---- normalizeAthlete: an allowlist ---- */

test('a complete record survives, with weight rounded to 100 g', () => {
  assert.deepEqual(normalizeAthlete(full()), { ...full(), weightKg: 61.3 });
});

test('normalizing twice changes nothing', () => {
  const once = normalizeAthlete(full());
  assert.deepEqual(normalizeAthlete(once), once);
});

test('nothing outside the allowlist survives', () => {
  // The record syncs (with consent) and is offered for download, so anything a
  // hand-edited copy smuggles in has to stop at the one door it comes through.
  const a = normalizeAthlete({ ...full(), restingHr: 48, hrv: 62, sleep: 7, notes: 'knee', name: 'X' });
  for (const k of ['restingHr', 'hrv', 'sleep', 'notes', 'name']) assert.equal(k in a, false, k);
  assert.deepEqual(Object.keys(a).sort(), [...ATHLETE_FIELDS].sort());
});

test('an impossible value is dropped rather than clamped', () => {
  // Clamping would store a number the athlete never gave.
  const a = normalizeAthlete({
    birthYear: 1850, sex: 'x', heightCm: 20, weightKg: 400, yearsInSport: -1,
    recentWeeklyHours: 99, longestRideMin: 5000, longestRunMin: -5,
    levels: { Swim: 'pro', Bike: 'some', Strength: 'strong' },
    equipment: { pool: 'yes', openWater: true, jetpack: true },
    goal: 'podium', goalTime: 330, updatedAt: 'later',
  });
  assert.deepEqual(a, { levels: { Bike: 'some' }, equipment: { openWater: true } });
});

test('a target time only means something with a time goal', () => {
  assert.equal('goalTime' in normalizeAthlete({ goal: 'finish', goalTime: 330 }), false);
  assert.equal('goalTime' in normalizeAthlete({ goalTime: 330 }), false);
  assert.equal(normalizeAthlete({ goal: 'time', goalTime: '330' }).goalTime, 330);
});

test('false is an answer, absent is not', () => {
  // "No pool" and "did not say" are different facts for the plan.
  assert.deepEqual(normalizeAthlete({ equipment: { pool: false } }).equipment, { pool: false });
  assert.equal('equipment' in normalizeAthlete({ equipment: {} }), false);
});

test('anything that is not an object reads as an empty record', () => {
  for (const raw of [null, undefined, 42, 'x', []]) assert.deepEqual(normalizeAthlete(raw), {});
  assert.equal(isEmptyAthlete(normalizeAthlete(null)), true);
  assert.equal(isEmptyAthlete({ updatedAt: 5 }), true, 'a timestamp alone says nothing about anybody');
  assert.equal(isEmptyAthlete({ sex: 'male' }), false);
});

test('the choice lists are what the record accepts', () => {
  for (const sex of SEXES) assert.equal(normalizeAthlete({ sex }).sex, sex);
  for (const level of LEVELS) assert.equal(normalizeAthlete({ levels: { Run: level } }).levels.Run, level);
});

/* ---- mergeAthletes ---- */

test('the newer record wins a merge, and the cloud wins a tie', () => {
  const older = { sex: 'male', updatedAt: 1 };
  const newer = { sex: 'female', updatedAt: 2 };
  assert.equal(mergeAthletes(older, newer).sex, 'female');
  assert.equal(mergeAthletes(newer, older).sex, 'female');
  assert.equal(mergeAthletes({ sex: 'male', updatedAt: 3 }, { sex: 'female', updatedAt: 3 }).sex, 'female');
});

test('an empty side never wipes out the other', () => {
  assert.deepEqual(mergeAthletes(full(), {}), normalizeAthlete(full()));
  assert.deepEqual(mergeAthletes(null, full()), normalizeAthlete(full()));
});

/* ---- athleteGaps ---- */

test('a blank athlete and a blank plan are missing the things that shape a plan first', () => {
  const gaps = athleteGaps({}, newPlan({ name: 'My plan', startISO: '2026-10-05' }));
  const used = gaps.filter((g) => g.used).map((g) => g.key);
  assert.deepEqual(used.slice(0, 5), ['race', 'recentWeeklyHours', 'runResult', 'ftp', 'css']);
  for (const g of gaps) {
    assert.ok(g.label && g.why, `${g.key} says what it is and why it is asked`);
  }
});

test('nothing is reported missing once it is there', () => {
  const plan = newPlan({
    name: 'Season', startISO: '2026-10-05', raceDate: '2027-06-06', raceType: '70.3',
    benchmarks: [{ id: 'b', date: '2026-09-01', distanceMeters: 10000, timeSeconds: 2700, source: 'manual', current: true }],
    loadRefs: { ftpW: 240, cssSecPer100m: 100 },
  });
  assert.deepEqual(athleteGaps(full(), plan), []);
});

test('without a plan only the athlete record is checked', () => {
  assert.equal(athleteGaps(full()).length, 0);
  assert.ok(athleteGaps({}).every((g) => !['race', 'runResult', 'ftp', 'css'].includes(g.key)));
});

test('a field is only claimed to be used when something reads it', () => {
  // The reason is shown to the athlete; promising a use that does not exist yet
  // would be a claim the app cannot back.
  const gaps = athleteGaps({});
  const byKey = Object.fromEntries(gaps.map((g) => [g.key, g]));
  assert.equal(byKey.birthYear.used, false);
  assert.match(byKey.birthYear.why, /not used for planning yet/i);
  assert.equal(byKey.weightKg.used, true);
  assert.equal(byKey.recentWeeklyHours.used, true, 'where a season\'s fitness starts from, when synced sessions cannot say');
  assert.equal(byKey.longest.used, false, 'nothing reads the longest ride and run yet');
});

/* ---- wattsPerKg ---- */

test('watts per kilogram needs both numbers', () => {
  assert.equal(wattsPerKg(240, 61.3), 3.92);
  assert.equal(wattsPerKg(240, undefined), null);
  assert.equal(wattsPerKg(undefined, 61.3), null);
});

test('recent hours, years in the sport and background are now used, and say what for', () => {
  const gaps = athleteGaps({}, null);
  for (const key of ['recentWeeklyHours', 'yearsInSport', 'levels']) {
    const g = gaps.find((x) => x.key === key);
    assert.ok(g, key);
    assert.equal(g.used, true, `${key} is read now`);
    assert.match(g.why, /start|fitness/i, `${key} says what it is for`);
  }
  for (const key of ['longest', 'pool', 'goal', 'birthYear']) {
    assert.equal(gaps.find((x) => x.key === key)?.used, false, `${key} is still not used`);
  }
});
