import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startFitness } from '../assets/coach/startfit.js';
import { PLAN_MODEL } from '../assets/coach/targets.js';
import { HISTORY_THRESHOLDS } from '../assets/coach/history.js';

/* Where the athlete's fitness stands today, as the chronic training load the
   season is built up from. Three sources, tried in this order: the athlete's
   own typed figure; their synced sessions, when there are enough of them and
   enough can be scored; an estimate from their recent weekly hours.

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

test('a figure the athlete typed wins, as long as it is a usable number', () => {
  const r = startFitness({ ...base, entered: 72 });
  assert.equal(r.source, 'entered');
  assert.equal(r.ctl, 72);
  assert.match(r.note, /entered/i);
  assert.equal(startFitness({ ...base, entered: '65.25' }).ctl, 65.3);
  assert.equal(startFitness({ ...base, entered: 0 }).source, 'entered', 'zero is an answer: starting from nothing');
  for (const bad of [-1, 'lots', null, undefined, NaN, '', PLAN_MODEL.estimate.maxCtl + 1]) {
    assert.notEqual(startFitness({ ...base, entered: bad }).source, 'entered', String(bad));
  }
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

test('the answer is always one of the three sources, with the fields the plan stores', () => {
  for (const input of [base, { today: TODAY, athlete: { recentWeeklyHours: 6 } }, { ...base, entered: 50 }, { today: TODAY }]) {
    const r = startFitness(input);
    assert.deepEqual(Object.keys(r).sort(), ['asOf', 'coveredWeeks', 'ctl', 'note', 'scoredShare', 'source']);
    assert.ok(['garmin', 'estimate', 'entered'].includes(r.source));
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
