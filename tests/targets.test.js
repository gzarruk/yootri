import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_MODEL, targetCtl, taperDepth } from '../assets/coach/targets.js';
import { AMBITIONS, DEFAULT_AMBITION, TAPER_MIN_MINUTES, hasTaper } from '../assets/coach/events.js';
import { FITNESS_BANDS } from '../assets/coach/fitness.js';

/* A target is the chronic training load the plan should leave the athlete with
   on race day. It is read off the same bands the Fitness chart draws, so the
   chart and the plan cannot drift apart: change a band and the target moves. */

test('the three ambitions are named, in order of how hard they ask', () => {
  assert.deepEqual([...AMBITIONS], ['finish', 'intermediate', 'competitive']);
  assert.equal(DEFAULT_AMBITION, 'intermediate');
});

test('targets by race and ambition', () => {
  const table = {
    ironman: { finish: 80, intermediate: 98, competitive: 115 },
    '70.3': { finish: 60, intermediate: 75, competitive: 90 },
    olympic: { finish: 40, intermediate: 55, competitive: 70 },
  };
  for (const [race, row] of Object.entries(table)) {
    for (const [ambition, ctl] of Object.entries(row)) {
      assert.equal(targetCtl(race, ambition), ctl, `${race} ${ambition}`);
    }
  }
});

test('every target is derived from the chart bands, so the two cannot disagree', () => {
  for (const { key, lo, hi } of FITNESS_BANDS) {
    assert.equal(targetCtl(key, 'finish'), lo, `${key} finish is the band's low end`);
    assert.equal(targetCtl(key, 'intermediate'), Math.round((lo + hi) / 2), `${key} intermediate is its middle`);
    assert.equal(targetCtl(key, 'competitive'), hi, `${key} competitive is its high end`);
  }
});

test('a higher ambition never asks for less', () => {
  for (const { key } of FITNESS_BANDS) {
    const t = AMBITIONS.map((a) => targetCtl(key, a));
    assert.deepEqual(t, [...t].sort((a, b) => a - b), key);
    assert.equal(new Set(t).size, t.length, `${key}: three different targets`);
  }
});

test('no ambition, or one that is not a level, is the default level', () => {
  assert.equal(targetCtl('70.3'), targetCtl('70.3', DEFAULT_AMBITION));
  assert.equal(targetCtl('70.3', undefined), 75);
  assert.equal(targetCtl('70.3', 'bogus'), 75);
  assert.equal(targetCtl('70.3', null), 75);
});

test('a distance with no band has no target', () => {
  for (const t of ['sprint', 'marathon', '10k', 'swimrun', '', undefined, null, 'nonsense']) {
    assert.equal(targetCtl(t, 'finish'), null, String(t));
  }
});

test('the constants table is frozen all the way down', () => {
  const walk = (o, path) => {
    assert.ok(Object.isFrozen(o), `${path} is frozen`);
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  };
  walk(PLAN_MODEL, 'PLAN_MODEL');
});

/* ---- how deep a tune-up race's taper goes ---- */

const race = (raceType, expectedMinutes) => ({ kind: 'race', raceType, priority: 'secondary', ...(expectedMinutes ? { expectedMinutes } : {}) });

test('a taper is a share of the week it replaces, deeper for a longer race', () => {
  assert.equal(taperDepth(race('10k')), 0, 'no taper at all');
  assert.equal(taperDepth(race('olympic')), 0.2, 'two to three hours');
  assert.equal(taperDepth(race('marathon')), 0.35, 'three to six hours');
  assert.equal(taperDepth(race('70.3')), 0.35);
  assert.equal(taperDepth(race('ironman')), 0.5, 'over six hours');
});

test('the tier edges: more than two hours, more than three, more than six', () => {
  const d = (m) => taperDepth(race('70.3', m));
  assert.deepEqual([120, 121, 180, 181, 360, 361].map(d), [0, 0.2, 0.2, 0.35, 0.35, 0.5]);
});

test('a race that has a taper has a depth, and one that has none has none', () => {
  for (const t of ['10k', 'half-marathon', 'sprint', 'olympic', 'marathon', 'swimrun', '70.3', 'ironman']) {
    assert.equal(taperDepth(race(t)) > 0, hasTaper(race(t)), t);
  }
  assert.equal(PLAN_MODEL.taper[0].over, TAPER_MIN_MINUTES, 'the first tier starts where a taper does');
});

test('a longer race never gets a shallower taper', () => {
  let last = 0;
  for (let m = 100; m <= 900; m += 5) {
    const depth = taperDepth(race('70.3', m));
    assert.ok(depth >= last, `${m} min`);
    last = depth;
  }
});

test('a race of unknown length gets the middle tier, because it is tapered', () => {
  assert.equal(taperDepth(race(null)), 0.35);
  assert.equal(taperDepth(null), 0, 'and nothing at all is not a race');
});
