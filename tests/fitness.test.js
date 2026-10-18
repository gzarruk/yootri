import test from 'node:test';
import assert from 'node:assert/strict';

import { PLANNED, FITNESS_BANDS, zoneIntensity, plannedLoad, formZone, raceFormPosition, fitnessSeries, minutesByDiscipline, carry } from '../assets/coach/fitness.js';
import { trainingLoad } from '../assets/coach/load.js';

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
  const base = trainingLoad(activities, { today: TODAY, thresholds: T, sync });
  assert.equal(r.hasHistory, true);
  assert.equal(r.today.fit, base.chronic);
  assert.equal(r.today.fat, base.acute);
  assert.equal(r.today.form, Math.round((base.chronic - base.acute) * 10) / 10);
  assert.ok(r.today.fat > r.today.fit, 'a new block: the fast average is ahead of the slow one');
});

test('the change over seven days is today against the same figure a week ago', () => {
  const { activities, sync } = history();
  const r = fitnessSeries(plan({ activities, activitySync: sync }), { today: TODAY, thresholds: T });
  const weekAgo = trainingLoad(activities, { today: dayISO(16), thresholds: T, sync });
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
  assert.ok(r.race.fit > r.today.fit, 'eleven more weeks of the same hour a day keep adding fitness');
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
  const base = trainingLoad(activities, { today: dayISO(6), thresholds: T, sync });
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
  assert.ok(r.weeks[4].followed > r.today.fit, 'and it rises from where fitness stands now');
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
  const base = trainingLoad(activities, { today: TODAY, thresholds: T, sync });
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
