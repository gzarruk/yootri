/* Fitness, fatigue and form, and the lines the Fitness chart draws.

   Fitness is load.js's chronic training load (the 42-day average), fatigue its
   acute load (the 7-day average), and form their difference, as of today. On
   top of that this module draws three lines across a season, week by week:

     actual   what was done: the chronic average from synced activities
     planned  what the plan asks: the same average, fed by an *estimate* of each
              planned session's load
     trend    the actual average carried to race day, with the rest of the plan
              done at the rate the last four weeks were

   and one projection: the plan followed exactly from today to race day, which
   is also returned week by week as `followed` so the chart can draw it.

   **Nothing here is stored.** It is worked out when it is read, from the plan,
   its synced activities and the references load.js already uses, and returned
   as plain numbers. Heart-rate-derived loads reach it only through `hrById`,
   which the page reads from this browser's own store, so nothing derived from
   heart rate can land on a plan that syncs.

   **What is measured and what is estimated.** Actual load is load.js's,
   unchanged. A planned session has no power file and no pace, so its load is
   estimated from its duration and its zone through PLANNED.zoneIF, a table of
   one intensity per zone fed to the same formulas a real session goes through.
   A session with no zone to read — an endurance session with "—" — is counted
   in `unestimated` rather than guessed at.

   **Unfitted.** Every constant in PLANNED is a starting value, not a finding:
   the zone table, the RPE assumed for planned strength work, the cap on
   adherence, and the cut-offs for what the page calls low, neutral and high
   form. The 42/7-day windows are load.js's conventional ones. See
   ../yootri-rnd/FINDINGS.md (28 Sep and 16 Oct). */

import { parseISO, toISO, addDays } from './dates.js';
import { dateOf, weekIndexOf } from './calendar.js';
import { durToMin } from './duration.js';
import { LOAD, dailyLoads, ewma } from './load.js';

export const PLANNED = Object.freeze({
  // One intensity (a share of threshold) for each zone, evenly spaced so that
  // a range such as Z2–Z4 reads as its middle zone.
  zoneIF: Object.freeze({ 1: 0.55, 2: 0.7, 3: 0.85, 4: 1.0, 5: 1.15 }),
  strengthRpe: 5,           // load.js counts RPE 7 as threshold
  adherenceDays: 28,
  maxAdherence: 1.5,        // doing three times the plan does not project three times the fitness
  form: Object.freeze({ low: -10, high: 10 }),
  // A range of form often used on race day. Illustrative like the bands, not a target.
  raceForm: Object.freeze({ low: 5, high: 25 }),
});

/** Illustrative fitness ranges for each race distance: a guide to the eye, not a finding. */
export const FITNESS_BANDS = Object.freeze([
  Object.freeze({ key: 'olympic', name: 'Olympic', lo: 40, hi: 70 }),
  Object.freeze({ key: '70.3', name: '70.3', lo: 60, hi: 90 }),
  Object.freeze({ key: 'ironman', name: 'Ironman', lo: 80, hi: 115 }),
]);

const round1 = (n) => Math.round(n * 10) / 10;
const ENDURANCE = new Set(['Bike', 'Run', 'Swim', 'Brick']);

/** The intensity a zone label stands for: the mean of its two ends, or null. */
export function zoneIntensity(zone) {
  const zs = [...String(zone ?? '').matchAll(/Z([1-5])(?!\d)/g)].map((m) => Number(m[1]));
  if (!zs.length) return null;
  return (PLANNED.zoneIF[zs[0]] + PLANNED.zoneIF[zs[zs.length - 1]]) / 2;
}

/**
 * An estimate of one planned session's load: 0 for sessions that carry none
 * (rest, yoga, a session with no length), null for one that would carry some
 * but has nothing to be scored by.
 */
export function plannedLoad(session) {
  const mins = durToMin(session?.dur);
  if (!(mins > 0)) return 0;
  const hours = mins / 60;
  const disc = session?.disc;
  if (disc === 'Strength') return round1((mins * PLANNED.strengthRpe) / (60 * LOAD.thresholdRpe) * 100);
  if (!ENDURANCE.has(disc)) return 0;
  const IF = zoneIntensity(session.zone);
  if (IF === null) return null;
  return round1(hours * (disc === 'Swim' ? IF ** 3 : IF ** 2) * 100);
}

/** Where form sits: 0 low, 1 neutral, 2 high. Cut-offs are PLANNED.form's. */
export function formZone(form) {
  if (form < PLANNED.form.low) return { index: 0, name: 'Low' };
  if (form > PLANNED.form.high) return { index: 2, name: 'High' };
  return { index: 1, name: 'Neutral' };
}

/** Where race-day form sits against PLANNED.raceForm: 'below', 'within' or 'above'. */
export function raceFormPosition(form) {
  if (form < PLANNED.raceForm.low) return 'below';
  if (form > PLANNED.raceForm.high) return 'above';
  return 'within';
}

const EMPTY = Object.freeze({
  hasHistory: false, scored: 0, unscored: 0, missing: [], unestimated: 0,
  today: null, race: null, trend: null, adherence: null, weeks: [],
});
const empty = () => ({ ...EMPTY, missing: [], weeks: [] });

/** The planned estimate for every date the plan has a session on. */
function plannedByDate(plan, weeks) {
  const byDate = {};
  let unestimated = 0;
  for (let w = 0; w < weeks; w++) {
    const sessions = plan.weeks?.[`w${w}`];
    for (const s of Array.isArray(sessions) ? sessions : []) {
      const iso = dateOf(plan.start, w, s?.day);
      if (!iso) continue;
      const load = plannedLoad(s);
      if (load === null) { unestimated++; continue; }
      byDate[iso] = (byDate[iso] ?? 0) + load;
    }
  }
  return { byDate, unestimated };
}

/**
 * Carry the two averages forward one day at a time from `from` (exclusive),
 * whose values are `state`, to `to` (inclusive), adding `loadOn(date)` each day.
 * Calls `each(date, state)` after every day.
 *
 * Exported so the planner steps its averages with the very function the chart
 * does: a season built to arrive at a number and a chart that draws it cannot
 * then disagree about what a day of load does.
 */
export function carry(state, from, to, loadOn, each) {
  const kc = 1 - Math.exp(-1 / LOAD.chronicDays);
  const ka = 1 - Math.exp(-1 / LOAD.acuteDays);
  let { fit, fat } = state;
  for (let d = addDays(parseISO(from), 1), end = parseISO(to); d <= end; d = addDays(d, 1)) {
    const iso = toISO(d);
    const x = loadOn(iso);
    fit += kc * (x - fit);
    fat += ka * (x - fat);
    if (each) each(iso, { fit, fat });
  }
  return { fit, fat };
}

/**
 * Everything the Fitness chart, the two cards and the Status page show.
 * `today` is an ISO date; `thresholds` and `hrById` are what load.js takes.
 */
export function fitnessSeries(plan, { today, thresholds = {}, hrById = new Map() } = {}) {
  const N = Array.isArray(plan?.season) ? plan.season.length : 0;
  if (!plan || !parseISO(plan.start) || !N || !parseISO(today)) return empty();

  const start = plan.start;
  const planned = plannedByDate(plan, N);
  const acts = Array.isArray(plan.activities) ? plan.activities : [];
  const d = dailyLoads(acts, thresholds, hrById);
  const hasHistory = d.scored > 0;

  const firstDate = acts.map((a) => a?.date).filter(Boolean).sort()[0];
  const from = plan.activitySync?.from ?? firstDate ?? today;
  const covers = hasHistory && from <= today;
  const chronic = new Map();
  const acute = new Map();
  if (covers) {
    for (const p of ewma(d.byDate, { from, to: today, days: LOAD.chronicDays })) chronic.set(p.date, p.value);
    for (const p of ewma(d.byDate, { from, to: today, days: LOAD.acuteDays })) acute.set(p.date, p.value);
  }
  // Before the first synced day there was, as far as anything knows, no load.
  const at = (series, iso) => (iso < from ? 0 : series.get(iso));

  // Planned line: the same average, fed by the plan, starting from wherever the
  // actual one stood the day before the plan began (zero when it was not known).
  // A plan that has not begun yet starts from where the athlete is today: the
  // days between are not modelled, and zero would draw a plan for someone with
  // no fitness at all.
  const dayBefore = toISO(addDays(parseISO(start), -1));
  const seedDay = dayBefore > today ? today : dayBefore;
  const seed = covers && seedDay >= from ? at(chronic, seedDay) : 0;
  const plannedChronic = new Map();
  carry({ fit: seed, fat: 0 }, dayBefore, dateOf(start, N - 1, 'Sun'), (iso) => planned.byDate[iso] ?? 0,
    (iso, s) => plannedChronic.set(iso, s.fit));

  const state = covers ? { fit: chronic.get(today), fat: acute.get(today) } : null;
  const weekAgo = toISO(addDays(parseISO(today), -7));
  const todayOut = state && (() => {
    const fit = round1(state.fit);
    const fat = round1(state.fat);
    const pFit = round1(at(chronic, weekAgo));
    const pFat = round1(at(acute, weekAgo));
    return {
      fit, fat, form: round1(fit - fat),
      dFit: round1(fit - pFit), dFat: round1(fat - pFat), dForm: round1(round1(fit - fat) - round1(pFit - pFat)),
    };
  })();

  // The plan followed from today to race day, and the same at the rate the last
  // four weeks were followed.
  const raceDate = parseISO(plan.profile?.raceDate) ? plan.profile.raceDate : dateOf(start, N - 1, 'Sun');
  const windowFrom = (() => {
    const a = toISO(addDays(parseISO(today), 1 - PLANNED.adherenceDays));
    return a < start ? start : a;
  })();
  let plannedIn = 0;
  let actualIn = 0;
  for (const [iso, v] of Object.entries(planned.byDate)) if (iso >= windowFrom && iso <= today) plannedIn += v;
  for (const [iso, v] of Object.entries(d.byDate)) if (iso >= windowFrom && iso <= today) actualIn += v;
  const adherence = covers && plannedIn > 0
    ? Math.round(Math.min(PLANNED.maxAdherence, actualIn / plannedIn) * 1000) / 1000
    : null;

  let race = null;
  let trend = null;
  const trendByDate = new Map();
  const followedByDate = new Map();
  if (covers && today < raceDate) {
    const end = carry(state, today, raceDate, (iso) => planned.byDate[iso] ?? 0,
      (iso, s) => followedByDate.set(iso, s.fit));
    const fit = round1(end.fit);
    const fat = round1(end.fat);
    race = {
      date: raceDate, week: weekIndexOf(start, raceDate), fit, fat, form: round1(fit - fat),
      dFit: round1(fit - todayOut.fit), dFat: round1(fat - todayOut.fat), dForm: round1(round1(fit - fat) - todayOut.form),
    };
    if (adherence !== null) {
      const t = carry(state, today, raceDate, (iso) => (planned.byDate[iso] ?? 0) * adherence,
        (iso, s) => trendByDate.set(iso, s.fit));
      trend = round1(t.fit);
    }
  }

  const todayWeek = weekIndexOf(start, today);
  const weeks = Array.from({ length: N }, (_, w) => {
    const date = dateOf(start, w, 'Sun');
    const reading = w === todayWeek && date > today ? today : date;
    return {
      week: w,
      date,
      planned: round1(plannedChronic.get(date) ?? 0),
      actual: covers && w <= todayWeek && reading >= from ? round1(chronic.get(reading)) : null,
      actualFat: covers && w <= todayWeek && reading >= from ? round1(acute.get(reading)) : null,
      trend: trend !== null && w > todayWeek && trendByDate.has(date) ? round1(trendByDate.get(date)) : null,
      // The plan followed from today. A race before the week's Sunday ends the line on the race.
      followed: race !== null && w > todayWeek
        ? (followedByDate.has(date) ? round1(followedByDate.get(date)) : w === race.week ? race.fit : null)
        : null,
    };
  });

  return {
    hasHistory, scored: d.scored, unscored: d.unscored, missing: Object.keys(d.missing),
    unestimated: planned.unestimated, today: todayOut, race, trend, adherence, weeks,
  };
}

/**
 * Minutes trained in each discipline over the `days` days ending today, from
 * the synced activities: moving time where it was recorded, else total time.
 */
export function minutesByDiscipline(activities, { today, days = 28 } = {}) {
  const end = parseISO(today);
  if (!end || !Array.isArray(activities)) return {};
  const first = toISO(addDays(end, 1 - days));
  const out = {};
  for (const a of activities) {
    if (!a?.date || a.date < first || a.date > today) continue;
    const secs = Number(a.movingS) || Number(a.durationS) || 0;
    if (secs > 0) out[a.disc || 'Other'] = (out[a.disc || 'Other'] ?? 0) + secs / 60;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  return out;
}
