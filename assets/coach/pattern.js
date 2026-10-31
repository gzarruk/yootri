/* The weekly pattern: which days a discipline's sessions take, and how many of
   them a block has.

   `profile.weekPattern` lists days per discipline in priority order, and
   `profile.sessionCounts` says how many of those a block uses (see profile.js).
   This module answers the two questions that follow, and nothing else — it
   knows nothing about minutes, so the generator, the validator and the planner
   can all ask it and never disagree about where a session goes:

     - `resolveCounts`  how many sessions each discipline has in a block
     - `patternSlots`   which days those sessions take
     - `nextDrop`       which session goes when a small week cannot hold them all

   Pure: no DOM, no I/O. It takes the block's family as an argument rather than
   importing generate.js, which imports this. */

import { DAYS, DISCIPLINES, allowedDays, maxPerWeek } from './profile.js';

/** Counts resolve like splits: an exact block ("Base 3") beats its family
    ("Base"), per discipline. A discipline with no entry in either is simply
    absent from the answer, so a caller can tell "no opinion" from "none". */
export function resolveCounts(block, family, profile) {
  const table = profile?.sessionCounts;
  if (!table) return {};
  const out = {};
  for (const disc of DISCIPLINES) {
    const n = table[block]?.[disc] ?? table[family]?.[disc];
    if (n !== undefined) out[disc] = n;
  }
  return out;
}

/**
 * The days one discipline's sessions take: the first `count` days of its list
 * that can be used. A day that is closed, has no time (or less than `floor`
 * minutes, when the caller says what a session of this discipline needs), or is
 * ruled out by the athlete's constraints is skipped and the next listed day
 * takes the slot. If the list runs out the slot is dropped. `maxPerWeek` caps
 * the count first, silently — the pattern never asks for more than the cap.
 *
 * @returns {{days: string[], displaced: string[], lost: number}}
 *   `displaced` is each skipped day a later day took the place of; `lost` is
 *   how many slots the list could not fill.
 */
export function patternSlots(profile, disc, count, { closedDays = [], floor = 1 } = {}) {
  const list = profile?.weekPattern?.[disc] ?? [];
  const wanted = Math.max(0, Math.min(Math.trunc(Number(count)) || 0, list.length, maxPerWeek(profile, disc)));
  const allowed = allowedDays(profile, disc);
  const usable = (d) => !closedDays.includes(d) && allowed.includes(d) && (profile.availability[d] || 0) >= floor;

  const days = [];
  const skipped = [];
  for (const d of list) {
    if (days.length === wanted) break;
    if (usable(d)) days.push(d);
    else skipped.push(d);
  }
  // A skipped day only counts as displaced if a later day took its place.
  const lastTaken = days.length ? list.indexOf(days[days.length - 1]) : -1;
  return {
    days,
    displaced: skipped.filter((d) => list.indexOf(d) < lastTaken),
    lost: wanted - days.length,
  };
}

/**
 * The first days of a discipline's list that `count` sessions need, and, for
 * each one this athlete's week cannot use, why. This is the profile's own
 * answer — a day with no time, a constraint — not a given week's: a race day
 * closes a day in the one week it falls in, which is expected and not asked
 * about here. The validator reads it to say so once for the season.
 *
 * @returns {{day: string, why: 'no-time'|'constraint'}[]} only the unusable ones
 */
export function unusableNeeded(profile, disc, count) {
  const list = profile?.weekPattern?.[disc] ?? [];
  const wanted = Math.max(0, Math.min(Math.trunc(Number(count)) || 0, list.length, maxPerWeek(profile, disc)));
  const out = [];
  for (const day of list.slice(0, wanted)) {
    if (!((profile.availability[day] || 0) > 0)) out.push({ day, why: 'no-time' });
    else if (!allowedDays(profile, disc).includes(day)) out.push({ day, why: 'constraint' });
  }
  return out;
}

/** Where a week that cannot hold every session gives them up, in order. Written
    down in docs/FINDINGS.md next to the measurement. */
export const DROP_ORDER = ['extra strength', 'extra swim', 'easy bike or run'];

/**
 * The next session to drop from a week that cannot hold them all, or null when
 * every session left is one that stays: the long ride, the long run, and a
 * discipline's only session. Deterministic:
 *
 *   1. strength beyond the first, the last-listed day first;
 *   2. swims beyond the first, the last-listed day first;
 *   3. the shortest easy ride or run (ties: the later slot, then the ride).
 *
 * @param {{disc: string, day: string, minutes: number, rank: number, isLong: boolean}[]} sessions
 *   `rank` is the session's place in its discipline's slot list.
 * @param {object[]} [within] only these may be chosen (one day's sessions, say);
 *   whether a session is a discipline's only one is still counted over all of
 *   `sessions`.
 */
export function nextDrop(sessions, within = sessions) {
  const count = (disc) => sessions.filter((s) => s.disc === disc).length;
  const tier = (s) => (s.disc === 'Strength' ? 0 : s.disc === 'Swim' ? 1 : 2);
  const candidates = within
    .filter((s) => !s.isLong && count(s.disc) > 1)
    .sort((a, b) => tier(a) - tier(b)
      || (tier(a) === 2 ? a.minutes - b.minutes : 0)
      || b.rank - a.rank
      || a.disc.localeCompare(b.disc)
      || DAYS.indexOf(b.day) - DAYS.indexOf(a.day));
  return candidates[0] ?? null;
}

/** How many sessions a recovery week gives up: one when the pattern holds fewer
    than eight, two from eight. */
export const recoveryDropCount = (slotCount) => (slotCount < 8 ? 1 : 2);
