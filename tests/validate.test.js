import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWeek, validateSeason } from '../assets/coach/validate.js';
import { normalizeProfile, DAYS, peakHoursFor } from '../assets/coach/profile.js';
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

/* ---- a season sized by the athlete's own week cannot outrun it ------------ */

const availOf = (mins) => normalizeProfile({ availability: mins });
const DEFAULT_WEEK = { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 }; // 11.5h

/** A season as validateSeason wants it: model weeks plus their built sessions. */
const seasonWith = (prof, weeks = 16, size = { peakHours: peakHoursFor(prof) }) =>
  fitToRace({ ...size, weeks }).map((w) => ({
    ...w,
    sessions: generateWeek({
      hours: w.hours, block: w.block, profile: prof, idPrefix: `w${w.absWeek}`,
    }).sessions,
  }));

test('a season sized by the athlete week is never flagged as flattened, at any week length', () => {
  for (const mins of [DEFAULT_WEEK, { Mon: 0, Tue: 45, Wed: 60, Thu: 45, Fri: 0, Sat: 120, Sun: 90 }, anyDay(60)]) {
    const prof = availOf(mins);
    for (const weeks of [8, 16, 27, 43]) {
      const issues = validateSeason(seasonWith(prof, weeks), { profile: prof });
      assert.ok(!codes(issues).includes('season-flattened'), `${weeks} weeks: ${codes(issues)}`);
      const hours = seasonWith(prof, weeks).map((w) => w.hours);
      assert.ok(Math.max(...hours) * 60 <= Object.values(prof.availability).reduce((a, b) => a + b, 0));
      assert.ok(new Set(hours).size > 3, 'the season still builds and tapers');
    }
  }
});

/* ---- volume-beyond-race: a plan aimed at the wrong size of race ----------- */

const BIG_WEEK = { Mon: 600, Tue: 600, Wed: 600, Thu: 600, Fri: 600, Sat: 600, Sun: 600 };
const raceProf = (availability, raceType) => normalizeProfile({ availability, raceType });

test('a sprint plan for an empty diary is flagged', () => {
  const prof = raceProf(BIG_WEEK, 'sprint');
  const issues = validateSeason(seasonWith(prof), { profile: prof });
  const hit = issues.find((i) => i.code === 'volume-beyond-race');
  assert.ok(hit, `expected volume-beyond-race, got ${codes(issues)}`);
  assert.equal(hit.level, 'warn');
  assert.equal(hit.weekIndex, null);
  assert.match(hit.message, /Sprint/, 'named the way the picker names it, now that it offers one');
  assert.doesNotMatch(hit.message, /annual/i, 'there is no annual figure to check any more');
});

test('the warning names the distance the way the athlete sees it', () => {
  // The message is copy, so it says what the picker says. A stored '70.3'
  // reaching the athlete as '70.3' would be the one place in the app still
  // calling the distance by its key.
  const prof = raceProf({ Mon: 600, Tue: 600, Wed: 600, Thu: 600, Fri: 600, Sat: 600, Sun: 600 }, '70.3');
  const hit = validateSeason(seasonWith(prof), { profile: prof })
    .find((i) => i.code === 'volume-beyond-race');
  assert.ok(hit, 'expected volume-beyond-race');
  assert.match(hit.message, /IM 70\.3/);
});

test('plausible weeks at every distance are left alone', () => {
  for (const raceType of ['sprint', 'olympic', '70.3', 'ironman']) {
    const prof = raceProf(DEFAULT_WEEK, raceType);
    const issues = validateSeason(seasonWith(prof), { profile: prof });
    assert.ok(!codes(issues).includes('volume-beyond-race'),
      `${raceType} on an 11.5h week should be fine, got ${codes(issues)}`);
  }
});

test('a stored season longer than the athlete week is not held against the race', () => {
  // Plans made before a season was sized by availability can carry weeks the
  // athlete never had time for. 57h of intent on an 11.5h week is 11.5h of
  // training, which is unremarkable for a sprint.
  const prof = raceProf(DEFAULT_WEEK, 'sprint');
  const out = codes(validateSeason(seasonWith(prof, 16, { annualHours: 2000 }), { profile: prof }));
  assert.ok(!out.includes('volume-beyond-race'), `got ${out}`);
});

/* ---- Seasons with more than one race in them ------------------------------

   A tune-up race splices a taper week and a race week into the block it lands
   in. Two of the rules above were written when a season could only have one
   race, and both fire on the engine's own output once it can have several. */

const landedSeason = (opts = {}) => {
  const prof = normalizeProfile({
    availability: { Mon: 0, Tue: 90, Wed: 105, Thu: 90, Fri: 75, Sat: 300, Sun: 210 },
  });
  const season = fitToRace({ annualHours: 500, weeks: 27, landings: opts.landings ?? [12] });
  return {
    profile: prof,
    weeks: season.map((w) => ({
      ...w,
      sessions: generateWeek({
        hours: w.hours, block: w.block, profile: prof, idPrefix: `w${w.absWeek}`,
      }).sessions,
    })),
  };
};

test('a season with a tune-up race in it does not trip the engine own warnings', () => {
  // The same regression test as for the default season, and the same reason.
  // Both rules below were caught by exactly this.
  const { weeks, profile: prof } = landedSeason();
  const issues = validateSeason(weeks, { profile: prof });
  assert.deepEqual(issues, [], `a freshly generated season should be clean, got ${JSON.stringify(issues, null, 1)}`);
});

test('two tune-up races in one season are still clean', () => {
  const { weeks, profile: prof } = landedSeason({ landings: [8, 17] });
  assert.deepEqual(validateSeason(weeks, { profile: prof }), []);
});

test('the taper rule applies within a taper, not to everything after one', () => {
  // Volume rising again after a tune-up race is the plan resuming, not a taper
  // going backwards. Measured to the end of the season it fired on every week.
  const weeks = seasonOf([600, 400, 250, 620, 640], {
    blocks: ['Base 2', 'Taper', 'Race', 'Base 3', 'Base 3'],
  });
  assert.ok(!codes(validateSeason(weeks, { profile })).includes('taper-not-decreasing'));
});

test('a tune-up taper that goes back up is still flagged', () => {
  const weeks = seasonOf([600, 250, 400, 620], {
    blocks: ['Base 2', 'Taper', 'Race', 'Base 3'],
  });
  const hit = validateSeason(weeks, { profile }).find((i) => i.code === 'taper-not-decreasing');
  assert.ok(hit, `expected taper-not-decreasing, got ${codes(validateSeason(weeks, { profile }))}`);
  assert.equal(hit.weekIndex, 2);
});

test('resuming training after a race week is not a step too steep', () => {
  // The block-step ceiling compares against the previous block hardest week. A
  // race week is a deliberate down week, so every return from one cleared it.
  const weeks = seasonOf([600, 250, 150, 620], {
    blocks: ['Base 2', 'Taper', 'Race', 'Base 3'],
    loads: [1.4, 0.88, 0.7, 1.275],
  });
  assert.ok(!codes(validateSeason(weeks, { profile })).includes('block-step-too-steep'));
});

test('the block-step ceiling is still measured, just from the last block that loaded', () => {
  // Resetting at a race week must not become a blind spot either.
  const weeks = seasonOf([400, 250, 150, 900], {
    blocks: ['Base 2', 'Taper', 'Race', 'Base 3'],
    loads: [1.4, 0.88, 0.7, 1.5],
  });
  const hit = validateSeason(weeks, { profile }).find((i) => i.code === 'block-step-too-steep');
  assert.ok(hit, 'doubling volume coming out of a race week should not pass silently');
  assert.equal(hit.weekIndex, 3);
  assert.match(hit.message, /6\.7h/, 'measured against Base 2, not against the race week');
});

/* Races the season model could not build a taper for. The athlete is told at
   the diff, where they are deciding — not left to notice a missing taper weeks
   later. `diffPlans` passes these through from `planLandings`. */

test('a race inside the primary taper is reported against its week', () => {
  const weeks = seasonOf([600, 400, 250], { blocks: ['Build 2', 'Peak', 'Race'] });
  const hit = validateSeason(weeks, {
    profile,
    refusedLandings: [{ absWeek: 1, reason: 'in-primary-taper' }],
  }).find((i) => i.code === 'race-in-primary-taper');
  assert.ok(hit);
  assert.equal(hit.level, 'warn', 'the race is the athlete own call; it is not impossible');
  assert.equal(hit.weekIndex, 1);
});

test('two races too close together is reported against the later one', () => {
  const hit = validateSeason(seasonOf([600, 610, 620]), {
    profile,
    refusedLandings: [{ absWeek: 2, reason: 'too-close' }],
  }).find((i) => i.code === 'races-too-close');
  assert.ok(hit);
  assert.equal(hit.weekIndex, 2);
});

test('a race outside the season is not warned about', () => {
  // The calendar draws those deliberately — a race further out than the plan
  // reaches is exactly the one you have not built for yet. Warning on every
  // parked future race would be noise.
  const issues = validateSeason(seasonOf([600, 610]), {
    profile,
    refusedLandings: [{ absWeek: 99, reason: 'outside-season' }],
  });
  assert.deepEqual(issues.filter((i) => i.code.startsWith('race')), []);
});

test('no refused landings is no new warnings', () => {
  const weeks = seasonOf([600, 610]);
  assert.deepEqual(validateSeason(weeks, { profile }), validateSeason(weeks, { profile, refusedLandings: [] }));
});

/* ---- long days and sessions a day ---- */

test('more sessions on a day than the athlete allows is a warning', () => {
  const capped = normalizeProfile({ availability: anyDay(180), maxSessionsPerDay: 1 });
  const week = [s('Tue', 'Swim', '0:45'), s('Tue', 'Run', '0:40'), s('Wed', 'Bike', '1:00')];
  const hits = validateWeek(week, { profile: capped }).filter((i) => i.code === 'too-many-sessions');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].level, 'warn');
  assert.match(hits[0].message, /Tue/);
  assert.deepEqual(codes(validateWeek(week, { profile })).filter((c) => c === 'too-many-sessions'), [],
    'without a cap, two on a day is fine');
});

test('a long day with no time on it is said once for the season, not every week', () => {
  const p = normalizeProfile({
    availability: { ...anyDay(180), Mon: 0 }, longDays: { Bike: 'Mon', Run: 'Sun' },
  });
  const weeks = fitToRace({ annualHours: 500, weeks: 6 }).map((w) => ({
    ...w, sessions: generateWeek({ hours: w.hours, block: w.block, profile: p }).sessions,
  }));
  const hits = validateSeason(weeks, { profile: p }).filter((i) => i.code === 'long-day-unavailable');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /Mon/);
});

test('a long day a constraint rules out is said too', () => {
  const p = normalizeProfile({
    availability: anyDay(180), longDays: { Run: 'Sat' },
    constraints: [{ disc: 'Run', rule: 'avoidDays', value: ['Sat'] }],
  });
  const weeks = [{ absWeek: 0, block: 'Base 1', hours: 8, sessions: [] }];
  assert.ok(codes(validateSeason(weeks, { profile: p })).includes('long-day-unavailable'));
});

/* ---- the weekly pattern ---- */

const patterned = (extra = {}) => normalizeProfile({
  availability: { ...anyDay(120), Mon: 0 },
  weekPattern: { Run: ['Tue', 'Thu', 'Sat'], Swim: ['Fri', 'Sat', 'Sun'] },
  sessionCounts: { Base: { Run: 3, Swim: 2 }, Build: { Run: 3, Swim: 2 } },
  ...extra,
});
const seasonBlocks = (blocks) => blocks.map((block, absWeek) => ({ absWeek, block, hours: 8, sessions: [] }));
const slotHits = (weeks, p) => validateSeason(weeks, { profile: p }).filter((i) => i.code === 'pattern-slot-unavailable');

test('a listed day with no time is said once for the season, not every week', () => {
  const p = patterned({ availability: { ...anyDay(120), Mon: 0, Thu: 0 } });
  const hits = slotHits(seasonBlocks(['Base 1', 'Base 2', 'Base 3', 'Build 1', 'Build 2']), p);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].level, 'warn');
  assert.equal(hits[0].weekIndex, null);
  assert.match(hits[0].message, /Thu/);
});

test('a listed day a constraint rules out is said too', () => {
  const p = patterned({ constraints: [{ disc: 'Swim', rule: 'avoidDays', value: ['Fri'] }] });
  const hits = slotHits(seasonBlocks(['Base 1']), p);
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /Fri/);
  assert.match(hits[0].message, /swim/i);
});

test('a day past the count is not needed, so it is not said', () => {
  // Swim wants two: Fri and Sat. Sun being unusable changes nothing.
  const p = patterned({ availability: { ...anyDay(120), Mon: 0, Sun: 0 } });
  assert.deepEqual(slotHits(seasonBlocks(['Base 1']), p), []);
});

test('only the blocks the season has are read', () => {
  const p = patterned({
    availability: { ...anyDay(120), Mon: 0, Thu: 0 },
    sessionCounts: { Base: { Run: 2, Swim: 1 }, Build: { Run: 3, Swim: 1 } },
  });
  // Base asks for Tue and Thu only for two runs; a season with no Build never needs Sat.
  assert.equal(slotHits(seasonBlocks(['Base 1']), p).length, 1);
  const needsThird = patterned({
    availability: { ...anyDay(120), Mon: 0, Sat: 0 },
    sessionCounts: { Base: { Run: 2, Swim: 1 }, Build: { Run: 3, Swim: 1 } },
  });
  assert.deepEqual(slotHits(seasonBlocks(['Base 1']), needsThird), []);
  assert.equal(slotHits(seasonBlocks(['Base 1', 'Build 1']), needsThird).length, 1);
});

test('more swims than the cap allows is capped silently, with no warning', () => {
  const p = patterned({
    availability: { ...anyDay(120), Mon: 0, Sun: 0 },
    constraints: [{ disc: 'Swim', rule: 'maxPerWeek', value: 1 }],
    sessionCounts: { Base: { Run: 3, Swim: 3 } },
  });
  assert.deepEqual(slotHits(seasonBlocks(['Base 1']), p), []);
});

test('it never fires on a profile without a pattern', () => {
  const plain = normalizeProfile({ availability: { ...anyDay(120), Mon: 0, Thu: 0 } });
  assert.deepEqual(slotHits(seasonBlocks(['Base 1', 'Build 1']), plain), []);
  assert.deepEqual(slotHits(seasonBlocks(['Base 1']), patterned({ sessionCounts: undefined })), []);
});

/* The planner builds weeks against the ceilings the validator holds them to, so
   it reads them from here rather than keeping its own copy. */

import { MAX_RAMP, MAX_BLOCK_STEP } from '../assets/coach/validate.js';

test('the volume steps the validator allows are exported for the planner to read', () => {
  assert.equal(MAX_RAMP, 1.1, 'a loading week may be 10% above the last one within a block');
  assert.equal(MAX_BLOCK_STEP, 1.25, 'and a new block may open 25% above the last block\'s hardest week');
});
