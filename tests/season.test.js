import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SEASON,
  multiplier,
  weeklyHours,
  seasonWeeks,
  seasonHours,
  fitToRace,
} from '../assets/coach/season.js';

/* Golden values taken from ../yootri-rnd/plan_model.py, which is the reference
   implementation. If these drift, the JS port is wrong — not the test. */

test('weeklyHours matches the reference model on its own documented examples', () => {
  assert.equal(weeklyHours(500, 'Base 2', 3), 13.5);   // third loading week
  assert.equal(weeklyHours(500, 'Base 2', 4), 6.5);    // its recovery week
  assert.equal(weeklyHours(900, 'Base 2', 3), 24.0);   // same week, bigger budget
});

test('weeklyHours scales linearly with the annual budget', () => {
  assert.equal(weeklyHours(1000, 'Base 2', 3), weeklyHours(500, 'Base 2', 3) * 2);
});

test('recovery weeks use the season-wide floor, not a fraction of their block', () => {
  // Base 1 and Base 3 have different loads; their recovery weeks should match.
  assert.equal(weeklyHours(700, 'Base 1', 4), weeklyHours(700, 'Base 3', 4));
});

test('multiplier ramps across a block loading weeks and resets on recovery', () => {
  assert.equal(multiplier('Base 2', 1), 1.4 * 0.85);
  assert.equal(multiplier('Base 2', 3), 1.4);
  assert.equal(multiplier('Base 2', 4), 0.7);
});

test('a flat block holds every loading week at its full load', () => {
  // Build 1 overrides ramp to (1.0, 1.0): intensity rises, volume does not.
  assert.equal(multiplier('Build 1', 1), multiplier('Build 1', 3));
});

test('the default season spans 27 weeks', () => {
  assert.equal(seasonWeeks(), 27);
});

test('the default season spends only part of the annual budget', () => {
  // The blocks cover 27 of 52 weeks, so they cannot sum to the annual figure.
  // This is the FINDINGS.md constraint: annual hours is a scale, not a total.
  const spent = seasonHours(700);
  assert.ok(Math.abs(spent - 391.5288) < 0.001, `expected ~391.53, got ${spent}`);
  assert.ok(spent / 700 < 0.6, 'season should spend well under the full budget');
});

test('unknown block names are rejected rather than silently defaulted', () => {
  assert.throws(() => multiplier('Taper', 1), /unknown period/i);
});

test('week numbers outside a block are rejected', () => {
  assert.throws(() => multiplier('Peak', 3), /weeks 1..2/);
});

test('DEFAULT_SEASON is exposed as data so a plan can carry its own copy', () => {
  const names = DEFAULT_SEASON.blocks.map((b) => b.name);
  assert.deepEqual(names, ['Prep', 'Base 1', 'Base 2', 'Base 3', 'Build 1', 'Build 2', 'Peak', 'Race']);
});

/* fitToRace — resolving the block model onto a concrete number of weeks.
   This has no equivalent in plan_model.py; the reference model describes a
   season's shape, not how to land it on a given race date. */

test('a full-length season resolves to every block in order', () => {
  const s = fitToRace({ annualHours: 700, weeks: 27 });
  assert.equal(s.length, 27);
  assert.equal(s[0].block, 'Prep');
  assert.equal(s[0].week, 1);
  assert.equal(s.at(-1).block, 'Race');
});

test('every resolved week carries its own hours and recovery flag', () => {
  const s = fitToRace({ annualHours: 700, weeks: 27 });
  assert.ok(s.every((w) => w.hours > 0), 'no week should be zero hours');
  assert.equal(s[3].recovery, false, 'Prep has no recovery week');
  assert.equal(s[7].recovery, true, 'Base 1 week 4 is a recovery week');
  assert.equal(s[7].hours, weeklyHours(700, 'Base 1', 4));
});

test('resolved weeks are numbered from the start, ending at the race', () => {
  const s = fitToRace({ annualHours: 700, weeks: 27 });
  assert.deepEqual(s.map((w) => w.absWeek).slice(0, 3), [0, 1, 2]);
  assert.equal(s.at(-1).absWeek, 26);
});

test('a short runway keeps the race-specific end and drops the front', () => {
  // 16 weeks of the 27-week season = the last 16. Index 11 of the full season
  // is Base 2 week 4, so that is where a 16-week plan starts.
  const s = fitToRace({ annualHours: 700, weeks: 16 });
  assert.equal(s.length, 16);
  assert.equal(s[0].block, 'Base 2');
  assert.equal(s[0].week, 4);
  assert.equal(s.at(-1).block, 'Race');
  assert.equal(s.at(-1).absWeek, 15);
});

test('a long runway extends the front with prep weeks, not extra race weeks', () => {
  const s = fitToRace({ annualHours: 700, weeks: 32 });
  assert.equal(s.length, 32);
  assert.ok(s.slice(0, 5).every((w) => w.block === 'Prep'), 'extra weeks are prep');
  assert.equal(s.at(-1).block, 'Race');
  assert.equal(s.at(-2).block, 'Peak');
});

test('the taper is never truncated away, even on a very short runway', () => {
  const s = fitToRace({ annualHours: 700, weeks: 3 });
  assert.deepEqual(s.map((w) => w.block), ['Peak', 'Peak', 'Race']);
});

test('fitToRace rejects a runway that cannot hold a plan', () => {
  assert.throws(() => fitToRace({ annualHours: 700, weeks: 0 }), /at least one week/i);
});

test('resolved weeks carry the load multiplier that produced them', () => {
  // Downstream rules need to know whether a week is genuinely hard. Inferring
  // that from volume fails in a flat season, where half the weeks sit below the
  // mean by construction. The model already knows; it should say so.
  const season = fitToRace({ annualHours: 700, weeks: 27 });
  assert.ok(season.every((w) => typeof w.load === 'number' && w.load > 0));
  assert.equal(season[0].load, multiplier('Prep', 1));
  assert.ok(season[0].load < 1, 'a prep week is easier than a flat average week');
  const hard = season.find((w) => w.block === 'Base 3' && w.week === 3);
  assert.ok(hard.load > 1, 'the last loading week of Base 3 is harder than average');
});
