/* The athlete record: who is training, as opposed to what the plan says.

   A plan is a season. This is the person the seasons are for — birth year,
   sex, height, weight, background, recent training, equipment and goal — so it
   lives once, outside every plan, and a new season can start from it instead
   of asking again.

   **None of it ever goes on a plan.** Weight and height are health data, and a
   plan syncs to the cloud with only the ordinary sync consent and is written
   into every export. The page keeps this record in the browser and copies it
   to the account only under a second, separate consent; `loadPlan` and the
   plan-file envelope both drop an `athlete` field if one is ever smuggled onto
   a plan. Heart rate is not part of it at all — that stays where `synced.js`
   puts it.

   `normalizeAthlete` is an allowlist and the one door every copy comes
   through: this browser's storage, the cloud copy and anything a download is
   re-read from. An impossible value is dropped, not clamped, so the record
   never holds a number the athlete did not give.

   What reads it today is deliberately small, and `athleteGaps` says so to the
   athlete rather than implying more: recent weekly hours size a new season
   (`estimateAnnualHours`), weight turns FTP into watts per kilogram, and sex is
   the default heart-rate formula for training load. Everything else is kept
   for the onboarding steps that come next, and is labelled as not used for
   planning yet. */

import { fitToRace, WEEKS_PER_YEAR } from './season.js';
import { goalEvent } from './events.js';
import { normalizeBenchmarks } from './paces.js';
import { normalizeLoadRefs } from './load.js';

export const SEXES = ['female', 'male', 'unspecified'];
/** How much of each sport somebody has done, in words they can answer. */
export const LEVELS = ['new', 'some', 'strong'];
export const SPORTS = ['Swim', 'Bike', 'Run'];
export const EQUIPMENT = ['pool', 'openWater', 'indoorTrainer', 'powerMeter'];
export const GOALS = ['finish', 'time'];

/** Every key a normalized record can have. */
export const ATHLETE_FIELDS = [
  'birthYear', 'sex', 'heightCm', 'weightKg', 'yearsInSport', 'levels',
  'recentWeeklyHours', 'longestRideMin', 'longestRunMin', 'equipment',
  'goal', 'goalTime', 'updatedAt',
];

/* The bounds Plan setup's own annual-hours field accepts. */
const MIN_ANNUAL = 50;
const MAX_ANNUAL = 2000;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const within = (v, lo, hi, step = 1) => {
  if (v === null || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return undefined;
  return Math.round(n / step) * step;
};
// Rounding to a step leaves float dust (61.300000000000004); one more round
// to the step's own decimals keeps the stored number the one that was meant.
const tidy = (n, decimals) => (n === undefined ? undefined : Number(n.toFixed(decimals)));

/**
 * The athlete record, cleaned. Returns `{}` for anything that is not one.
 * Absent means "not said": `equipment.pool === false` is an answer.
 */
export function normalizeAthlete(raw) {
  if (!isObj(raw)) return {};
  const out = {};
  const put = (k, v) => { if (v !== undefined) out[k] = v; };

  put('birthYear', within(raw.birthYear, 1900, 2100));
  put('sex', SEXES.includes(raw.sex) ? raw.sex : undefined);
  put('heightCm', within(raw.heightCm, 100, 250));
  put('weightKg', tidy(within(raw.weightKg, 30, 250, 0.1), 1));
  put('yearsInSport', within(raw.yearsInSport, 0, 80));

  if (isObj(raw.levels)) {
    const levels = {};
    for (const s of SPORTS) if (LEVELS.includes(raw.levels[s])) levels[s] = raw.levels[s];
    if (Object.keys(levels).length) out.levels = levels;
  }

  put('recentWeeklyHours', tidy(within(raw.recentWeeklyHours, 0, 40, 0.5), 1));
  put('longestRideMin', within(raw.longestRideMin, 0, 900));
  put('longestRunMin', within(raw.longestRunMin, 0, 400));

  if (isObj(raw.equipment)) {
    const eq = {};
    for (const k of EQUIPMENT) if (typeof raw.equipment[k] === 'boolean') eq[k] = raw.equipment[k];
    if (Object.keys(eq).length) out.equipment = eq;
  }

  put('goal', GOALS.includes(raw.goal) ? raw.goal : undefined);
  // A target time is only meaningful beside a time goal; on its own it would be
  // a number with nothing to say what it is for.
  if (out.goal === 'time') put('goalTime', within(raw.goalTime, 30, 1200));

  put('updatedAt', Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : undefined);
  return out;
}

/** True when the record says nothing about anybody (a timestamp alone does not). */
export function isEmptyAthlete(athlete) {
  return Object.keys(normalizeAthlete(athlete)).every((k) => k === 'updatedAt');
}

/**
 * Two copies of the record — this browser's and the account's — reduced to
 * one. The newer edit wins whole, the way plans merge, and the cloud copy wins
 * a tie. An empty copy never wins: a device that has never been told anything
 * must not erase what another device was told.
 */
export function mergeAthletes(local, cloud) {
  const a = normalizeAthlete(local);
  const b = normalizeAthlete(cloud);
  if (isEmptyAthlete(b)) return a;
  if (isEmptyAthlete(a)) return b;
  return (a.updatedAt ?? 0) > (b.updatedAt ?? 0) ? a : b;
}

/* What each missing item is, and what it is for. `used` is the honest answer
   to "does anything read this yet?" — shown to the athlete, so it may not
   promise more than the code does. Listed in the order worth asking. */
const NOT_YET = 'Kept with your profile; not used for planning yet.';
const GAPS = [
  { key: 'race', label: 'Your main race', used: true, plan: true,
    why: 'Decides how long the season is and where it peaks.',
    missing: (a, p) => !goalEvent(p.events) },
  { key: 'recentWeeklyHours', label: 'Hours a week you train now', used: true,
    why: 'Sizes a new season so it starts close to what you already do.',
    missing: (a) => a.recentWeeklyHours === undefined },
  { key: 'runResult', label: 'A recent running result', used: true, plan: true,
    why: 'Sets the paces on every run.',
    missing: (a, p) => !normalizeBenchmarks(p.benchmarks).some((b) => b.current) },
  { key: 'ftp', label: 'FTP', used: true, plan: true,
    why: 'Puts watts on bike workouts and scores the load of rides.',
    missing: (a, p) => !normalizeLoadRefs(p.loadRefs)?.ftpW },
  { key: 'css', label: 'Swim CSS', used: true, plan: true,
    why: 'Scores the load of synced swims.',
    missing: (a, p) => !normalizeLoadRefs(p.loadRefs)?.cssSecPer100m },
  { key: 'weightKg', label: 'Weight', used: true,
    why: 'Shows your FTP as watts per kilogram.',
    missing: (a) => a.weightKg === undefined },
  { key: 'sex', label: 'Sex', used: true,
    why: 'Preselects the heart-rate formula for training load.',
    missing: (a) => a.sex === undefined },
  { key: 'birthYear', label: 'Birth year', used: false, why: NOT_YET,
    missing: (a) => a.birthYear === undefined },
  { key: 'yearsInSport', label: 'Years in triathlon', used: false, why: NOT_YET,
    missing: (a) => a.yearsInSport === undefined },
  { key: 'levels', label: 'Your swim, bike and run background', used: false, why: NOT_YET,
    missing: (a) => !a.levels },
  { key: 'longest', label: 'Your longest recent ride and run', used: false, why: NOT_YET,
    missing: (a) => a.longestRideMin === undefined || a.longestRunMin === undefined },
  { key: 'pool', label: 'Pool access', used: false, why: NOT_YET,
    missing: (a) => a.equipment?.pool === undefined },
  { key: 'goal', label: 'Your goal for the race', used: false, why: NOT_YET,
    missing: (a) => a.goal === undefined },
];

/**
 * What is still missing, in the order worth asking for it: each
 * `{ key, label, why, used }`. With a plan, the race, running result, FTP and
 * CSS it carries are checked too. Height is never reported missing: nothing
 * reads it, so it is only ever offered.
 */
export function athleteGaps(athlete, plan = null) {
  const a = normalizeAthlete(athlete);
  return GAPS
    .filter((g) => (g.plan ? plan && g.missing(a, plan) : g.missing(a, plan)))
    .map(({ key, label, why, used }) => ({ key, label, why, used }));
}

/**
 * The annual-hours figure that opens a season of `weeks` at roughly the hours
 * a week the athlete trains now, or null when there is nothing to anchor it.
 *
 * Annual hours are a scale, not a total (season.js): the hours a week opens at
 * depend on which blocks the runway keeps. So this asks the season model
 * rather than assuming a ratio — it fits the runway once at a known scale and
 * reads off the opening month. A month rather than a week because a runway
 * can open on a recovery week, and anchoring on that would put the next week
 * well above what the athlete has been doing.
 *
 * Rounded to 10 h and held to what Plan setup accepts.
 */
export function estimateAnnualHours({ recentWeeklyHours, weeks, landings = [] } = {}) {
  const recent = Number(recentWeeklyHours);
  const n = Math.round(Number(weeks));
  if (!(recent > 0) || !(n >= 1)) return null;

  const SCALE = 100 * WEEKS_PER_YEAR;   // one hour a week of "annual" scale, ×100 for rounding headroom
  const opening = fitToRace({ annualHours: SCALE, weeks: n, landings }).slice(0, 4);
  const perUnit = opening.reduce((a, w) => a + w.hours, 0) / opening.length / 100;
  if (!(perUnit > 0)) return null;

  const annual = Math.round((recent * WEEKS_PER_YEAR) / perUnit / 10) * 10;
  return Math.min(MAX_ANNUAL, Math.max(MIN_ANNUAL, annual));
}

/** FTP over body weight, to two decimals, or null when either is missing. */
export function wattsPerKg(ftpW, weightKg) {
  const w = Number(ftpW);
  const kg = Number(weightKg);
  if (!(w > 0) || !(kg > 0)) return null;
  return Math.round((w / kg) * 100) / 100;
}
