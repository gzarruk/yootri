import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAYS,
  DEFAULT_PROFILE,
  normalizeProfile,
  weeklyAvailableMinutes,
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
  const once = normalizeProfile({ annualHours: 500, availability: { Sun: 120 } });
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
