import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startFitness, startLine, syncBasis } from '../assets/coach/startfit.js';
import { loadThresholds } from '../assets/coach/load.js';
import { PLAN_MODEL } from '../assets/coach/targets.js';
import { HISTORY_THRESHOLDS } from '../assets/coach/history.js';

/* Where the athlete's fitness stands today, as the chronic training load (CTL)
   the season is built up from. Two sources, tried in this order: their synced
   sessions, when there are enough of them and enough can be scored; an estimate
   from their recent weekly hours. Nobody types a figure in.

   Heart rate is never read here. The figure ends up on the plan, which syncs
   and exports, so it is worked out only from power, pace, swim pace and
   session effort — see the note at the top of startfit.js. */

const TODAY = '2026-10-14';                                   // a Wednesday
const day = (n) => new Date(Date.UTC(2026, 7, 17) + n * 86400000).toISOString().slice(0, 10); // from Mon 17 Aug
const FTP = { ftpW: 250 };

// One hour of bike at 200 W on 250 W FTP: 64 load.
const ride = (date, extra = {}) => ({
  id: `garmin:${date}`, source: 'garmin', date, disc: 'Bike', durationS: 3600, normPowerW: 200, ...extra,
});
const everyDay = (from, to, extra) => {
  const out = [];
  for (let d = from; d <= to; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) out.push(ride(d, extra));
  return out;
};
const sync = (from, through) => ({ source: 'garmin', from, through, at: 1 });

const base = {
  activities: everyDay('2026-08-17', '2026-10-11'),
  activitySync: sync('2026-08-17', '2026-10-11'),
  loadRefs: FTP,
  athlete: { recentWeeklyHours: 8 },
  today: TODAY,
};

test('enough synced, scoreable sessions: the figure is theirs, and it says so', () => {
  const r = startFitness(base);
  assert.equal(r.source, 'garmin');
  assert.ok(Math.abs(r.ctl - 64) < 1, `a steady 64 a day reads about 64, got ${r.ctl}`);
  assert.ok(r.coveredWeeks >= HISTORY_THRESHOLDS.minCovered);
  assert.equal(r.scoredShare, 1);
  assert.match(r.note, /synced/);
});

test('three weeks of history is enough, because the average starts at the athlete\'s level and not at zero', () => {
  const three = {
    ...base,
    activities: everyDay('2026-09-21', '2026-10-11'),
    activitySync: sync('2026-09-21', '2026-10-11'),
  };
  const r = startFitness(three);
  assert.equal(r.source, 'garmin');
  assert.equal(r.coveredWeeks, 3);
  // From zero, 21 days of 64 reads 64 × (1 − e^(−21/42)) ≈ 25.
  assert.ok(Math.abs(r.ctl - 64) < 2, `got ${r.ctl}`);
});

test('a history that began with nothing reads as the climb it was', () => {
  // Synced since August, but only the last week has anything in it.
  const r = startFitness({ ...base, activities: everyDay('2026-10-05', '2026-10-11') });
  assert.equal(r.source, 'garmin');
  assert.ok(r.ctl < 25, `one hard week on a long empty history is still a low average, got ${r.ctl}`);
});

test('under the minimum number of covered weeks it is an estimate from recent hours', () => {
  const two = {
    ...base,
    activities: everyDay('2026-09-28', '2026-10-11'),
    activitySync: sync('2026-09-28', '2026-10-11'),
  };
  const r = startFitness(two);
  assert.equal(r.coveredWeeks, 2);
  assert.equal(r.source, 'estimate');
  assert.equal(r.ctl, Math.round((8 * PLAN_MODEL.estimate.loadPerHour / 7) * 10) / 10);
  assert.match(r.note, /estimate/i);
});

test('history that mostly cannot be scored is not trusted, and the note says what would help', () => {
  const unscored = { ...base, activities: everyDay('2026-08-17', '2026-10-11', { normPowerW: undefined }) };
  const r = startFitness(unscored);
  assert.equal(r.source, 'estimate');
  assert.equal(r.scoredShare, 0);
  assert.match(r.note, /FTP/);
});

test('the scored share is counted in minutes, and the bar is PLAN_MODEL.garmin.scoredShare', () => {
  // Every day one scoreable hour; on `unscoredDays` of them also an unscoreable one (no power).
  const mix = (extraMinutesPerDay) => {
    const acts = everyDay('2026-08-17', '2026-10-11');
    return acts.concat(acts.map((a) => ({ ...a, id: `${a.id}-b`, normPowerW: undefined, durationS: extraMinutesPerDay * 60 })));
  };
  const share = PLAN_MODEL.garmin.scoredShare;                // 0.6: scored / (scored + unscored)
  const justOver = Math.floor(60 * (1 / share - 1)) - 1;       // unscored minutes that keep it above the bar
  const justUnder = Math.ceil(60 * (1 / share - 1)) + 1;
  assert.equal(startFitness({ ...base, activities: mix(justOver) }).source, 'garmin');
  assert.equal(startFitness({ ...base, activities: mix(justUnder) }).source, 'estimate');
});

test('unscoreable sessions add nothing to the figure; they are not guessed at', () => {
  const clean = startFitness(base);
  const withUnscored = startFitness({
    ...base,
    activities: [...base.activities, ...everyDay('2026-09-01', '2026-09-05', { id: undefined, normPowerW: undefined, durationS: 600 })
      .map((a, i) => ({ ...a, id: `garmin:u${i}` }))],
  });
  assert.equal(withUnscored.source, 'garmin');
  assert.equal(withUnscored.ctl, clean.ctl);
});

test('days after the last synced day are not read as days off', () => {
  const stale = { ...base, today: '2026-10-25' };            // two weeks after the sync's last day
  const r = startFitness(stale);
  assert.equal(r.asOf, '2026-10-11', 'read as of the last day the sync covers');
  assert.ok(Math.abs(r.ctl - startFitness(base).ctl) < 0.1);
});

test('the figure is as of today when the sync reaches today', () => {
  const r = startFitness({ ...base, activitySync: sync('2026-08-17', '2026-10-14'), activities: everyDay('2026-08-17', '2026-10-14') });
  assert.equal(r.asOf, TODAY);
});

test('with no history, the estimate is hours × a nominal hour ÷ 7', () => {
  const none = { today: TODAY, athlete: { recentWeeklyHours: 8 } };
  const r = startFitness(none);
  assert.equal(r.source, 'estimate');
  assert.equal(r.coveredWeeks, 0);
  assert.equal(r.scoredShare, null);
  assert.equal(r.ctl, 62.9);                                   // 8 × 55 ÷ 7, one decimal
  assert.equal(startFitness({ ...none, athlete: { recentWeeklyHours: 12 } }).ctl, 94.3);
});

test('years in the sport and per-sport background move the estimate a little, not a lot', () => {
  const at = (athlete) => startFitness({ today: TODAY, athlete: { recentWeeklyHours: 10, ...athlete } }).ctl;
  const plain = at({});
  assert.ok(at({ yearsInSport: 0 }) < plain, 'a first-year athlete reads lower');
  assert.ok(at({ yearsInSport: 10 }) > plain, 'a long-time one reads higher');
  assert.ok(at({ levels: { Swim: 'new', Bike: 'new', Run: 'new' } }) < plain);
  assert.ok(at({ levels: { Swim: 'strong', Bike: 'strong', Run: 'strong' } }) > plain);
  assert.equal(at({ levels: { Swim: 'some', Bike: 'some', Run: 'some' } }), plain, 'some is neutral');
  // Mixed: the factors average over the sports given.
  assert.equal(at({ levels: { Swim: 'new', Bike: 'strong' } }), plain, 'new 0.9 and strong 1.1 average to 1');
  // Small: nothing here moves it by more than the table's own extremes.
  const lo = PLAN_MODEL.estimate.years[0].factor * PLAN_MODEL.estimate.level.new;
  const hi = PLAN_MODEL.estimate.years.at(-1).factor * PLAN_MODEL.estimate.level.strong;
  assert.ok(at({ yearsInSport: 0, levels: { Run: 'new' } }) >= plain * lo - 0.1);
  assert.ok(at({ yearsInSport: 30, levels: { Run: 'strong' } }) <= plain * hi + 0.1);
});

test('body measurements play no part in the estimate', () => {
  const at = (athlete) => startFitness({ today: TODAY, athlete: { recentWeeklyHours: 10, ...athlete } }).ctl;
  const plain = at({});
  assert.equal(at({ weightKg: 55, heightCm: 160, birthYear: 1960, sex: 'female' }), plain);
  assert.equal(at({ weightKg: 110, heightCm: 200, birthYear: 2000, sex: 'male' }), plain);
});

test('the estimate cannot exceed a plausible ceiling', () => {
  const r = startFitness({ today: TODAY, athlete: { recentWeeklyHours: 40, yearsInSport: 30, levels: { Run: 'strong' } } });
  assert.ok(r.ctl <= PLAN_MODEL.estimate.maxCtl);
});

test('with neither hours nor history there is no figure, and the note says what to give', () => {
  const r = startFitness({ today: TODAY });
  assert.equal(r.ctl, null);
  assert.equal(r.source, 'estimate');
  assert.match(r.note, /hours/i);
  assert.equal(startFitness({ today: TODAY, athlete: { recentWeeklyHours: 0 } }).ctl, null, 'zero hours is no basis for one');
});

test('nothing handed in is changed, and the same inputs give the same answer', () => {
  const copy = structuredClone(base);
  const a = startFitness(base);
  assert.deepEqual(base, copy);
  assert.deepEqual(startFitness(base), a);
});

test('the answer is always one of the two sources, with the fields the plan stores', () => {
  for (const input of [base, { today: TODAY, athlete: { recentWeeklyHours: 6 } }, { ...base, entered: 50 }, { today: TODAY }]) {
    const r = startFitness(input);
    assert.deepEqual(Object.keys(r).sort(), ['asOf', 'coveredWeeks', 'ctl', 'note', 'scoredShare', 'source']);
    assert.ok(['garmin', 'estimate'].includes(r.source));
  }
});

/* ---- heart rate ---- */

const code = (file) => readFileSync(new URL(`../assets/coach/${file}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('startfit.js reads no heart rate: no store of it, no threshold for it, no method that uses it', () => {
  const src = code('startfit.js');
  for (const re of [/hrById/, /hrThresholds/, /\bheart/i, /\bhr\b/i, /trimp/i, /lthr/i]) {
    assert.doesNotMatch(src, re, `startfit.js mentions ${re}`);
  }
});

test('an activity only heart rate could score is left out of the figure, not scored', () => {
  // No power, no FTP for it: the heart-rate method would be the only way in. It is not offered.
  const hrOnly = { id: 'garmin:hr', source: 'garmin', date: '2026-10-10', disc: 'Bike', durationS: 7200 };
  const a = startFitness(base);
  const b = startFitness({ ...base, activities: [...base.activities, hrOnly] });
  assert.equal(b.ctl, a.ctl);
  assert.ok(b.scoredShare < a.scoredShare, 'but it does count against how much of the time could be scored');
});

/* ---- the athlete's fitness at a date in the past ---- */

import { actualCtlAt, startNote } from '../assets/coach/startfit.js';

test('the fitness a synced history gives at a date it covers, as the review re-anchors from', () => {
  const r = actualCtlAt({ ...base, date: '2026-10-04' });
  assert.ok(r);
  assert.ok(Math.abs(r.ctl - 64) < 1, `a steady 64 a day reads about 64, got ${r.ctl}`);
  assert.equal(r.scoredShare, 1);
});

test('there is no figure for a date the sync does not reach, or reached only just before', () => {
  assert.equal(actualCtlAt({ ...base, date: '2026-10-20' }), null, 'after the last synced day');
  assert.equal(actualCtlAt({ ...base, date: '2026-08-25' }), null, 'a week into the sync: too little to read a level from');
  assert.equal(actualCtlAt({ date: '2026-10-04', loadRefs: FTP, activities: [] }), null, 'no sync at all');
});

test('history that mostly cannot be scored gives no figure for a date either', () => {
  assert.equal(actualCtlAt({ ...base, date: '2026-10-04', activities: everyDay('2026-08-17', '2026-10-11', { normPowerW: undefined }) }), null);
});

test('heart rate is not read for a date in the past any more than for today', () => {
  const hrOnly = { id: 'garmin:hr', source: 'garmin', date: '2026-10-02', disc: 'Bike', durationS: 7200 };
  assert.equal(actualCtlAt({ ...base, date: '2026-10-04', activities: [...base.activities, hrOnly] }).ctl, actualCtlAt({ ...base, date: '2026-10-04' }).ctl);
});

test('a stored start is described in words, from what is stored and nothing else', () => {
  assert.match(startNote({ source: 'garmin', coveredWeeks: 6 }), /6 weeks of your synced sessions/);
  assert.match(startNote({ source: 'estimate' }), /estimate/i);
  assert.match(startNote({ source: 'entered' }), /entered/i, 'a stored start from before the field went away is still described');
  assert.equal(startNote({ source: 'heart-rate' }), '');
  assert.equal(startNote(null), '');
});

/* ---- the basis every CTL and ATL display shares with the planner ---- */

const T = loadThresholds({ loadRefs: FTP });
const basisOf = (over = {}) => syncBasis({
  today: TODAY, activities: base.activities, activitySync: base.activitySync, thresholds: T, ...over,
});

test('with no sync there is no basis, and the record says what would be enough', () => {
  assert.deepEqual(basisOf({ activitySync: null, activities: [] }), {
    enough: false, reason: 'no-sync', coveredWeeks: 0,
    neededWeeks: HISTORY_THRESHOLDS.minCovered, scoredShare: null, neededShare: PLAN_MODEL.garmin.scoredShare,
  });
});

test('a sync that holds no recorded session in the last 42 days is read as no sync', () => {
  const r = basisOf({ activities: [], activitySync: sync('2026-08-17', '2026-10-11') });
  assert.equal(r.reason, 'no-sync');
  assert.equal(r.scoredShare, null);
  assert.ok(r.coveredWeeks >= HISTORY_THRESHOLDS.minCovered, 'the weeks were synced; there was nothing in them');
});

test('the basis is enough at exactly the minimum number of covered weeks, and short one week below it', () => {
  const weeks = (from) => ({ activities: everyDay(from, '2026-10-11'), activitySync: sync(from, '2026-10-11') });
  const two = basisOf(weeks('2026-09-28'));
  assert.equal(two.coveredWeeks, HISTORY_THRESHOLDS.minCovered - 1);
  assert.equal(two.enough, false);
  assert.equal(two.reason, 'too-short');
  const three = basisOf(weeks('2026-09-21'));
  assert.equal(three.coveredWeeks, HISTORY_THRESHOLDS.minCovered);
  assert.equal(three.enough, true);
  assert.equal(three.reason, null);
});

test('enough weeks that mostly cannot be scored is its own reason, with the share it has and the share it needs', () => {
  const r = basisOf({ activities: everyDay('2026-08-17', '2026-10-11', { normPowerW: undefined }) });
  assert.equal(r.enough, false);
  assert.equal(r.reason, 'unscorable');
  assert.equal(r.scoredShare, 0);
  assert.equal(r.neededShare, PLAN_MODEL.garmin.scoredShare);
});

test('the scored share is held to PLAN_MODEL.garmin.scoredShare, at the edge', () => {
  const mix = (extraMinutesPerDay) => {
    const acts = everyDay('2026-08-17', '2026-10-11');
    return acts.concat(acts.map((a) => ({ ...a, id: `${a.id}-b`, normPowerW: undefined, durationS: extraMinutesPerDay * 60 })));
  };
  const share = PLAN_MODEL.garmin.scoredShare;
  assert.equal(basisOf({ activities: mix(Math.floor(60 * (1 / share - 1)) - 1) }).enough, true);
  assert.equal(basisOf({ activities: mix(Math.ceil(60 * (1 / share - 1)) + 1) }).reason, 'unscorable');
});

test('heart rate cannot make a session count toward the basis, even when its thresholds are known', () => {
  const withHr = loadThresholds({ loadRefs: FTP, hrThresholds: { lthr: 170, max: 190, rest: 50, trimp: 'male' } });
  const noPower = everyDay('2026-08-17', '2026-10-11', { normPowerW: undefined });
  const r = basisOf({ activities: noPower, thresholds: withHr });
  assert.equal(r.reason, 'unscorable');
  assert.equal(r.scoredShare, 0);
});

test('the basis and startFitness hold the same bar: garmin exactly when the basis is enough', () => {
  const cases = [
    base,
    { ...base, activities: everyDay('2026-09-28', '2026-10-11'), activitySync: sync('2026-09-28', '2026-10-11') },
    { ...base, activities: everyDay('2026-09-21', '2026-10-11'), activitySync: sync('2026-09-21', '2026-10-11') },
    { ...base, activities: everyDay('2026-08-17', '2026-10-11', { normPowerW: undefined }) },
    { ...base, activitySync: null },
    { ...base, activities: [] },
    { ...base, today: '2026-10-25' },
  ];
  for (const c of cases) {
    const b = syncBasis({ today: c.today, activities: c.activities, activitySync: c.activitySync, thresholds: loadThresholds({ loadRefs: c.loadRefs }) });
    const r = startFitness(c);
    assert.equal(r.source === 'garmin', b.enough, JSON.stringify({ ...b }));
    assert.equal(r.coveredWeeks, b.coveredWeeks);
    assert.equal(r.scoredShare, b.scoredShare);
  }
});

test('a figure the athlete types is not a source: nothing in startFitness reads one', () => {
  for (const entered of [72, '65', 0]) {
    const r = startFitness({ ...base, entered });
    assert.equal(r.source, 'garmin');
    assert.equal(r.ctl, startFitness(base).ctl);
  }
  assert.equal(startFitness({ today: TODAY, athlete: { recentWeeklyHours: 8 }, entered: 72 }).source, 'estimate');
});

test('the line shown beside the plan says where today\'s fitness comes from, or that it is not available yet', () => {
  const g = startFitness(base);
  assert.equal(startLine(g), `Your fitness today: ${Math.round(g.ctl)} (CTL), from ${g.coveredWeeks} weeks of your synced sessions.`);
  const est = startFitness({ today: TODAY, athlete: { recentWeeklyHours: 8 } });
  assert.equal(startLine(est), 'Not available yet. We’ll size your season from your recent weekly hours and update it once your Garmin sessions give us enough data.');
  const none = startFitness({ today: TODAY });
  assert.match(startLine(none), /^Not available yet\./);
  assert.match(startLine(none), /hours a week/);
  assert.equal(startLine(null), startLine(none), 'nothing at all reads the same as nothing to go on');
});

test('a plan made before the field went away still says its start was typed', () => {
  assert.equal(startNote({ source: 'entered' }), 'Entered by you earlier.');
});
