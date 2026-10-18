/* Where a plan's races fall, what each one closes and what each one costs.

   The calendar, the season model and the planner all ask these. Everything else
   in plan.js counts weeks; events are dated. They live here, apart from
   plan.js, so the planner (backplan.js) can read them without importing the
   plan, which imports the planner. plan.js hands them back, so a caller that
   asked it for them still gets them.

   Every function takes anything carrying `start` and `events`, so a plan being
   built works as well as a stored one, and normalizes on the way in. `loadPlan`
   deliberately does not — events are the page's to clean — so an imported file
   or a coach-written list could otherwise reach the season model with a
   priority on a non-race. */

import { normalizeEvents, secondaryRaces, hasTaper, raceLoad } from './events.js';
import { weekIndexOf, weekdayOf, dateOf } from './calendar.js';
import { DAYS } from './profile.js';

/** The absolute weeks the plan's secondary races fall in — what `fitToRace`
    lands a taper and race week on. The primary race is not among them: it is
    the week the whole runway already ends on. */
export function landingsOf(plan) {
  return secondaryRaces(normalizeEvents(plan?.events))
    .map((ev) => weekIndexOf(plan?.start, ev.date))
    .filter((w) => Number.isInteger(w));
}

/**
 * The same landings with what each one needs: `{ absWeek, taper }`, where
 * `taper` is false for a race short enough to be a hard day in the build
 * (events.js `hasTaper`) and so gets neither a taper week nor a race week. This
 * is what `planLandings` and the planner are given; `landingsOf` is the weeks
 * alone, for a caller that only wants to know where the races are.
 */
export function landingsDetail(plan) {
  return secondaryRaces(normalizeEvents(plan?.events))
    .map((ev) => ({ absWeek: weekIndexOf(plan?.start, ev.date), taper: hasTaper(ev) }))
    .filter((l) => Number.isInteger(l.absWeek));
}

/**
 * The weekday a race falls on in a given week, or null when none does.
 *
 * Every race the athlete marked counts here, including one the season model
 * turned down for a taper: they are racing that day either way, so the week
 * should not schedule training on it. A marker with no priority does not — it
 * changes nothing by definition.
 *
 * Two races in one week give the earlier day, which is the conservative answer.
 */
export function raceDayFor(plan, absWeek) {
  return normalizeEvents(plan?.events)
    .filter((ev) => ev.kind === 'race' && ev.priority && weekIndexOf(plan?.start, ev.date) === absWeek)
    .map((ev) => weekdayOf(ev.date))
    .filter(Boolean)
    .sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b))[0] ?? null;
}

/**
 * What a week's races close, in the terms `generateWeek` takes: `raceDay`, the
 * earliest race day in the week (or null), and `raceOnly`, true when every race
 * that week is short enough to need no taper, so only its own day is cleared.
 * The race the season is built for, and any race with a taper, clears the rest
 * of its week as well. Two races of different kinds in one week clear from the
 * earlier day on: the conservative answer, as `raceDayFor` gives.
 */
export function raceClosure(plan, absWeek) {
  const raceDay = raceDayFor(plan, absWeek);
  if (!raceDay) return { raceDay: null, raceOnly: false };
  const races = normalizeEvents(plan?.events)
    .filter((ev) => ev.kind === 'race' && ev.priority && weekIndexOf(plan?.start, ev.date) === absWeek);
  const raceOnly = races.length > 0 && races.every((ev) => ev.priority === 'secondary' && !hasTaper(ev));
  return { raceDay, raceOnly };
}

/**
 * The load each tune-up race adds to the day it is on, as `{ date: load }`, for
 * the races inside a plan of `weeks` weeks. A race clears its own day of
 * training, so without this the planned fitness would read the athlete as
 * resting on it and run low from then on.
 *
 * Only a race that is not the one the season is built for: the plan is the way
 * to that one and stops on the day it arrives. A marker, and a race whose
 * length is not known, add nothing.
 */
export function plannedRaceLoads(plan, weeks) {
  const out = {};
  const n = Number(weeks);
  if (!plan?.start || !(n > 0)) return out;
  const last = dateOf(plan.start, n - 1, 'Sun');
  for (const ev of secondaryRaces(normalizeEvents(plan.events))) {
    const load = raceLoad(ev);
    if (load !== null && ev.date >= plan.start && ev.date <= last) out[ev.date] = (out[ev.date] ?? 0) + load;
  }
  return out;
}
