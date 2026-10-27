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

test('the taper into the race is two weeks of shares that only come down, each less than the week before', () => {
  const shares = PLAN_MODEL.taperTail.hoursShare;
  assert.equal(shares.length, 2, 'two weeks, as the studies favour for a race of this length');
  assert.ok(shares.every((x) => x > 0 && x < 1), 'each is a part of the last loading week');
  assert.ok(shares[1] < shares[0], 'and the second is smaller than the first');
  assert.ok(shares[0] >= 0.5 && shares[1] >= 0.4, 'a volume cut of a half or so at the deepest, not the whole week');
});

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

/* ---- what the athlete is shown about a target ---- */

import { AMBITION_INFO, ambitionOptions, describeTarget } from '../assets/coach/targets.js';

const goodTarget = (over = {}) => ({
  ctl: 75, start: { ctl: 50, source: 'estimate' },
  feasibility: { feasible: true, status: 'build', targetCtl: 75, achievableCtl: 75, shortfall: 0, limitingFactor: null },
  ...over,
});
const shortTarget = (limitingFactor = 'availability') => goodTarget({
  ctl: 98,
  feasibility: { feasible: false, status: 'build', targetCtl: 98, achievableCtl: 64.3, shortfall: 33.7, limitingFactor },
});

/* A target aimed at the peak before the taper says so, and says where race day comes out. One made
   for race day, before the peak existed, says what it always did. */
const peakTarget = (over = {}) => goodTarget({
  at: 'peak',
  feasibility: { feasible: true, status: 'build', targetCtl: 75, achievableCtl: 74.9, shortfall: 0, limitingFactor: null, raceCtl: 61.7 },
  ...over,
});
const shortPeak = (limitingFactor = 'runway') => peakTarget({
  ctl: 98,
  feasibility: { feasible: false, status: 'build', targetCtl: 98, achievableCtl: 64.3, shortfall: 33.7, limitingFactor, raceCtl: 53 },
});

test('each level has a name and a plain-language description', () => {
  assert.deepEqual(Object.keys(AMBITION_INFO), [...AMBITIONS]);
  for (const a of AMBITIONS) {
    assert.ok(AMBITION_INFO[a].label && AMBITION_INFO[a].blurb, a);
    assert.ok(Object.isFrozen(AMBITION_INFO[a]));
  }
});

test('the levels on offer for a race carry their targets, from the band', () => {
  const opts = ambitionOptions('70.3');
  assert.deepEqual(opts.map((o) => [o.key, o.target]), [['finish', 60], ['intermediate', 75], ['competitive', 90]]);
  assert.deepEqual(opts[0].band, { lo: 60, hi: 90 });
  assert.deepEqual(ambitionOptions('sprint'), [], 'no band, nothing to offer');
  assert.deepEqual(ambitionOptions(undefined), []);
});

test('a target that is reached says so, in plain words, and calls the figure an estimate', () => {
  const d = describeTarget({ target: goodTarget() });
  assert.equal(d.state, 'reached');
  assert.match(d.headline, /75/);
  assert.match(d.detail, /estimate/i);
  assert.deepEqual(d.choices, []);
});

test('a target aimed at the peak says peak, and where race day comes out', () => {
  const d = describeTarget({ target: peakTarget() });
  assert.equal(d.state, 'reached');
  assert.match(d.headline, /peak/i);
  assert.match(d.headline, /75/);
  assert.doesNotMatch(d.headline, /on race day/i, 'race day is not what it was built to arrive at');
  assert.match(d.detail, /75/, 'about what the plan reaches');
  assert.match(d.detail, /62/, 'and about what race day comes to');
  assert.match(d.detail, /race day/i);
  assert.match(d.detail, /estimate/i);
});

test('a peak target made before race-day figures were kept still reads, without one', () => {
  const t = peakTarget();
  delete t.feasibility.raceCtl;
  const d = describeTarget({ target: t });
  assert.match(d.headline, /peak/i);
  assert.doesNotMatch(d.detail, /NaN|undefined|null/);
});

test('a target made for race day says what it always said', () => {
  const d = describeTarget({ target: goodTarget() });
  assert.equal(d.headline, 'Built to arrive at a fitness of 75 on race day.');
  assert.match(d.detail, /The plan reaches about 75\./);
});

test('an athlete already above a peak target is told the plan holds what they have', () => {
  const t = peakTarget({ feasibility: { feasible: true, status: 'hold', targetCtl: 75, achievableCtl: 88, shortfall: 0, limitingFactor: null, raceCtl: 72 } });
  const d = describeTarget({ target: t });
  assert.equal(d.state, 'hold');
  assert.match(d.headline, /already/i);
  assert.match(d.detail, /88/);
  assert.match(d.detail, /peak/i);
});

test('a peak target out of reach says so plainly, in terms of the peak', () => {
  const d = describeTarget({ target: shortPeak() });
  assert.equal(d.state, 'short');
  assert.match(d.headline, /out of reach/i);
  assert.match(d.headline, /peak/i);
  assert.match(d.headline, /64/);
  assert.match(d.headline, /98/);
  assert.match(d.detail, /enough weeks/i);
});

test('an athlete already above the target is told the plan holds what they have', () => {
  const t = goodTarget({ feasibility: { feasible: true, status: 'hold', targetCtl: 75, achievableCtl: 88, shortfall: 0, limitingFactor: null } });
  const d = describeTarget({ target: t });
  assert.equal(d.state, 'hold');
  assert.match(d.headline, /already/i);
  assert.match(d.detail, /88/);
});

test('a target out of reach says so plainly: how far short, and what is in the way', () => {
  const byFactor = {
    availability: /time you have each week/i,
    runway: /enough weeks/i,
    ramp: /pinned or already trained/i,
  };
  for (const [factor, re] of Object.entries(byFactor)) {
    const d = describeTarget({ target: shortTarget(factor) });
    assert.equal(d.state, 'short');
    assert.match(d.headline, /out of reach/i);
    assert.match(d.headline, /64/);
    assert.match(d.headline, /98/);
    assert.match(d.detail, re, factor);
  }
});

test('what would help is offered as choices, each worked out and none promised', () => {
  const levers = {
    raceDate: { weeks: 40, raceDate: '2027-09-12' },
    ambition: { ambition: 'finish', targetCtl: 80 },
    hours: { weeklyHours: 16 },
    distance: { raceType: '70.3', ambition: 'competitive', targetCtl: 90 },
  };
  const d = describeTarget({ target: shortTarget(), levers });
  const text = d.choices.join(' | ');
  assert.match(text, /Finish/);
  assert.match(text, /80/);
  assert.match(text, /70\.3/);
  assert.match(text, /12 Sep 2027/);
  assert.match(text, /16 hours/);
  assert.match(d.choices.at(-1), /keep this goal/i, 'and the athlete may keep the goal, with the best plan that can be built');
  assert.equal(d.choices.length, 5);
});

test('levers that are not there are not offered', () => {
  const d = describeTarget({ target: shortTarget('runway'), levers: { raceDate: null, ambition: null, hours: null, distance: null } });
  assert.deepEqual(d.choices.length, 1, 'only keeping the goal');
  assert.deepEqual(describeTarget({ target: shortTarget() }).choices, [], 'levers not asked for: none shown');
});

test('what is said about a target never promises a result or talks about the body', () => {
  const levers = { raceDate: { weeks: 40, raceDate: '2027-09-12' }, ambition: { ambition: 'finish', targetCtl: 80 }, hours: { weeklyHours: 16 }, distance: { raceType: '70.3', ambition: 'competitive', targetCtl: 90 } };
  const text = JSON.stringify([
    AMBITION_INFO, describeTarget({ target: goodTarget() }), describeTarget({ target: shortTarget(), levers }),
    describeTarget({ target: peakTarget() }), describeTarget({ target: shortPeak(), levers }),
    describeTarget({ target: goodTarget({ feasibility: { feasible: true, status: 'hold', targetCtl: 75, achievableCtl: 88, shortfall: 0, limitingFactor: null } }) }),
  ]);
  for (const re of [/guarantee/i, /will (reach|qualify|finish|achieve|hit)/i, /injur/i, /readiness/i, /\brisk/i, /overtrain/i, /medical/i, /\bready\b/i]) {
    assert.doesNotMatch(text, re);
  }
});

test('nothing to say for a plan with no target', () => {
  assert.equal(describeTarget({ target: null }), null);
  assert.equal(describeTarget({}), null);
});
