/* What a season is built to arrive with, and the constants the target-driven
   planner reads.

   A target is a chronic training load (load.js: an hour at threshold is 100,
   averaged over 42 days) for race day. It comes from one place — the bands the
   Fitness chart draws (`FITNESS_BANDS`) — so the chart and the plan cannot
   disagree about what a distance asks for:

     finish        the band's low end
     intermediate  its middle, rounded
     competitive   its high end

   **Unfitted.** The bands are illustrative (FINDINGS, 16 Oct), so a target is a
   number the athlete chose to aim for, not a finding about any athlete, and
   nothing here says what a number means for a result.

   Every other coaching constant the planner needs is in `PLAN_MODEL` below, one
   table, each documented as a starting value. A constant that is not in it is
   not a coaching decision.

   This lives apart from fitness.js on purpose: the copy test holds fitness.js
   and the surfaces that draw it to a stricter word list, and the name of the
   highest level is one of the words on it. */

import { FITNESS_BANDS } from './fitness.js';
import { AMBITIONS, DEFAULT_AMBITION, TAPER_MIN_MINUTES, raceMinutes, raceTypeLabel } from './events.js';
import { sayDate } from './dates.js';

const freeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
};

export const PLAN_MODEL = freeze({
  /* How much of its week a tune-up race's taper takes out, by how long the race
     is: a share of the week's load, so the week is as hard as the build would
     have made it less this much. Over two hours (events.js decides what is a
     taper at all) 20 %, over three 35 %, over six 50 %. A race whose length is
     not known gets the middle tier. */
  taper: [
    { over: TAPER_MIN_MINUTES, depth: 0.2 },
    { over: 180, depth: 0.35 },
    { over: 360, depth: 0.5 },
  ],
  taperUnknown: 0.35,

  /* How fast fitness may be built (backplan.js). `max` is the most chronic
     training load a loading week may add, a figure often quoted as the top of
     what is sustainable for a few weeks; the planner also keeps each week
     inside the validator's own volume steps, which bind first at low fitness.
     `floor` is the slowest climb worth making: below it the gap is tiny and
     the athlete holds where they are until it is time to start. */
  ramp: {
    max: 7,
    floor: 1,
    // The first week of a season is held to a tenth above what the athlete trains
    // now — the time that holds their fitness at an ordinary hour's load
    // (`estimate.loadPerHour`) — and never below this many minutes, so someone
    // starting from nothing is not given a week of none.
    minWeekMinutes: 180,
  },

  /* How close to the target a built season counts as having landed, in points
     of fitness on race day. */
  tolerance: 2,

  /* Reading the athlete's own synced history as their fitness today
     (startfit.js). */
  garmin: {
    // Share of recorded training minutes that must be scoreable — by power,
    // pace, swim pace or session effort, never heart rate — before the figure
    // is trusted. Below it the estimate is used and the note says why.
    scoredShare: 0.6,
    // The averaging starts at the mean daily load of the first this-many days
    // of the synced window, not at zero. From zero three weeks of history would
    // read about 60 % low (1 − e^(−21/42) of the way up).
    warmStartDays: 7,
  },

  /* The estimate used when there is no usable history (startfit.js):
     recent weekly hours × a nominal load for an hour of training ÷ 7. */
  estimate: {
    // Load of an average hour of an athlete's training. Between an easy hour
    // (about 49, zone 2) and a build-block hour (about 84) as the planner
    // itself estimates them (fitness.js PLANNED.zoneIF).
    loadPerHour: 55,
    // Years in the sport nudge the figure by a few per cent: a consistent
    // athlete's average sits nearer their weekly load than a new one's.
    years: [
      { below: 1, factor: 0.9 },
      { below: 5, factor: 1 },
      { below: Infinity, factor: 1.05 },
    ],
    // Per-sport background, averaged over the sports given.
    level: { new: 0.9, some: 1, strong: 1.1 },
    // Nobody trains the 40 hours a week the record allows at this load.
    maxCtl: 200,
  },
});

/**
 * The fitness a season is built to arrive with on race day, or null for a
 * distance the chart has no band for (a sprint, a marathon). An absent or
 * unrecognised ambition is read as the default level, the same way a plan
 * stored before ambitions existed is.
 */
export function targetCtl(raceType, ambition) {
  const band = FITNESS_BANDS.find((b) => b.key === raceType);
  if (!band) return null;
  const level = AMBITIONS.includes(ambition) ? ambition : DEFAULT_AMBITION;
  if (level === 'finish') return band.lo;
  if (level === 'competitive') return band.hi;
  return Math.round((band.lo + band.hi) / 2);
}

/**
 * The share of a week's load a tune-up race's taper takes out: 0 for a race
 * that gets no taper, then the tier its length falls in. Takes the event, so the
 * athlete's own expected time counts as it does everywhere else.
 */
export function taperDepth(event) {
  if (!event) return 0;
  const minutes = raceMinutes(event);
  if (minutes === null) return PLAN_MODEL.taperUnknown;
  let depth = 0;
  for (const tier of PLAN_MODEL.taper) if (minutes > tier.over) depth = tier.depth;
  return depth;
}

/** What each level is, in words the athlete chooses by. The names are the
    stored keys' display text; the stored keys never change. */
export const AMBITION_INFO = freeze({
  finish: {
    label: 'Finish',
    blurb: 'Reach the start line prepared to finish. The lightest of the three builds.',
  },
  intermediate: {
    label: 'Intermediate',
    blurb: 'A solid build for a solid race: the middle of the illustrative range for the distance.',
  },
  competitive: {
    label: 'Competitive',
    blurb: 'Build as much fitness as the illustrative range for the distance reaches. The most training of the three.',
  },
});

/**
 * The levels on offer for a race, each with the target it sets: `[{ key, label,
 * blurb, target, band }]`, empty for a distance the chart has no band for.
 */
export function ambitionOptions(raceType) {
  const band = FITNESS_BANDS.find((b) => b.key === raceType);
  if (!band) return [];
  return AMBITIONS.map((key) => ({
    key, ...AMBITION_INFO[key], target: targetCtl(raceType, key), band: { lo: band.lo, hi: band.hi },
  }));
}

const BLOCKED_BY = {
  availability: 'The time you have each week is the limit. More weeks would not close the gap.',
  runway: 'There are not enough weeks to build safely from where you are now.',
  ramp: 'The weeks you have pinned or already trained leave too little room to climb.',
};

/**
 * What to tell the athlete about a plan's target, in words and as plain text:
 * `{ state, headline, detail, choices }`, or null for a plan with no target.
 *
 * `state` is `reached`, `hold` (they are already above it) or `short`. A target
 * that cannot be reached is said to be out of reach, how far short the plan
 * falls and what stands in the way; with `levers` (backplan.js `planLevers`) it
 * also lists what would change that, each of them worked out and none promised,
 * and ends by saying the goal may be kept. The figures are estimates, and are
 * called so: they describe planned training, not the athlete.
 */
export function describeTarget({ target, levers = null } = {}) {
  const f = target?.feasibility;
  if (!target || !f) return null;
  const goal = Math.round(target.ctl);
  const reaches = Math.round(f.achievableCtl);

  if (f.status === 'hold') {
    return {
      state: 'hold',
      headline: `You are already at or above the fitness this race calls for (${goal}).`,
      detail: `The plan holds what you have rather than building more; it reaches about ${reaches} on race day. That is an estimate from the planned sessions.`,
      choices: [],
    };
  }
  if (f.feasible) {
    return {
      state: 'reached',
      headline: `Built to arrive at a fitness of ${goal} on race day.`,
      detail: `The plan reaches about ${reaches}. That is an estimate from the planned sessions and describes training, not you.`,
      choices: [],
    };
  }

  const choices = [];
  if (levers) {
    if (levers.ambition) {
      const a = levers.ambition;
      choices.push(`Aim at the ${AMBITION_INFO[a.ambition]?.label ?? a.ambition} level instead: a fitness of ${Math.round(a.targetCtl)} can be reached.`);
    }
    if (levers.distance) {
      const d = levers.distance;
      choices.push(`Choose a shorter race: ${raceTypeLabel(d.raceType)} at the ${AMBITION_INFO[d.ambition]?.label ?? d.ambition} level (${Math.round(d.targetCtl)}) can be reached.`);
    }
    if (levers.raceDate) {
      const r = levers.raceDate;
      choices.push(`Allow more time: a race${r.raceDate ? ` on ${sayDate(r.raceDate)}` : ''}, ${r.weeks} weeks from the start, would work.`);
    }
    if (levers.hours) {
      choices.push(`Train more: about ${levers.hours.weeklyHours} hours a week would do it.`);
    }
    choices.push('Or keep this goal: the plan above is the best that can be built.');
  }
  return {
    state: 'short',
    headline: `A fitness of ${goal} is out of reach as things stand: this plan reaches about ${reaches} on race day, ${Math.round(f.shortfall)} short.`,
    detail: BLOCKED_BY[f.limitingFactor] ?? '',
    choices,
  };
}
