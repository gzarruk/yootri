import test from 'node:test';
import assert from 'node:assert/strict';

import { planSeason } from '../assets/coach/backplan.js';
import { targetCtl } from '../assets/coach/targets.js';
import { normalizeProfile } from '../assets/coach/profile.js';
import { isTaperBlock } from '../assets/coach/season.js';
import { addDays, parseISO, toISO } from '../assets/coach/dates.js';

/* The planner builds a season along an even climb from where the athlete is to the
   target. A week the athlete pins is fixed, and a pin above that climb leaves fitness
   ahead of it. The weeks after it must not be starved to bring fitness back to a line it
   has already passed: the climb is re-based on where fitness actually is, and what is
   planned does not lose fitness — outside recovery weeks, the first weeks of a season, and
   the weeks before the race. */

const START = '2026-11-02';
const BASE_WEEK = { Mon: 0, Tue: 120, Wed: 120, Thu: 120, Fri: 120, Sat: 240, Sun: 360 };
const raceDateFor = (weeks) => toISO(addDays(parseISO(START), (weeks - 1) * 7 + 5));

function input({ weeks = 57, startCtl = 42.4, ambition = 'intermediate', extra = {} } = {}) {
  const raceDate = raceDateFor(weeks);
  return {
    start: START,
    weeks,
    profile: normalizeProfile({ availability: BASE_WEEK, raceType: '70.3', raceDate }),
    events: [{ id: 'a', name: 'A', date: raceDate, kind: 'race', raceType: '70.3', priority: 'primary', ambition }],
    startCtl,
    targetCtl: targetCtl('70.3', ambition),
    ...extra,
  };
}

/** Eight hours a week for twelve weeks, an easy week every fourth: what a plan the athlete
    has been editing for a while can look like. */
const twelvePinned = () => Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [`w${i}`, i % 4 === 3 ? 5.5 : 8]));

/** The weeks that are the build: past the pins, before the taper at the end of the season. */
const buildWeeks = (r, from) => r.season.filter((w) => w.absWeek >= from && !isTaperBlock(w.block) && w.block !== 'Race');

test('weeks after a run of big pinned weeks are not starved to bring fitness back to the line', () => {
  const inp = input();
  const free = planSeason(inp);
  const r = planSeason({ ...inp, weekBudgets: twelvePinned() });
  assert.equal(r.season[0].hours, 8, 'the pins are honoured');
  const after = buildWeeks(r, 12).filter((w) => !w.recovery);
  const smallest = Math.min(...after.map((w) => w.hours));
  // The pins were 8 h; nothing after them, in a loading week, falls to a fraction of that.
  assert.ok(smallest >= 4, `the smallest loading week after the pins is ${smallest} h`);
  const freeAfter = buildWeeks(free, 12).filter((w) => !w.recovery);
  assert.ok(after[0].hours >= freeAfter[0].hours * 0.8, `week 13 is ${after[0].hours} h; unpinned it is ${freeAfter[0].hours} h`);
});

test('a plan that has been pinned ahead of the climb does not plan a systematic loss of fitness', () => {
  const r = planSeason({ ...input(), weekBudgets: twelvePinned() });
  const level = r.season[11].ctl;                      // where the pins leave the athlete
  const build = buildWeeks(r, 12);
  const lowest = Math.min(...build.map((w) => w.ctl));
  // Easy weeks give a point or two back; nothing after the pins gives back more than that.
  assert.ok(lowest >= level - 4, `fitness is ${level} after the pins and falls to ${lowest}`);
  // And it does not spend weeks in a row falling.
  let falling = 0;
  for (let i = 1; i < build.length; i++) {
    falling = !build[i].recovery && !build[i - 1].recovery && build[i].ctl < build[i - 1].ctl - 0.05 ? falling + 1 : 0;
    assert.ok(falling < 2, `fitness falls through weeks ${build[i - 1].absWeek + 1} to ${build[i].absWeek + 1}`);
  }
});

test('the season still reaches its target after the pins, and says so', () => {
  const r = planSeason({ ...input(), weekBudgets: twelvePinned() });
  assert.equal(r.feasibility.feasible, true);
  const peak = Math.max(...r.season.map((w) => w.ctl));
  assert.ok(peak >= r.feasibility.targetCtl - 1, `peaks at ${peak} against a target of ${r.feasibility.targetCtl}`);
  assert.ok(peak <= r.feasibility.targetCtl + 0.5, 'and not above it');
});

test('fewer pins, or lighter ones, leave the weeks after them as they were', () => {
  const inp = input();
  for (const pins of [{ w5: 6 }, { w0: 7, w1: 7 }, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, 6]))]) {
    const free = planSeason(inp);
    const r = planSeason({ ...inp, weekBudgets: pins });
    const lastPin = Math.max(...Object.keys(pins).map((k) => Number(k.slice(1))));
    const next = lastPin + 1;
    assert.ok(r.season[next].hours >= free.season[next].hours * 0.7, `${JSON.stringify(pins).slice(0, 40)}: week ${next + 1} is ${r.season[next].hours} h against ${free.season[next].hours} h`);
  }
});

test('a pin that takes fitness past the target is held there, not unwound', () => {
  const inp = input({ startCtl: 70 });
  const r = planSeason({ ...inp, weekBudgets: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`w${i}`, 12])) });
  const build = buildWeeks(r, 8).filter((w) => !w.recovery);
  assert.ok(Math.min(...build.map((w) => w.hours)) > 0, 'no week is emptied');
});
