import test from 'node:test';
import assert from 'node:assert/strict';

import {
  landingsOf, landingsDetail, raceDayFor, raceClosure, plannedRaceLoads,
} from '../assets/coach/races.js';
import * as plan from '../assets/coach/plan.js';
import { raceLoad } from '../assets/coach/events.js';

/* Where a plan's races fall, what each one closes and what each one costs. The
   calendar, the season model and the planner all ask these, and they live apart
   from plan.js so the planner can read them without importing the plan. */

const START = '2026-11-02';                                  // a Monday
const race = (over) => ({ id: 'e', name: 'R', kind: 'race', priority: 'secondary', raceType: '10k', ...over });
const base = (events) => ({ start: START, events });

test('plan.js hands back these same functions', () => {
  assert.equal(plan.landingsOf, landingsOf);
  assert.equal(plan.landingsDetail, landingsDetail);
  assert.equal(plan.raceDayFor, raceDayFor);
  assert.equal(plan.raceClosure, raceClosure);
});

test('the weeks tune-ups fall in, with whether each needs a taper', () => {
  const p = base([race({ id: 'a', date: '2027-01-26' }), race({ id: 'b', date: '2027-02-14', raceType: '70.3' })]);
  assert.deepEqual(landingsOf(p), [12, 14]);
  assert.deepEqual(landingsDetail(p), [{ absWeek: 12, taper: false }, { absWeek: 14, taper: true }]);
});

test('a race closes its day, and what follows unless it is a short tune-up', () => {
  const p = base([race({ date: '2027-01-26' })]);                // a Tuesday
  assert.equal(raceDayFor(p, 12), 'Tue');
  assert.deepEqual(raceClosure(p, 12), { raceDay: 'Tue', raceOnly: true });
  assert.deepEqual(raceClosure(p, 11), { raceDay: null, raceOnly: false });
});

test('the load of each tune-up falls on its own date, and only inside the weeks given', () => {
  const ev = race({ id: 'a', date: '2027-01-26' });
  const p = base([ev, race({ id: 'b', date: '2027-08-01' }), race({ id: 'c', date: '2026-10-01' })]);
  const loads = plannedRaceLoads(p, 20);
  assert.deepEqual(Object.keys(loads), ['2027-01-26'], 'the other two are outside a 20-week plan from 2 Nov');
  assert.equal(loads['2027-01-26'], raceLoad({ ...ev }));
});

test('the main race adds nothing, a marker adds nothing, and a race of unknown length adds nothing', () => {
  const p = base([
    race({ id: 'p', priority: 'primary', raceType: '70.3', date: '2027-03-21' }),
    race({ id: 'm', priority: null, date: '2027-01-26' }),
    race({ id: 'u', raceType: null, date: '2027-01-27' }),
  ]);
  assert.deepEqual(plannedRaceLoads(p, 20), {});
});

test('two tune-ups on one day add up', () => {
  const p = base([race({ id: 'a', date: '2027-01-26' }), race({ id: 'b', date: '2027-01-26', raceType: 'half-marathon' })]);
  const loads = plannedRaceLoads(p, 20);
  assert.equal(loads['2027-01-26'], raceLoad(race({ raceType: '10k' })) + raceLoad(race({ raceType: 'half-marathon' })));
});

test('nothing in, nothing out', () => {
  assert.deepEqual(plannedRaceLoads({}, 20), {});
  assert.deepEqual(plannedRaceLoads(base([]), 0), {});
  assert.deepEqual(landingsDetail({}), []);
});
