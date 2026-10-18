/* Where the athlete's fitness stands today: the chronic training load a season
   is built up from.

   Fitness here is load.js's — the 42-day average of training load, where an
   hour at threshold is 100. Three sources, tried in this order:

     entered   a figure the athlete typed. It is theirs and is not second-guessed.
     garmin    their own synced sessions, when the sync covers enough weeks
               (`HISTORY_THRESHOLDS.minCovered`) and enough of the recorded time
               could be scored.
     estimate  otherwise: recent weekly hours × a nominal load for an hour of
               training ÷ 7, nudged a few per cent by years in the sport and by
               the athlete's background in each sport. It is an estimate and
               says so, and the athlete can replace it.

   **No heart rate, ever.** The figure is stored on the plan, and a plan syncs
   and exports; heart rate never goes on one (CLAUDE.md, and FINDINGS 28 Sep).
   So sessions are scored here by power, pace, swim pace and session effort
   alone: no heart-rate store is read, no heart-rate threshold is taken, and a
   session only heart rate could score counts against how much of the recorded
   time was scored instead of being scored some other way.

   **Body measurements play no part.** Weight, height, birth year and sex are
   health data that stay off a plan; recent training predicts far better than
   they do (docs/onboarding-roadmap.md). What goes on the plan is the number
   that comes out, never what it came from.

   Every constant is in `PLAN_MODEL` (targets.js) and is unfitted. */

import { PLAN_MODEL } from './targets.js';
import { HISTORY_DISCIPLINES, HISTORY_THRESHOLDS, trainingHistory } from './history.js';
import { LOAD, activityLoad, dailyLoads, ewma, loadThresholds } from './load.js';
import { parseISO, toISO, addDays } from './dates.js';

const round1 = (n) => Math.round(n * 10) / 10;
const shift = (iso, days) => toISO(addDays(parseISO(iso), days));
const secondsOf = (a) => Number(a?.movingS) || Number(a?.durationS) || 0;

/* A figure the athlete typed, or null when it is not a usable one. */
function enteredCtl(raw) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > PLAN_MODEL.estimate.maxCtl) return null;
  return round1(n);
}

/* The estimate from recent hours, or null when there are none to go on. */
function estimateCtl(athlete) {
  const hours = Number(athlete?.recentWeeklyHours);
  if (!(hours > 0)) return null;
  const { loadPerHour, years, level, maxCtl } = PLAN_MODEL.estimate;

  const y = Number(athlete?.yearsInSport);
  const yearsFactor = Number.isFinite(y) && y >= 0 ? years.find((row) => y < row.below).factor : 1;

  const given = Object.values(athlete?.levels ?? {}).filter((l) => l in level);
  const levelFactor = given.length ? given.reduce((sum, l) => sum + level[l], 0) / given.length : 1;

  return round1(Math.min(maxCtl, (hours * loadPerHour * yearsFactor * levelFactor) / 7));
}

/* Of the time recorded in the 42 days up to `asOf`, the share that load.js can
   score without heart rate; null when nothing was recorded. */
function scoredShare(activities, thresholds, { from, asOf }) {
  const first = shift(asOf, 1 - LOAD.chronicDays);
  let scored = 0;
  let total = 0;
  for (const a of activities) {
    if (!a?.date || a.date < from || a.date < first || a.date > asOf) continue;
    if (!HISTORY_DISCIPLINES.includes(a.disc)) continue;
    const secs = secondsOf(a);
    if (!(secs > 0)) continue;
    total += secs;
    if (activityLoad(a, thresholds, null).value !== null) scored += secs;
  }
  return total > 0 ? Math.round((scored / total) * 1000) / 1000 : null;
}

/* The 42-day average at `asOf` from the synced sessions, started from the mean
   daily load of the window's first days so a short window is not read as a low
   level (PLAN_MODEL.garmin.warmStartDays). */
function syncedCtl(activities, thresholds, { from, asOf }) {
  const inWindow = activities.filter((a) => a?.date >= from && a.date <= asOf);
  const { byDate } = dailyLoads(inWindow, thresholds, new Map());
  const days = PLAN_MODEL.garmin.warmStartDays;
  let seed = 0;
  for (let i = 0; i < days; i++) seed += byDate[shift(from, i)] ?? 0;
  const series = ewma(byDate, { from, to: asOf, days: LOAD.chronicDays, seed: seed / days });
  return series.length ? series[series.length - 1].value : null;
}

/**
 * The athlete's fitness at the end of a past day, from their synced sessions —
 * what the weekly review re-anchors a season to once some of it has been
 * trained. `{ ctl, scoredShare }`, or null when the sync does not reach the
 * date, began too recently to read a level from, or mostly could not be
 * scored. Scored the same way and by the same bar as `startFitness`: power,
 * pace, swim pace and session effort, never heart rate.
 */
export function actualCtlAt({
  date, activities = [], activitySync = null, benchmarks = [], loadRefs = null,
} = {}) {
  const sync = activitySync && activitySync.from && activitySync.through ? activitySync : null;
  const acts = Array.isArray(activities) ? activities : [];
  if (!sync || !parseISO(date) || sync.through < date) return null;
  if (sync.from > shift(date, 1 - HISTORY_THRESHOLDS.minCovered * 7)) return null;
  const thresholds = loadThresholds({ benchmarks, loadRefs });
  const share = scoredShare(acts, thresholds, { from: sync.from, asOf: date });
  if (share === null || share < PLAN_MODEL.garmin.scoredShare) return null;
  const ctl = syncedCtl(acts, thresholds, { from: sync.from, asOf: date });
  return ctl === null ? null : { ctl: round1(ctl), scoredShare: share };
}

/** A stored start, in words — from the source and the weeks it was read from,
    which are all that is stored. Empty for anything that is not one. */
export function startNote(start) {
  switch (start?.source) {
    case 'garmin':
      return `From ${start.coveredWeeks ?? 'several'} weeks of your synced sessions, scored by power, pace, swim pace or session effort.`;
    case 'estimate':
      return 'An estimate from your recent weekly hours. Replace it if you know your number.';
    case 'entered':
      return 'Entered by you.';
    default:
      return '';
  }
}

/**
 * The athlete's fitness today, as `{ ctl, source, coveredWeeks, scoredShare,
 * asOf, note }`. `ctl` is null only when there is nothing to estimate from.
 *
 * @param {object} [opts]
 * @param {string} opts.today        ISO date
 * @param {object[]} [opts.activities]    `plan.activities`
 * @param {object} [opts.activitySync]    `plan.activitySync`
 * @param {object[]} [opts.benchmarks]    `plan.benchmarks`, for the run threshold
 * @param {object} [opts.loadRefs]        `plan.loadRefs`: FTP and CSS
 * @param {object} [opts.athlete]         the About you record (recent hours, years, levels)
 * @param {number|string} [opts.entered]  a figure the athlete typed
 */
export function startFitness({
  today, activities = [], activitySync = null, benchmarks = [], loadRefs = null, athlete = null, entered,
} = {}) {
  const acts = Array.isArray(activities) ? activities : [];
  // Heart-rate thresholds are deliberately not passed: with none, that method cannot apply.
  const thresholds = loadThresholds({ benchmarks, loadRefs });

  const sync = activitySync && activitySync.from && activitySync.through ? activitySync : null;
  const { summary } = trainingHistory(acts, {
    today, weeks: HISTORY_THRESHOLDS.lookback + 2, sync,
  });
  const coveredWeeks = summary.coveredWeeks;

  // Nothing after the last synced day is known, so it is not read as days off.
  const asOf = sync ? (sync.through < today ? sync.through : today) : null;
  const share = sync ? scoredShare(acts, thresholds, { from: sync.from, asOf }) : null;
  const base = { coveredWeeks, scoredShare: share, asOf: asOf ?? today };

  const typed = enteredCtl(entered);
  if (typed !== null) {
    return { ...base, ctl: typed, source: 'entered', note: 'Entered by you.' };
  }

  const enough = coveredWeeks >= HISTORY_THRESHOLDS.minCovered;
  const scoreable = share !== null && share >= PLAN_MODEL.garmin.scoredShare;
  if (sync && enough && scoreable) {
    const ctl = syncedCtl(acts, thresholds, { from: sync.from, asOf });
    if (ctl !== null) {
      return {
        ...base,
        ctl: round1(ctl),
        source: 'garmin',
        note: `From ${coveredWeeks} weeks of your synced sessions, scored by power, pace, swim pace or session effort.`,
      };
    }
  }

  const estimate = estimateCtl(athlete);
  if (estimate === null) {
    return {
      ...base,
      ctl: null,
      source: 'estimate',
      note: 'Give the hours a week you train now and this can be estimated.',
    };
  }

  let why = 'An estimate from your recent weekly hours. Replace it if you know your number.';
  if (sync && !enough) {
    why = `Fewer than ${HISTORY_THRESHOLDS.minCovered} weeks of synced sessions so far, so this is an estimate from your recent weekly hours.`;
  } else if (sync && enough && !scoreable) {
    why = 'Most of your synced time could not be scored, so this is an estimate from your recent weekly hours. '
      + 'Add your FTP, swim CSS or a running result to use your sessions.';
  }
  return { ...base, ctl: estimate, source: 'estimate', note: why };
}
