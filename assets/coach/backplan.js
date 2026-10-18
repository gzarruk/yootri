/* Build a season backwards from where the athlete should be on race day.

   `fitToRace` (season.js) sizes a season from the hours the athlete has and
   nothing else: it never asks what the race needs or where the athlete is
   now. This asks both. Given the fitness they start from, the fitness the race
   calls for, and the weeks between, it works out how much training each week
   has to hold, and builds exactly that — or builds the best that can be built
   and says how far short it is. It never blocks and never overshoots.

   Fitness is load.js's chronic training load: the 42-day average, where an
   hour at threshold is 100. **Race-day fitness** is that average on the race
   date, with the taper already in it, which is why the target is landed there
   and not on the peak before it.

   How a season is worked out:

   1. The weeks keep the model's own shape — Prep and Base, Build 1 and 2, then
      Peak, Peak and Race — so session generation, the validator and the focus
      and zone tables read them unchanged. A runway longer than the model is
      padded, as it always was, with more Prep; every fourth week of Prep is an
      easy one, as it is in every other block.
   2. The last three weeks are the model's own tail, as hours: the same
      multiples of the last build week it has always used.
   3. Fitness is built at an even rate over the loading weeks from where the
      athlete is to a level at the end of the build, chosen so that the tail
      then leaves them on the target. Where the gap is tiny they hold until it
      is time to start. A rate that would have to exceed `PLAN_MODEL.ramp.max`
      is not asked for. (An even climb, not the latest start at the top rate:
      owner decision, 18 Oct 2026.)
   4. A week's fitness waypoint becomes the load the week must carry, by
      inverting the average (`weeklyLoadFor`), and the load becomes hours by
      bisection through `generateWeek` and `plannedLoad` — the very estimate
      the Fitness chart draws, so the chart and the plan cannot disagree. The
      average is then carried day by day with `fitness.js`'s own `carry`, and
      each week starts from where the last one actually ended.
   5. Each week also stays inside the athlete's own week, and inside the
      validator's volume steps (a loading week may be 10 % above the last one in
      its block, a new block 25 % above the last block's hardest week), so a
      season it builds is one the validator has nothing to say about.

   A tune-up race longer than two hours gets a taper week and a race week
   carrying `1 − depth` of the load the trajectory called for there
   (targets.js `taperDepth`); a shorter one changes no week, only clears its
   own day. Its load is counted either way (races.js `plannedRaceLoads`).

   Everything here is pure: no clock, no storage. **Unfitted:** every constant is
   in `PLAN_MODEL` (targets.js). No heart rate is read: nothing here takes a
   heart-rate store or a threshold, and what it returns is stored on a plan. */

import { fitToRace, multiplier, isTaperBlock, DEFAULT_SEASON } from './season.js';
import { generateWeek } from './generate.js';
import { plannedLoad, carry } from './fitness.js';
import { PLAN_MODEL, targetCtl, taperDepth } from './targets.js';
import { MAX_RAMP, MAX_BLOCK_STEP } from './validate.js';
import { LOAD } from './load.js';
import { raceClosure, plannedRaceLoads } from './races.js';
import { normalizeEvents, secondaryRaces, goalEvent, AMBITIONS, RACE_TYPES } from './events.js';
import { DAYS, weeklyAvailableMinutes } from './profile.js';
import { dateOf, weekIndexOf } from './calendar.js';
import { parseISO, toISO, addDays } from './dates.js';

const STEP = 5;                                       // minutes: sessions are built in whole 5-minute blocks
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
const weekKey = (w) => `w${w}`;

/**
 * The load a week must carry to take chronic training load from `ctlStart` to
 * `ctlEnd`, if every day of it carried the same. With `a = e^(−7/42)`,
 * `CTL_end = CTL_start·a + L·(1 − a)` for a daily load `L`; the week is `7L`.
 * Negative when the average would have to fall faster than rest lets it.
 */
export function weeklyLoadFor(ctlStart, ctlEnd) {
  const a = Math.exp(-7 / LOAD.chronicDays);
  return (7 * (ctlEnd - ctlStart * a)) / (1 - a);
}

/* ---- one week, as the planned-load estimate sees it ----------------------- */

const MODELS = new Map();
const MODEL_LIMIT = 40000;

/* A memo of "this many minutes of this block on a week with this race closure",
   for one athlete's week. Generating a week is cheap but a season asks for
   thousands, and the same few hundred recur across every pass, so they are
   kept — across seasons too, for the same profile. */
function weekModel(profile) {
  const key = JSON.stringify([
    profile.availability, profile.constraints, profile.splits ?? null, profile.weekShape ?? null,
    profile.longDays ?? null, profile.maxSessionsPerDay ?? null, profile.raceType,
  ]);
  let memo = MODELS.get(key);
  if (!memo) {
    if (MODELS.size > 24) MODELS.clear();
    memo = new Map();
    MODELS.set(key, memo);
  }
  let held = 0;
  for (const m of MODELS.values()) held += m.size;
  if (held > MODEL_LIMIT) for (const m of MODELS.values()) m.clear();

  return function week(minutes, block, raceDay = null, raceOnly = false) {
    const k = `${block}|${minutes}|${raceDay ?? ''}|${raceOnly ? 1 : 0}`;
    let hit = memo.get(k);
    if (!hit) {
      const { sessions, plannedMinutes } = generateWeek({ hours: minutes / 60, block, profile, raceDay, raceOnly });
      const byDay = DAYS.map(() => 0);
      for (const s of sessions) {
        const i = DAYS.indexOf(s.day);
        if (i >= 0) byDay[i] += plannedLoad(s) ?? 0;
      }
      hit = { byDay, load: byDay.reduce((a, b) => a + b, 0), minutes: plannedMinutes };
      memo.set(k, hit);
    }
    return hit;
  };
}

/* The fewest minutes (in whole blocks) whose week carries at least `load`; the
   most there is when none does. */
function minutesForLoad(week, block, closure, load, maxMinutes) {
  const top = Math.max(0, Math.floor(maxMinutes / STEP));
  if (!(load > 0)) return 0;
  const at = (i) => week(i * STEP, block, closure.raceDay, closure.raceOnly);
  if (at(top).load < load) return top * STEP;
  let lo = 0;
  let hi = top;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid).load >= load) hi = mid; else lo = mid + 1;
  }
  return lo * STEP;
}

/* ---- the layout of the weeks ---------------------------------------------- */

function layout(weeks, landings) {
  const withLandings = fitToRace({ peakHours: 1, weeks, landings });
  const plain = fitToRace({ peakHours: 1, weeks });
  // The model's Prep block has no easy week in it, and a runway longer than the
  // model is padded with more of it. Every fourth week of the build is an easy
  // one, Prep included: the validator counts hard weeks in a row across blocks.
  // The plan's first week is never an easy one: a runway cut from the end of
  // the model can open on the last week of a block, and an athlete starting a
  // plan does not start it with a rest week.
  const recovers = (e, i) => i > 0 && (e.block === 'Prep' ? e.week % DEFAULT_SEASON.blocks[0].weeks === 0 : e.recovery);
  return withLandings.map((e, i) => ({
    block: e.block,
    week: e.week,
    recovery: recovers(e, i),
    multiplier: e.load,
    absWeek: i,
    base: { block: plain[i].block, recovery: recovers(plain[i], i), multiplier: plain[i].load },
  }));
}

/* The tail the model gives the race the season is built for. */
const tailLength = (plain) => {
  let n = 0;
  for (let i = plain.length - 1; i >= 0 && isTaperBlock(plain[i].block); i--) n++;
  return n;
};

/* ---- checking what is handed in ------------------------------------------- */

function check(input) {
  const n = Number(input?.weeks);
  if (!Number.isInteger(n) || n < 1) throw new Error(`a season needs at least one week; got ${JSON.stringify(input?.weeks)}`);
  if (!parseISO(input?.start)) throw new Error(`the start has to be a date, like 2026-10-19; got ${JSON.stringify(input?.start)}`);
  if (!(typeof input.startCtl === 'number' && input.startCtl >= 0 && input.startCtl <= 400)) {
    throw new Error(`the start fitness has to be a number from 0 to 400; got ${JSON.stringify(input.startCtl)}`);
  }
  if (!(typeof input.targetCtl === 'number' && input.targetCtl > 0 && input.targetCtl <= 400)) {
    throw new Error(`the target fitness has to be a number from 1 to 400; got ${JSON.stringify(input.targetCtl)}`);
  }
  if (!input.profile?.availability) throw new Error('a season is built for an athlete\'s week: a profile with availability is needed');
  return n;
}

/* ---- one pass: build the season for a given level at the end of the build --- */

function buildPass(ctx, preTail) {
  const { N, labels, tailStart, keep, c0, week, closures, extra, pins, frozen, depths, start, raceDate, availability } = ctx;
  const entries = [];
  let ctl = c0;                         // the average as the days actually carry it
  let ideal = c0;                       // the average as the plan means it to run: what the weeks are asked of
  let lastLoadMinutes = null;           // the last loading week's requested minutes: what the tail is a multiple of
  let lastLoadMultiplier = null;
  let lastLoad = null;                  // its load
  let sameBlockMinutes = null;          // the last loading week in this block, as generated
  let blockPeak = 0;                    // the hardest loading week in this block
  let prevBlockPeak = null;             // the hardest week of the last block that had one
  let curBlock = null;

  const closureOf = (i) => closures[i];
  const track = (i, block, generated, loading) => {
    if (block !== curBlock) {
      if (curBlock !== null && blockPeak > 0) prevBlockPeak = blockPeak;
      curBlock = block;
      blockPeak = 0;
      sameBlockMinutes = null;
    }
    if (loading) {
      sameBlockMinutes = generated;
      blockPeak = Math.max(blockPeak, generated);
    }
  };

  // The weeks already trained are carried as they were.
  for (let i = 0; i < keep; i++) {
    const f = frozen[i];
    entries.push(f);
    const minutes = Math.round(f.hours * 60);
    const g = week(minutes, f.block, closureOf(i).raceDay, closureOf(i).raceOnly);
    const loading = !f.recovery && !isTaperBlock(f.block);
    track(i, f.block, g.minutes, loading);
    if (loading) { lastLoadMinutes = minutes; lastLoadMultiplier = labels[i].multiplier; lastLoad = g.load; }
  }

  // Waypoints: an even climb over the weeks the trajectory loads, from here to
  // the level at the end of the build.
  const loadingWeeks = [];
  for (let i = keep; i < tailStart; i++) if (!labels[i].base.recovery) loadingWeeks.push(i);
  const K = loadingWeeks.length;
  const gap = preTail - c0;
  let climbing = K;
  if (gap <= 0) climbing = 0;
  else if (K > 0 && gap / K < PLAN_MODEL.ramp.floor) climbing = Math.max(1, Math.ceil(gap / PLAN_MODEL.ramp.floor));
  const waypoint = new Map();
  loadingWeeks.forEach((w, k) => {
    const done = k + 1 - (K - climbing);
    waypoint.set(w, gap <= 0 || done <= 0 ? c0 : c0 + (gap * Math.min(done, climbing)) / climbing);
  });

  const advance = (fit, i, byDay) => {
    const monday = dateOf(start, i, 'Mon');
    const dayBefore = toISO(addDays(parseISO(monday), -1));
    const through = i === N - 1 ? raceDate : dateOf(start, i, 'Sun');
    const loads = {};
    DAYS.forEach((d, j) => {
      const iso = dateOf(start, i, d);
      loads[iso] = byDay[j] + (extra[iso] ?? 0);
    });
    return carry({ fit, fat: 0 }, dayBefore, through, (iso) => loads[iso] ?? (extra[iso] ?? 0)).fit;
  };

  for (let i = keep; i < N; i++) {
    const L = labels[i];
    const closure = closureOf(i);
    const tail = i >= tailStart;
    const loadingKind = !tail && !L.recovery && !isTaperBlock(L.block);
    const special = !tail && !L.recovery && isTaperBlock(L.block);     // a tune-up's taper or race week
    let minutes;
    const pinned = pins[weekKey(i)];

    // What the trajectory would have asked of this week, as a load.
    const goalOf = () => Math.min(waypoint.get(i) ?? ideal, ideal + PLAN_MODEL.ramp.max);
    const trajectoryLoad = () => {
      if (L.base.recovery) return (lastLoad ?? 0) * DEFAULT_SEASON.recovery;
      return Math.max(0, weeklyLoadFor(ideal, goalOf()));
    };
    let idealNext = null;

    if (Number.isFinite(pinned) && pinned >= 0) {
      minutes = Math.round((pinned * 60) / STEP) * STEP;
    } else if (tail) {
      const ref = lastLoadMinutes ?? virtualBuildMinutes(ctx, ctl);
      const refMultiplier = lastLoadMultiplier ?? multiplier('Build 2', 2);
      minutes = Math.round(((ref * multiplier(L.block, L.week)) / refMultiplier) / STEP) * STEP;
      minutes = Math.min(minutes, Math.floor(availability / STEP) * STEP);
    } else if (L.recovery) {
      minutes = minutesForLoad(week, L.block, closure, (lastLoad ?? weeklyLoadFor(ctl, ctl)) * DEFAULT_SEASON.recovery, availability);
    } else if (special) {
      const depth = depths.get(i) ?? PLAN_MODEL.taperUnknown;
      minutes = minutesForLoad(week, L.block, closure, trajectoryLoad() * (1 - depth), availability);
    } else {
      // A loading week: as much as the waypoint asks, no more than the athlete's
      // week, and no more than the validator's volume step allows.
      const step = sameBlockMinutes !== null ? MAX_RAMP : (prevBlockPeak !== null ? MAX_BLOCK_STEP : Infinity);
      const base = sameBlockMinutes !== null ? sameBlockMinutes : prevBlockPeak;
      const stepCap = base === null || base === undefined ? Infinity : Math.floor((base * step) / STEP) * STEP;
      const cap = Math.min(availability, stepCap);
      const asked = trajectoryLoad();
      minutes = minutesForLoad(week, L.block, closure, asked, cap);
      // The generated week can come in a few minutes over what was asked for.
      while (minutes > 0 && week(minutes, L.block, closure.raceDay, closure.raceOnly).minutes > cap) minutes -= STEP;
      // And the average, carried day by day, can rise a little more than the
      // week's even-load figure says; the ramp is held to what it actually does.
      while (minutes > 0 && advance(ctl, i, week(minutes, L.block, closure.raceDay, closure.raceOnly).byDay) > ctl + PLAN_MODEL.ramp.max + 1e-9) minutes -= STEP;
      // A week that carries what was asked of it puts the plan exactly on its
      // waypoint; one held back by a cap puts it where that load really takes it.
      if (week(minutes, L.block, closure.raceDay, closure.raceOnly).load >= asked - 1e-6) idealNext = goalOf();
    }

    const g = week(minutes, L.block, closure.raceDay, closure.raceOnly);
    ideal = idealNext ?? afterWeek(ideal, g.load);
    const next = advance(ctl, i, g.byDay);
    entries.push({
      block: L.block, week: L.week, recovery: L.recovery, absWeek: i, load: 0,
      hours: round3(minutes / 60), ctl: round1(next),
    });
    track(i, L.block, g.minutes, loadingKind);
    if (loadingKind) { lastLoadMinutes = minutes; lastLoadMultiplier = L.multiplier; lastLoad = g.load; }
    ctl = next;
  }

  // `load` is how hard a week is against the season's own loading weeks, so a
  // value of 1 or more is a week at or above the usual one (what the validator reads).
  const loading = entries.filter((e, i) => i < tailStart && !e.recovery && !isTaperBlock(e.block));
  const mean = loading.length ? loading.reduce((a, e) => a + e.hours, 0) / loading.length : 0;
  const season = entries.map((e, i) => (i < keep ? e : { ...e, load: mean > 0 ? round3(e.hours / mean) : 1 }));
  const preTailCtl = tailStart > 0 ? season[tailStart - 1].ctl : c0;
  return { season, raceCtl: ctl, preTailCtl };
}

/* Chronic load after a week that carried `load` in all, spread evenly. */
const afterWeek = (ctl, load) => {
  const a = Math.exp(-7 / LOAD.chronicDays);
  return ctl * a + (load / 7) * (1 - a);
};

/* Hours for the week the tail is a multiple of, when no week before it carries
   load: what it would take to hold where the athlete is, in a build block. */
function virtualBuildMinutes(ctx, ctl) {
  const { week, availability } = ctx;
  return minutesForLoad(week, 'Build 2', { raceDay: null, raceOnly: false }, Math.max(0, weeklyLoadFor(ctl, ctl)), availability);
}

/* ---- the whole solve ------------------------------------------------------- */

function solveCore(input) {
  const N = check(input);
  const { start, profile, startCtl: c0Start, targetCtl: target } = input;
  const events = normalizeEvents(input.events);
  const shell = { start, events };
  const keep = Math.max(0, Math.min(N, Math.floor(Number(input.keepBefore) || 0)));
  const frozen = Array.isArray(input.frozen) ? input.frozen : [];
  if (keep > frozen.length) throw new Error(`${keep} weeks are kept but only ${frozen.length} were given`);
  const anchor = Number.isFinite(input.anchorCtl) ? input.anchorCtl
    : (keep > 0 && Number.isFinite(frozen[keep - 1]?.ctl) ? frozen[keep - 1].ctl : c0Start);

  const landings = secondaryRaces(events)
    .map((ev) => ({ absWeek: weekIndexOf(start, ev.date), ev }))
    .filter((l) => Number.isInteger(l.absWeek));
  const detail = landings.map((l) => ({ absWeek: l.absWeek, taper: taperDepth(l.ev) > 0 }));
  const labels = layout(N, detail);
  const plainLabels = labels.map((l) => ({ block: l.base.block }));
  const tailStart = Math.max(keep, N - tailLength(plainLabels));

  // Each landing's depth, keyed by the weeks it takes over: the taper week and the race week.
  const depths = new Map();
  for (const { absWeek, ev } of landings) {
    const depth = taperDepth(ev);
    if (depth <= 0) continue;
    for (const w of [absWeek - 1, absWeek]) if (w >= 0) depths.set(w, Math.max(depths.get(w) ?? 0, depth));
  }

  const closures = Array.from({ length: N }, (_, i) => raceClosure(shell, i));
  const extra = plannedRaceLoads(shell, N);
  const primary = goalEvent(events);
  const raceDate = primary && parseISO(primary.date) && weekIndexOf(start, primary.date) === N - 1
    ? primary.date : dateOf(start, N - 1, 'Sun');

  const ctx = {
    N, labels, tailStart, keep, c0: anchor, week: weekModel(profile), closures, extra,
    pins: input.weekBudgets ?? {}, frozen, depths, start, raceDate,
    availability: Math.floor(weeklyAvailableMinutes(profile) / STEP) * STEP || STEP,
  };

  const tol = PLAN_MODEL.tolerance;
  const hold = buildPass(ctx, anchor);
  let best;
  let status = 'build';
  let feasible;

  if (hold.raceCtl >= target - tol) {
    // Already as fit as the season needs: hold it, and say so.
    best = hold;
    status = 'hold';
    feasible = true;
  } else {
    const ceiling = buildPass(ctx, 1000);                      // everything the caps allow
    if (ceiling.raceCtl < target - tol) {
      const smooth = buildPass(ctx, ceiling.preTailCtl);       // the same arrival, climbed evenly
      best = smooth.raceCtl >= ceiling.raceCtl - 0.5 ? smooth : ceiling;
      feasible = false;
    } else {
      let lo = anchor;
      let hi = Math.max(ceiling.preTailCtl, anchor + 1);
      best = ceiling;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const pass = buildPass(ctx, mid);
        if (Math.abs(pass.raceCtl - target) < Math.abs(best.raceCtl - target) || best === ceiling) best = pass;
        if (Math.abs(pass.raceCtl - target) < 0.25) { best = pass; break; }
        if (pass.raceCtl < target) lo = mid; else hi = mid;
      }
      feasible = best.raceCtl >= target - tol;
    }
  }

  const achievable = round1(best.raceCtl);
  return {
    season: best.season,
    raceCtl: achievable,
    feasibility: {
      feasible,
      status,
      targetCtl: target,
      achievableCtl: achievable,
      shortfall: feasible ? 0 : round1(Math.max(0, target - achievable)),
      limitingFactor: null,
    },
  };
}

/** Is `input` feasible with the front of the season stretched, the pins and the
    weeks already trained let go? Used to say what is in the way. */
const FREE_WEEKS = 52;
const stretched = (input) => ({
  ...input,
  start: toISO(addDays(parseISO(input.start), -7 * FREE_WEEKS)),
  weeks: input.weeks + FREE_WEEKS,
  weekBudgets: {},
  keepBefore: 0,
  frozen: undefined,
  anchorCtl: undefined,
});

/**
 * Build a season backwards from `targetCtl`.
 *
 * @param {object} input
 * @param {string} input.start        the Monday the plan starts
 * @param {number} input.weeks        runway: Monday start to the race week
 * @param {object} input.profile      a normalized profile; its availability is the ceiling
 * @param {object[]} input.events     the plan's events: the race, tune-ups
 * @param {number} input.startCtl     the athlete's fitness when the plan starts
 * @param {number} input.targetCtl    the fitness to arrive with on race day
 * @param {object} [input.weekBudgets] pinned hours by week key (`w3`): fixed inputs
 * @param {number} [input.keepBefore] weeks before this one are carried as they were…
 * @param {object[]} [input.frozen]   …these season entries, and the solve starts from…
 * @param {number} [input.anchorCtl]  …this fitness at the end of the last of them
 * @returns {{season: object[], raceCtl: number, feasibility: object}}
 *   `season` is `fitToRace`'s entries with `ctl`, the planned fitness at the end of each week.
 *   `feasibility` is `{ feasible, status, targetCtl, achievableCtl, shortfall, limitingFactor }`;
 *   `status` is `build`, or `hold` when the athlete starts above what the target needs.
 */
export function planSeason(input) {
  const result = solveCore(input);
  if (result.feasibility.feasible) return result;

  // Not reachable. Say what is in the way: the athlete's week if even a long
  // runway would fall short, the pins or the weeks already trained if letting
  // them go would do it, else the runway.
  let limitingFactor = 'runway';
  if (!solveCore(stretched(input)).feasibility.feasible) limitingFactor = 'availability';
  else if (Object.keys(input.weekBudgets ?? {}).length || (input.keepBefore ?? 0) > 0) {
    const free = solveCore({ ...input, weekBudgets: {}, keepBefore: 0, frozen: undefined, anchorCtl: undefined });
    if (free.feasibility.feasible) limitingFactor = 'ramp';
  }
  return { ...result, feasibility: { ...result.feasibility, limitingFactor } };
}

/* ---- what would make it reachable ------------------------------------------ */

const shiftEvents = (events, days) => normalizeEvents(events).map((ev) => (ev.priority === 'primary'
  ? { ...ev, date: toISO(addDays(parseISO(ev.date), days)) } : ev));

/**
 * What would make an unreachable target reachable, worked out by building the
 * season again each way and not by guessing: `raceDate` — the earliest race
 * date on which it is reachable; `ambition` — the highest lower ambition that
 * is; `hours` — the weekly hours it would take, only when hours are what is
 * in the way; `distance` — a shorter race and ambition the athlete's week can
 * carry. Each is null when nothing of the kind works. Null for a season that
 * can be built as asked.
 */
export function planLevers(input, result = planSeason(input)) {
  if (result.feasibility.feasible) return null;
  const feasible = (changes) => solveCore({ ...input, ...changes }).feasibility.feasible;
  const raceType = input.profile.raceType;

  // A later date: the shortest stretch of the runway that works.
  const later = (w) => ({
    weeks: input.weeks + w,
    events: shiftEvents(input.events, 7 * w),
    profile: input.profile.raceDate
      ? { ...input.profile, raceDate: toISO(addDays(parseISO(input.profile.raceDate), 7 * w)) } : input.profile,
  });
  let raceDate = null;
  if (feasible(later(FREE_WEEKS))) {
    let lo = 1;
    let hi = FREE_WEEKS;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (feasible(later(mid))) hi = mid; else lo = mid + 1;
    }
    const primary = goalEvent(normalizeEvents(input.events));
    raceDate = {
      weeks: input.weeks + lo,
      raceDate: primary ? toISO(addDays(parseISO(primary.date), 7 * lo)) : null,
    };
  }

  // A lower ambition: the highest one below the target that works.
  let ambition = null;
  for (const a of [...AMBITIONS].reverse()) {
    const t = targetCtl(raceType, a);
    if (t === null || t >= input.targetCtl) continue;
    if (feasible({ targetCtl: t })) { ambition = { ambition: a, targetCtl: t }; break; }
  }

  // More hours, when hours are the limit: scale the week until it works.
  let hours = null;
  if (result.feasibility.limitingFactor === 'availability') {
    const total = weeklyAvailableMinutes(input.profile);
    const scaled = (minutes) => ({
      profile: {
        ...input.profile,
        availability: Object.fromEntries(DAYS.map((d) => [d, Math.min(1440, Math.round((input.profile.availability[d] * minutes) / total / STEP) * STEP)])),
      },
    });
    const ceiling = total * 3;
    if (feasible(scaled(ceiling))) {
      let lo = total;
      let hi = ceiling;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (feasible(scaled(mid))) hi = mid; else lo = mid;
      }
      let weekly = Math.ceil(hi / 30) / 2;
      while (!feasible(scaled(weekly * 60)) && weekly * 60 < ceiling * 2) weekly += 0.5;
      hours = { weeklyHours: weekly };
    }
  }

  // A different goal: the longest race below this one, at the highest ambition the week can carry.
  let distance = null;
  const shorter = RACE_TYPES.slice(0, Math.max(0, RACE_TYPES.indexOf(raceType)));
  for (const type of [...shorter].reverse()) {
    for (const a of [...AMBITIONS].reverse()) {
      const t = targetCtl(type, a);
      if (t === null) continue;
      const events = normalizeEvents(input.events).map((ev) => (ev.priority === 'primary' ? { ...ev, raceType: type } : ev));
      if (feasible({ targetCtl: t, profile: { ...input.profile, raceType: type }, events })) { distance = { raceType: type, ambition: a, targetCtl: t }; break; }
    }
    if (distance) break;
  }

  return { raceDate, ambition, hours, distance };
}
