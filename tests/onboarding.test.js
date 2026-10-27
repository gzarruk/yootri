import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STEPS, emptyAnswers, prefill, stepProblems, racePreview, athleteFromAnswers,
  buildPlanFromAnswers, planReview, isReturning, startFitnessFor, carriedAnswers,
} from '../assets/coach/onboarding.js';
import { newPlan, weekCount, sessionsAt, loadPlan } from '../assets/coach/plan.js';
import { normalizeEvents, goalEvent, secondaryRaces } from '../assets/coach/events.js';
import { durToMin } from '../assets/coach/duration.js';
import { DAYS } from '../assets/coach/profile.js';

const TODAY = '2026-10-14'; // a Wednesday
const MONDAY = '2026-10-12';            // the Monday before today: already under way
const NEXT_MONDAY = '2026-10-19';       // where a new plan starts

/** A wizard filled in the way an athlete would. */
const filled = (over = {}) => ({
  ...emptyAnswers(),
  birthYear: 1984, sex: 'female', weightKg: 61, recentWeeklyHours: 8,
  ftpW: 230, cssSecPer100m: 105,
  runResult: { distanceMeters: 10000, timeSeconds: 2700, date: '2026-09-20' },
  longRideDay: 'Sat', longRunDay: 'Sun', maxSessionsPerDay: 2,
  race: { name: 'Lisbon 70.3', date: '2027-05-16', raceType: '70.3' },
  goal: 'finish',
  ...over,
});

/* ---- the steps ---- */

test('the steps run welcome to review, in the order the athlete meets them', () => {
  assert.deepEqual(STEPS, ['welcome', 'about', 'background', 'thresholds', 'week', 'races', 'ambition', 'goal', 'review']);
});

test('an empty wizard starts from a defensible week and nothing else assumed', () => {
  const a = emptyAnswers();
  assert.equal(Object.values(a.availability).reduce((x, y) => x + y, 0) > 0, true);
  assert.equal(a.race, null);
  assert.deepEqual(a.tuneUps, []);
  assert.equal(a.recentWeeklyHours, undefined, 'recent hours are asked, never assumed');
});

/* ---- prefill: a returning athlete is not asked again ---- */

test('prefill reads About you, the plan profile and the plan’s numbers', () => {
  const plan = newPlan({
    name: 'Old', startISO: '2026-01-05',
    profile: { availability: { Mon: 0, Tue: 60, Wed: 60, Thu: 60, Fri: 0, Sat: 300, Sun: 180 }, longDays: { Bike: 'Sat' } },
    benchmarks: [{ id: 'b', date: '2026-08-01', distanceMeters: 5000, timeSeconds: 1260, source: 'manual', current: true }],
    loadRefs: { ftpW: 250, cssSecPer100m: 100 },
  });
  const a = prefill({ athlete: { weightKg: 70, recentWeeklyHours: 9, equipment: { pool: true } }, plan, today: TODAY });
  assert.equal(a.weightKg, 70);
  assert.equal(a.recentWeeklyHours, 9);
  assert.equal(a.pool, true);
  assert.equal(a.availability.Sat, 300);
  assert.equal(a.longRideDay, 'Sat');
  assert.equal(a.ftpW, 250);
  assert.equal(a.cssSecPer100m, 100);
  assert.deepEqual(a.runResult, { distanceMeters: 5000, timeSeconds: 1260, date: '2026-08-01' });
  assert.equal(a.race, null, 'a new season is a new race: the old one is never carried in');
});

test('recent hours come from synced Garmin weeks when About you has none', () => {
  // Three covered weeks of 6 hours each, the minimum the history rules trust.
  const activities = [];
  for (const monday of ['2026-09-21', '2026-09-28', '2026-10-05']) {
    for (let i = 0; i < 3; i++) {
      activities.push({ id: `garmin:${monday}-${i}`, source: 'garmin', date: monday, disc: 'Bike', durationS: 7200 });
    }
  }
  const plan = { ...newPlan({ name: 'x', startISO: '2026-09-07' }), activities,
    activitySync: { source: 'garmin', from: '2026-09-21', through: '2026-10-13', at: 1 } };
  const a = prefill({ athlete: {}, plan: loadPlan(plan), today: TODAY });
  assert.equal(a.recentWeeklyHours, 6);
  assert.equal(a.prefilledFrom.recentWeeklyHours, 'garmin');
});

test('without enough synced weeks recent hours stay unasked-for, not guessed', () => {
  const a = prefill({ athlete: {}, plan: newPlan({ name: 'x', startISO: '2026-09-07' }), today: TODAY });
  assert.equal(a.recentWeeklyHours, undefined);
});

test('a returning athlete is one with About you or a plan they have used', () => {
  const blank = newPlan({ name: 'My plan', startISO: MONDAY });
  assert.equal(isReturning({ athlete: {}, plans: [blank] }), false);
  assert.equal(isReturning({ athlete: { sex: 'male' }, plans: [blank] }), true);
  assert.equal(isReturning({ athlete: {}, plans: [{ ...blank, name: 'Roth' }] }), true);
});

/* ---- step problems ---- */

test('every step of a well-filled wizard has nothing to say', () => {
  for (const step of STEPS) assert.deepEqual(stepProblems(step, filled(), { today: TODAY }), [], step);
});

test('recent weekly hours are asked for, because the season is built up from where the athlete is', () => {
  const p = stepProblems('background', filled({ recentWeeklyHours: undefined }), { today: TODAY });
  assert.deepEqual(p.map((x) => x.field), ['recentWeeklyHours']);
  assert.match(p[0].message, /hours a week/i);
  assert.deepEqual(stepProblems('background', filled({ recentWeeklyHours: 90 }), { today: TODAY }).map((x) => x.field), ['recentWeeklyHours'], 'and a nonsense figure is refused');
});

test('a typed fitness no longer stands in for the hours, and a stale draft that carries one is not read', () => {
  // The wizard keeps its answers between visits, so a draft saved before the field went away may still have one.
  const stale = { recentWeeklyHours: undefined, startCtlEntered: 70 };
  assert.deepEqual(stepProblems('background', filled(stale), { today: TODAY }).map((x) => x.field), ['recentWeeklyHours']);
  for (const v of [70, -5, 250, 'lots']) {
    assert.deepEqual(stepProblems('review', filled({ startCtlEntered: v }), { today: TODAY }), [], `nothing is validated for ${v}`);
  }
});

test('an impossible body measurement or threshold is named, not stored', () => {
  assert.deepEqual(stepProblems('about', filled({ weightKg: 400 }), { today: TODAY }).map((x) => x.field), ['weightKg']);
  assert.deepEqual(stepProblems('thresholds', filled({ ftpW: 20 }), { today: TODAY }).map((x) => x.field), ['ftpW']);
  const fast = filled({ runResult: { distanceMeters: 10000, timeSeconds: 900, date: '2026-09-20' } });
  assert.deepEqual(stepProblems('thresholds', fast, { today: TODAY }).map((x) => x.field), ['runResult']);
});

test('yootri is not for children', () => {
  // The privacy notice says it is not directed at anyone under 16; the wizard
  // is where that can actually be said before anything is stored.
  assert.deepEqual(stepProblems('about', filled({ birthYear: 2015 }), { today: TODAY }).map((x) => x.field), ['birthYear']);
  assert.deepEqual(stepProblems('about', filled({ birthYear: 2010 }), { today: TODAY }), []);
});

test('the week needs time in it, and the long days need time on them', () => {
  const empty = filled({ availability: Object.fromEntries(DAYS.map((d) => [d, 0])) });
  assert.ok(stepProblems('week', empty, { today: TODAY }).some((x) => x.field === 'availability'));
  const noTime = filled({ availability: { ...emptyAnswers().availability, Mon: 0 }, longRunDay: 'Mon' });
  assert.deepEqual(stepProblems('week', noTime, { today: TODAY }).map((x) => x.field), ['longRunDay']);
});

test('the main race must be a long-course race, after today', () => {
  const p = (race) => stepProblems('races', filled({ race }), { today: TODAY }).map((x) => x.field);
  assert.deepEqual(p(null), ['race']);
  assert.deepEqual(p({ date: '2026-10-01', raceType: '70.3' }), ['race']);
  assert.deepEqual(p({ date: '2027-05-16', raceType: 'marathon' }), ['race']);
  assert.deepEqual(p({ date: '2027-05-16', raceType: 'ironman' }), []);
});

test('a tune-up must sit between today and the main race', () => {
  const p = (tuneUps) => stepProblems('races', filled({ tuneUps }), { today: TODAY }).map((x) => x.field);
  assert.deepEqual(p([{ name: 'Half', date: '2027-03-07', raceType: 'half-marathon' }]), []);
  assert.deepEqual(p([{ name: 'Late', date: '2027-06-01', raceType: '10k' }]), ['tuneUps.0']);
  assert.deepEqual(p([{ name: 'Odd', date: '2027-03-07', raceType: 'ultra' }]), ['tuneUps.0']);
});

test('a time goal needs the time', () => {
  assert.deepEqual(stepProblems('goal', filled({ goal: 'time' }), { today: TODAY }).map((x) => x.field), ['goalTime']);
  assert.deepEqual(stepProblems('goal', filled({ goal: 'time', goalTime: 330 }), { today: TODAY }), []);
});

/* ---- race preview ---- */

test('the preview says how long the season is and where tune-ups land', () => {
  const r = racePreview(filled({ tuneUps: [{ name: 'Half', date: '2027-03-07', raceType: 'half-marathon' }] }), { today: TODAY });
  assert.equal(r.startISO, NEXT_MONDAY);
  assert.equal(r.weeks, 30);
  assert.equal(r.landings.applied.length, 1);
  assert.equal(r.landings.refused.length, 0);
});

test('a tune-up inside the main race taper is reported, not hidden', () => {
  const r = racePreview(filled({ tuneUps: [{ name: 'Close', date: '2027-05-09', raceType: 'marathon' }] }), { today: TODAY });
  assert.equal(r.landings.refused[0].reason, 'in-primary-taper');
});

/* ---- building the plan ---- */

test('the plan starts next Monday and ends on the main race', () => {
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  assert.equal(p.start, NEXT_MONDAY);
  assert.equal(weekCount(p), 30);
  assert.equal(goalEvent(normalizeEvents(p.events)).date, '2027-05-16');
  assert.equal(p.profile.raceType, '70.3');
});

test('the biggest week is the time the athlete said they have', () => {
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  const week = Object.values(emptyAnswers().availability).reduce((a, b) => a + b, 0);
  assert.equal(Math.max(...p.season.map((w) => w.hours)), Math.floor(week / 30) / 2);
  assert.equal('annualHours' in p.profile, false);
});

test('the week, the long days and the cap reach the profile', () => {
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  assert.deepEqual(p.profile.longDays, { Bike: 'Sat', Run: 'Sun' });
  assert.equal(p.profile.maxSessionsPerDay, 2);
  assert.deepEqual(p.profile.availability, emptyAnswers().availability);
});

test('nowhere to swim means no swims; a pool or open water means swims as usual', () => {
  const dry = buildPlanFromAnswers(filled({ pool: false, openWater: false }), { today: TODAY, now: 1 });
  assert.ok(dry.profile.constraints.some((c) => c.disc === 'Swim' && c.rule === 'maxPerWeek' && c.value === 0));
  assert.equal(Object.values(dry.weeks).flat().some((s) => s.disc === 'Swim'), false);
  const lake = buildPlanFromAnswers(filled({ pool: false, openWater: true }), { today: TODAY, now: 1 });
  assert.equal(lake.profile.constraints.some((c) => c.disc === 'Swim' && c.value === 0), false);
});

test('thresholds and the run result go on the plan, body measurements do not', () => {
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  assert.deepEqual(p.loadRefs, { ftpW: 230, cssSecPer100m: 105 });
  assert.equal(p.benchmarks.length, 1);
  assert.equal(p.benchmarks[0].current, true);
  assert.equal(p.benchmarks[0].distanceMeters, 10000);
  const text = JSON.stringify(p);
  for (const k of ['weightKg', 'birthYear', 'heightCm', '"sex"', 'athlete']) assert.equal(text.includes(k), false, k);
});

test('tune-ups are on the calendar with their taper landed', () => {
  const p = buildPlanFromAnswers(
    filled({ tuneUps: [{ name: 'Marathon', date: '2027-03-07', raceType: 'marathon' }] }),
    { today: TODAY, now: 1 },
  );
  const tune = secondaryRaces(normalizeEvents(p.events));
  assert.equal(tune.length, 1);
  assert.ok(p.season.some((w) => w.block === 'Taper'), 'a taper week was spliced in for it');
});

test('a tune-up of two hours or less is on the calendar with no taper', () => {
  const p = buildPlanFromAnswers(
    filled({ tuneUps: [{ name: 'Half', date: '2027-03-07', raceType: 'half-marathon' }] }),
    { today: TODAY, now: 1 },
  );
  assert.equal(secondaryRaces(normalizeEvents(p.events)).length, 1);
  assert.ok(!p.season.some((w) => w.block === 'Taper'), 'a half marathon is a hard day in the build');
});

test('a returning athlete keeps their history, splits and other results', () => {
  const base = {
    ...newPlan({
      name: 'Old', startISO: '2026-01-05',
      profile: { splits: { Base: { Swim: 1, Bike: 2, Run: 1, Strength: 0 } },
        constraints: [{ disc: 'Run', rule: 'avoidDays', value: ['Wed'] }] },
      benchmarks: [{ id: 'old', date: '2026-03-01', distanceMeters: 21097.5, timeSeconds: 6000, source: 'manual', current: true }],
    }),
    activities: [{ id: 'garmin:1', source: 'garmin', date: '2026-09-01', disc: 'Run', durationS: 3600 }],
  };
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1, base });
  assert.deepEqual(p.profile.splits, base.profile.splits);
  assert.ok(p.profile.constraints.some((c) => c.disc === 'Run' && c.rule === 'avoidDays'));
  assert.equal(p.activities.length, 1);
  assert.deepEqual(p.benchmarks.map((b) => [b.id === 'old', b.current]).sort(), [[false, true], [true, false]]);
});

test('the plan is named for the race unless the athlete names it', () => {
  assert.equal(buildPlanFromAnswers(filled(), { today: TODAY, now: 1 }).name, 'Lisbon 70.3');
  assert.equal(buildPlanFromAnswers(filled({ race: { date: '2027-05-16', raceType: 'ironman' } }), { today: TODAY, now: 1 }).name, 'IRONMAN 2027');
  assert.equal(buildPlanFromAnswers(filled({ planName: 'Comeback' }), { today: TODAY, now: 1 }).name, 'Comeback');
});

test('building is deterministic', () => {
  assert.deepEqual(
    buildPlanFromAnswers(filled(), { today: TODAY, now: 1, id: 'p-x' }),
    buildPlanFromAnswers(filled(), { today: TODAY, now: 1, id: 'p-x' }),
  );
});

/* ---- the athlete record and the review ---- */

test('the athlete record collects the About you answers and nothing from the plan', () => {
  const a = athleteFromAnswers(filled({ pool: true, yearsInSport: 3 }), { now: 5 });
  assert.equal(a.weightKg, 61);
  assert.equal(a.recentWeeklyHours, 8);
  assert.deepEqual(a.equipment, { pool: true });
  assert.equal(a.updatedAt, 5);
  for (const k of ['ftpW', 'race', 'availability']) assert.equal(k in a, false, k);
});

test('the review shows week 1 and blocks nothing on a buildable plan', () => {
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  const r = planReview(p);
  assert.equal(r.weeks, 30);
  assert.equal(r.blocked, false);
  assert.deepEqual(r.firstWeek, sessionsAt(p, 0));
  assert.equal(r.firstWeekMinutes, sessionsAt(p, 0).reduce((a, s) => a + durToMin(s.dur), 0));
  assert.equal(r.hoursByWeek.length, 30);
});

test('a season built by the wizard is released one week at a time, from week 1', () => {
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  assert.deepEqual(p.release, { through: 0 });
});

/* ---- Starting over keeps the races the athlete chose ---- */

const carried = [
  { id: 'a', name: 'Lisbon 70.3', date: '2027-05-16', kind: 'race', raceType: '70.3', priority: 'primary', note: '' },
  { id: 'b', name: 'Half', date: '2027-03-07', kind: 'race', raceType: 'half-marathon', priority: 'secondary', note: '' },
  { id: 'c', name: 'Club ride', date: '2027-02-01', kind: 'other', raceType: null, priority: null, note: '' },
];

test('carriedAnswers: A fills the race, B the tune-ups, C is a marker; the past is ignored', () => {
  const c = carriedAnswers([...carried, { ...carried[1], id: 'old', date: '2026-01-01' }], { today: TODAY });
  assert.deepEqual(c.race, { name: 'Lisbon 70.3', date: '2027-05-16', raceType: '70.3' });
  assert.deepEqual(c.tuneUps, [{ name: 'Half', date: '2027-03-07', raceType: 'half-marathon' }]);
  assert.deepEqual(c.markers.map((m) => m.name), ['Club ride']);
});

test('carriedAnswers with no primary leaves the race to be asked', () => {
  assert.equal(carriedAnswers([carried[1]], { today: TODAY }).race, null);
});

test('prefill with carried events fills the races step; without them it still never carries the old race', () => {
  const a = prefill({ athlete: {}, today: TODAY, carry: carried });
  assert.equal(a.race.date, '2027-05-16');
  assert.equal(a.tuneUps.length, 1);
  assert.equal(prefill({ athlete: {}, today: TODAY }).race, null);
});

test('a plan built from carried answers has all three kinds on the calendar', () => {
  const a = prefill({ athlete: {}, today: TODAY, carry: carried });
  const p = buildPlanFromAnswers(filled({ race: a.race, tuneUps: a.tuneUps, markers: a.markers }), { today: TODAY, now: 1 });
  const events = normalizeEvents(p.events);
  assert.equal(goalEvent(events).date, '2027-05-16');
  assert.equal(secondaryRaces(events).length, 1);
  assert.ok(events.some((e) => e.name === 'Club ride' && e.priority === null));
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, 'ids are unique');
});

/* ---- when the plan starts ---- */

test('a new plan starts on a Monday that has not happened yet, whatever day it is made', () => {
  for (let i = 0; i < 21; i++) {
    const today = new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10);
    const p = buildPlanFromAnswers(filled({ race: { date: '2027-05-16', raceType: '70.3' } }), { today, now: 1 });
    assert.equal(new Date(`${p.start}T00:00:00Z`).getUTCDay(), 1, `${p.start} is a Monday`);
    assert.ok(p.start > today, `${today}: the plan starts ${p.start}, not in the past`);
    assert.equal(racePreview(filled(), { today }).startISO, p.start, 'the preview shows the same start');
  }
});

test('made on a Sunday, the plan starts tomorrow; made on a Monday, a week on', () => {
  const sunday = buildPlanFromAnswers(filled(), { today: '2026-10-18', now: 1 });
  assert.equal(sunday.start, '2026-10-19');
  const monday = buildPlanFromAnswers(filled(), { today: '2026-10-19', now: 1 });
  assert.equal(monday.start, '2026-10-26');
});

test('a start date the athlete picks snaps forward to a Monday, never back', () => {
  const at = (startDate) => buildPlanFromAnswers(filled({ startDate }), { today: TODAY, now: 1 }).start;
  assert.equal(at('2026-11-02'), '2026-11-02', 'a Monday stays');
  assert.equal(at('2026-11-04'), '2026-11-09', 'a Wednesday goes to the Monday after');
  assert.equal(at('2026-09-01'), NEXT_MONDAY, 'a date long gone is the next Monday');
  assert.equal(at(MONDAY), NEXT_MONDAY, 'so is the Monday that has already started');
  assert.equal(at('not a date'), NEXT_MONDAY, 'and so is nothing sensible');
});

test('the preview, the plan and the review use the start the athlete picked', () => {
  const a = filled({ startDate: '2026-11-04' });
  const preview = racePreview(a, { today: TODAY });
  const p = buildPlanFromAnswers(a, { today: TODAY, now: 1 });
  assert.equal(preview.startISO, '2026-11-09');
  assert.equal(p.start, preview.startISO);
  assert.equal(weekCount(p), preview.weeks, 'the length the preview promised is the length built');
  assert.equal(planReview(p).weeks, preview.weeks);
});

test('a later start is a shorter runway to the same race', () => {
  const early = racePreview(filled(), { today: TODAY }).weeks;
  const late = racePreview(filled({ startDate: '2026-12-07' }), { today: TODAY }).weeks;
  assert.equal(early - late, 7);
});

test('a race before the plan starts is refused, with the date it would have to be after', () => {
  const p = stepProblems('races', filled({ race: { date: '2026-10-16', raceType: '70.3' } }), { today: TODAY });
  assert.deepEqual(p.map((x) => x.field), ['race']);
  assert.match(p[0].message, /19 Oct|2026-10-19/);
});

test('a race on the start day itself is allowed; so is one in the first week', () => {
  assert.deepEqual(stepProblems('races', filled({ race: { date: NEXT_MONDAY, raceType: '70.3' } }), { today: TODAY }), []);
  assert.deepEqual(stepProblems('races', filled({ race: { date: '2026-10-24', raceType: '70.3' } }), { today: TODAY }), []);
});

test('a tune-up before the plan starts is refused, since no week holds it', () => {
  const p = stepProblems('races', filled({ tuneUps: [{ name: 'Early', date: '2026-10-17', raceType: '10k' }] }), { today: TODAY });
  assert.deepEqual(p.map((x) => x.field), ['tuneUps.0']);
});

test('a start after the race week is refused', () => {
  const p = stepProblems('races', filled({ startDate: '2027-06-07' }), { today: TODAY });
  assert.deepEqual(p.map((x) => x.field), ['startDate']);
  assert.deepEqual(stepProblems('races', filled({ startDate: '2027-05-10' }), { today: TODAY }), [], 'the race week itself is fine');
});

test('when the athlete picked the start, it is the start that is wrong, not the race', () => {
  // The race is on 2026-11-20; a start of 2026-12-07 would come after it.
  const answers = filled({ race: { date: '2026-11-20', raceType: '70.3' }, startDate: '2026-12-07' });
  assert.deepEqual(stepProblems('races', answers, { today: TODAY }).map((x) => x.field), ['startDate']);
});

test('a start date that is not a date is said so', () => {
  const p = stepProblems('races', filled({ startDate: 'next week' }), { today: TODAY });
  assert.deepEqual(p.map((x) => x.field), ['startDate']);
});

/* ---- tune-ups that need no taper ---- */

test('the preview says a short tune-up gets no taper, and does not refuse it for sitting in the main race\'s', () => {
  const r = racePreview(filled({ tuneUps: [{ name: 'Close', date: '2027-05-09', raceType: '10k' }] }), { today: TODAY });
  assert.deepEqual(r.landings.refused, [], 'nothing is overwritten, so nothing is turned down');
  assert.equal(r.landings.applied[0].taper, false);
});

test('the preview still turns a tune-up with a taper away when it sits inside the main race\'s', () => {
  const r = racePreview(filled({ tuneUps: [{ name: 'Close', date: '2027-05-09', raceType: 'marathon' }] }), { today: TODAY });
  assert.equal(r.landings.refused[0].reason, 'in-primary-taper');
});

test('the review reports a refused taper, not a short race', () => {
  const short = buildPlanFromAnswers(filled({ tuneUps: [{ name: 'Close', date: '2027-05-09', raceType: '10k' }] }), { today: TODAY, now: 1 });
  assert.equal(planReview(short).issues.some((i) => i.code === 'race-in-primary-taper'), false);
  const long = buildPlanFromAnswers(filled({ tuneUps: [{ name: 'Close', date: '2027-05-09', raceType: 'marathon' }] }), { today: TODAY, now: 1 });
  assert.equal(planReview(long).issues.some((i) => i.code === 'race-in-primary-taper'), true);
});

/* ---- a season built to a target ---- */

import { fitnessSeries } from '../assets/coach/fitness.js';

const raceRead = (p) => fitnessSeries(p, { today: TODAY }).plannedRace.fit;
const peakRead = (p) => Math.max(...fitnessSeries(p, { today: TODAY }).weeks.map((w) => w.planned));

test('the plan the wizard builds records its target and where the athlete starts', () => {
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  assert.equal(p.target.ctl, 75, 'a 70.3 with no ambition given: the middle of its band');
  assert.equal(p.target.start.source, 'estimate');
  assert.equal(p.target.start.ctl, 62.9, 'eight hours a week, from About you');
  assert.equal(goalEvent(normalizeEvents(p.events)).ambition, 'intermediate');
  assert.equal(p.target.at, 'peak', 'the target is the peak before the taper');
  assert.ok(Math.abs(peakRead(p) - 75) <= 2, `peak fitness reads ${peakRead(p)}`);
  assert.ok(raceRead(p) < peakRead(p) - 5, `and race day is lower: ${raceRead(p)}`);
});

test('the ambition the athlete chose sets the target', () => {
  for (const [ambition, ctl] of [['finish', 60], ['intermediate', 75], ['competitive', 90]]) {
    const p = buildPlanFromAnswers(filled({ ambition }), { today: TODAY, now: 1 });
    assert.equal(p.target.ctl, ctl, ambition);
    assert.equal(goalEvent(normalizeEvents(p.events)).ambition, ambition);
  }
  assert.equal(buildPlanFromAnswers(filled({ ambition: 'fast' }), { today: TODAY, now: 1 }).target.ctl, 75, 'a level that is not one is the default');
});

test('an Olympic season is built to the Olympic band', () => {
  const p = buildPlanFromAnswers(filled({ race: { date: '2027-03-14', raceType: 'olympic' }, ambition: 'competitive' }), { today: TODAY, now: 1 });
  assert.equal(p.target.ctl, 70);
  assert.equal(p.profile.raceType, 'olympic');
});

test('a fitness left in an old draft is not where the season starts from', () => {
  const p = buildPlanFromAnswers(filled({ startCtlEntered: 72 }), { today: TODAY, now: 1 });
  assert.equal(p.target.start.source, 'estimate');
  assert.notEqual(p.target.start.ctl, 72);
  assert.equal(p.target.start.ctl, buildPlanFromAnswers(filled(), { today: TODAY, now: 1 }).target.start.ctl, 'the same as with no figure at all');
});

test('a returning athlete\'s synced history is where they start from, when it can be scored', () => {
  const day = (n) => new Date(Date.UTC(2026, 8, 1) + n * 86400000).toISOString().slice(0, 10);       // from 1 Sep
  const activities = Array.from({ length: 40 }, (_, n) => ({
    id: `garmin:${n}`, source: 'garmin', date: day(n), disc: 'Bike', durationS: 3600, normPowerW: 200,
  }));
  const base = { ...newPlan({ name: 'Old', startISO: '2026-08-31', now: 1 }), activities, activitySync: { source: 'garmin', from: day(0), through: day(39), at: 1 } };
  const p = buildPlanFromAnswers(filled({ ftpW: 250 }), { today: TODAY, now: 1, base });
  assert.equal(p.target.start.source, 'garmin');
  assert.ok(Math.abs(p.target.start.ctl - 64) < 3, `a steady 64 a day: ${p.target.start.ctl}`);
  assert.ok(p.target.start.coveredWeeks >= 3);
  const unscoreable = buildPlanFromAnswers(filled({ ftpW: undefined }), { today: TODAY, now: 1, base });
  assert.equal(unscoreable.target.start.source, 'estimate', 'with no FTP the rides cannot be scored, so the hours are used');
});

test('the inputs the start was worked out from are not on the plan; only the figure is', () => {
  const p = buildPlanFromAnswers(filled({ yearsInSport: 6, levels: { Swim: 'some', Bike: 'strong', Run: 'some' }, heightCm: 170 }), { today: TODAY, now: 1 });
  const text = JSON.stringify(p);
  for (const re of [/recentWeeklyHours/, /yearsInSport/, /weightKg/, /heightCm/, /birthYear/, /"levels"/, /"sex"/]) assert.doesNotMatch(text, re);
  assert.deepEqual(Object.keys(p.target.start).sort(), ['asOf', 'coveredWeeks', 'ctl', 'source']);
});

test('nothing derived from heart rate is on a plan the wizard builds', () => {
  const text = JSON.stringify(buildPlanFromAnswers(filled(), { today: TODAY, now: 1 }));
  for (const re of [/avgHr/i, /maxHr/i, /heart/i, /hrById/i, /trimp/i]) assert.doesNotMatch(text, re);
});

test('tune-ups are landed inside a season built to a target, and it still peaks at it', () => {
  const p = buildPlanFromAnswers(filled({ tuneUps: [
    { name: 'Marathon', date: '2027-01-30', raceType: 'marathon' },
    { name: '10k', date: '2027-03-06', raceType: '10k' },
  ] }), { today: TODAY, now: 1 });
  assert.ok(p.season.some((w) => w.block === 'Taper'), 'the marathon is tapered for');
  assert.ok(Math.abs(peakRead(p) - 75) <= 2, `peak fitness reads ${peakRead(p)}`);
});

test('a plan the wizard builds has no more asked of any week than the athlete has', () => {
  const p = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  const week = Object.values(emptyAnswers().availability).reduce((a, b) => a + b, 0) / 60;
  assert.ok(Math.max(...p.season.map((w) => w.hours)) <= week + 0.01);
});

test('the review carries the target, and what would make it reachable only when asked', () => {
  const ok = buildPlanFromAnswers(filled(), { today: TODAY, now: 1 });
  assert.equal(planReview(ok).target.ctl, 75);
  assert.equal(planReview(ok, { levers: true }).levers, null, 'nothing to offer when it can be reached');
  const tight = buildPlanFromAnswers(filled({
    race: { date: '2027-04-03', raceType: 'ironman' }, ambition: 'competitive',
    availability: { Mon: 0, Tue: 60, Wed: 60, Thu: 60, Fri: 60, Sat: 120, Sun: 90 },
  }), { today: TODAY, now: 1 });
  const r = planReview(tight);
  assert.equal(r.target.feasibility.feasible, false);
  assert.equal(r.levers, null, 'and not worked out unless asked');
  const withLevers = planReview(tight, { levers: true });
  assert.ok(withLevers.levers.distance, 'a different goal is offered');
  assert.equal(withLevers.blocked, false, 'an unreachable target does not block the plan');
});

test('a season built without a start still reviews, with no target', () => {
  const a = filled({ recentWeeklyHours: undefined });
  const p = buildPlanFromAnswers(a, { today: TODAY, now: 1 });
  assert.equal(p.target, undefined);
  assert.equal(planReview(p).target, null);
});

/* ---- the ambition step ---- */

test('the ambition step comes straight after the races, and before the goal', () => {
  assert.equal(STEPS.indexOf('ambition'), STEPS.indexOf('races') + 1);
  assert.equal(STEPS.indexOf('goal'), STEPS.indexOf('ambition') + 1);
});

test('the ambition step accepts any of the three levels, or none, and refuses what is not one', () => {
  for (const ambition of [undefined, 'finish', 'intermediate', 'competitive']) {
    assert.deepEqual(stepProblems('ambition', filled({ ambition }), { today: TODAY }), [], String(ambition));
  }
  for (const bad of ['fast', 3, '']) {
    const p = stepProblems('ambition', filled({ ambition: bad }), { today: TODAY });
    if (bad === '') assert.deepEqual(p, [], 'an empty box is no answer');
    else assert.deepEqual(p.map((x) => x.field), ['ambition'], String(bad));
  }
});

test('every step the wizard has can be left with a filled-in answer set', () => {
  for (const step of STEPS) assert.deepEqual(stepProblems(step, filled({ ambition: 'finish' }), { today: TODAY }), [], step);
});

test('where the athlete starts is worked out once, for the review and for the plan alike', () => {
  const a = filled();
  const start = startFitnessFor(a, { today: TODAY, now: 1 });
  const plan = buildPlanFromAnswers(a, { today: TODAY, now: 1 });
  assert.equal(start.ctl, plan.target.start.ctl);
  assert.equal(start.source, plan.target.start.source);
  assert.match(start.note, /estimate/i, 'with the sentence the review shows');
  assert.equal(startFitnessFor(filled({ startCtlEntered: 80 }), { today: TODAY, now: 1 }).source, 'estimate', 'a typed figure is not read');
});
