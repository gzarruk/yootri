import test from 'node:test';
import assert from 'node:assert/strict';

import { PLANNED, FITNESS_BANDS, zoneIntensity, plannedLoad, formZone, raceFormPosition, fitnessSeries, minutesByDiscipline, carry } from '../assets/coach/fitness.js';
import { trainingLoad } from '../assets/coach/load.js';
import { PLAN_MODEL } from '../assets/coach/targets.js';
import { HISTORY_THRESHOLDS } from '../assets/coach/history.js';

/* Fitness, fatigue and form: the 42-day and 7-day averages of training load as
   of today, their difference, a line for what the plan asks, a line for what
   was done, and a projection to race day.

   Everything is derived when asked for and returned as plain numbers; nothing
   here is stored. Actual load is load.js's, unchanged. Planned load has no
   measurement behind it, so it is an estimate from each session's duration and
   zone through PLANNED's table, and says so. */

const bike = (dur, zone, day = 'Mon') => ({ id: `b-${day}-${dur}-${zone}`, disc: 'Bike', day, dur, zone });

test('a zone is an intensity, a range is the mean of its ends, and no zone is none', () => {
  assert.equal(zoneIntensity('Z2'), PLANNED.zoneIF[2]);
  assert.equal(zoneIntensity('Z2–Z4'), PLANNED.zoneIF[3]);   // mean of Z2 and Z4 is Z3
  assert.equal(zoneIntensity('Z1-Z2'), (PLANNED.zoneIF[1] + PLANNED.zoneIF[2]) / 2);
  assert.equal(zoneIntensity('—'), null);
  assert.equal(zoneIntensity(''), null);
  assert.equal(zoneIntensity(undefined), null);
  assert.equal(zoneIntensity('Z9'), null);
});

test('a planned session is scored with the same formulas as a real one', () => {
  const IF2 = PLANNED.zoneIF[2];
  assert.equal(plannedLoad(bike('1:00', 'Z2')), Math.round(IF2 * IF2 * 1000) / 10);        // hours × IF² × 100
  assert.equal(plannedLoad({ disc: 'Run', dur: '0:30', zone: 'Z4' }), Math.round(0.5 * PLANNED.zoneIF[4] ** 2 * 1000) / 10);
  assert.equal(plannedLoad({ disc: 'Swim', dur: '1:00', zone: 'Z3' }), Math.round(PLANNED.zoneIF[3] ** 3 * 1000) / 10); // swim is cubic
  assert.equal(plannedLoad({ disc: 'Strength', dur: '1:00', zone: '—' }), Math.round((60 * PLANNED.strengthRpe) / 420 * 1000) / 10);
});

test('rest, yoga and a session with nothing to score it by add no load, and the last is counted', () => {
  assert.equal(plannedLoad({ disc: 'Rest', dur: '—', zone: '—' }), 0);
  assert.equal(plannedLoad({ disc: 'Yoga', dur: '0:30', zone: '—' }), 0);
  assert.equal(plannedLoad({ disc: 'Bike', dur: '1:00', zone: '—' }), null);   // endurance with no zone: unknown, not zero
  assert.equal(plannedLoad({ disc: 'Run', dur: '—', zone: 'Z2' }), 0);
});

test('form is where fitness sits against fatigue: low, neutral or high', () => {
  assert.deepEqual(formZone(0), { index: 1, name: 'Neutral' });
  assert.deepEqual(formZone(PLANNED.form.high), { index: 1, name: 'Neutral' });   // the edge belongs to the middle
  assert.deepEqual(formZone(PLANNED.form.high + 0.1), { index: 2, name: 'High' });
  assert.deepEqual(formZone(PLANNED.form.low - 0.1), { index: 0, name: 'Low' });
});

/* ---- a six-week plan with one hour of bike a day ---- */

const START = '2026-09-07';                 // a Monday
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const plan = (extra = {}) => ({
  start: START,
  profile: { raceDate: '2026-10-17', raceType: '70.3' },
  season: Array.from({ length: 6 }, () => ({ block: 'Base', hours: 7 })),
  weeks: Object.fromEntries(Array.from({ length: 6 }, (_, w) => [`w${w}`, DAYS.map((d) => bike('1:00', 'Z2', d))])),
  ...extra,
});
const T = { ftpW: 250 };
// The coach's number and the card's start from the same level: the window's first days.
const WARM = { warmStartDays: PLAN_MODEL.garmin.warmStartDays };
const dayISO = (n) => new Date(Date.UTC(2026, 8, 7 + n)).toISOString().slice(0, 10);
// An hour at 70% of FTP scores exactly what the planned Z2 hour does.
const ride = (n, share = 1) => ({
  id: `garmin:${n}`, date: dayISO(n), disc: 'Bike', durationS: 3600 * share, movingS: 3600 * share,
  normPowerW: 250 * PLANNED.zoneIF[2],
});
const rides = (days, share) => Array.from({ length: days }, (_, n) => ride(n, share));
const TODAY = dayISO(23);                   // Wednesday of week 4
const history = (share = 1) => ({ activities: rides(24, share), sync: { source: 'garmin', from: START, through: TODAY } });

test('with nothing synced there is no today and no projection, only the plan, and it says what is missing', () => {
  const r = fitnessSeries(plan(), { today: TODAY, thresholds: T });
  assert.equal(r.hasHistory, false);
  assert.equal(r.today, null);
  assert.equal(r.race, null);
  assert.equal(r.trend, null);
  assert.equal(r.weeks.length, 6);
  assert.ok(r.weeks.every((w) => w.actual === null), 'no actual line without history');
  assert.ok(r.weeks[5].planned > r.weeks[0].planned, 'the planned line still rises from zero');
});

test('activities that cannot be scored are not history, and what they lack is named', () => {
  const unscorable = [{ id: 'garmin:1', date: START, disc: 'Bike', durationS: 3600, movingS: 3600 }];   // no power, no FTP
  const r = fitnessSeries(plan({ activities: unscorable }), { today: TODAY, thresholds: {} });
  assert.equal(r.hasHistory, false);
  assert.equal(r.unscored, 1);
  assert.ok(r.missing.includes('power') || r.missing.includes('ftp'));
});

test("today's fitness and fatigue are load.js's chronic and acute, unchanged", () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  const base = trainingLoad(activities, { today: TODAY, thresholds: T, sync, ...WARM });
  assert.equal(r.hasHistory, true);
  assert.equal(r.today.fit, base.chronic);
  assert.equal(r.today.fat, base.acute);
  assert.equal(r.today.form, Math.round((base.chronic - base.acute) * 10) / 10);
  // A steady 49 a day from the first synced day is a steady 49: the two averages start from the level
  // of the window's first week (warm start), not from nothing, so neither is ahead of the other.
  assert.ok(Math.abs(r.today.fit - 49) < 0.2 && Math.abs(r.today.fat - 49) < 0.2, `fit ${r.today.fit}, fat ${r.today.fat}`);
});

test('the change over seven days is today against the same figure a week ago', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  const weekAgo = trainingLoad(activities, { today: dayISO(16), thresholds: T, sync, ...WARM });
  assert.equal(r.today.dFit, Math.round((r.today.fit - weekAgo.chronic) * 10) / 10);
  assert.equal(r.today.dFat, Math.round((r.today.fat - weekAgo.acute) * 10) / 10);
});

test('followed exactly, the planned and actual lines agree up to today', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  for (const w of r.weeks.filter((x) => x.actual !== null && x.date <= TODAY)) {
    assert.ok(Math.abs(w.planned - w.actual) < 0.2, `week ${w.week + 1}: planned ${w.planned}, actual ${w.actual}`);
  }
  // The current week has an actual up to today and none after it.
  assert.ok(r.weeks[3].actual !== null);
  assert.equal(r.weeks[4].actual, null);
});

test('race day, followed exactly, is where the plan takes the averages from where they are now', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  assert.equal(r.race.date, '2026-10-17');
  assert.equal(r.race.week, 5);
  assert.ok(Math.abs(r.race.fit - r.today.fit) < 1, 'six more weeks of the same hour a day hold the average where it is');
  assert.equal(r.race.form, Math.round((r.race.fit - r.race.fat) * 10) / 10);
  assert.equal(r.race.dFit, Math.round((r.race.fit - r.today.fit) * 10) / 10);
  assert.equal(r.adherence, 1);
  assert.ok(Math.abs(r.trend - r.race.fit) < 0.2, 'doing it all is the trend');
});

test('doing half of what was planned lowers the trend, not the plan', () => {
  const { activities, sync } = history(0.5);
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  assert.ok(Math.abs(r.adherence - 0.5) < 0.01);
  assert.ok(r.trend < r.race.fit, 'the trend follows what was done');
  const full = fitnessSeries(plan({ activities: history().activities, activitySync: history().sync }), { today: TODAY, thresholds: T });
  assert.equal(r.race.fit < full.race.fit, true, 'and race day from a lower start is lower too');
});

test('adherence is capped, and absent when the plan asked for nothing', () => {
  const over = fitnessSeries(plan({ activities: rides(24, 3), activitySync: history().sync }), { today: TODAY, thresholds: T });
  assert.equal(over.adherence, PLANNED.maxAdherence);
  const empty = plan({ weeks: Object.fromEntries(Array.from({ length: 6 }, (_, w) => [`w${w}`, []])) });
  const none = fitnessSeries({ ...empty, ...history(), activitySync: history().sync }, { today: TODAY, thresholds: T });
  assert.equal(none.adherence, null);
  assert.equal(none.trend, null);
});

test('the trend waits for a window long enough to read: a few days of plan are not a rate', () => {
  // Day 4 of a plan whose first days were each a half-day over the plan would read 1.5 and
  // draw a line to a race-day figure half as high again as the plan's own. The athlete has
  // synced for weeks before the plan began, so the basis is there; it is the plan that is young.
  const before = Array.from({ length: 28 }, (_, i) => ride(i - 28));
  const at = (n) => fitnessSeries(
    plan({ activities: [...before, ...rides(n + 1, 3)], activitySync: { source: 'garmin', from: dayISO(-28), through: dayISO(n) } }),
    { today: dayISO(n), thresholds: T },
  );
  const days = PLANNED.adherenceMinDays;
  for (const n of [0, 3, days - 2]) {
    const r = at(n);
    assert.equal(r.basis.enough, true, `${n + 1} days in`);
    assert.equal(r.adherence, null, `${n + 1} days in`);
    assert.equal(r.trend, null);
    assert.ok(r.weeks.every((w) => w.trend === null), 'and no line is drawn');
    assert.ok(r.race && Number.isFinite(r.race.fit), 'the plan from today is still there');
  }
  const ok = at(days - 1);
  assert.equal(ok.adherence, PLANNED.maxAdherence, `${days} days in is a window`);
  assert.ok(ok.trend !== null);
});

test('a plan with no race date projects to the end of the season', () => {
  const p = plan({ ...history(), activitySync: history().sync });
  p.profile = { raceType: '70.3' };
  const r = fitnessSeries(p, { today: TODAY, thresholds: T });
  assert.equal(r.race.date, '2026-10-18');   // the Sunday of the last week
});

test('after the race there is nothing to project', () => {
  const r = fitnessSeries(plan({ ...history(), activitySync: history().sync }), { today: '2026-10-25', thresholds: T });
  assert.equal(r.race, null);
  assert.equal(r.trend, null);
});

test('it is derived and returned, never written into the plan it was given', () => {
  const p = plan({ ...history(), activitySync: history().sync });
  const before = JSON.stringify(p);
  fitnessSeries(p, { today: TODAY, thresholds: T });
  assert.equal(JSON.stringify(p), before);
});

test('garbage in is an empty answer, not a throw', () => {
  for (const bad of [null, undefined, {}, { start: 'x' }, { start: START, season: 'no', weeks: null }]) {
    const r = fitnessSeries(bad, { today: TODAY, thresholds: T });
    assert.equal(r.hasHistory, false);
    assert.deepEqual(r.weeks, []);
  }
  assert.equal(fitnessSeries(plan(), { today: 'not a date', thresholds: T }).today, null);
});

test('each week carries the fatigue as well as the fitness it ended on', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  const base = trainingLoad(activities, { today: dayISO(6), thresholds: T, sync, ...WARM });
  assert.equal(r.weeks[0].actualFat, base.acute);
  assert.equal(r.weeks[0].actual, base.chronic);
  assert.equal(r.weeks[5].actualFat, null);
});

test('minutes by discipline over the last days, newest included, older left out', () => {
  const acts = [
    { id: 'a', date: '2026-09-30', disc: 'Run', durationS: 3000 },
    { id: 'b', date: '2026-09-03', disc: 'Bike', durationS: 7200 },     // day 28 back: inside
    { id: 'c', date: '2026-09-02', disc: 'Bike', durationS: 7200 },     // day 29 back: outside
    { id: 'd', date: '2026-09-20', disc: 'Run', movingS: 600, durationS: 9999 },
    { id: 'e', date: '2026-10-01', disc: 'Swim', durationS: 3600 },     // after today
    { id: 'f', date: '2026-09-25', disc: 'Other', durationS: 600 },
  ];
  assert.deepEqual(minutesByDiscipline(acts, { today: '2026-09-30', days: 28 }), { Run: 60, Bike: 120, Other: 10 });
  assert.deepEqual(minutesByDiscipline(null, { today: '2026-09-30' }), {});
  assert.deepEqual(minutesByDiscipline(acts, { today: 'nope' }), {});
});

test('the plan followed from today is a line to race day that ends where the race-day figure does', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  assert.ok(r.weeks.slice(0, 4).every((w) => w.followed === null), 'nothing before the week today falls in');
  assert.ok(r.weeks[4].followed !== null, 'the weeks still to come carry it');
  assert.equal(r.weeks[5].followed, r.race.fit, 'the race week reads the race-day figure, even for a Saturday race');
  assert.ok(Math.abs(r.weeks[4].followed - r.today.fit) < 1, 'and it carries on from where fitness stands now');
});

test('there is no followed line without a projection', () => {
  const none = fitnessSeries(plan(), { today: TODAY, thresholds: T });
  assert.ok(none.weeks.every((w) => w.followed === null));
  const after = fitnessSeries(plan({ ...history(), activitySync: history().sync }), { today: '2026-10-25', thresholds: T });
  assert.ok(after.weeks.every((w) => w.followed === null));
});

test('a followed line does not depend on how much was done, only on where it starts', () => {
  const a = fitnessSeries(plan({ ...history(), activitySync: history().sync }), { today: TODAY, thresholds: T });
  const b = fitnessSeries(plan({ ...history(0.5), activitySync: history().sync }), { today: TODAY, thresholds: T });
  assert.ok(b.weeks[4].followed < a.weeks[4].followed, 'a lower start gives a lower line');
  assert.ok(b.weeks[4].followed !== b.weeks[4].trend, 'and it is not the trend');
});

test('race-day form sits below, within or above a range often used on the day', () => {
  assert.equal(raceFormPosition(PLANNED.raceForm.low - 0.1), 'below');
  assert.equal(raceFormPosition(PLANNED.raceForm.low), 'within');
  assert.equal(raceFormPosition(PLANNED.raceForm.high), 'within');
  assert.equal(raceFormPosition(PLANNED.raceForm.high + 0.1), 'above');
  assert.deepEqual(PLANNED.raceForm, { low: 5, high: 25 });
});

test('the illustrative fitness bands live in the engine, one per race distance', () => {
  assert.deepEqual(FITNESS_BANDS.map((b) => b.key), ['olympic', '70.3', 'ironman']);
  assert.ok(FITNESS_BANDS.every((b) => b.lo < b.hi && b.name));
});

/* ---- a plan that has not started yet ---- */

test('a plan that starts after today is seeded from where the athlete is today, not from zero', () => {
  // History to Wednesday of week 4; the plan itself starts the Monday after.
  const { activities, sync } = history();
  const later = plan({
    start: dayISO(28),
    activities,
    activitySync: sync,
    profile: { raceDate: dayISO(28 + 6 * 7 - 1), raceType: '70.3' },
  });
  const r = fitnessSeries(later, { today: TODAY, thresholds: T });
  const base = trainingLoad(activities, { today: TODAY, thresholds: T, sync, ...WARM });
  // An hour of zone 2 a day is what the history was, so the line should carry on from about there.
  assert.ok(r.weeks[0].planned > base.chronic - 1, `week 1 planned ${r.weeks[0].planned}, athlete today ${base.chronic}`);
  assert.ok(r.weeks[0].planned < base.chronic + 12, 'and rise, not jump');
});

test('a plan that starts after today with no history still starts its line at zero', () => {
  const later = plan({ start: dayISO(28), profile: { raceDate: dayISO(28 + 6 * 7 - 1), raceType: '70.3' } });
  const r = fitnessSeries(later, { today: TODAY, thresholds: T });
  assert.ok(r.weeks[0].planned < 10);
});

test('carry steps the two averages one day at a time, adding the load of each day', () => {
  const kc = 1 - Math.exp(-1 / 42);
  const ka = 1 - Math.exp(-1 / 7);
  const seen = [];
  const end = carry({ fit: 10, fat: 20 }, '2026-09-30', '2026-10-02', () => 100, (iso, s) => seen.push([iso, s.fit]));
  assert.deepEqual(seen.map(([d]) => d), ['2026-10-01', '2026-10-02'], 'from is exclusive, to is inclusive');
  const fit1 = 10 + kc * (100 - 10);
  assert.ok(Math.abs(end.fit - (fit1 + kc * (100 - fit1))) < 1e-9);
  const fat1 = 20 + ka * (100 - 20);
  assert.ok(Math.abs(end.fat - (fat1 + ka * (100 - fat1))) < 1e-9);
});

/* ---- a tune-up race's own load ---- */

// The six-week plan above is a week of one-hour rides; a 10 km tune-up lands on its Wednesday of week 3.
const withRace = (ev) => plan({ events: [{ id: 'ev-t', name: 'Tune', kind: 'race', priority: 'secondary', ...ev }] });
const TUNE = { date: dayISO(16), raceType: '10k' };                          // Wednesday, week 3

test('a tune-up race adds its own load to the planned line from its day on', () => {
  const without = fitnessSeries(plan(), { today: TODAY, thresholds: T });
  const withIt = fitnessSeries(withRace(TUNE), { today: TODAY, thresholds: T });
  assert.equal(withIt.weeks[0].planned, without.weeks[0].planned, 'before the race nothing moves');
  assert.equal(withIt.weeks[1].planned, without.weeks[1].planned);
  assert.ok(withIt.weeks[2].planned > without.weeks[2].planned, 'the week it is in');
  assert.ok(withIt.weeks[5].planned > without.weeks[5].planned, 'and the weeks after');
});

test('the load is the race\'s nominal time at its nominal intensity', () => {
  // 55 min at 0.95 is about 83 load. One day's load moves a 42-day average by 1/42 of the gap to it.
  const without = fitnessSeries(plan(), { today: TODAY, thresholds: T });
  const withIt = fitnessSeries(withRace(TUNE), { today: TODAY, thresholds: T });
  const step = withIt.weeks[2].planned - without.weeks[2].planned;
  assert.ok(step > 0.5 && step < 3, `a single hard day lifts the end of its week by about a point or two, got ${step}`);
});

test('a longer race, or the athlete\'s own slower time, adds more', () => {
  const at = (ev) => fitnessSeries(withRace({ ...TUNE, ...ev }), { today: TODAY, thresholds: T }).weeks[5].planned;
  assert.ok(at({ raceType: '70.3' }) > at({ raceType: '10k' }));
  assert.ok(at({ expectedMinutes: 90 }) > at({}), 'a 10 km that takes 90 minutes costs more than one that takes 55');
});

test('the race the season is built for adds nothing: the plan arrives at it', () => {
  const primary = plan({ events: [{ id: 'ev-p', name: 'Race', date: '2026-10-17', kind: 'race', raceType: '70.3', priority: 'primary' }] });
  const a = fitnessSeries(primary, { today: TODAY, thresholds: T });
  const b = fitnessSeries(plan(), { today: TODAY, thresholds: T });
  assert.deepEqual(a.weeks.map((w) => w.planned), b.weeks.map((w) => w.planned));
});

test('a marker, a race outside the plan and a race of unknown length add nothing', () => {
  const base = fitnessSeries(plan(), { today: TODAY, thresholds: T }).weeks.map((w) => w.planned);
  const planned = (events) => fitnessSeries(plan({ events }), { today: TODAY, thresholds: T }).weeks.map((w) => w.planned);
  assert.deepEqual(planned([{ id: 'm', date: TUNE.date, kind: 'race', raceType: '10k', priority: null }]), base, 'a marker');
  assert.deepEqual(planned([{ id: 'o', date: '2027-06-06', kind: 'race', raceType: '10k', priority: 'secondary' }]), base, 'after the plan');
  assert.deepEqual(planned([{ id: 'b', date: '2026-08-01', kind: 'race', raceType: '10k', priority: 'secondary' }]), base, 'before it');
  assert.deepEqual(planned([{ id: 'u', date: TUNE.date, kind: 'race', raceType: null, priority: 'secondary' }]), base, 'no distance, no load');
});

test('the projection to race day counts a tune-up that is still ahead', () => {
  const { activities, sync } = history();
  const base = plan({ activities, activitySync: sync });
  const without = fitnessSeries(base, { today: TODAY, thresholds: T });
  const withIt = fitnessSeries({ ...base, events: [{ id: 'ev-t', date: dayISO(30), kind: 'race', raceType: '70.3', priority: 'secondary' }] }, { today: TODAY, thresholds: T });
  assert.ok(withIt.race.fit > without.race.fit);
});

/* ---- where the plan alone takes the athlete ---- */

test('with nothing synced, the planned line starts from the fitness the plan was built from', () => {
  const seeded = plan({ target: { start: { ctl: 60 } } });
  const r = fitnessSeries(seeded, { today: TODAY, thresholds: T });
  const zero = fitnessSeries(plan(), { today: TODAY, thresholds: T });
  assert.ok(r.weeks[0].planned > zero.weeks[0].planned + 40, `week 1 is ${r.weeks[0].planned}, from 60, not ${zero.weeks[0].planned}, from nothing`);
  assert.ok(r.weeks[0].planned < 60 + 5, 'and it moves toward what the week asks, not away');
});

test('a figure that is not a number is not a seed', () => {
  const zero = fitnessSeries(plan(), { today: TODAY, thresholds: T }).weeks.map((w) => w.planned);
  for (const ctl of [null, undefined, 'lots', -5, NaN]) {
    assert.deepEqual(fitnessSeries(plan({ target: { start: { ctl } } }), { today: TODAY, thresholds: T }).weeks.map((w) => w.planned), zero, String(ctl));
  }
});

test('synced history from before the plan began still wins over the stored start', () => {
  // Two weeks of rides before the plan, then the plan's own weeks.
  const earlier = Array.from({ length: 38 }, (_, n) => ride(n - 14));
  const sync = { source: 'garmin', from: dayISO(-14), through: TODAY };
  const a = fitnessSeries(plan({ activities: earlier, activitySync: sync }), { today: TODAY, thresholds: T });
  const b = fitnessSeries(plan({ activities: earlier, activitySync: sync, target: { start: { ctl: 120 } } }), { today: TODAY, thresholds: T });
  assert.deepEqual(b.weeks.map((w) => w.planned), a.weeks.map((w) => w.planned));
});

test('history that begins with the plan leaves the stored start as the plan\'s own, and without one the window opens at its own level', () => {
  // The synced line cannot say where the athlete stood before its first day; the plan can. Without a
  // stored start the line begins at the level the window opened at, as the actual one does.
  const { activities, sync } = history();
  const at = (target) => fitnessSeries(plan({ activities, activitySync: sync, ...(target ? { target } : {}) }), { today: TODAY, thresholds: T }).weeks[0].planned;
  const none = at(null);
  const low = at({ start: { ctl: 30 } });
  const zero = at({ start: { ctl: 0 } });
  assert.ok(zero < low && low < none, `0 → ${zero}, 30 → ${low}, none → ${none}`);
  assert.ok(Math.abs(none - 49) < 0.2, 'the level the window opened at');
});

test('the plan alone says where fitness is on race day, with no history at all', () => {
  const r = fitnessSeries(plan({ target: { start: { ctl: 40 } } }), { today: TODAY, thresholds: T });
  assert.equal(r.race, null, 'the projection from today still needs history');
  assert.equal(r.plannedRace.date, '2026-10-17');
  assert.equal(r.plannedRace.week, 5);
  assert.ok(r.plannedRace.fit > 40, 'six weeks of an hour a day from 40');
  const sunday = r.weeks[5].planned;
  assert.ok(Math.abs(r.plannedRace.fit - sunday) < 1, 'the Saturday and the Sunday of that week are a day apart');
});

test('planned race-day fitness is the race morning, not the end of its week', () => {
  const p = plan({ target: { start: { ctl: 40 } }, profile: { raceDate: '2026-10-14', raceType: '70.3' } });  // a Wednesday of week 6
  const r = fitnessSeries(p, { today: TODAY, thresholds: T });
  const sunday = Math.round(carry({ fit: 40, fat: 40 }, '2026-09-06', '2026-10-18', () => 49).fit * 10) / 10;
  assert.notEqual(r.plannedRace.fit, sunday, 'four more days of an hour a day change it');
  assert.equal(r.plannedRace.fit, Math.round(carry({ fit: 40, fat: 40 }, '2026-09-06', '2026-10-13', () => 49).fit * 10) / 10, 'the Tuesday evening');
  assert.equal(r.weeks[5].planned, r.plannedRace.fit, 'the race week is drawn at the morning of the race');
  assert.equal(r.plannedRace.date, '2026-10-14');
});

test('with no race date, race day is the last day of the season', () => {
  const r = fitnessSeries(plan({ profile: { raceDate: null, raceType: '70.3' } }), { today: TODAY, thresholds: T });
  assert.equal(r.plannedRace.date, '2026-10-18');
  assert.equal(r.plannedRace.fit, r.weeks[5].planned);
});

test('a race date outside the plan has no planned race day', () => {
  const r = fitnessSeries(plan({ profile: { raceDate: '2027-06-01', raceType: '70.3' } }), { today: TODAY, thresholds: T });
  assert.equal(r.plannedRace, null);
});

/* ---- race morning ----
   "On race day" is the state the athlete wakes up to: the end of the day before.
   The race the season is built for adds no load of its own (the line stops at the
   day it arrives), so reading the end of race day itself would count a rest day
   that is not one: fitness two points low, fatigue eight, form six too high. */

// Five weeks of an hour a day, then a race-week Monday to Friday and nothing on the Saturday race day.
const raceWeekOffPlan = (extra = {}) => plan({
  weeks: Object.fromEntries(Array.from({ length: 6 }, (_, w) => [
    `w${w}`, (w === 5 ? DAYS.slice(0, 5) : DAYS).map((d) => bike('1:00', 'Z2', d)),
  ])),
  ...extra,
});

test('planned race-day fitness and fatigue are read the morning of the race, not after its zero-load day', () => {
  const r = fitnessSeries(raceWeekOffPlan({ target: { start: { ctl: 40 } } }), { today: TODAY, thresholds: T });
  const eve = carry({ fit: 40, fat: 40 }, '2026-09-06', '2026-10-16', () => 49);       // an hour at Z2 a day, up to the Friday
  assert.equal(r.plannedRace.date, '2026-10-17', 'it is still the race date');
  assert.equal(r.plannedRace.fit, Math.round(eve.fit * 10) / 10);
  assert.equal(r.plannedRace.fat, Math.round(eve.fat * 10) / 10);
  assert.equal(r.weeks[5].planned, r.plannedRace.fit, 'the race week is drawn where the race morning is, not on the Sunday after it');
  assert.equal(r.weeks[5].plannedFat, r.plannedRace.fat);
});

test('the plan followed from today ends on race morning too', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(raceWeekOffPlan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  const eve = carry({ fit: r.today.fit, fat: r.today.fat }, TODAY, '2026-10-16', () => 49);
  assert.ok(Math.abs(r.race.fit - eve.fit) < 0.2, `fit ${r.race.fit} against ${eve.fit}`);
  assert.ok(Math.abs(r.race.fat - eve.fat) < 0.2, `fat ${r.race.fat} against ${eve.fat}`);
  assert.equal(r.race.date, '2026-10-17');
  assert.equal(r.weeks[5].followed, r.race.fit);
  assert.equal(r.weeks[5].followedFat, r.race.fat);
});

test('a plan with no race date still ends on the last day of the season', () => {
  const r = fitnessSeries(raceWeekOffPlan({ profile: { raceDate: null, raceType: '70.3' }, target: { start: { ctl: 40 } } }), { today: TODAY, thresholds: T });
  assert.equal(r.plannedRace.date, '2026-10-18');
  assert.equal(r.plannedRace.fit, r.weeks[5].planned);
  const eve = carry({ fit: 40, fat: 40 }, '2026-09-06', '2026-10-18', (iso) => (iso <= '2026-10-16' ? 49 : 0));
  assert.equal(r.plannedRace.fit, Math.round(eve.fit * 10) / 10, 'nothing is shifted when there is no race to wake up to');
});

/* ---- characterization: what the actual and planned lines read today ----
   A sync window whose first week held nothing has a zero warm start, so any
   change to how the averages begin (a warm start from the window's first days)
   must leave these figures exactly as they were. Recorded from the code as it
   stood before CTL and ATL got a shared basis. */

test('CTL outputs are unchanged when the first synced week was empty', () => {
  const activities = Array.from({ length: 17 }, (_, i) => ride(i + 7));
  const r = fitnessSeries(plan({ activities, activitySync: { source: 'garmin', from: START, through: TODAY } }), { today: TODAY, thresholds: T });
  assert.deepEqual(r.today, { fit: 16.3, fat: 44.7, form: -28.4, dFit: 5.9, dFat: 7.4, dForm: -1.5 });
  // The race-day figures were recorded at the end of the race day (27.2, 30.5, 22.4, 31, 27.2);
  // they are now the morning of it, the Friday evening, so each is one day's load earlier. The
  // race week also has a trend point now: it is read inside the window the trend is carried over.
  assert.deepEqual(r.race, { date: '2026-10-17', week: 5, fit: 26.7, fat: 48.6, form: -21.9, dFit: 10.4, dFat: 3.9, dForm: 6.5 });
  const { fat: _plannedFat, ...plannedRace } = r.plannedRace;           // the ATL beside it is new
  assert.deepEqual(plannedRace, { date: '2026-10-17', week: 5, fit: 30.1 });
  assert.equal(r.trend, 22.1);
  assert.equal(r.adherence, 0.708);
  assert.deepEqual(r.weeks.map((w) => [w.actual, w.actualFat, w.planned, w.followed, w.trend]), [
    [0, 0, 7.5, null, null],
    [7.5, 31, 13.9, null, null],
    [13.9, 42.4, 19.3, null, null],
    [16.3, 44.7, 23.8, null, null],
    [null, null, 27.7, 23.8, 20.5],
    [null, null, 30.1, 26.7, 22.1],
  ]);
});


/* ---- CTL and ATL read from one basis, and the plan has an ATL of its own ---- */

const noPower = (n) => Array.from({ length: n }, (_, i) => ({ ...ride(i), normPowerW: undefined }));
const synced = (from, through = TODAY) => ({ source: 'garmin', from, through });

test('every answer carries the basis it was read on, and an empty one says there is no sync', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  assert.deepEqual(r.basis, {
    enough: true, reason: null, coveredWeeks: 3, neededWeeks: HISTORY_THRESHOLDS.minCovered,
    scoredShare: 1, neededShare: PLAN_MODEL.garmin.scoredShare,
  });
  for (const bad of [null, {}, { start: 'x' }]) {
    const e = fitnessSeries(bad, { today: TODAY, thresholds: T });
    assert.equal(e.basis.enough, false);
    assert.equal(e.basis.reason, 'no-sync');
    assert.equal(e.basis.neededWeeks, HISTORY_THRESHOLDS.minCovered);
  }
});

test('without a basis there is no actual, no today, no race day and no trend, for CTL or for ATL', () => {
  const cases = {
    'no-sync': plan(),
    'too-short': plan({ activities: rides(24), activitySync: synced(dayISO(14)) }),
    unscorable: plan({ activities: noPower(24), activitySync: synced(START) }),
  };
  for (const [reason, p] of Object.entries(cases)) {
    const r = fitnessSeries(p, { today: TODAY, thresholds: T });
    assert.equal(r.basis.enough, false, reason);
    assert.equal(r.basis.reason, reason);
    assert.equal(r.today, null, reason);
    assert.equal(r.race, null, reason);
    assert.equal(r.trend, null, reason);
    assert.equal(r.trendFat, null, reason);
    for (const w of r.weeks) {
      for (const k of ['actual', 'actualFat', 'followed', 'followedFat', 'trend', 'trendFat']) assert.equal(w[k], null, `${reason} week ${w.week + 1} ${k}`);
      assert.ok(Number.isFinite(w.planned) && Number.isFinite(w.plannedFat), 'the plan alone still has both lines');
    }
  }
});

test('too short says how many weeks it has; unscorable says how much it can read', () => {
  const short = fitnessSeries(plan({ activities: rides(24), activitySync: synced(dayISO(7)) }), { today: TODAY, thresholds: T }).basis;
  assert.equal(short.coveredWeeks, HISTORY_THRESHOLDS.minCovered - 1);
  const none = fitnessSeries(plan({ activities: noPower(24), activitySync: synced(START) }), { today: TODAY, thresholds: T }).basis;
  assert.equal(none.scoredShare, 0);
  assert.equal(none.neededShare, PLAN_MODEL.garmin.scoredShare);
});

test('the figures appear at exactly the minimum number of covered weeks and not one week short of it', () => {
  const at = (from) => fitnessSeries(plan({ activities: rides(24), activitySync: synced(from) }), { today: TODAY, thresholds: T });
  const short = at(dayISO(7));                                   // two whole weeks covered
  assert.equal(short.basis.coveredWeeks, HISTORY_THRESHOLDS.minCovered - 1);
  assert.equal(short.today, null);
  assert.equal(short.weeks[0].actualFat, null);
  const enough = at(START);                                      // three
  assert.equal(enough.basis.coveredWeeks, HISTORY_THRESHOLDS.minCovered);
  assert.ok(enough.today && Number.isFinite(enough.today.fat));
  assert.ok(Number.isFinite(enough.weeks[0].actualFat));
});

test('heart rate cannot make a session count toward the basis; it may still colour a session that has one', () => {
  const hr = { lthr: 170, maxHr: 190, restHr: 50, trimp: 'male' };
  const hrById = new Map(Array.from({ length: 24 }, (_, i) => [`garmin:${i}`, { avg: 150 }]));
  const r = fitnessSeries(plan({ activities: noPower(24), activitySync: synced(START) }), { today: TODAY, thresholds: { ...T, ...hr }, hrById });
  assert.equal(r.basis.reason, 'unscorable');
  assert.equal(r.today, null, 'sessions only heart rate could score are not a basis');
});

test('carry hands each day\'s fatigue to the caller as well as its fitness', () => {
  const seen = [];
  const end = carry({ fit: 10, fat: 20 }, '2026-09-30', '2026-10-02', () => 100, (iso, s) => seen.push([iso, s.fit, s.fat]));
  // Two days of 100 from fit 10 and fat 20, worked by hand:
  //   fit  10 → 10 + (1 − e^(−1/42))·90 = 12.1175 → 14.1853
  //   fat  20 → 20 + (1 − e^(−1/7))·80  = 30.6498 → 39.8818
  assert.deepEqual(seen.map(([iso]) => iso), ['2026-10-01', '2026-10-02']);
  assert.ok(Math.abs(seen[0][1] - 12.1175) < 1e-4 && Math.abs(seen[0][2] - 30.6498) < 1e-4);
  assert.ok(Math.abs(seen[1][1] - 14.1853) < 1e-4 && Math.abs(seen[1][2] - 39.8818) < 1e-4);
  assert.deepEqual({ fit: end.fit, fat: end.fat }, { fit: seen[1][1], fat: seen[1][2] });
});

test('with nothing synced, planned ATL starts where planned CTL does: the athlete is taken to have been training steadily', () => {
  // A planned Z2 hour is 49 a day. Seven days of it from a steady 40 end the week at 49 + (40 − 49)·e^(−1).
  const seeded = fitnessSeries(plan({ target: { start: { ctl: 40 } } }), { today: TODAY, thresholds: T });
  assert.ok(Math.abs(seeded.weeks[0].plannedFat - 45.7) < 0.05, `week 1 planned ATL is ${seeded.weeks[0].plannedFat}`);
  // With no start at all both begin at nothing: 49·(1 − e^(−1)).
  const zero = fitnessSeries(plan(), { today: TODAY, thresholds: T });
  assert.ok(Math.abs(zero.weeks[0].plannedFat - 31.0) < 0.05);
});

test('planned ATL is seeded from the actual acute load the day before the plan starts', () => {
  // One hard week and then nothing, so the acute average has fallen a long way and the chronic one has not.
  const acts = rides(7);
  const sync = synced(START);
  const later = plan({ start: dayISO(28), activities: acts, activitySync: sync, profile: { raceDate: dayISO(28 + 6 * 7 - 1), raceType: '70.3' } });
  const r = fitnessSeries(later, { today: TODAY, thresholds: T });
  const base = trainingLoad(acts, { today: TODAY, thresholds: T, sync, ...WARM });
  assert.ok(base.acute < base.chronic - 20, `the fixture has the two apart: acute ${base.acute}, chronic ${base.chronic}`);
  const fromActual = 49 + (base.acute - 49) * Math.exp(-1);
  const fromChronic = 49 + (base.chronic - 49) * Math.exp(-1);
  assert.ok(Math.abs(r.weeks[0].plannedFat - fromActual) < 0.2, `planned ATL ${r.weeks[0].plannedFat}, from the actual acute ${fromActual}`);
  assert.ok(Math.abs(r.weeks[0].plannedFat - fromChronic) > 5, 'and not from the chronic load');
});

test('the plan from today and the trend each carry an ATL, and race day carries the planned one', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  assert.ok(r.weeks.slice(0, 4).every((w) => w.followedFat === null && w.trendFat === null), 'nothing before the week today falls in');
  assert.ok(Number.isFinite(r.weeks[4].followedFat));
  assert.equal(r.weeks[5].followedFat, r.race.fat, 'the race week reads the race-day figure');
  assert.ok(Number.isFinite(r.plannedRace.fat));
  assert.ok(Math.abs(r.plannedRace.fat - r.weeks[5].plannedFat) < 3, 'a day apart at the end of the same week');
  const half = history(0.5);
  const slow = fitnessSeries(plan({ activities: half.activities, activitySync: half.sync }), { today: TODAY, thresholds: T });
  assert.ok(slow.trendFat !== null && slow.trendFat < slow.race.fat, 'doing half of it carries less fatigue to race day');
  assert.ok(slow.weeks[4].trendFat !== null);
});

test('there is no trend ATL where there is no trend', () => {
  const r = fitnessSeries(plan({ ...history(), activitySync: history().sync }), { today: '2026-10-25', thresholds: T });
  assert.equal(r.trendFat, null);
  assert.ok(r.weeks.every((w) => w.followedFat === null && w.trendFat === null));
});

test('days after the last synced day are not read as days off', () => {
  // Three weeks and a day synced, the last day being day 21; today is two days later and nothing has come in since.
  const activities = rides(22);
  const sync = { source: 'garmin', from: START, through: dayISO(21) };
  const stale = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  const atSync = fitnessSeries(plan({ activities, activitySync: sync }), { today: dayISO(21), thresholds: T });
  assert.equal(stale.today.fit, atSync.today.fit, 'fitness stays where the last synced day left it');
  assert.equal(stale.today.fat, atSync.today.fat, 'and so does fatigue, which would fall by a quarter in two days of nothing');
  assert.ok(stale.race.fit > stale.today.fit - 1, 'the plan followed from today starts from that held level, not from a decayed one');
  assert.ok(Number.isFinite(stale.today.dFit) && Number.isFinite(stale.today.dFat), 'a week ago is a day the window has');
  assert.ok(stale.weeks[3].actual !== null && Number.isFinite(stale.weeks[3].actual), 'the current week reads the last synced day');
});

test('actual CTL and ATL start from the level of the window\'s first days, as the planner reads it', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  // A steady 49 a day from the first synced day is 49 from the first day, not a climb out of zero.
  assert.ok(Math.abs(r.weeks[0].actual - 49) < 0.2, `end of week 1 reads ${r.weeks[0].actual}`);
  assert.ok(Math.abs(r.weeks[0].actualFat - 49) < 0.2);
});
