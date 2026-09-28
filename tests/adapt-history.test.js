import test from 'node:test';
import assert from 'node:assert/strict';

import { HISTORY_THRESHOLDS, THRESHOLDS, suggest } from '../assets/coach/adapt.js';
import { newPlan, sessionsAt } from '../assets/coach/plan.js';
import { setActual } from '../assets/coach/actuals.js';
import { resolveSplit } from '../assets/coach/generate.js';
import { DISCIPLINES } from '../assets/coach/profile.js';
import { durToMin } from '../assets/coach/duration.js';

/* The rules that read synced history rather than the plan's own log.

   Same principles as the rest of adapt.js, applied harder because history is
   evidence about the athlete and not just about the plan: silence when fewer
   than three synced weeks are covered, never propose an increase from history,
   and never touch a week that has already started. */

const START = '2026-09-28';                           // a Monday; week 0 is the planned week
const PRIOR = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
const SYNC = { source: 'garmin', from: '2026-08-01', through: '2026-09-27', at: 1 };

const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

/** Synced activities: `perWeek` is minutes per discipline, spread over the week. */
function synced(perWeek, mondays = PRIOR) {
  const out = [];
  let id = 0;
  for (const monday of mondays) {
    Object.entries(perWeek).forEach(([disc, minutes], i) => {
      if (!minutes) return;
      out.push({ id: `garmin:${++id}`, source: 'garmin', date: addDays(monday, i + 1), disc, durationS: minutes * 60 });
    });
  }
  return out;
}

const plan = (over = {}) => ({
  ...newPlan({ name: 'H', startISO: START, raceDate: '2027-06-27', raceType: '70.3', now: 1 }),
  activitySync: SYNC,
  ...over,
});

const hoursOf = (p, w) => sessionsAt(p, w).reduce((a, s) => a + durToMin(s.dur), 0) / 60;
const byCode = (list, code) => list.find((x) => x.code === code);

/* ---- plan outruns history ---- */

test('a planned week well above what has been trained is flagged, from week one', () => {
  const p = plan({ activities: synced({ Swim: 45, Bike: 120, Run: 75 }) });   // 4h a week
  const s = byCode(suggest(p, { week: 0 }), 'plan-outruns-history');
  assert.ok(hoursOf(p, 0) > 4 * THRESHOLDS.maxRamp, 'fixture: the plan asks for more than a 10% step');
  assert.ok(s, 'fires before the week-one return');
  assert.equal(s.severity, 'warn');
  assert.deepEqual(s.action, { tool: 'set_week_budget', input: { week: 0, hours: 4.4 } });
  assert.equal(s.evidence.coveredWeeks, 4);
  assert.equal(s.evidence.avgHours, 4);
  assert.deepEqual(s.evidence.weeklyHours, [4, 4, 4, 4]);
  assert.match(s.message, /4h/);
});

test('history never proposes more than the plan already has', () => {
  const p = plan({ activities: synced({ Bike: 600 }) });   // 10h a week
  assert.equal(byCode(suggest(p, { week: 0 }), 'plan-outruns-history'), undefined);
});

test('fewer than three covered weeks is too little to go on', () => {
  const late = { ...SYNC, from: '2026-09-10' };   // covers 09-14 and 09-21 only
  const p = plan({ activities: synced({ Bike: 120 }), activitySync: late });
  assert.equal(HISTORY_THRESHOLDS.minCovered, 3);
  assert.deepEqual(suggest(p, { week: 0 }).filter((x) => x.code !== 'season-flattened'), []);
});

test('no sync, no history rules', () => {
  const p = plan({ activities: synced({ Bike: 120 }) });
  delete p.activitySync;
  assert.deepEqual(suggest(p, { week: 0 }).filter((x) => x.code !== 'season-flattened'), []);
});

test('a trickle of training is not a baseline to plan from', () => {
  const p = plan({ activities: synced({ Run: 60 }) });   // 1h a week
  assert.equal(byCode(suggest(p, { week: 0 }), 'plan-outruns-history'), undefined);
});

test('a week the athlete already pinned is left alone', () => {
  const p = plan({ activities: synced({ Bike: 240 }), weekBudgets: { w0: 9 } });
  assert.equal(byCode(suggest(p, { week: 0 }), 'plan-outruns-history'), undefined);
});

test('a week already under way is history, not something to rebuild', () => {
  const p = plan({ activities: synced({ Bike: 240 }), activitySync: { ...SYNC, through: '2026-09-29' } });
  assert.equal(byCode(suggest(p, { week: 0 }), 'plan-outruns-history'), undefined);
  assert.ok(byCode(suggest(p, { week: 1 }), 'plan-outruns-history'), 'next week is still fair game');
});

/* ---- discipline split ---- */

test('recorded training that drifts from the block split is pointed out', () => {
  const p = plan({ activities: synced({ Swim: 30, Bike: 240, Run: 60, Strength: 30 }) });   // 6h, bike-heavy
  const block = p.season[0].block;
  const planned = resolveSplit(block, p.profile);
  const s = byCode(suggest(p, { week: 0 }), 'split-drift');
  assert.ok(s, `planned split ${JSON.stringify(planned)}`);
  assert.equal(s.severity, 'info');
  assert.equal(s.action.tool, 'set_split');
  assert.equal(s.action.input.block, block);
  const w = s.action.input.weights;
  assert.ok(Object.keys(w).every((d) => DISCIPLINES.includes(d)));
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.051, `weights sum to ${sum}`);
  for (const v of Object.values(w)) assert.equal(Math.round(v * 20), v * 20, 'rounded to 5%');
});

test('a split proposal never drops a discipline the block schedules', () => {
  const p = plan({ activities: synced({ Bike: 300, Run: 60 }) });   // no swimming at all
  const s = byCode(suggest(p, { week: 0 }), 'split-drift');
  assert.ok(s);
  assert.equal(s.action, null, 'said, but not proposed as a split with swimming at zero');
});

test('a split is not judged on a few hours', () => {
  const p = plan({ activities: synced({ Bike: 30, Run: 20 }, PRIOR.slice(1)) });
  assert.equal(byCode(suggest(p, { week: 0 }), 'split-drift'), undefined);
});

/* ---- long sessions ---- */

test('a planned long session far beyond anything recorded is pointed out, not changed', () => {
  const p = plan({ activities: synced({ Swim: 45, Bike: 60, Run: 40 }) });
  const longRide = Math.max(...sessionsAt(p, 0).filter((x) => x.disc === 'Bike').map((x) => durToMin(x.dur)));
  const s = suggest(p, { week: 0 }).find((x) => x.code === 'long-session-jump' && x.evidence.discipline === 'Bike');
  if (longRide >= 60 * HISTORY_THRESHOLDS.longJump && longRide - 60 >= HISTORY_THRESHOLDS.longJumpMinutes) {
    assert.ok(s, `planned ride ${longRide}m`);
    assert.equal(s.severity, 'info');
    assert.equal(s.action, null);
    assert.equal(s.evidence.longestRecorded, 60);
    assert.equal(s.evidence.longestPlanned, longRide);
  } else {
    assert.equal(s, undefined);
  }
});

test('a discipline never recorded is not a jump — there is nothing to jump from', () => {
  const p = plan({ activities: synced({ Run: 200 }) });
  const jumps = suggest(p, { week: 0 }).filter((x) => x.code === 'long-session-jump');
  assert.ok(jumps.every((x) => x.evidence.discipline === 'Run'));
});

/* ---- best effort ---- */

const tenK = (date, seconds) => ({
  id: `garmin:r${date}`, source: 'garmin', date, disc: 'Run', durationS: seconds, distanceM: 10000, name: 'Parkrun x2',
});

test('a synced run faster than the benchmark is offered, never adopted', () => {
  const p = plan({
    activities: [tenK('2026-09-20', 42 * 60)],
    benchmarks: [{ id: 'bm-1', date: '2026-05-01', distanceMeters: 10000, timeSeconds: 50 * 60, source: 'manual', current: true }],
  });
  const s = byCode(suggest(p, { week: 0 }), 'best-effort');
  assert.ok(s);
  assert.equal(s.severity, 'info');
  assert.equal(s.action, null);
  assert.equal(s.offer.kind, 'benchmark');
  assert.equal(s.offer.candidate.source, 'garmin');
  assert.equal(s.offer.candidate.timeSeconds, 42 * 60);
  assert.equal(s.offer.candidate.date, '2026-09-20');
});

test('no offer when the benchmark is already as good', () => {
  const p = plan({
    activities: [tenK('2026-09-20', 42 * 60)],
    benchmarks: [{ id: 'bm-1', date: '2026-09-20', distanceMeters: 10000, timeSeconds: 42 * 60, source: 'garmin', current: true }],
  });
  assert.equal(byCode(suggest(p, { week: 0 }), 'best-effort'), undefined);
});

test('an old effort is not offered', () => {
  const p = plan({ activities: [tenK('2026-07-01', 40 * 60)] });
  assert.equal(byCode(suggest(p, { week: 0 }), 'best-effort'), undefined);
});

test('with no benchmark at all, a good synced effort is offered', () => {
  const p = plan({ activities: [tenK('2026-09-20', 45 * 60)] });
  assert.ok(byCode(suggest(p, { week: 0 }), 'best-effort'));
});

/* ---- one budget per week ---- */

test('when two rules propose a budget for the same week, the lower one is the proposal', () => {
  // Weeks 0-1 logged at half their plan (under-compliance), and synced history
  // lower still (the plan outruns it). Both say "less"; only the lower is offered.
  let p = newPlan({ name: 'H', startISO: '2026-09-14', raceDate: '2027-06-27', raceType: '70.3', now: 1 });
  for (const w of [0, 1]) {
    for (const s of sessionsAt(p, w).filter((x) => durToMin(x.dur) > 0)) {
      p = setActual(p, s.id, { status: 'partial', min: Math.round(durToMin(s.dur) / 2) });
    }
  }
  p = { ...p, activitySync: SYNC, activities: synced({ Bike: 90, Run: 60 }) };   // 2.5h a week
  const list = suggest(p, { week: 2 });
  const budgets = list.filter((x) => x.action?.tool === 'set_week_budget');
  assert.equal(budgets.length, 1, JSON.stringify(list.map((x) => [x.code, x.action])));
  assert.equal(budgets[0].code, 'plan-outruns-history');
  assert.equal(budgets[0].action.input.hours, 2.7);
  assert.equal(byCode(list, 'under-compliance').action, null, 'still said, no longer proposed');
});

test('every history suggestion carries its evidence and a number in its message', () => {
  const p = plan({ activities: synced({ Swim: 30, Bike: 240, Run: 60, Strength: 30 }) });
  for (const s of suggest(p, { week: 0 }).filter((x) => x.code !== 'season-flattened')) {
    assert.ok(s.evidence && typeof s.evidence === 'object', s.code);
    assert.match(s.message, /\d/, s.code);
  }
});

test('reading history mutates nothing', () => {
  const p = plan({ activities: synced({ Bike: 120 }) });
  const snapshot = structuredClone(p);
  suggest(p, { week: 0 });
  assert.deepEqual(p, snapshot);
});
