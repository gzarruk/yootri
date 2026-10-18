import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyAnswers, buildPlanFromAnswers, stepProblems } from '../assets/coach/onboarding.js';
import { fitnessSeries } from '../assets/coach/fitness.js';
import { normalizeEvent, goalEvent, normalizeEvents } from '../assets/coach/events.js';

/* How a season is sized, from the wizard's answers to the fitness line.

   This file began (phase 1) as a record of the sizing defects the target-driven
   planner exists to replace: a season sized by the hours the athlete has and
   nothing else, whatever the race, whatever their fitness, with no notion of
   where they are now. It was written to pass against the engine as it was so
   that the pull request which changed each behaviour changed the test beside it.
   Phase 2 flipped the tune-up and Olympic tests; phase 4, which wired the
   planner into the wizard, flipped the rest. What is left is the contrast: the
   same four athletes the defects were measured on, now with a target.

   The numbers are the fitness line the Fitness chart draws for a plan built
   from the wizard's answers on Sun 18 Oct 2026 for a race on Sat 3 Apr 2027,
   with an availability scaled from the default week. Planned fitness is an
   estimate (fitness.js); what matters here is how it moves with the inputs. */

const TODAY = '2026-10-18';
const BASE = { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 };       // 11.5 h
const week = (hours) => Object.fromEntries(
  Object.entries(BASE).map(([d, m]) => [d, Math.round((m * hours) / 11.5 / 5) * 5]));

function built(hours, raceType, { ambition, ...extra } = {}) {
  const a = { ...emptyAnswers(), recentWeeklyHours: 8, ...(ambition ? { ambition } : {}), ...extra };
  a.availability = week(hours);
  a.race = { raceType, date: '2027-04-03', name: 'Test' };
  const plan = buildPlanFromAnswers(a, { today: TODAY, now: 1 });
  const planned = fitnessSeries(plan, { today: TODAY }).weeks.map((w) => w.planned);
  const n = planned.length;
  return { plan, planned, raceDay: fitnessSeries(plan, { today: TODAY }).plannedRace.fit, peak: Math.max(...planned.slice(0, n - 3)) };
}

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} is not within ${tol} of ${expected}`);

test('the fitness a season arrives with is what the race and the ambition call for, not what the hours would allow', () => {
  // Before: 17 h gave about 115 for a 70.3 and an Ironman alike, and 8 h about 51 with nothing said.
  near(built(17, '70.3', { ambition: 'competitive' }).raceDay, 90, 2, '17 h 70.3 competitive');
  near(built(17, 'ironman', { ambition: 'competitive' }).raceDay, 115, 2, '17 h Ironman competitive');
  near(built(12, '70.3', { ambition: 'finish' }).raceDay, 60, 2, '12 h 70.3 finish');
});

test('an Ironman and a 70.3 on the same hours are not the same season', () => {
  const im = built(17, 'ironman', { ambition: 'intermediate' });
  const half = built(17, '70.3', { ambition: 'intermediate' });
  assert.notDeepEqual(im.plan.season.map((w) => w.hours), half.plan.season.map((w) => w.hours));
  assert.ok(Math.abs(im.raceDay - half.raceDay) > 15, `${im.raceDay} against ${half.raceDay}`);
});

test('an 8-hour athlete aiming at an Ironman is told so, and given the best that 8 hours can do', () => {
  const { plan, raceDay } = built(8, 'ironman', { ambition: 'competitive' });
  assert.equal(plan.target.ctl, 115);
  assert.equal(plan.target.feasibility.feasible, false);
  assert.equal(plan.target.feasibility.limitingFactor, 'availability');
  assert.ok(plan.target.feasibility.shortfall > 20);
  near(raceDay, plan.target.feasibility.achievableCtl, 1, 'and it reads back what it said');
  assert.ok(raceDay < 115, 'it does not overshoot');
  assert.equal(plan.release.through, 0);
});

test('the athlete\'s recent hours are where the season starts from', () => {
  const quiet = built(11.5, '70.3', { ambition: 'intermediate', recentWeeklyHours: 3 });
  const busy = built(11.5, '70.3', { ambition: 'intermediate', recentWeeklyHours: 10 });
  assert.ok(quiet.plan.target.start.ctl < busy.plan.target.start.ctl);
  assert.equal(quiet.plan.target.start.source, 'estimate');
  assert.notDeepEqual(quiet.plan.season.map((w) => w.hours), busy.plan.season.map((w) => w.hours), 'a longer climb is a different season');
  assert.ok(quiet.plan.season[0].hours < busy.plan.season[0].hours);
});

test('the planned line starts from where the athlete is now', () => {
  const { planned, plan } = built(11.5, '70.3', { ambition: 'intermediate' });
  assert.ok(plan.target.start.ctl > 55);
  assert.ok(planned[0] > 40, `week 1 is ${planned[0]}: from ${plan.target.start.ctl}, not the climb from zero`);
});

test('a plan records its target and the athlete\'s ambition', () => {
  const { plan } = built(11.5, '70.3', { ambition: 'competitive' });
  assert.equal(plan.target.ctl, 90);
  assert.equal(goalEvent(normalizeEvents(plan.events)).ambition, 'competitive');
  assert.equal(built(11.5, '70.3').plan.target.ctl, 75, 'no ambition given is the middle one');
});

test('with nothing to start from, a season is sized the way it was before targets', () => {
  const a = { ...emptyAnswers() };
  a.availability = week(11.5);
  a.race = { raceType: '70.3', date: '2027-04-03', name: 'Test' };
  const plan = buildPlanFromAnswers(a, { today: TODAY, now: 1 });
  assert.equal(plan.target, undefined);
  assert.ok(plan.season.every((w) => !('ctl' in w)));
});

test('a tune-up race gets a taper week only if it takes more than two hours (phase 2)', () => {
  const plan = (raceType) => {
    const a = { ...emptyAnswers(), recentWeeklyHours: 8 };
    a.availability = week(11.5);
    a.race = { raceType: '70.3', date: '2027-04-03', name: 'Test' };
    a.tuneUps = [{ name: 'Tune', date: '2027-01-16', raceType }];
    return buildPlanFromAnswers(a, { today: TODAY, now: 1 });
  };
  const tapered = (p) => p.season.some((w, i) => i < p.season.length - 3 && w.block === 'Taper');
  assert.equal(tapered(plan('10k')), false, 'a 10 km is a hard day in the build');
  assert.equal(tapered(plan('olympic')), true);
});

test('Olympic can be the race a season is built for; a sprint cannot (phase 2)', () => {
  const problems = (raceType) => stepProblems('races', { ...emptyAnswers(), race: { raceType, date: '2027-04-03', name: 'Short' } },
    { today: TODAY }).map((p) => p.field);
  assert.deepEqual(problems('olympic'), []);
  assert.deepEqual(problems('sprint'), ['race']);
});

test('an event keeps an ambition only on the race the season is built for', () => {
  const ev = normalizeEvent({ id: 'e', date: '2027-04-03', kind: 'race', raceType: 'ironman', priority: 'primary', ambition: 'competitive' });
  assert.equal(ev.ambition, 'competitive');
  assert.equal('ambition' in normalizeEvent({ id: 'e', date: '2027-04-03', kind: 'race', raceType: '10k', priority: 'secondary', ambition: 'competitive' }), false);
});
