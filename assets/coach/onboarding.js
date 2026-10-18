/* The onboarding wizard's logic: the steps, what each one checks, what a
   returning athlete is not asked again, and how the answers become a season.

   The page draws the steps; everything that decides anything is here, pure and
   tested, the way the rest of the engine is. Nothing here stores anything or
   touches a plan in place — `buildPlanFromAnswers` hands back a new plan for
   the page to show in a review and only then save.

   Two records come out of one set of answers, and they are kept apart on
   purpose (see athlete.js): body measurements, background and equipment go to
   the athlete record via `athleteFromAnswers`; the week, the races, the
   thresholds and the running result go on the plan. Nothing from the first
   ever reaches the second. */

import { DAYS, DEFAULT_PROFILE, normalizeProfile } from './profile.js';
import { newPlan, refit, weekCount, sessionsAt, landingsDetail, isUntouchedPlan } from './plan.js';
import { planLandings, LONG_RUNWAY_WEEKS } from './season.js';
import { nextMonday, snapToMonday, weeksUntil, parseISO } from './dates.js';
import {
  RACE_TYPES, SECONDARY_RACE_TYPES, normalizeEvent, normalizeEvents, goalEvent, secondaryRaces, raceTypeLabel,
} from './events.js';
import { normalizeBenchmarks, currentBenchmark, upsertBenchmark, vdotFrom } from './paces.js';
import { normalizeLoadRefs } from './load.js';
import { normalizeAthlete, isEmptyAthlete } from './athlete.js';
import { trainingHistory } from './history.js';
import { HISTORY_THRESHOLDS } from './adapt.js';
import { validateSeason } from './validate.js';
import { durToMin } from './duration.js';

export const STEPS = ['welcome', 'about', 'background', 'thresholds', 'week', 'races', 'goal', 'review'];

/** The privacy notice says yootri is not for anyone under this age. */
export const MIN_AGE = 16;

/* The answer fields that belong to the athlete record rather than the plan. */
const ATHLETE_KEYS = [
  'birthYear', 'sex', 'heightCm', 'weightKg', 'yearsInSport', 'levels',
  'recentWeeklyHours', 'longestRideMin', 'longestRunMin', 'goal', 'goalTime',
];
const EQUIPMENT_KEYS = ['pool', 'openWater', 'indoorTrainer', 'powerMeter'];

const yearOf = (iso) => parseISO(iso)?.getUTCFullYear() ?? null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* "19 Oct 2026", for a sentence the athlete reads. Fixed English month names,
   not the locale's: the engine has no locale, and the message is text. */
const sayDate = (iso) => {
  const d = parseISO(iso);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : String(iso);
};

/**
 * The Monday the plan these answers describe starts on: the one the athlete
 * picked, moved forward to a Monday if it was not one and never into the past,
 * or — with none picked — the first Monday after today.
 *
 * This is not `mondayOf(today)`. That is the Monday *before* today, and a plan
 * built from it starts in a week that is already over (dates.js `nextMonday`).
 */
export function startOf(a, { today } = {}) {
  return a?.startDate ? snapToMonday(a.startDate, { today }) : nextMonday(today);
}

/** A wizard with nothing answered: a defensible week, and no assumptions. */
export function emptyAnswers() {
  return {
    availability: { ...DEFAULT_PROFILE.availability },
    levels: {},
    longRideDay: '',
    longRunDay: '',
    race: null,
    tuneUps: [],
    markers: [],
    prefilledFrom: {},
  };
}

/**
 * Answers already known, so a returning athlete is not asked twice: About you,
 * the current plan's week and preferences, its thresholds and running result,
 * and — when About you has none — recent weekly hours from synced Garmin
 * weeks. Never the old race: a new season is a new race.
 */
export function prefill({ athlete, plan = null, today, carry = null } = {}) {
  const a = normalizeAthlete(athlete);
  const out = emptyAnswers();
  if (carry) Object.assign(out, carriedAnswers(carry, { today }));
  for (const k of ATHLETE_KEYS) if (a[k] !== undefined) out[k] = structuredClone(a[k]);
  for (const k of EQUIPMENT_KEYS) if (a.equipment?.[k] !== undefined) out[k] = a.equipment[k];
  for (const k of Object.keys(out).filter((k) => ATHLETE_KEYS.includes(k))) out.prefilledFrom[k] = 'about-you';

  if (plan) {
    const prof = normalizeProfile(plan.profile);
    out.availability = { ...prof.availability };
    out.longRideDay = prof.longDays?.Bike ?? '';
    out.longRunDay = prof.longDays?.Run ?? '';
    if (prof.maxSessionsPerDay) out.maxSessionsPerDay = prof.maxSessionsPerDay;
    const swims = prof.constraints.find((c) => c.disc === 'Swim' && c.rule === 'maxPerWeek');
    if (swims) out.maxSwims = swims.value;

    const refs = normalizeLoadRefs(plan.loadRefs);
    if (refs?.ftpW) out.ftpW = refs.ftpW;
    if (refs?.cssSecPer100m) out.cssSecPer100m = refs.cssSecPer100m;
    const bm = currentBenchmark(normalizeBenchmarks(plan.benchmarks));
    if (bm) out.runResult = { distanceMeters: bm.distanceMeters, timeSeconds: bm.timeSeconds, date: bm.date };

    // The same bar the coach's history rules set before trusting a baseline.
    if (out.recentWeeklyHours === undefined && (plan.activities ?? []).length && today) {
      const { summary } = trainingHistory(plan.activities, {
        today, weeks: HISTORY_THRESHOLDS.lookback + 2, sync: plan.activitySync ?? null,
      });
      if (summary.coveredWeeks >= HISTORY_THRESHOLDS.minCovered && summary.avgMinutes > 0) {
        out.recentWeeklyHours = Math.round(summary.avgMinutes / 30) / 2;
        out.prefilledFrom.recentWeeklyHours = 'garmin';
      }
    }
  }
  return out;
}

/**
 * Races the athlete chose to keep when starting over, as wizard answers: the
 * A race (primary) is the season's race, B races (secondary) are tune-ups, and
 * anything else on the calendar is a marker. Only what is still to come.
 */
export function carriedAnswers(events, { today } = {}) {
  const future = normalizeEvents(events).filter((e) => !today || e.date >= today);
  const primary = goalEvent(future);
  return {
    race: primary ? { name: primary.name, date: primary.date, raceType: primary.raceType } : null,
    tuneUps: secondaryRaces(future).map((e) => ({ name: e.name, date: e.date, raceType: e.raceType })),
    markers: future.filter((e) => !e.priority).map((e) => ({ name: e.name, date: e.date, kind: e.kind, raceType: e.raceType, note: e.note })),
  };
}

/** Has this person used yootri before? Decides which welcome they see. */
export function isReturning({ athlete, plans = [] } = {}) {
  return !isEmptyAthlete(athlete) || plans.some((p) => p && !isUntouchedPlan(p));
}

const problem = (field, message) => ({ field, message });
const given = (v) => v !== undefined && v !== null && v !== '';

/* A value is usable when the athlete record keeps it. Used for every field the
   record owns, so the wizard and About you refuse exactly the same numbers. */
const keeps = (field, value) => normalizeAthlete({ [field]: value })[field] !== undefined;

/**
 * What is wrong with one step's answers, as `{ field, message }` — empty when
 * the step can be left. Each message names the field and says what would work,
 * so it can be shown beside the box as it is.
 */
export function stepProblems(step, a, { today } = {}) {
  const out = [];
  switch (step) {
    case 'about': {
      if (given(a.birthYear)) {
        if (!keeps('birthYear', a.birthYear)) out.push(problem('birthYear', 'That birth year could not be used.'));
        else if (yearOf(today) - Number(a.birthYear) < MIN_AGE) {
          out.push(problem('birthYear', `yootri is for athletes aged ${MIN_AGE} and over.`));
        }
      }
      if (given(a.weightKg) && !keeps('weightKg', a.weightKg)) out.push(problem('weightKg', 'Weight is in kilograms, between 30 and 250.'));
      if (given(a.heightCm) && !keeps('heightCm', a.heightCm)) out.push(problem('heightCm', 'Height is in centimetres, between 100 and 250.'));
      break;
    }
    case 'background': {
      // Optional: the season is sized by the week on the next step, not by this.
      if (given(a.recentWeeklyHours) && (!(Number(a.recentWeeklyHours) > 0) || !keeps('recentWeeklyHours', a.recentWeeklyHours))) {
        out.push(problem('recentWeeklyHours', 'Hours a week is between 0.5 and 40.'));
      }
      if (given(a.yearsInSport) && !keeps('yearsInSport', a.yearsInSport)) out.push(problem('yearsInSport', 'Years in triathlon is a whole number.'));
      if (given(a.longestRideMin) && !keeps('longestRideMin', a.longestRideMin)) out.push(problem('longestRideMin', 'That longest ride could not be used.'));
      if (given(a.longestRunMin) && !keeps('longestRunMin', a.longestRunMin)) out.push(problem('longestRunMin', 'That longest run could not be used.'));
      break;
    }
    case 'thresholds': {
      if (given(a.ftpW) && !normalizeLoadRefs({ ftpW: a.ftpW })?.ftpW) out.push(problem('ftpW', 'An FTP is a number of watts between 50 and 600.'));
      if (given(a.cssSecPer100m) && !normalizeLoadRefs({ cssSecPer100m: a.cssSecPer100m })?.cssSecPer100m) {
        out.push(problem('cssSecPer100m', 'CSS is a time per 100 m, between 0:50 and 5:00.'));
      }
      if (a.runResult) {
        const r = a.runResult;
        if (!parseISO(r.date) || (today && r.date > today)) out.push(problem('runResult', 'That result needs the date you ran it.'));
        else if (vdotFrom(r) === null) {
          out.push(problem('runResult', 'That distance and time work out faster than anybody has run. Check which box each went in.'));
        }
      }
      break;
    }
    case 'week': {
      const total = DAYS.reduce((sum, d) => sum + (Number(a.availability?.[d]) || 0), 0);
      if (!(total > 0)) out.push(problem('availability', 'Give at least one day some time to train.'));
      else {
        if (a.longRideDay && !(a.availability[a.longRideDay] > 0)) {
          out.push(problem('longRideDay', `${a.longRideDay} has no time set, so the long ride cannot go there.`));
        }
        if (a.longRunDay && !(a.availability[a.longRunDay] > 0)) {
          out.push(problem('longRunDay', `${a.longRunDay} has no time set, so the long run cannot go there.`));
        }
      }
      if (given(a.maxSwims) && !(Number.isInteger(Number(a.maxSwims)) && Number(a.maxSwims) >= 0 && Number(a.maxSwims) <= 14)) {
        out.push(problem('maxSwims', 'Swims a week is a whole number from 0 to 14.'));
      }
      break;
    }
    case 'races': {
      const r = a.race;
      const start = today ? startOf(a, { today }) : null;
      const chosen = given(a.startDate);
      if (chosen && !parseISO(a.startDate)) {
        out.push(problem('startDate', 'That start date could not be used.'));
      }
      if (!r || !parseISO(r.date) || !RACE_TYPES.includes(r.raceType) || (today && r.date <= today)) {
        out.push(problem('race', `Choose the race this season is for: ${RACE_TYPES.map(raceTypeLabel).join(' or ')}, on a date after today.`));
      } else if (start && r.date < start) {
        // A chosen start that lands after the race is the start's fault; with
        // none chosen, the race is simply sooner than the first Monday there is.
        if (chosen && parseISO(a.startDate)) {
          out.push(problem('startDate', `The plan would start on ${sayDate(start)}, after your race. Start on or before the week of the race.`));
        } else {
          out.push(problem('race', `The plan starts on Monday ${sayDate(start)}, so the race needs to be on or after that date.`));
        }
      }
      (a.tuneUps ?? []).forEach((t, i) => {
        const ok = t && parseISO(t.date) && SECONDARY_RACE_TYPES.includes(t.raceType)
          && (!today || t.date > today) && (!start || t.date >= start) && (!r?.date || t.date < r.date);
        if (!ok) {
          out.push(problem(`tuneUps.${i}`,
            `A tune-up race needs a distance and a date on or after ${start ? sayDate(start) : 'today'}, when the plan starts, and before your main race.`));
        }
      });
      break;
    }
    case 'goal': {
      if (a.goal === 'time' && normalizeAthlete({ goal: 'time', goalTime: a.goalTime }).goalTime === undefined) {
        out.push(problem('goalTime', 'A time goal needs the time, like 5:30.'));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/* Tune-ups as stored events. Ids are minted from `now` so a rebuild is
   deterministic, and kept apart from the primary's own `ev-<now>`. */
function tuneUpEvents(a, now) {
  return (a.tuneUps ?? [])
    .map((t, i) => normalizeEvent({
      id: `ev-${now.toString(36)}-${i + 1}`, name: t.name, date: t.date,
      kind: 'race', raceType: t.raceType, priority: 'secondary',
    }))
    .filter(Boolean);
}

/**
 * How long the season will be and where the tune-ups land — what the races
 * step shows while it is being filled in. `landings` is `planLandings`' own
 * answer, so a refused taper reads the same here as it will in the review.
 */
export function racePreview(a, { today, now = 0 } = {}) {
  const startISO = startOf(a, { today });
  const weeks = a.race?.date ? weeksUntil(startISO, a.race.date) : null;
  if (!weeks) return { startISO, weeks: null, landings: { applied: [], refused: [] }, longRunway: false };
  const landings = planLandings({ weeks, landings: landingsDetail({ start: startISO, events: tuneUpEvents(a, now) }) });
  return { startISO, weeks, landings, longRunway: weeks > LONG_RUNWAY_WEEKS };
}

/** The About you record these answers describe. Nothing from the plan side. */
export function athleteFromAnswers(a, { now = Date.now() } = {}) {
  const raw = { updatedAt: now };
  for (const k of ATHLETE_KEYS) if (a[k] !== undefined) raw[k] = a[k];
  const equipment = {};
  for (const k of EQUIPMENT_KEYS) if (typeof a[k] === 'boolean') equipment[k] = a[k];
  if (Object.keys(equipment).length) raw.equipment = equipment;
  return normalizeAthlete(raw);
}

const sameResult = (bm, r) => bm && r
  && bm.distanceMeters === r.distanceMeters && bm.timeSeconds === r.timeSeconds && bm.date === r.date;

/**
 * The season these answers describe, as a new plan — not saved, not adopted.
 *
 * It starts on the Monday `startOf` gives and ends on the main race. Its biggest week is the
 * time the athlete said they have (profile.js `peakHoursFor`), and tune-ups are
 * landed through the same refit the calendar uses. With `base` — the plan a returning athlete is leaving — the history and
 * the settings the wizard does not ask about come along: synced activities,
 * earlier running results, discipline splits, the week shape and any other
 * constraints.
 *
 * Nowhere to swim (no pool, no open water) is a swim cap of 0: the swim time
 * goes to the other sports rather than to sessions that cannot happen.
 */
export function buildPlanFromAnswers(a, { today, now = Date.now(), base = null, id } = {}) {
  const startISO = startOf(a, { today });
  const raceType = a.race.raceType;
  const tune = tuneUpEvents(a, now);
  const baseProfile = base ? normalizeProfile(base.profile) : null;

  const constraints = (baseProfile?.constraints ?? [])
    .filter((c) => !(c.disc === 'Swim' && c.rule === 'maxPerWeek'));
  const nowhereToSwim = a.pool === false && a.openWater !== true;
  const swimCap = nowhereToSwim ? 0 : (given(a.maxSwims) ? Number(a.maxSwims) : undefined);
  if (swimCap !== undefined) constraints.push({ disc: 'Swim', rule: 'maxPerWeek', value: swimCap });

  const profile = {
    ...(baseProfile?.splits ? { splits: baseProfile.splits } : {}),
    ...(baseProfile?.weekShape ? { weekShape: baseProfile.weekShape } : {}),
    availability: a.availability,
    constraints,
    longDays: { Bike: a.longRideDay, Run: a.longRunDay },
    maxSessionsPerDay: a.maxSessionsPerDay,
  };

  let benchmarks = normalizeBenchmarks(base?.benchmarks);
  if (a.runResult && vdotFrom(a.runResult) !== null && !sameResult(currentBenchmark(benchmarks), a.runResult)) {
    benchmarks = upsertBenchmark(benchmarks, {
      id: `bm-${now.toString(36)}`, ...a.runResult, source: 'manual', current: true,
    });
  }

  const name = String(a.planName ?? '').trim() || String(a.race.name ?? '').trim()
    || `${raceTypeLabel(raceType)} ${yearOf(a.race.date)}`;

  let plan = newPlan({
    name,
    startISO,
    raceDate: a.race.date,
    raceType,
    profile,
    benchmarks,
    activities: base?.activities,
    activitySync: base?.activitySync,
    loadRefs: normalizeLoadRefs({ ftpW: a.ftpW, cssSecPer100m: a.cssSecPer100m }),
    id,
    now,
  });
  plan.events = plan.events.map((e) => (e.priority === 'primary' && String(a.race.name ?? '').trim()
    ? { ...e, name: String(a.race.name).trim() } : e));

  // Markers carry no priority, so they change nothing about the season: they
  // are added after it is fitted, with ids minted from `now`.
  const markers = (a.markers ?? [])
    .map((m, i) => normalizeEvent({ ...m, id: `ev-${now.toString(36)}-m${i + 1}`, priority: null }))
    .filter(Boolean);

  if (tune.length) plan = refit({ ...plan, events: [...plan.events, ...tune] }, { weeks: weekCount(plan) });
  if (markers.length) plan.events = normalizeEvents([...plan.events, ...markers]);
  // Released a week at a time: week 1 now, each later week after the review of
  // the one before (review.js).
  plan.release = { through: 0 };
  return plan;
}

/**
 * What the review step shows before anything is saved: the season's length and
 * weekly hours, week 1 as it will appear on the calendar, and the validator's
 * issues — an `error` among them blocks the plan from being created, the same
 * rule an Apply follows.
 */
export function planReview(plan) {
  const weeks = plan.season.map((w) => ({ ...w, sessions: sessionsAt(plan, w.absWeek) }));
  const issues = validateSeason(weeks, {
    profile: plan.profile,
    refusedLandings: planLandings({ weeks: weekCount(plan), landings: landingsDetail(plan) }).refused,
  });
  const firstWeek = sessionsAt(plan, 0);
  return {
    weeks: weekCount(plan),
    hoursByWeek: plan.season.map((w) => w.hours),
    blocks: plan.season.map((w) => w.block),
    firstWeek,
    firstWeekMinutes: firstWeek.reduce((sum, s) => sum + durToMin(s.dur), 0),
    issues,
    blocked: issues.some((i) => i.level === 'error'),
  };
}

