/* What actually happened, as opposed to what was planned.

   A planner only needs the plan. A coach needs the gap between the plan and the
   week you really had — that gap is what the adaptation rules read, and it is
   the only thing that makes "your plan is too big for your life" answerable
   with evidence rather than opinion.

   Relationship to the existing `done` flag: `done` stays the canonical
   "completed" marker that the board, the completion percentage and the chart
   already read. Logging an actual keeps it in step rather than forking a second
   source of truth, and a plan that predates this module still reports its old
   `done` flags as completed sessions. */

import { durToMin } from './duration.js';

export const STATUSES = ['done', 'partial', 'missed', 'sick'];

/** Statuses that mean the session did not happen, whatever else was recorded. */
const ZERO_STATUSES = new Set(['missed', 'sick']);

const weekKey = (absWeek) => `w${absWeek}`;
const clone = (x) => structuredClone(x);

/** Coerce raw input (a form, or a model) into a stored actual, or null. */
export function normalizeActual(raw) {
  if (!raw || !STATUSES.includes(raw.status)) return null;

  let min = null;
  if (raw.min != null && raw.min !== '') {
    const n = Number(raw.min);
    if (Number.isFinite(n)) min = Math.max(0, Math.round(n));
  }

  let rpe = null;
  if (raw.rpe != null && raw.rpe !== '') {
    const n = Number(raw.rpe);
    if (Number.isFinite(n)) rpe = Math.min(10, Math.max(1, Math.round(n)));
  }

  // A session that did not happen has no duration, whatever was typed into the
  // form. RPE and note survive — "sick, felt terrible" is still worth keeping.
  if (ZERO_STATUSES.has(raw.status)) min = null;

  return { status: raw.status, min, rpe, note: String(raw.note ?? '').slice(0, 500) };
}

export function getActual(plan, sessionId) {
  return plan.actuals?.[sessionId] ?? null;
}

/**
 * Record (or clear, with `patch === null`) what happened for one session.
 * Returns a new plan; the input is untouched.
 */
export function setActual(plan, sessionId, patch) {
  const next = clone(plan);
  next.actuals = next.actuals ?? {};
  next.done = next.done ?? {};

  const actual = normalizeActual(patch);
  if (!actual) {
    delete next.actuals[sessionId];
    delete next.done[sessionId];
    return next;
  }

  next.actuals[sessionId] = actual;
  if (ZERO_STATUSES.has(actual.status)) delete next.done[sessionId];
  else next.done[sessionId] = true;
  return next;
}

/**
 * Minutes actually trained for one session.
 *
 * An explicit number always wins. Failing that, a session marked done or partial
 * counts as the time that was planned — the athlete did the session, they just
 * did not say how long it took. Missed and sick count as nothing.
 */
export function actualMinutes(plan, session) {
  const planned = durToMin(session.dur);
  const a = getActual(plan, session.id);

  // Plans predating this module carry only `done`; honour it.
  if (!a) return plan.done?.[session.id] ? planned : 0;

  if (ZERO_STATUSES.has(a.status)) return 0;
  if (a.min != null) return a.min;
  return planned;
}

/** Planned vs actual for a single week. */
export function weekCompliance(plan, absWeek) {
  const sessions = (plan.weeks?.[weekKey(absWeek)] ?? []).filter((s) => durToMin(s.dur) > 0);

  let plannedMinutes = 0;
  let actualMin = 0;
  let logged = 0;
  const rpes = [];

  for (const s of sessions) {
    plannedMinutes += durToMin(s.dur);
    actualMin += actualMinutes(plan, s);
    const a = getActual(plan, s.id);
    if (a || plan.done?.[s.id]) logged++;
    if (a?.rpe != null) rpes.push(a.rpe);
  }

  return {
    absWeek,
    plannedMinutes,
    actualMinutes: actualMin,
    ratio: plannedMinutes > 0 ? actualMin / plannedMinutes : 0,
    logged,
    sessions: sessions.length,
    meanRpe: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null,
  };
}

/** One compliance row per week, in season order — what the chart plots. */
export function seasonActuals(plan) {
  return plan.season.map((w) => weekCompliance(plan, w.absWeek));
}

/**
 * Compliance across the `n` weeks *before* `uptoWeek`, which is what the
 * adaptation rules ask about: how has the recent past actually gone?
 */
export function trailingCompliance(plan, uptoWeek, n = 2) {
  const first = Math.max(0, uptoWeek - n);
  const rows = [];
  for (let i = first; i < uptoWeek; i++) rows.push(weekCompliance(plan, i));

  const planned = rows.reduce((a, r) => a + r.plannedMinutes, 0);
  const actual = rows.reduce((a, r) => a + r.actualMinutes, 0);
  const rpes = rows.map((r) => r.meanRpe).filter((x) => x != null);

  return {
    weeks: rows.length,
    plannedMinutes: planned,
    actualMinutes: actual,
    ratio: planned > 0 ? actual / planned : 0,
    meanRpe: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null,
  };
}
