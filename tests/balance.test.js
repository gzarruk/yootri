import test from 'node:test';
import assert from 'node:assert/strict';

import { balanceWeek } from '../assets/coach/balance.js';
import { normalizeProfile } from '../assets/coach/profile.js';
import { validateWeek } from '../assets/coach/validate.js';
import { durToMin } from '../assets/coach/duration.js';

/* A day over the session count the athlete prefers, mended without losing any
   time: time is the limit, the count is a preference. */

const anyDay = (m) => Object.fromEntries(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => [d, m]));
const s = (id, day, disc, dur, extra = {}) => ({ id, day, disc, dur, focus: '', zone: '', ...extra });
const prof = (over = {}) => normalizeProfile({ availability: anyDay(120), maxSessionsPerDay: 2, ...over });
const total = (week) => week.reduce((a, x) => a + durToMin(x.dur), 0);

const thursday = () => [
  s('a', 'Thu', 'Strength', '0:50'),
  s('b', 'Thu', 'Strength', '0:25'),
  s('c', 'Thu', 'Run', '0:25'),
  s('d', 'Wed', 'Bike', '1:00'),
];

test('two sessions of one discipline on an over-count day become one', () => {
  const out = balanceWeek(thursday(), { profile: prof() });
  const thu = out.filter((x) => x.day === 'Thu');
  assert.equal(thu.length, 2);
  assert.equal(thu.find((x) => x.disc === 'Strength').dur, '1:15');
  assert.equal(total(out), total(thursday()), 'no time lost');
});

test('a week at or under the count is left as it was', () => {
  const week = [s('a', 'Tue', 'Run', '1:00'), s('b', 'Tue', 'Swim', '0:45')];
  assert.deepEqual(balanceWeek(week, { profile: prof() }), week);
});

test('without a count the week is left alone', () => {
  assert.deepEqual(balanceWeek(thursday(), { profile: prof({ maxSessionsPerDay: undefined }) }), thursday());
});

test('when merging is not possible the smallest session moves to a day with room', () => {
  const week = [
    s('a', 'Thu', 'Swim', '0:40'), s('b', 'Thu', 'Run', '0:40'), s('c', 'Thu', 'Bike', '0:40'),
    s('d', 'Wed', 'Bike', '1:00'),
  ];
  const out = balanceWeek(week, { profile: prof() });
  const perDay = (d) => out.filter((x) => x.day === d && x.disc !== 'Rest').length;
  assert.ok(perDay('Thu') <= 2);
  assert.equal(total(out), total(week));
  assert.deepEqual(validateWeek(out, { profile: prof() }).filter((i) => i.level === 'error'), []);
});

test('a session never moves to a day its discipline is ruled out of', () => {
  const p = prof({ constraints: [{ disc: 'Bike', rule: 'onlyDays', value: ['Thu'] }] });
  const week = [s('a', 'Thu', 'Swim', '0:40'), s('b', 'Thu', 'Run', '0:40'), s('c', 'Thu', 'Bike', '0:40')];
  const out = balanceWeek(week, { profile: p });
  assert.equal(out.find((x) => x.id === 'c').day, 'Thu');
});

test('a move that would overfill the other day is not made', () => {
  const p = prof({ availability: anyDay(60) });
  const week = [s('a', 'Thu', 'Swim', '0:20'), s('b', 'Thu', 'Run', '0:20'), s('c', 'Thu', 'Bike', '0:20'),
    ...['Mon', 'Tue', 'Wed', 'Fri', 'Sat', 'Sun'].map((d) => s(d, d, 'Run', '1:00'))];
  const out = balanceWeek(week, { profile: p });
  assert.equal(out.filter((x) => x.day === 'Thu').length, 3, 'nowhere to put it, so it stays');
});

test('the long run never moves, and the input is not mutated', () => {
  const week = [s('a', 'Sat', 'Run', '2:00'), s('b', 'Sat', 'Swim', '0:30'), s('c', 'Sat', 'Strength', '0:30'),
    s('e', 'Tue', 'Run', '0:45')];
  const copy = structuredClone(week);
  const out = balanceWeek(week, { profile: prof({ availability: anyDay(180) }) });
  assert.deepEqual(week, copy);
  assert.equal(out.find((x) => x.id === 'a').day, 'Sat');
  assert.ok(out.filter((x) => x.day === 'Sat' && x.disc !== 'Rest').length <= 2);
});

test('rest entries are not sessions and stay put', () => {
  const week = [...thursday(), s('r', 'Mon', 'Rest', '—')];
  const out = balanceWeek(week, { profile: prof() });
  assert.ok(out.some((x) => x.id === 'r' && x.day === 'Mon'));
});
