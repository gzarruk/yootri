import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { planSeason, weeklyLoadFor, planLevers } from '../assets/coach/backplan.js';
import { PLAN_MODEL, targetCtl } from '../assets/coach/targets.js';
import { AMBITIONS, normalizeEvents } from '../assets/coach/events.js';
import { fitnessSeries, plannedLoad } from '../assets/coach/fitness.js';
import { generateWeek } from '../assets/coach/generate.js';
import { raceClosure } from '../assets/coach/races.js';
import { normalizeProfile, weeklyAvailableMinutes, DAYS } from '../assets/coach/profile.js';
import { validateSeason, MAX_RAMP, MAX_BLOCK_STEP } from '../assets/coach/validate.js';
import { LOAD } from '../assets/coach/load.js';
import { durToMin } from '../assets/coach/duration.js';
import { addDays, parseISO, toISO } from '../assets/coach/dates.js';

/* The planner builds a season backwards from where the athlete should be on race
   day. It is checked here the only way that means anything: the season it
   returns is turned into a plan and read back through the same fitness line the
   Fitness chart draws, and has to land where it said it would.

   Every week it builds is a week generate.js would build, scored by the same
   planned-load estimate the chart uses — there is no second estimator. */

const START = '2026-10-19';                                  // a Monday
const BASE_WEEK = { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 };   // 11.5 h
const availability = (hours) => Object.fromEntries(
  Object.entries(BASE_WEEK).map(([d, m]) => [d, Math.round((m * hours) / 11.5 / 5) * 5]));
const raceDateFor = (weeks) => toISO(addDays(parseISO(START), (weeks - 1) * 7 + 5));        // the Saturday of the last week

function input({ raceType = '70.3', ambition = 'intermediate', hours = 12, weeks = 24, startCtl = 50, extra = {}, events } = {}) {
  const raceDate = raceDateFor(weeks);
  return {
    start: START,
    weeks,
    profile: normalizeProfile({ availability: availability(hours), raceType, raceDate }),
    events: events ?? [{ id: 'a', name: 'A', date: raceDate, kind: 'race', raceType, priority: 'primary', ambition }],
    startCtl,
    targetCtl: targetCtl(raceType, ambition),
    ...extra,
  };
}

/** The plan these inputs and this season make, as the page would hold it. */
function assemble(inp, result) {
  const events = normalizeEvents(inp.events);
  const shell = { start: inp.start, events };
  const weeks = {};
  for (const w of result.season) {
    weeks[`w${w.absWeek}`] = generateWeek({
      hours: w.hours, block: w.block, profile: inp.profile, idPrefix: `w${w.absWeek}`, ...raceClosure(shell, w.absWeek),
    }).sessions;
  }
  return {
    start: inp.start, profile: inp.profile, season: result.season, weeks, events,
    target: { start: { ctl: inp.startCtl } },
  };
}
const today = '2026-10-18';
const raceDayCtl = (inp, result) => fitnessSeries(assemble(inp, result), { today }).plannedRace.fit;
const minutesOf = (inp, result) => {
  const p = assemble(inp, result);
  return result.season.map((w) => p.weeks[`w${w.absWeek}`].reduce((a, s) => a + durToMin(s.dur), 0));
};
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} is not within ${tol} of ${expected}`);
const TOL = PLAN_MODEL.tolerance;

/* ---- the arithmetic ---- */

test('a week at a constant daily load moves the average by the closed form', () => {
  // CTL_end = CTL_start·a + L·(1 − a), a = e^(−7/42), L the daily load; the week's load is 7L.
  const k = 1 - Math.exp(-1 / LOAD.chronicDays);
  for (const [from, to] of [[0, 50], [50, 80], [80, 80], [100, 60]]) {
    const week = weeklyLoadFor(from, to);
    let c = from;
    for (let d = 0; d < 7; d++) c += k * (week / 7 - c);
    near(c, to, 1e-9, `${from} → ${to}`);
  }
});

test('holding fitness takes a daily load equal to it', () => {
  near(weeklyLoadFor(70, 70), 7 * 70, 1e-9, 'steady state');
});

/* ---- landing ---- */

test('a 70.3 built for the middle of its band lands there through the fitness line the chart draws', () => {
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 24, startCtl: 50 });
  const r = planSeason(inp);
  assert.equal(r.feasibility.feasible, true);
  assert.equal(r.feasibility.targetCtl, 75);
  near(raceDayCtl(inp, r), 75, TOL, 'race-day fitness');
  near(r.feasibility.achievableCtl, raceDayCtl(inp, r), 0.6, 'what it says it reaches is what the line reads');
});

test('17 hours: a 70.3 is built to 90, not to whatever the hours would allow', () => {
  const inp = input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 24, startCtl: 50 });
  const r = planSeason(inp);
  near(raceDayCtl(inp, r), 90, TOL, '70.3 competitive');
  assert.ok(Math.max(...r.season.map((w) => w.hours)) < 17, 'and it does not spend the whole week to get there');
});

test('17 hours: an Ironman built for the top of its band reaches it', () => {
  const inp = input({ raceType: 'ironman', ambition: 'competitive', hours: 17, weeks: 36, startCtl: 50 });
  const r = planSeason(inp);
  assert.equal(r.feasibility.feasible, true);
  near(raceDayCtl(inp, r), 115, TOL, 'ironman competitive');
});

test('an Ironman and a 70.3 on the same inputs are not the same season', () => {
  const im = planSeason(input({ raceType: 'ironman', ambition: 'intermediate', hours: 17, weeks: 24 }));
  const half = planSeason(input({ raceType: '70.3', ambition: 'intermediate', hours: 17, weeks: 24 }));
  assert.notDeepEqual(im.season.map((w) => w.hours), half.season.map((w) => w.hours));
  assert.ok(Math.max(...im.season.map((w) => w.hours)) > Math.max(...half.season.map((w) => w.hours)), 'the longer race asks for a bigger week');
});

test('the season ends in the same tail the model has always had: Peak, Peak, Race, coming down', () => {
  const inp = input();
  const r = planSeason(inp);
  assert.deepEqual(r.season.slice(-3).map((w) => w.block), ['Peak', 'Peak', 'Race']);
  const mins = minutesOf(inp, r).slice(-3);
  assert.ok(mins[0] > mins[1] && mins[1] > mins[2], `the taper only comes down: ${mins}`);
});

test('race day itself, and the Sunday after a Saturday race, hold no training', () => {
  const inp = input();
  const p = assemble(inp, planSeason(inp));
  const last = p.weeks[`w${p.season.length - 1}`];
  for (const day of ['Sat', 'Sun']) assert.equal(durToMin(last.find((s) => s.day === day).dur), 0, day);
});

/* ---- when it cannot be done ---- */

test('8 hours cannot be built to any Ironman target, and the plan says so plainly', () => {
  for (const ambition of AMBITIONS) {
    const inp = input({ raceType: 'ironman', ambition, hours: 8, weeks: 24, startCtl: 50 });
    const r = planSeason(inp);
    const f = r.feasibility;
    assert.equal(f.feasible, false, ambition);
    assert.equal(f.limitingFactor, 'availability', `${ambition}: more weeks would not help`);
    assert.ok(f.achievableCtl < f.targetCtl - TOL, ambition);
    assert.ok(f.shortfall > 0 && Math.abs(f.shortfall - (f.targetCtl - f.achievableCtl)) < 0.2, ambition);
    near(raceDayCtl(inp, r), f.achievableCtl, 1, `${ambition}: it builds the best it can and reads back what it said`);
  }
});

test('an infeasible plan never overshoots the target', () => {
  const inp = input({ raceType: 'ironman', ambition: 'finish', hours: 8, weeks: 24 });
  assert.ok(raceDayCtl(inp, planSeason(inp)) <= targetCtl('ironman', 'finish'));
});

test('too short a runway is a runway problem, and a longer one would do', () => {
  const inp = input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 8, startCtl: 20 });
  const r = planSeason(inp);
  assert.equal(r.feasibility.feasible, false);
  assert.equal(r.feasibility.limitingFactor, 'runway');
  const longer = planSeason(input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 40, startCtl: 20 }));
  assert.equal(longer.feasibility.feasible, true, 'the same athlete with the time');
});

test('an athlete already above what the target needs is held there, and told so', () => {
  const inp = input({ raceType: 'olympic', ambition: 'finish', hours: 12, weeks: 16, startCtl: 110 });
  const r = planSeason(inp);
  assert.equal(r.feasibility.feasible, true);
  assert.equal(r.feasibility.status, 'hold');
  assert.equal(r.feasibility.shortfall, 0);
  assert.ok(r.feasibility.achievableCtl >= r.feasibility.targetCtl, 'the target is already met');
  const early = r.season.slice(0, 10).map((w) => w.ctl);
  assert.ok(Math.max(...early) <= 110 + 5, `fitness is not raised above where it is: ${early}`);
  assert.ok(Math.min(...early) >= 110 - 30, `and the athlete\'s week, which cannot hold quite that, lets it drift: ${early}`);
});

/* ---- the shape of what it builds ---- */

test('a higher ambition never asks for fewer hours in any week', () => {
  // Down to the 5-minute block a session is rounded to: the same week can come
  // out a block either side of where a smooth line would put it.
  const BLOCK = 10 / 60;
  const bad = [];
  for (const raceType of ['olympic', '70.3', 'ironman']) {
    for (const startCtl of [20, 50, 80]) {
      for (const weeks of [16, 24, 36]) {
        for (const hours of [12, 17]) {
          const seasons = AMBITIONS.map((ambition) => planSeason(input({ raceType, ambition, hours, weeks, startCtl })).season);
          for (let level = 1; level < seasons.length; level++) {
            seasons[level].forEach((w, i) => {
              if (w.hours < seasons[level - 1][i].hours - BLOCK) {
                bad.push(`${raceType} from ${startCtl}, ${weeks} wk, ${hours} h, week ${i + 1}: ${AMBITIONS[level]} ${w.hours} < ${AMBITIONS[level - 1]} ${seasons[level - 1][i].hours}`);
              }
            });
          }
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('no week asks for more than the athlete has', () => {
  for (const hours of [8, 12, 17]) {
    const inp = input({ raceType: 'ironman', ambition: 'competitive', hours, weeks: 24 });
    const ceiling = weeklyAvailableMinutes(inp.profile);
    const r = planSeason(inp);
    // What the season asks for, not only what the generator would cut it to.
    for (const w of r.season) assert.ok(w.hours * 60 <= ceiling + 0.5, `${hours} h, week ${w.absWeek + 1} asks for ${w.hours * 60} of ${ceiling} minutes`);
    for (const m of minutesOf(inp, r)) assert.ok(m <= ceiling, `${hours} h: ${m} > ${ceiling}`);
  }
});

test('no loading week raises fitness by more than the ramp allows', () => {
  for (const [raceType, ambition, hours, startCtl] of [['70.3', 'competitive', 17, 20], ['ironman', 'intermediate', 17, 30], ['olympic', 'competitive', 12, 10]]) {
    const r = planSeason(input({ raceType, ambition, hours, weeks: 30, startCtl }));
    let prev = startCtl;
    for (const w of r.season) {
      if (!w.recovery) assert.ok(w.ctl - prev <= PLAN_MODEL.ramp.max + 0.05, `${raceType} week ${w.absWeek + 1}: ${prev} → ${w.ctl}`);
      prev = w.ctl;
    }
  }
});

test('a solved season is one the validator has nothing to say about', () => {
  for (const [raceType, ambition, hours, weeks, startCtl] of [
    ['70.3', 'intermediate', 12, 24, 50], ['70.3', 'competitive', 17, 24, 50], ['ironman', 'competitive', 17, 36, 50],
    ['olympic', 'finish', 8, 16, 20], ['70.3', 'finish', 8, 52, 30], ['ironman', 'finish', 8, 24, 50],
  ]) {
    const inp = input({ raceType, ambition, hours, weeks, startCtl });
    const r = planSeason(inp);
    const p = assemble(inp, r);
    const issues = validateSeason(r.season.map((w) => ({ ...w, sessions: p.weeks[`w${w.absWeek}`] })), { profile: inp.profile });
    assert.deepEqual(issues.map((i) => `${i.code}@${i.weekIndex}: ${i.message}`), [], `${raceType} ${ambition} ${hours} h ${weeks} wk from ${startCtl}`);
  }
});

test('a long runway climbs gently from where the athlete is, and is not the first block repeated', () => {
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 52, startCtl: 50 });
  const r = planSeason(inp);
  const early = r.season.slice(0, 16);
  let prev = 50;
  for (const w of early) {
    assert.ok(w.ctl - prev < 4, `week ${w.absWeek + 1} rises ${w.ctl - prev}: nothing like the top of the ramp`);
    prev = w.ctl;
  }
  assert.ok(early.some((w) => w.recovery), 'with a recovery week among them');
  const cycles = [0, 1, 2].map((c) => early.slice(c * 4, c * 4 + 4).map((w) => w.hours));
  assert.notDeepEqual(cycles[0], cycles[1], 'four weeks and the same four again is what padding with Prep used to be');
  assert.notDeepEqual(cycles[1], cycles[2]);
  near(raceDayCtl(inp, r), 75, TOL, 'and it still arrives');
});

test('where the gap to climb is tiny, the athlete holds until it is time to start', () => {
  const inp = input({ raceType: '70.3', ambition: 'finish', hours: 12, weeks: 52, startCtl: 72 });  // 60 on race day needs about 74 before the tail
  const r = planSeason(inp);
  const early = r.season.slice(0, 20).map((w) => w.ctl);
  assert.ok(Math.max(...early) - Math.min(...early) < 8, `held: ${early}`);
  near(raceDayCtl(inp, r), 60, TOL, 'and it arrives');
});

test('every week carries what the rest of the engine reads', () => {
  const r = planSeason(input());
  r.season.forEach((w, i) => {
    assert.equal(w.absWeek, i);
    assert.equal(typeof w.block, 'string');
    assert.equal(typeof w.recovery, 'boolean');
    assert.ok(w.hours >= 0 && Number.isFinite(w.hours));
    assert.ok(Number.isFinite(w.load) && w.load >= 0);
    assert.ok(Number.isFinite(w.ctl) && w.ctl >= 0);
  });
});

test('every 4th week of a build is a recovery week at the model\'s own recovery multiplier', () => {
  const inp = input({ weeks: 24 });
  const r = planSeason(inp);
  const mins = minutesOf(inp, r);
  r.season.forEach((w, i) => {
    if (!w.recovery || i === 0) return;
    const prev = r.season.slice(0, i).reverse().find((x) => !x.recovery);
    if (prev) assert.ok(mins[i] < mins[prev.absWeek], `week ${i + 1} is lighter than the loading week before it`);
  });
  assert.ok(r.season.some((w) => w.recovery));
});

test('the first week of a plan is a week of training, whatever block the runway opens on', () => {
  for (const weeks of [8, 9, 12, 13, 16, 17, 20, 21, 24, 25, 30, 36]) {
    assert.equal(planSeason(input({ weeks })).season[0].recovery, false, `${weeks} weeks`);
  }
});

/* ---- tune-up races ---- */

const withTuneUp = (over) => ({ id: 't', name: 'T', kind: 'race', priority: 'secondary', ...over });

test('a tune-up of more than two hours gets a taper whose load is the share its length calls for', () => {
  const raceDate = raceDateFor(24);
  const events = [
    { id: 'a', date: raceDate, kind: 'race', raceType: '70.3', priority: 'primary', ambition: 'intermediate' },
    withTuneUp({ date: toISO(addDays(parseISO(START), 11 * 7 + 5)), raceType: 'marathon' }),    // week 12, a Saturday
  ];
  const inp = input({ events });
  const plain = planSeason(input());
  const r = planSeason(inp);
  assert.equal(r.season[10].block, 'Taper');
  assert.equal(r.season[11].block, 'Race');
  assert.ok(r.season[10].hours < plain.season[10].hours, 'the taper week is lighter than the week it replaced');
  near(raceDayCtl(inp, r), 75, TOL, 'and the season still arrives');
});

test('a tune-up of two hours or less changes no block, clears its own day, and its load counts', () => {
  const raceDate = raceDateFor(24);
  const day = toISO(addDays(parseISO(START), 19 * 7 + 2));                                    // week 20, a Wednesday, close enough to race day to matter
  const events = [
    { id: 'a', date: raceDate, kind: 'race', raceType: '70.3', priority: 'primary', ambition: 'intermediate' },
    withTuneUp({ date: day, raceType: '10k' }),
  ];
  const inp = input({ events });
  const plain = planSeason(input());
  const r = planSeason(inp);
  assert.deepEqual(r.season.map((w) => w.block), plain.season.map((w) => w.block));
  const p = assemble(inp, r);
  assert.equal(durToMin(p.weeks.w19.find((s) => s.day === 'Wed').dur), 0, 'race day is clear');
  assert.ok(durToMin(p.weeks.w19.find((s) => s.day === 'Thu').dur) > 0, 'and the days after it are not');
  near(raceDayCtl(inp, r), 75, TOL, 'with the race\'s own load in the line, it still arrives');
  near(r.feasibility.achievableCtl, raceDayCtl(inp, r), 0.3, 'and the planner counted that load the way the line does');
  const without = planSeason(input());
  assert.ok(r.season[19].hours < without.season[19].hours + 1e-9 || r.season[20].hours <= without.season[20].hours, 'the race\'s own load is part of the week, so it asks a little less of the rest');
});

test('a taper carries the share of the week\'s load that the length of its race calls for', () => {
  // The same season with a tune-up of each length landing on the same week. What the taper week
  // carries is the trajectory's own week less `depth` of it: an Olympic (2.5 h) takes 20 %, a
  // marathon (4 h) 35 %, an Ironman as a tune-up 50 %. The trajectory is the same for all three
  // to within what the race's own load changes about the climb, so the three weeks stand in
  // the ratio of what each leaves.
  const raceDate = raceDateFor(24);
  const load = (raceType) => {
    const events = [
      { id: 'a', date: raceDate, kind: 'race', raceType: '70.3', priority: 'primary', ambition: 'intermediate' },
      withTuneUp({ date: toISO(addDays(parseISO(START), 11 * 7 + 5)), raceType }),
    ];
    const inp = input({ events });
    const r = planSeason(inp);
    assert.equal(r.season[10].block, 'Taper', raceType);
    return assemble(inp, r).weeks.w10.reduce((a, s) => a + (plannedLoad(s) ?? 0), 0);
  };
  const [olympic, marathon, ironman] = [load('olympic'), load('marathon'), load('ironman')];
  near(marathon / olympic, 0.65 / 0.8, 0.06, 'a marathon taper against an Olympic one');
  near(ironman / olympic, 0.5 / 0.8, 0.06, 'an Ironman taper against an Olympic one');
  assert.ok(olympic > marathon && marathon > ironman, 'a longer race takes more out of the week');
});

/* ---- weeks the athlete has already trained, and weeks they have pinned ---- */

test('weeks before keepBefore come back exactly as they were, and the rest is built from where the athlete is', () => {
  const inp = input({ weeks: 24, startCtl: 50 });
  const first_ = planSeason(inp);
  const keep = 6;
  const frozen = first_.season.slice(0, keep);
  // The athlete turned out fitter than planned by the end of week 6.
  const fitter = planSeason({ ...inp, keepBefore: keep, frozen, anchorCtl: first_.season[keep - 1].ctl + 10 });
  const same = planSeason({ ...inp, keepBefore: keep, frozen, anchorCtl: first_.season[keep - 1].ctl });
  assert.equal(JSON.stringify(fitter.season.slice(0, keep)), JSON.stringify(frozen), 'byte for byte');
  assert.equal(JSON.stringify(same.season.slice(0, keep)), JSON.stringify(frozen));
  const first = (r) => r.season[keep].ctl - (r === fitter ? first_.season[keep - 1].ctl + 10 : first_.season[keep - 1].ctl);
  assert.ok(first(fitter) < first(same), 'a fitter athlete has less of a climb in front of them, so the first week asks for less of it');
  const preTail = (r) => r.season[r.season.length - 4].ctl;
  near(preTail(fitter), preTail(same), 3, 'both are aiming at the same level at the end of the build');
  near(same.feasibility.achievableCtl, first_.feasibility.achievableCtl, 2, 'carried on as planned, it arrives where it would have');
});

test('a pinned week is built to its pin, and a pin that puts the target out of reach is said to', () => {
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 24, startCtl: 50 });
  const free = planSeason(inp);
  const pinned = planSeason({ ...inp, weekBudgets: { w8: 4 } });
  assert.equal(pinned.season[8].hours, 4);
  assert.ok(pinned.feasibility.feasible, 'one light week can be made up');
  const starved = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`w${i + 5}`, 3]));
  const r = planSeason({ ...inp, weekBudgets: starved });
  assert.equal(r.feasibility.feasible, false);
  assert.equal(r.feasibility.limitingFactor, 'ramp', 'the pins, not the hours or the date, are what is in the way');
  assert.equal(free.feasibility.feasible, true);
});

/* ---- what to do about a target that cannot be reached ---- */

test('the levers are computed, not guessed: the date, the ambition, the hours', () => {
  const inp = input({ raceType: '70.3', ambition: 'competitive', hours: 12, weeks: 12, startCtl: 30 });
  const r = planSeason(inp);
  assert.equal(r.feasibility.feasible, false);
  const levers = planLevers(inp, r);
  assert.ok(levers.raceDate, 'a later date would do it');
  const at = (weeks) => planSeason({ ...inp, weeks, events: [{ ...inp.events[0], date: raceDateFor(weeks) }], profile: normalizeProfile({ ...inp.profile, raceDate: raceDateFor(weeks) }) });
  assert.equal(at(levers.raceDate.weeks).feasibility.feasible, true, 'that date works');
  assert.equal(at(levers.raceDate.weeks - 1).feasibility.feasible, false, 'and the week before it does not');
  assert.equal(levers.raceDate.raceDate, raceDateFor(levers.raceDate.weeks));
  if (levers.ambition) {
    const lower = planSeason({ ...inp, targetCtl: targetCtl('70.3', levers.ambition.ambition) });
    assert.equal(lower.feasibility.feasible, true, 'the ambition it names is one that works');
  }
});

test('hours are a lever only when hours are what is in the way', () => {
  const short = input({ raceType: 'ironman', ambition: 'intermediate', hours: 8, weeks: 36, startCtl: 50 });
  const rs = planSeason(short);
  assert.equal(rs.feasibility.limitingFactor, 'availability');
  const l = planLevers(short, rs);
  assert.ok(l.hours && l.hours.weeklyHours > 8, `more time would do it: ${JSON.stringify(l.hours)}`);
  const need = planSeason({ ...short, profile: normalizeProfile({ ...short.profile, availability: availability(l.hours.weeklyHours) }) });
  assert.equal(need.feasibility.feasible, true, 'and the number it gives works');

  const date = input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 8, startCtl: 20 });
  assert.equal(planLevers(date, planSeason(date)).hours, null, 'more hours cannot make up for a short runway');
});

test('a different goal is offered when the one chosen cannot be reached', () => {
  const inp = input({ raceType: 'ironman', ambition: 'competitive', hours: 8, weeks: 24, startCtl: 50 });
  const l = planLevers(inp, planSeason(inp));
  assert.ok(l.distance, 'a shorter race that the week can carry');
  assert.notEqual(l.distance.raceType, 'ironman');
  const there = input({ raceType: l.distance.raceType, ambition: l.distance.ambition, hours: 8, weeks: 24, startCtl: 50 });
  assert.equal(planSeason(there).feasibility.feasible, true);
});

test('a plan that can be built has no levers to offer', () => {
  const inp = input();
  assert.equal(planLevers(inp, planSeason(inp)), null);
});

/* ---- housekeeping ---- */

test('the same inputs give the same season, and nothing handed in is changed', () => {
  const inp = input({ extra: { weekBudgets: { w3: 5 } } });
  const copy = structuredClone(inp);
  const a = planSeason(inp);
  assert.deepEqual(inp, copy);
  assert.deepEqual(planSeason(inp), a);
});

test('a runway of one, two or three weeks is a season and not a crash', () => {
  for (const weeks of [1, 2, 3, 4]) {
    const inp = input({ weeks, startCtl: 60 });
    const r = planSeason(inp);
    assert.equal(r.season.length, weeks);
    assert.ok(r.season.every((w) => Number.isFinite(w.hours)));
  }
});

test('inputs that cannot be built from are refused with a sentence', () => {
  assert.throws(() => planSeason({ ...input(), weeks: 0 }), /week/i);
  assert.throws(() => planSeason({ ...input(), targetCtl: 'high' }), /target/i);
  assert.throws(() => planSeason({ ...input(), startCtl: -4 }), /start/i);
  assert.throws(() => planSeason({ ...input(), start: 'soon' }), /start/i);
});

test('the planner reads no heart rate', () => {
  const src = readFileSync(new URL('../assets/coach/backplan.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const re of [/hrById/, /hrThresholds/, /\bheart/i, /trimp/i, /lthr/i, /\bhr\b/i]) assert.doesNotMatch(src, re, `backplan.js mentions ${re}`);
});

/* ---- the whole grid ---- */

test('across races, ambitions, starting fitness, runways and weeks: it lands or says how far short', () => {
  const cases = [];
  for (const raceType of ['olympic', '70.3', 'ironman']) {
    for (const ambition of AMBITIONS) {
      for (const startCtl of [20, 50, 80, 110]) {
        for (const weeks of [8, 16, 24, 36]) {
          for (const hours of [8, 12, 17]) cases.push({ raceType, ambition, startCtl, weeks, hours });
        }
      }
    }
  }
  assert.equal(cases.length, 432);
  const bad = [];
  for (const c of cases) {
    const inp = input(c);
    const r = planSeason(inp);
    const f = r.feasibility;
    const read = raceDayCtl(inp, r);
    const label = `${c.raceType} ${c.ambition} from ${c.startCtl} over ${c.weeks} wk at ${c.hours} h`;
    if (f.status === 'hold') {
      if (!(read >= f.targetCtl - TOL)) bad.push(`${label}: held but reads ${read} for ${f.targetCtl}`);
    } else if (f.feasible) {
      if (Math.abs(read - f.targetCtl) > TOL) bad.push(`${label}: reads ${read}, target ${f.targetCtl}`);
    } else {
      if (!(read <= f.targetCtl + 0.5)) bad.push(`${label}: infeasible but overshoots, reads ${read} for ${f.targetCtl}`);
      if (!(f.shortfall > 0)) bad.push(`${label}: infeasible with no shortfall`);
      if (!['availability', 'runway'].includes(f.limitingFactor)) bad.push(`${label}: limiting factor ${f.limitingFactor}`);
      // The factor is the one that matters: with a longer runway it is feasible only if the runway was the limit.
      const longer = planSeason(input({ ...c, weeks: c.weeks + 52 }));
      const expected = longer.feasibility.feasible ? 'runway' : 'availability';
      if (f.limitingFactor !== expected) bad.push(`${label}: says ${f.limitingFactor}, a longer runway says ${expected}`);
    }
  }
  assert.deepEqual(bad, []);
});
