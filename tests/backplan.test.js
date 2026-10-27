import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { planSeason, weeklyLoadFor, planLevers } from '../assets/coach/backplan.js';
import { PLAN_MODEL, targetCtl } from '../assets/coach/targets.js';
import { AMBITIONS, normalizeEvents } from '../assets/coach/events.js';
import { fitnessSeries, plannedLoad, carry, PLANNED } from '../assets/coach/fitness.js';
import { generateWeek } from '../assets/coach/generate.js';
import { raceClosure, plannedRaceLoads } from '../assets/coach/races.js';
import { dateOf } from '../assets/coach/calendar.js';
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

/* The planned fitness and fatigue of every day of the season, stepped by the
   chart's own `carry`. Fatigue starts where fitness does: the athlete is taken to
   have been training at a steady level. The race the season is for is in the
   line, as it is on the chart, and so is any tune-up's own load. */
function dailyLine(inp, result) {
  const p = assemble(inp, result);
  const byDate = { ...plannedRaceLoads(p, result.season.length) };
  for (const w of result.season) {
    for (const s of p.weeks[`w${w.absWeek}`]) {
      const iso = dateOf(inp.start, w.absWeek, s.day);
      byDate[iso] = (byDate[iso] ?? 0) + (plannedLoad(s) ?? 0);
    }
  }
  const out = [];
  const dayBefore = toISO(addDays(parseISO(inp.start), -1));
  carry({ fit: inp.startCtl, fat: inp.startCtl }, dayBefore, inp.profile.raceDate, (iso) => byDate[iso] ?? 0,
    (iso, s) => out.push({ iso, fit: s.fit, fat: s.fat }));
  return out;
}
const peakOf = (line) => Math.max(...line.map((d) => d.fit));
// Acute over chronic on its worst day. Against a chronic load smaller than the week a season opens on
// the ratio means nothing, so it is measured against that week's load.
const CHRONIC_FLOOR = (PLAN_MODEL.ramp.minWeekMinutes / 60) * (PLAN_MODEL.estimate.loadPerHour / 7);
const acuteRatioOf = (line) => Math.max(...line.map((d) => d.fat / Math.max(d.fit, CHRONIC_FLOOR)));
const peakCtl = (inp, result) => peakOf(dailyLine(inp, result));
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

test('a 70.3 built for the middle of its band peaks there, through the fitness line the chart draws', () => {
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 24, startCtl: 50 });
  const r = planSeason(inp);
  assert.equal(r.feasibility.feasible, true);
  assert.equal(r.feasibility.targetCtl, 75);
  assert.equal(r.feasibility.at, 'peak', 'the record says what the number is');
  near(peakCtl(inp, r), 75, TOL, 'peak fitness');
  near(r.feasibility.achievableCtl, peakCtl(inp, r), 0.6, 'what it says it reaches is what the line reads');
  near(r.feasibility.raceCtl, raceDayCtl(inp, r), 0.6, 'and what it says race day is');
});

test('17 hours: a 70.3 is built to peak at 90, not to whatever the hours would allow', () => {
  const inp = input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 24, startCtl: 50 });
  const r = planSeason(inp);
  near(peakCtl(inp, r), 90, TOL, '70.3 competitive');
  assert.ok(Math.max(...r.season.map((w) => w.hours)) < 17, 'and it does not spend the whole week to get there');
});

test('17 hours: an Ironman built for the top of its band peaks there', () => {
  const inp = input({ raceType: 'ironman', ambition: 'competitive', hours: 17, weeks: 36, startCtl: 50 });
  const r = planSeason(inp);
  assert.equal(r.feasibility.feasible, true);
  near(peakCtl(inp, r), 115, TOL, 'ironman competitive');
});

/* ---- the target is the peak before the taper, and a ceiling ---- */

test('a competitive 70.3 never rises above the top of its band, on any day, whatever the runway, the week or the start', () => {
  const hi = targetCtl('70.3', 'competitive');
  assert.equal(hi, 90);
  const bad = [];
  for (const weeks of [16, 24, 40, 56]) {
    for (const hours of [10, 12, 17]) {
      for (const startCtl of [30, 53, 80]) {
        const inp = input({ raceType: '70.3', ambition: 'competitive', hours, weeks, startCtl });
        const r = planSeason(inp);
        const peak = peakCtl(inp, r);
        const label = `${weeks} wk, ${hours} h, from ${startCtl}`;
        if (peak > hi + 1e-6) bad.push(`${label}: peaks at ${peak.toFixed(1)}`);
        if (r.feasibility.feasible && r.feasibility.status === 'build' && peak < hi - TOL) bad.push(`${label}: feasible but peaks at ${peak.toFixed(1)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

/* Race day is read the morning of it, as the chart reads it: the end of the day before. The race
   adds no load, so the end of its own day would count a rest day that is not one. */
const raceMorning = (line) => line[line.length - 2];
const weekLoads = (inp, result) => {
  const p = assemble(inp, result);
  return result.season.map((w) => p.weeks[`w${w.absWeek}`].reduce((a, s) => a + (plannedLoad(s) ?? 0), 0));
};

test('race morning is what a two-week taper leaves of the peak: a little lower, form up, and only the last two weeks come down', () => {
  const inp = input({ raceType: '70.3', ambition: 'competitive', hours: 12, weeks: 40, startCtl: 53 });
  const r = planSeason(inp);
  const line = dailyLine(inp, r);
  const peak = peakOf(line);
  const morning = raceMorning(line);
  const N = r.season.length;
  assert.ok(morning.fit / peak > 0.87 && morning.fit / peak < 0.96,
    `two weeks of taper take under a tenth off, not a fifth: ${(morning.fit / peak).toFixed(2)}`);
  const atPeak = line.find((d) => d.fit === peak);
  assert.ok(morning.fat < atPeak.fat * 0.8, `fatigue falls by a fifth or more: ${atPeak.fat.toFixed(0)} → ${morning.fat.toFixed(0)}`);
  const form = morning.fit - morning.fat;
  assert.ok(form >= PLANNED.raceForm.low && form <= PLANNED.raceForm.high, `race-morning form ${form.toFixed(1)} is in the usual range`);
  const ctl = r.season.map((w) => w.ctl);
  assert.ok(ctl[N - 3] >= Math.max(...ctl) - 0.5, `the peak is the end of the last loading week, the first of the Peak block: ${ctl.slice(-4)}`);
  assert.ok(ctl[N - 2] < ctl[N - 3] && ctl[N - 1] < ctl[N - 2], `fitness comes down only in the last two weeks: ${ctl.slice(-4)}`);
  assert.ok(ctl[N - 3] > ctl[N - 4], `and the week before the taper is not a fourth easy week in a row: ${ctl.slice(-4)}`);
});

test('the taper cuts the load of the last two weeks, never adds time, and the week before them is a loading week', () => {
  const inp = input({ raceType: '70.3', ambition: 'competitive', hours: 12, weeks: 40, startCtl: 53 });
  const r = planSeason(inp);
  const N = r.season.length;
  const load = weekLoads(inp, r);
  const mins = minutesOf(inp, r);
  const last = load[N - 3];
  assert.ok(load[N - 2] < last * 0.9 && load[N - 2] > last * 0.55, `the week before race week carries most of a loading week: ${(load[N - 2] / last).toFixed(2)}`);
  assert.ok(load[N - 1] < last * 0.5, `race week carries under half: ${(load[N - 1] / last).toFixed(2)}`);
  assert.ok(mins[N - 2] <= mins[N - 3] && mins[N - 1] <= mins[N - 2], `no taper week has more time than the one before: ${mins.slice(-3)}`);
  assert.ok(load[N - 3] >= load[N - 5] * 0.9, 'the first Peak week is sized as a loading week, not as the first step down');
});

test('a taper that costs fitness a tenth leaves a competitive build one it can arrive with, over runways, weeks and starts', () => {
  const bad = [];
  for (const [raceType, ambition] of [['70.3', 'competitive'], ['70.3', 'intermediate'], ['ironman', 'intermediate']]) {
    for (const weeks of [24, 40]) {
      for (const hours of [12, 17]) {
        const inp = input({ raceType, ambition, hours, weeks, startCtl: 50 });
        const r = planSeason(inp);
        if (!r.feasibility.feasible) continue;
        const line = dailyLine(inp, r);
        const peak = peakOf(line);
        const morning = raceMorning(line);
        const label = `${raceType} ${ambition}, ${weeks} wk, ${hours} h`;
        const ratio = morning.fit / peak;
        if (ratio < 0.85 || ratio > 0.97) bad.push(`${label}: arrives at ${(ratio * 100).toFixed(0)} % of the peak`);
        const form = morning.fit - morning.fat;
        if (form < PLANNED.raceForm.low || form > PLANNED.raceForm.high + 3) bad.push(`${label}: race-morning form ${form.toFixed(1)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('the taper is not paid for earlier: the climb stops at the target, it does not overshoot to arrive on it', () => {
  // Built the other way (race day on target) this season peaked near 107 for a target of 90.
  const inp = input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 24, startCtl: 50 });
  const before = Math.max(...planSeason({ ...inp, targetAt: 'raceDay' }).season.map((w) => w.ctl));
  const after = Math.max(...planSeason(inp).season.map((w) => w.ctl));
  assert.ok(before > 100, `race-day mode peaks at ${before}`);
  assert.ok(after <= 90 + 1e-6, `peak mode peaks at ${after}`);
});

test('targetAt: raceDay is the old solve, unchanged: race day lands on the target and the season is what it was', () => {
  const mid = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 24, startCtl: 50, extra: { targetAt: 'raceDay' } });
  const rMid = planSeason(mid);
  near(raceDayCtl(mid, rMid), 75, TOL, 'race-day fitness');
  assert.deepEqual(rMid.season.map((w) => w.hours),
    [7, 7.667, 8.417, 9.25, 6.5, 10.167, 11.167, 12.083, 8.417, 12.083, 12.083, 12.083, 8.417, 9.25, 9.083, 7.917, 5.583, 8.667, 8.583, 8.5, 6, 7.5, 6, 4.75]);
  assert.deepEqual(rMid.season.map((w) => w.ctl),
    [49.7, 50.1, 51.2, 53.1, 51.7, 54.4, 57.5, 61.3, 60.7, 64.1, 66.9, 69.4, 67.5, 74.4, 80, 82.4, 80.2, 84, 87.1, 89.5, 86.9, 85.4, 81.7, 75.1]);
  assert.deepEqual(rMid.feasibility, { feasible: true, status: 'build', targetCtl: 75, achievableCtl: 75.1, shortfall: 0, limitingFactor: null });

  const top = input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 24, startCtl: 50, extra: { targetAt: 'raceDay' } });
  const rTop = planSeason(top);
  assert.deepEqual(rTop.season.map((w) => w.hours),
    [7, 7.667, 8.417, 9.25, 6.583, 10.167, 11.167, 12.25, 8.833, 13.417, 14.75, 16.167, 11.333, 10.167, 10.75, 9.75, 6.917, 10.667, 10, 10.333, 7.333, 9.083, 7.25, 5.75]);
  assert.deepEqual(rTop.season.map((w) => w.ctl),
    [49.6, 50, 51.2, 53, 51.7, 54.5, 57.7, 62, 61.8, 66.3, 71.9, 78.1, 78.1, 85.1, 92, 96.1, 94.1, 99.5, 102.9, 106.4, 103.6, 102, 97.7, 90]);
});

test('a targetAt that is neither is refused with a sentence', () => {
  assert.throws(() => planSeason({ ...input(), targetAt: 'sometime' }), /targetAt|peak|race day/i);
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

test('8 hours cannot be built to the middle or the top of the Ironman range, and the plan says so plainly', () => {
  for (const ambition of ['intermediate', 'competitive']) {
    const inp = input({ raceType: 'ironman', ambition, hours: 8, weeks: 24, startCtl: 50 });
    const r = planSeason(inp);
    const f = r.feasibility;
    assert.equal(f.feasible, false, ambition);
    assert.equal(f.limitingFactor, 'availability', `${ambition}: more weeks would not help`);
    assert.ok(f.achievableCtl < f.targetCtl - TOL, ambition);
    assert.ok(f.shortfall > 0 && Math.abs(f.shortfall - (f.targetCtl - f.achievableCtl)) < 0.2, ambition);
    near(peakCtl(inp, r), f.achievableCtl, 1, `${ambition}: it builds the best it can and reads back what it said`);
  }
});

test('8 hours can be built to the low end of the Ironman range as a peak: it was out of reach only when race day had to be there', () => {
  // Aimed at race day, 80 asked for a peak near 97, which 8 hours could not carry.
  const inp = input({ raceType: 'ironman', ambition: 'finish', hours: 8, weeks: 24, startCtl: 50 });
  const r = planSeason(inp);
  assert.equal(r.feasibility.feasible, true);
  near(peakCtl(inp, r), 80, TOL, 'peak fitness');
  assert.ok(raceDayCtl(inp, r) < peakCtl(inp, r) - 8, 'and race day, after the taper, is lower');
});

test('an infeasible plan never overshoots the target', () => {
  const inp = input({ raceType: 'ironman', ambition: 'finish', hours: 8, weeks: 24 });
  assert.ok(peakCtl(inp, planSeason(inp)) <= targetCtl('ironman', 'finish') + 1e-6);
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

test('acute load is held to its ceiling over chronic load on every day, and a climb that would break that is not made', () => {
  assert.equal(PLAN_MODEL.ramp.acuteRatioMax, 1.5);
  const bad = [];
  for (const [raceType, ambition, hours, weeks, startCtl] of [
    ['70.3', 'competitive', 17, 20, 30], ['70.3', 'competitive', 17, 24, 53], ['70.3', 'competitive', 12, 24, 53],
    ['ironman', 'competitive', 17, 24, 50], ['olympic', 'competitive', 12, 16, 20], ['70.3', 'intermediate', 12, 16, 25],
  ]) {
    const inp = input({ raceType, ambition, hours, weeks, startCtl });
    const r = planSeason(inp);
    const ratio = acuteRatioOf(dailyLine(inp, r));
    const label = `${raceType} ${ambition} ${hours} h ${weeks} wk from ${startCtl}`;
    if (ratio > PLAN_MODEL.ramp.acuteRatioMax + 1e-6) bad.push(`${label}: ${ratio.toFixed(2)}`);
    // Held back is not hidden: a season the ceiling stops short of its target says how far.
    if (!r.feasibility.feasible) assert.ok(r.feasibility.shortfall > 0, label);
  }
  assert.deepEqual(bad, []);
});

test('a week the athlete pinned does not make the weeks after it empty, even when it breaks the ceiling', () => {
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 24, startCtl: 50 });
  const free = planSeason(inp);
  const pinned = planSeason({ ...inp, weekBudgets: { w8: 12 } });     // a very big week, whatever the ratio says
  assert.equal(pinned.season[8].hours, 12);
  assert.ok(pinned.season[9].hours > 0 && pinned.season[10].hours > 0, `the weeks after it are weeks of training: ${pinned.season.slice(8, 12).map((w) => w.hours)}`);
  assert.ok(pinned.season[10].hours >= free.season[10].hours * 0.5, 'and not a fraction of what they would have been');
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
  // A gap of 40 over about 39 loading weeks is a climb of about a point a week. A smaller gap is below
  // `ramp.floor`, and the athlete then holds where they are until it is time to start (the next test).
  const inp = input({ raceType: '70.3', ambition: 'competitive', hours: 12, weeks: 52, startCtl: 48 });
  const r = planSeason(inp);
  const early = r.season.slice(0, 16);
  let prev = 48;
  for (const w of early) {
    assert.ok(w.ctl - prev < 4, `week ${w.absWeek + 1} rises ${w.ctl - prev}: nothing like the top of the ramp`);
    prev = w.ctl;
  }
  assert.ok(early.some((w) => w.recovery), 'with a recovery week among them');
  const cycles = [0, 1, 2].map((c) => early.slice(c * 4, c * 4 + 4).map((w) => w.hours));
  assert.notDeepEqual(cycles[0], cycles[1], 'four weeks and the same four again is what padding with Prep used to be');
  assert.notDeepEqual(cycles[1], cycles[2]);
  near(peakCtl(inp, r), 90, TOL, 'and it still peaks where it should');
});

test('where the gap to climb is tiny, the athlete holds until it is time to start', () => {
  const inp = input({ raceType: '70.3', ambition: 'finish', hours: 12, weeks: 52, startCtl: 56 });  // a peak of 60 is four points off
  const r = planSeason(inp);
  const early = r.season.slice(0, 20).map((w) => w.ctl);
  assert.ok(Math.max(...early) - Math.min(...early) < 8, `held: ${early}`);
  near(peakCtl(inp, r), 60, TOL, 'and it peaks where it should');
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

test('the first week is held to a tenth above what the athlete trains now', () => {
  // From a fitness of 20 an ordinary hour's load is about 2.5 hours a week, so with the
  // three-hour floor the first week is at most 3.3: the season does not open on seven.
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 30, startCtl: 20 });
  const r = planSeason(inp);
  assert.ok(r.season[0].hours <= 3.3 + 1e-9, `week 1 is ${r.season[0].hours} h`);
  assert.ok(r.season[0].hours >= 2.5, 'and it is not less than they do now');
  const fitter = planSeason(input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 30, startCtl: 60 }));
  assert.ok(fitter.season[0].hours > r.season[0].hours, 'a fitter athlete opens on more');
  assert.ok(fitter.season[0].hours <= 60 * 7 * 60 / PLAN_MODEL.estimate.loadPerHour / 60 * 1.1 + 0.1);
});

test('a caller that knows what the athlete trains now can say so', () => {
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 30, startCtl: 20 });
  const big = planSeason({ ...inp, baselineMinutes: 600 });                      // ten hours a week, at a low fitness
  assert.ok(big.season[0].hours > planSeason(inp).season[0].hours);
  assert.ok(big.season[0].hours <= 11 + 1e-9);
});

test('nobody is given a week of nothing to open on', () => {
  const r = planSeason(input({ startCtl: 0, weeks: 30 }));
  assert.ok(r.season[0].hours >= PLAN_MODEL.ramp.minWeekMinutes / 60 - 0.01);
});

test('a runway too short to build safely from where the athlete is says so, and a longer one would do', () => {
  const short = input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 16, startCtl: 20 });
  const f = planSeason(short).feasibility;
  assert.equal(f.feasible, false);
  assert.equal(f.limitingFactor, 'runway');
  assert.equal(planSeason(input({ raceType: '70.3', ambition: 'competitive', hours: 17, weeks: 52, startCtl: 20 })).feasibility.feasible, true);
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
  near(peakCtl(inp, r), 75, TOL, 'and the season still peaks where it should');
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
  near(peakCtl(inp, r), 75, TOL, 'with the race\'s own load in the line, it still peaks where it should');
  near(r.feasibility.achievableCtl, peakCtl(inp, r), 0.6, 'and the planner counted that load the way the line does');
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

test('a week pinned down to a recovery week\'s size is one, and the weeks after it come back to where they were', () => {
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 24, startCtl: 50 });
  const free = planSeason(inp);
  const light = planSeason({ ...inp, weekBudgets: { w10: 3 } });
  assert.equal(light.season[10].hours, 3);
  assert.equal(light.season[10].recovery, true, 'a pinned light week is an easy week');
  assert.ok(light.season[11].hours >= free.season[11].hours - 1, 'the next week is not held to ten per cent above the pin');
  assert.equal(light.feasibility.feasible, true);
  const p = assemble(inp, light);
  const issues = validateSeason(light.season.map((w) => ({ ...w, sessions: p.weeks[`w${w.absWeek}`] })), { profile: inp.profile });
  assert.deepEqual(issues.map((i) => i.code), [], 'and the validator has nothing to say about it');
});

test('a pinned week bigger than that is a loading week like any other', () => {
  const inp = input({ raceType: '70.3', ambition: 'intermediate', hours: 12, weeks: 24, startCtl: 50 });
  const heavy = planSeason({ ...inp, weekBudgets: { w10: 11 } });
  assert.equal(heavy.season[10].hours, 11);
  assert.equal(heavy.season[10].recovery, false);
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

test('across races, ambitions, starting fitness, runways and weeks: it peaks on target or says how far short', () => {
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
    const line = dailyLine(inp, r);
    const read = peakOf(line);
    const label = `${c.raceType} ${c.ambition} from ${c.startCtl} over ${c.weeks} wk at ${c.hours} h`;
    if (f.status === 'hold') {
      if (!(read >= f.targetCtl - TOL)) bad.push(`${label}: held but peaks at ${read.toFixed(1)} for ${f.targetCtl}`);
    } else if (f.feasible) {
      if (Math.abs(read - f.targetCtl) > TOL) bad.push(`${label}: peaks at ${read.toFixed(1)}, target ${f.targetCtl}`);
      if (read > f.targetCtl + 1e-6) bad.push(`${label}: rises above its target, to ${read.toFixed(1)} for ${f.targetCtl}`);
    } else {
      if (!(read <= f.targetCtl + 1e-6)) bad.push(`${label}: infeasible but overshoots, peaks at ${read.toFixed(1)} for ${f.targetCtl}`);
      if (!(f.shortfall > 0)) bad.push(`${label}: infeasible with no shortfall`);
      if (!['availability', 'runway'].includes(f.limitingFactor)) bad.push(`${label}: limiting factor ${f.limitingFactor}`);
      // The factor is the one that matters: with a longer runway it is feasible only if the runway was the limit.
      const longer = planSeason(input({ ...c, weeks: c.weeks + 52 }));
      const expected = longer.feasibility.feasible ? 'runway' : 'availability';
      if (f.limitingFactor !== expected) bad.push(`${label}: says ${f.limitingFactor}, a longer runway says ${expected}`);
    }
    // Whatever else it does, it never asks the acute load to run past the ceiling over the chronic.
    const ratio = acuteRatioOf(line);
    if (ratio > PLAN_MODEL.ramp.acuteRatioMax + 1e-6) bad.push(`${label}: acute load reaches ${ratio.toFixed(2)} times chronic`);
  }
  assert.deepEqual(bad, []);
});
