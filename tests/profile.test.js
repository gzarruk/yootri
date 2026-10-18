import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAYS,
  DEFAULT_PROFILE,
  normalizeProfile,
  weeklyAvailableMinutes,
  peakHoursFor,
  allowedDays,
  maxPerWeek,
} from '../assets/coach/profile.js';

test('normalizeProfile fills every weekday so the generator never sees a hole', () => {
  const p = normalizeProfile({ availability: { Sat: 240 } });
  assert.deepEqual(Object.keys(p.availability), DAYS);
  assert.equal(p.availability.Sat, 240);
  assert.equal(p.availability.Mon, DEFAULT_PROFILE.availability.Mon);
});

test('normalizeProfile clamps nonsense availability instead of trusting it', () => {
  const p = normalizeProfile({ availability: { Mon: -30, Tue: 'x', Wed: 10000 } });
  assert.equal(p.availability.Mon, 0);
  assert.equal(p.availability.Tue, 0);
  assert.equal(p.availability.Wed, 24 * 60, 'a day cannot hold more than 24h');
});

test('normalizeProfile leaves an already-clean profile untouched', () => {
  const once = normalizeProfile({ availability: { Sun: 120 } });
  assert.deepEqual(normalizeProfile(once), once, 'normalize must be idempotent');
});

test('normalizeProfile does not mutate its input', () => {
  const raw = { availability: { Mon: 45 } };
  normalizeProfile(raw);
  assert.deepEqual(raw, { availability: { Mon: 45 } });
});

test('weeklyAvailableMinutes totals the week', () => {
  const p = normalizeProfile({ availability: Object.fromEntries(DAYS.map((d) => [d, 60])) });
  assert.equal(weeklyAvailableMinutes(p), 420);
});

test('an onlyDays constraint restricts a discipline to those days', () => {
  // Give every day time, so this test isolates the constraint rather than
  // also picking up the separate "a zero-minute day is not schedulable" rule.
  const p = normalizeProfile({
    availability: Object.fromEntries(DAYS.map((d) => [d, 60])),
    constraints: [{ disc: 'Swim', rule: 'onlyDays', value: ['Tue', 'Thu'] }],
  });
  assert.deepEqual(allowedDays(p, 'Swim'), ['Tue', 'Thu']);
  assert.deepEqual(allowedDays(p, 'Bike'), DAYS, 'other disciplines are unaffected');
});

test('an avoidDays constraint removes those days', () => {
  const p = normalizeProfile({ constraints: [{ disc: 'Run', rule: 'avoidDays', value: ['Mon'] }] });
  assert.ok(!allowedDays(p, 'Run').includes('Mon'));
  assert.equal(allowedDays(p, 'Run').length, 6);
});

test('a day with no available time is never an allowed day', () => {
  const p = normalizeProfile({ availability: { Mon: 0 } });
  assert.ok(!allowedDays(p, 'Bike').includes('Mon'));
});

test('maxPerWeek reports a session cap when one is set', () => {
  const p = normalizeProfile({ constraints: [{ disc: 'Swim', rule: 'maxPerWeek', value: 2 }] });
  assert.equal(maxPerWeek(p, 'Swim'), 2);
  assert.equal(maxPerWeek(p, 'Bike'), Infinity);
});

test('constraints that name an unknown rule are dropped, not obeyed blindly', () => {
  const p = normalizeProfile({ constraints: [{ disc: 'Swim', rule: 'banana', value: 1 }] });
  assert.equal(p.constraints.length, 0);
});

test('a clean profile carries no week-shape overrides', () => {
  // Same contract as splits: an absent override must not appear as data, or
  // every stored plan gets rewritten on load for no reason.
  assert.ok(!('weekShape' in normalizeProfile({})));
});

test('a week shape survives normalization', () => {
  const p = normalizeProfile({ weekShape: { enabled: false, spread: 'weekend', pins: { Wed: 60 } } });
  assert.deepEqual(p.weekShape, { enabled: false, spread: 'weekend', pins: { Wed: 60 } });
});

test('an unrecognised spread policy is dropped rather than obeyed', () => {
  const p = normalizeProfile({ weekShape: { spread: 'whenever' } });
  assert.equal(p.weekShape, undefined);
});

test('pins on days that do not exist are dropped', () => {
  const p = normalizeProfile({ weekShape: { pins: { Wed: 60, Funday: 90, Thu: -5 } } });
  assert.deepEqual(p.weekShape, { pins: { Wed: 60 } });
});

test('normalizing a week shape twice changes nothing', () => {
  const once = normalizeProfile({ weekShape: { spread: 'even', pins: { Sat: 200 } } });
  assert.deepEqual(normalizeProfile(once), once);
});

/* ---- long-session days and sessions a day ---- */

test('long-session days are kept for the bike and the run, on real days only', () => {
  const p = normalizeProfile({ longDays: { Bike: 'Sun', Run: 'Sat', Swim: 'Wed', Strength: 'Mon' } });
  assert.deepEqual(p.longDays, { Bike: 'Sun', Run: 'Sat' });
  assert.deepEqual(normalizeProfile({ longDays: { Bike: 'Sunday', Run: '' } }).longDays, undefined);
});

test('a profile that says nothing about long days or doubles stays silent about them', () => {
  // Writing defaults into every profile would rewrite every stored plan on load
  // to say nothing, the same reason splits and weekShape stay absent.
  const p = normalizeProfile({});
  assert.equal('longDays' in p, false);
  assert.equal('maxSessionsPerDay' in p, false);
});

test('sessions a day is a whole number from one to three, or absent', () => {
  assert.equal(normalizeProfile({ maxSessionsPerDay: 1 }).maxSessionsPerDay, 1);
  assert.equal(normalizeProfile({ maxSessionsPerDay: '2' }).maxSessionsPerDay, 2);
  for (const bad of [0, 4, 1.5, -1, 'two', null]) {
    assert.equal('maxSessionsPerDay' in normalizeProfile({ maxSessionsPerDay: bad }), false, String(bad));
  }
});

test('the new fields survive normalizing twice', () => {
  const once = normalizeProfile({ longDays: { Bike: 'Sat', Run: 'Sun' }, maxSessionsPerDay: 1 });
  assert.deepEqual(normalizeProfile(once), once);
});

test('a profile no longer carries annual hours; an old one is read past it', () => {
  assert.equal('annualHours' in DEFAULT_PROFILE, false);
  const p = normalizeProfile({ annualHours: 700, availability: { Sun: 120 } });
  assert.equal('annualHours' in p, false);
});

test('peakHoursFor is the week the athlete said they have, to the half hour below', () => {
  const week = (min) => normalizeProfile({ availability: Object.fromEntries(DAYS.map((d) => [d, min])) });
  assert.equal(peakHoursFor(week(60)), 7);
  assert.equal(peakHoursFor(normalizeProfile({ availability: { Mon: 0, Tue: 90, Wed: 90, Thu: 90, Fri: 90, Sat: 90, Sun: 90 } })), 9);
  // 9h50m is not a 10h week: rounding up would put the peak over what they have.
  assert.equal(peakHoursFor(normalizeProfile({ availability: { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 350, Sun: 240 } })), 9.5);
});

test('with no time at all a season is still sized, by the default week', () => {
  const none = normalizeProfile({ availability: Object.fromEntries(DAYS.map((d) => [d, 0])) });
  assert.equal(peakHoursFor(none), peakHoursFor(normalizeProfile({})));
  assert.ok(peakHoursFor(none) > 0);
});
