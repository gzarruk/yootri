import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWeek, validateSeason } from '../assets/coach/validate.js';
import { normalizeProfile, DAYS } from '../assets/coach/profile.js';
import { fitToRace } from '../assets/coach/season.js';
import { generateWeek } from '../assets/coach/generate.js';

const anyDay = (m) => Object.fromEntries(DAYS.map((d) => [d, m]));
const profile = normalizeProfile({ availability: anyDay(180) });
const s = (day, disc, dur) => ({ id: `${day}-${disc}`, day, disc, dur, focus: '', zone: '' });
const codes = (issues) => issues.map((i) => i.code);

test('a sane week produces no issues', () => {
  const week = [s('Tue', 'Swim', '1:00'), s('Sat', 'Bike', '2:00'), s('Sun', 'Run', '1:00')];
  assert.deepEqual(validateWeek(week, { profile, budgetMinutes: 240 }), []);
});

test('a day scheduled past its available time is an error', () => {
  const tight = normalizeProfile({ availability: { ...anyDay(180), Tue: 60 } });
  const issues = validateWeek([s('Tue', 'Bike', '2:00')], { profile: tight, budgetMinutes: 120 });
  const hit = issues.find((i) => i.code === 'day-over-capacity');
  assert.ok(hit, `expected day-over-capacity, got ${codes(issues)}`);
  assert.equal(hit.level, 'error');
  assert.match(hit.message, /Tue/);
});

test('scheduling a discipline on a day it is barred from is an error', () => {
  const p = normalizeProfile({
    availability: anyDay(180),
    constraints: [{ disc: 'Swim', rule: 'avoidDays', value: ['Mon'] }],
  });
  const issues = validateWeek([s('Mon', 'Swim', '1:00')], { profile: p, budgetMinutes: 60 });
  assert.ok(codes(issues).includes('constraint-violated'));
});

test('a token-length session is flagged but does not block', () => {
  const issues = validateWeek([s('Tue', 'Run', '0:10')], { profile, budgetMinutes: 10 });
  const hit = issues.find((i) => i.code === 'session-too-short');
  assert.ok(hit);
  assert.equal(hit.level, 'warn');
});

test('an implausibly long session is flagged', () => {
  const p = normalizeProfile({ availability: anyDay(600) });
  const issues = validateWeek([s('Sat', 'Bike', '7:00')], { profile: p, budgetMinutes: 420 });
  assert.ok(codes(issues).includes('session-too-long'));
});

test('rest entries are not mistaken for too-short sessions', () => {
  const issues = validateWeek([s('Mon', 'Rest', '—'), s('Tue', 'Run', '1:00')], {
    profile,
    budgetMinutes: 60,
  });
  assert.ok(!codes(issues).includes('session-too-short'));
});

test('a week that falls short of its budget is reported', () => {
  const issues = validateWeek([s('Tue', 'Run', '1:00')], { profile, budgetMinutes: 300 });
  const hit = issues.find((i) => i.code === 'budget-shortfall');
  assert.ok(hit);
  assert.match(hit.message, /5h|300/);
});

/* Season-level rules — the ones that can only be seen across weeks. */

const weekOf = (mins) => [s('Sat', 'Bike', `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`)];
const seasonOf = (mins, opts = {}) =>
  mins.map((m, i) => ({
    absWeek: i,
    block: opts.blocks?.[i] ?? 'Base 2',
    recovery: opts.recovery?.includes(i) ?? false,
    ...(opts.loads ? { load: opts.loads[i] } : {}),
    sessions: weekOf(m),
  }));

test('a steady progression raises no ramp complaint', () => {
  const issues = validateSeason(seasonOf([600, 630, 660]), { profile });
  assert.ok(!codes(issues).includes('ramp-too-steep'));
});

test('a jump beyond ten percent between loading weeks is flagged', () => {
  const issues = validateSeason(seasonOf([600, 780]), { profile });
  const hit = issues.find((i) => i.code === 'ramp-too-steep');
  assert.ok(hit, `expected ramp-too-steep, got ${codes(issues)}`);
  assert.equal(hit.weekIndex, 1);
});

test('a recovery week is allowed to drop sharply without complaint', () => {
  const issues = validateSeason(seasonOf([600, 400, 640], { recovery: [1] }), { profile });
  assert.ok(!codes(issues).includes('ramp-too-steep'));
});

test('the ramp is measured against the last loading week, not the recovery dip', () => {
  // 600 -> recovery 400 -> 660 is a 10% build on 600, not a 65% jump off 400.
  const issues = validateSeason(seasonOf([600, 400, 660], { recovery: [1] }), { profile });
  assert.ok(!codes(issues).includes('ramp-too-steep'));
});

test('too many consecutive loading weeks without recovery is flagged', () => {
  const issues = validateSeason(seasonOf([600, 610, 620, 630, 640, 650]), { profile });
  assert.ok(codes(issues).includes('recovery-overdue'));
});

test('a taper that goes back up is flagged', () => {
  const issues = validateSeason(
    seasonOf([600, 400, 500], { blocks: ['Build 2', 'Peak', 'Race'] }),
    { profile },
  );
  const hit = issues.find((i) => i.code === 'taper-not-decreasing');
  assert.ok(hit, `expected taper-not-decreasing, got ${codes(issues)}`);
});

test('a proper taper is not flagged', () => {
  const issues = validateSeason(
    seasonOf([600, 400, 250], { blocks: ['Build 2', 'Peak', 'Race'] }),
    { profile },
  );
  assert.ok(!codes(issues).includes('taper-not-decreasing'));
});

test('issues carry the week they belong to so the UI can point at it', () => {
  const issues = validateSeason(seasonOf([600, 900]), { profile });
  assert.ok(issues.every((i) => Number.isInteger(i.weekIndex)));
});


/* Block-boundary and easy-week handling.

   The 10%/week convention describes progression *within* a build. A new block
   deliberately re-steps, and the model's own Prep -> Base 1 transition is a 23%
   step up from a deliberately easy block. Flagging that taught the athlete to
   ignore the warnings. */

test('the ramp rule resets at a block boundary', () => {
  const weeks = seasonOf([500, 615], { blocks: ['Prep', 'Base 1'] });
  const issues = validateSeason(weeks, { profile });
  assert.ok(!codes(issues).includes('ramp-too-steep'), 'a new block is allowed to re-step');
});

test('the ramp rule still applies within a block', () => {
  const weeks = seasonOf([500, 615], { blocks: ['Base 1', 'Base 1'] });
  assert.ok(codes(validateSeason(weeks, { profile })).includes('ramp-too-steep'));
});

test('an egregious jump across a block boundary is still caught', () => {
  // Resetting at boundaries must not become a blind spot.
  const weeks = seasonOf([400, 800], { blocks: ['Prep', 'Base 1'] });
  const hit = validateSeason(weeks, { profile }).find((i) => i.code === 'block-step-too-steep');
  assert.ok(hit, 'doubling volume across a boundary should not pass silently');
});

test('weeks easier than the season average do not count toward a recovery debt', () => {
  // Five easy prep weeks then one hard week is not five loading weeks. Counting
  // raw weeks rather than load is what made the default season self-flag.
  const weeks = seasonOf([300, 300, 300, 300, 300, 900], {
    blocks: ['Prep', 'Prep', 'Prep', 'Prep', 'Prep', 'Base 1'],
    loads: [0.9, 0.9, 0.9, 0.9, 0.9, 1.3],
  });
  assert.ok(!codes(validateSeason(weeks, { profile })).includes('recovery-overdue'));
});

test('a run of genuinely hard weeks still demands recovery', () => {
  const weeks = seasonOf([600, 610, 620, 630, 640, 650], {
    loads: [1.2, 1.2, 1.2, 1.2, 1.2, 1.2],
  });
  assert.ok(codes(validateSeason(weeks, { profile })).includes('recovery-overdue'));
});

test('the default season does not trip the engine own warnings', () => {
  // The regression test that matters: an app that cries wolf on the plan it just
  // generated trains the athlete to ignore every warning it will ever show.
  const prof = normalizeProfile({
    availability: { Mon: 0, Tue: 90, Wed: 105, Thu: 90, Fri: 75, Sat: 300, Sun: 210 },
  });
  const season = fitToRace({ annualHours: 500, weeks: 27 });
  const weeks = season.map((w) => ({
    ...w,
    sessions: generateWeek({
      hours: w.hours, block: w.block, profile: prof, idPrefix: `w${w.absWeek}`,
    }).sessions,
  }));
  const issues = validateSeason(weeks, { profile: prof });
  assert.deepEqual(issues, [], `a freshly generated season should be clean, got ${JSON.stringify(issues, null, 1)}`);
});

test('without load data the recovery rule falls back to counting weeks', () => {
  // Hand-built weeks and migrated plans carry no load multiplier. Silently
  // skipping the check there would be worse than being conservative.
  assert.ok(codes(validateSeason(seasonOf([600, 610, 620, 630, 640, 650]), { profile }))
    .includes('recovery-overdue'));
});
