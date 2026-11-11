/* Which synced activity was which planned session.

   A proposal, never a write. The page shows "9 of these match planned
   sessions", the athlete unticks whatever is wrong, and only then does anything
   get logged — through `setActual`, the same path the session modal uses, so
   `done` stays in step and the compliance rules see it exactly as they see a
   session logged by hand.

   The rule is deliberately plain: **same date, same discipline, one activity per
   session, the closest duration first** — a session Garmin Coach scheduled is
   forgiven `garminBonus` minutes, being the one the athlete was told to do. A session moved to another day is not
   chased across the week; it shows up as an extra, which the athlete can read
   and a day tolerance could later absorb. And a session the athlete already
   logged is theirs — an activity never overwrites an actual, because the
   athlete's own word about their session outranks the watch's.

   The two numbers below are hand-chosen and unfitted (see
   ../yootri-rnd/FINDINGS.md). */

import { durToMin } from './duration.js';
import { dateOf, weekIndexOf } from './calendar.js';
import { normalizeActual } from './actuals.js';

export const MATCH = Object.freeze({
  doneRatio: 0.8,   // at least this share of the planned minutes counts as done
  garminBonus: 10,  // minutes of duration gap forgiven a session Garmin Coach scheduled
  minMinutes: 10,   // anything shorter is a warm-up or a stray recording
  disciplines: Object.freeze(['Swim', 'Bike', 'Run', 'Strength']),
});

const minutesOf = (a) => Math.round((Number(a.durationS) || 0) / 60);
const byStart = (a, b) =>
  a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id);

/**
 * @param {object} plan
 * @param {object[]} activities  as stored on `plan.activities`
 * @param {{from?: string, to?: string, repoint?: boolean}} [window]  only consider
 *   activities in it. With `repoint`, a link an earlier match made and the athlete
 *   never touched (its minutes are still the activity's) is reconsidered, so a Garmin
 *   Coach session that arrived afterwards can take it: the proposal then carries
 *   `clears`, the sessions whose log it replaces.
 * @returns {{proposals: object[], extra: object[]}}
 */
export function matchActivities(plan, activities, { from = null, to = null, repoint = false } = {}) {
  const weeks = plan.season?.length ?? 0;
  const byId = new Map((Array.isArray(activities) ? activities : []).filter((a) => a && a.id).map((a) => [a.id, a]));
  // A link is movable when it is still exactly what a match wrote.
  const movable = (actual) => repoint && actual?.activityId && byId.has(actual.activityId)
    && actual.min === minutesOf(byId.get(actual.activityId)) && !actual.note;
  const linked = new Set(Object.values(plan.actuals ?? {})
    .filter((a) => !movable(a)).map((a) => a?.activityId).filter(Boolean));

  // Every matchable session, keyed by date and discipline.
  const open = new Map();
  const logged = new Set();
  let order = 0;
  for (let w = 0; w < weeks; w++) {
    for (const s of plan.weeks?.[`w${w}`] ?? []) {
      order++;
      const planned = durToMin(s.dur);
      if (!(planned > 0) || !MATCH.disciplines.includes(s.disc)) continue;
      const date = dateOf(plan.start, w, s.day);
      if (!date) continue;
      const key = `${date}|${s.disc}`;
      const have = plan.actuals?.[s.id];
      if (have && !movable(have)) { logged.add(key); continue; }
      if (!open.has(key)) open.set(key, []);
      open.get(key).push({ session: s, absWeek: w, date, planned, order, prior: have?.activityId ?? null });
    }
  }

  const extra = [];
  const note = (a, reason) =>
    extra.push({ activityId: a.id, date: a.date, disc: a.disc, min: minutesOf(a), reason });

  const candidates = new Map();
  const considered = (Array.isArray(activities) ? activities : [])
    .filter((a) => a && a.id && a.date && (!from || a.date >= from) && (!to || a.date <= to))
    .sort(byStart);

  for (const a of considered) {
    if (linked.has(a.id)) { note(a, 'already-linked'); continue; }
    if (!MATCH.disciplines.includes(a.disc)) { note(a, 'not-matchable'); continue; }
    if (minutesOf(a) < MATCH.minMinutes) { note(a, 'too-short'); continue; }
    const week = weekIndexOf(plan.start, a.date);
    if (week === null || week < 0 || week >= weeks) { note(a, 'outside-plan'); continue; }
    const key = `${a.date}|${a.disc}`;
    if (!open.has(key)) { note(a, logged.has(key) ? 'session-logged' : 'no-session'); continue; }
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(a);
  }

  const proposals = [];
  for (const [key, acts] of candidates) {
    const sessions = open.get(key);
    // Every pairing, best first: closest duration, then the longer activity (a
    // session done in full is likelier than a fragment of it), then ids so the
    // answer never depends on the order things arrived in.
    const pairs = [];
    for (const a of acts) {
      for (const x of sessions) {
        const gap = Math.abs(minutesOf(a) - x.planned) - (x.session.source === 'garmin' ? MATCH.garminBonus : 0);
        pairs.push({ a, x, gap });
      }
    }
    pairs.sort((p, q) => p.gap - q.gap || minutesOf(q.a) - minutesOf(p.a)
      || p.a.id.localeCompare(q.a.id) || p.x.session.id.localeCompare(q.x.session.id));

    const usedA = new Set();
    const usedS = new Set();
    for (const { a, x } of pairs) {
      if (usedA.has(a.id) || usedS.has(x.session.id)) continue;
      usedA.add(a.id);
      usedS.add(x.session.id);
      if (x.prior === a.id) continue; // already linked to the right session
      const min = minutesOf(a);
      const clears = sessions.filter((y) => y.prior === a.id).map((y) => y.session.id);
      proposals.push({
        ...(clears.length ? { clears } : {}),
        order: x.order,
        sessionId: x.session.id,
        absWeek: x.absWeek,
        date: x.date,
        disc: x.session.disc,
        plannedMin: x.planned,
        activityId: a.id,
        actual: normalizeActual({
          status: min >= MATCH.doneRatio * x.planned ? 'done' : 'partial',
          min,
          rpe: a.rpe,
          activityId: a.id,
        }),
      });
    }
    for (const a of acts) if (!usedA.has(a.id)) note(a, 'no-session');
  }

  // In the order the board shows the sessions.
  proposals.sort((p, q) => p.order - q.order);
  extra.sort((p, q) => p.date.localeCompare(q.date) || p.activityId.localeCompare(q.activityId));
  return { proposals: proposals.map(({ order: _, ...p }) => p), extra };
}
