import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyAnswers, buildPlanFromAnswers, stepProblems } from '../assets/coach/onboarding.js';
import { fitnessSeries } from '../assets/coach/fitness.js';
import { normalizeEvent, goalEvent, normalizeEvents } from '../assets/coach/events.js';

/* How a season is sized today, written down before it changes.

   Every test here passes against the engine as it is, and each one pins a
   behaviour the target-driven planner exists to replace: a season sized by the
   hours the athlete has and nothing else, whatever the race, whatever their
   fitness, and with no notion of where they are now. They are deliberately
   asserted as facts rather than as a wish, so that the pull request which
   changes a behaviour changes the test beside it and the diff shows the defect
   being fixed.

   The numbers are the fitness line the Fitness chart draws for a plan built
   from the wizard's answers on Sun 18 Oct 2026 for a race on Sat 3 Apr 2027,
   with an availability scaled from the default week. Planned fitness is an
   estimate (fitness.js); what matters here is how it moves with the inputs. */

const TODAY = '2026-10-18';
const BASE = { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 };       // 11.5 h
const week = (hours) => Object.fromEntries(
  Object.entries(BASE).map(([d, m]) => [d, Math.round((m * hours) / 11.5 / 5) * 5]));

function built(hours, raceType, extra = {}) {
  const a = { ...emptyAnswers(), ...extra };
  a.availability = week(hours);
  a.race = { raceType, date: '2027-04-03', name: 'Test' };
  const plan = buildPlanFromAnswers(a, { today: TODAY, now: 1 });
  const planned = fitnessSeries(plan, { today: TODAY }).weeks.map((w) => w.planned);
  const n = planned.length;
  return { plan, planned, raceWeek: planned[n - 1], peak: Math.max(...planned.slice(0, n - 3)) };
}

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} is not within ${tol} of ${expected}`);

test('the fitness a season arrives with follows the athlete\'s hours, whatever the race asks', () => {
  // Race-week fitness / the highest point before the taper, for an Ironman.
  near(built(8, 'ironman').raceWeek, 51.3, 1, '8 h');
  near(built(8, 'ironman').peak, 62.1, 1, '8 h peak');
  near(built(11.5, 'ironman').raceWeek, 76.8, 1, '11.5 h');
  near(built(11.5, 'ironman').peak, 93.3, 1, '11.5 h peak');
  near(built(17, 'ironman').raceWeek, 113.3, 1, '17 h');
  near(built(17, 'ironman').peak, 136.6, 1, '17 h peak');
});

test('an Ironman and a 70.3 on the same hours get the same season, and the same fitness', () => {
  const im = built(17, 'ironman');
  const half = built(17, '70.3');
  assert.deepEqual(im.plan.season.map((w) => [w.block, w.hours]), half.plan.season.map((w) => [w.block, w.hours]));
  near(im.raceWeek, half.raceWeek, 1, 'race-week fitness');
  near(half.raceWeek, 113.6, 1, '17 h 70.3');
});

test('an 8-hour athlete aiming at an Ironman arrives at about 51 with nothing said about it', () => {
  const { plan, raceWeek } = built(8, 'ironman');
  assert.ok(raceWeek < 55);
  assert.equal(plan.target, undefined, 'no target is stored');
  assert.equal(plan.release.through, 0);
});

test('the athlete\'s recent hours size nothing; only the week they say they have does', () => {
  const quiet = built(11.5, 'ironman', { recentWeeklyHours: 3 });
  const busy = built(11.5, 'ironman', { recentWeeklyHours: 15 });
  assert.deepEqual(quiet.plan.season.map((w) => w.hours), busy.plan.season.map((w) => w.hours));
});

test('the planned line starts from nothing, so the plan has no notion of where the athlete is now', () => {
  const { planned } = built(11.5, 'ironman');
  assert.ok(planned[0] < 15, `week 1 is ${planned[0]}, the climb from zero`);
});

test('there is no ambition: it is not an event field, and a plan stores no target', () => {
  const ev = normalizeEvent({ id: 'e', date: '2027-04-03', kind: 'race', raceType: 'ironman', priority: 'primary', ambition: 'competitive' });
  assert.equal('ambition' in ev, false, 'the allowlist drops it');
  const { plan } = built(11.5, 'ironman');
  assert.equal(goalEvent(normalizeEvents(plan.events)).ambition, undefined);
});

test('every tune-up race gets a taper week, however short the race is', () => {
  const a = { ...emptyAnswers() };
  a.availability = week(11.5);
  a.race = { raceType: '70.3', date: '2027-04-03', name: 'Test' };
  a.tuneUps = [{ name: '10k', date: '2027-01-16', raceType: '10k' }];
  const plan = buildPlanFromAnswers(a, { today: TODAY, now: 1 });
  const race = plan.season.findIndex((w, i) => i < plan.season.length - 3 && w.block === 'Race');
  assert.ok(race > 0, 'the 10 km has its race week');
  assert.equal(plan.season[race - 1].block, 'Taper', 'and the week before it is a taper');
});

test('Olympic cannot be the race a season is built for', () => {
  const a = { ...emptyAnswers(), race: { raceType: 'olympic', date: '2027-04-03', name: 'Short' } };
  const fields = stepProblems('races', a, { today: TODAY }).map((p) => p.field);
  assert.deepEqual(fields, ['race']);
});
