/* Strength sessions and the weights lifted in them.

   A session from the library (liftsessions.js) is done on a planned Strength
   session, and what was lifted goes on that session's log: `actual.lifts` is
   `{ session, kg }`, where `kg` maps `<exercise>-<set>` to the weight in
   kilograms. It travels with the plan the way every other logged figure does
   (sync, export, import), and it is read back here — history is worked out
   when asked for and never stored on its own.

   Pure: no DOM, no storage. The page keeps the half-finished session on this
   device until Finish, and only Finish writes anything to the plan. */

import { LIFT_SESSIONS } from './liftsessions.js';
import { dateOf } from './calendar.js';

export { LIFT_SESSIONS };

/** The order the six sessions come round in: Week A is C1, L1, C2; Week B is C3, L2, C4. */
export const ROTATION = ['c1', 'l1', 'c2', 'c3', 'l2', 'c4'];

const KEY_RE = /^[a-z0-9]{1,12}-\d{1,2}$/;
const MAX_KG = 500;
const MAX_ENTRIES = 60;

export const liftSessionById = (id) => LIFT_SESSIONS.find((s) => s.id === id) || null;

/** Coerce a log's `lifts` into `{ session, kg }`, or null. An allowlist: a weight
    that is not a positive number up to 500 is dropped, never rounded into one. */
export function normalizeLifts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const template = liftSessionById(String(raw.session ?? ''));
  if (!template) return null;
  const kg = {};
  const src = raw.kg && typeof raw.kg === 'object' && !Array.isArray(raw.kg) ? raw.kg : {};
  for (const [key, value] of Object.entries(src)) {
    if (!KEY_RE.test(key)) continue;
    if (value === '' || value == null) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_KG) continue;
    kg[key] = Math.round(n * 10) / 10;
    if (Object.keys(kg).length >= MAX_ENTRIES) break;
  }
  return { session: template.id, kg };
}

/** The tick boxes of one exercise, in the order they are drawn: `{ key, label }`. */
export function tickBoxes(item) {
  const out = [];
  for (let i = 1; i <= item.sets; i++) {
    if (item.perSide) {
      out.push({ key: `${item.id}-${i}-R`, label: 'Right' }, { key: `${item.id}-${i}-L`, label: 'Left' });
    } else {
      const label = item.weighted || item.sets === 1 ? 'Done' : `${item.unit || 'Set'} ${i}`;
      out.push({ key: `${item.id}-${i}`, label });
    }
  }
  return out;
}

/** Every tick box of a session, including the circuit's one "finished" box. */
export function sessionTicks(template) {
  const keys = [];
  for (const sec of template.sections) {
    if (sec.kind === 'circuit') { keys.push(`${sec.id}done`); continue; }
    for (const item of sec.items) for (const t of tickBoxes(item)) keys.push(t.key);
  }
  return keys;
}

/** How much of a session is ticked: `{ done, total }`. */
export function sessionProgress(template, ticks = {}) {
  const keys = sessionTicks(template);
  return { done: keys.filter((k) => ticks[k]).length, total: keys.length };
}

/** The lifts that take a weight, once each, with the sessions that have them. */
export function trackedLifts() {
  const seen = new Map();
  for (const s of LIFT_SESSIONS) {
    for (const sec of s.sections) {
      for (const item of sec.items) {
        if (!item.weighted) continue;
        const row = seen.get(item.id) || { id: item.id, name: item.name, sessions: [] };
        if (!row.sessions.includes(s.id)) row.sessions.push(s.id);
        seen.set(item.id, row);
      }
    }
  }
  return [...seen.values()];
}

function locate(plan, sessionId) {
  for (const [key, sessions] of Object.entries(plan.weeks ?? {})) {
    const found = (sessions || []).find((s) => s.id === sessionId);
    if (found) return { absWeek: Number(key.slice(1)), day: found.day };
  }
  return null;
}

/** The logged strength sessions, oldest first: `{ id, date, session, kg }`. A log
    whose session has since been deleted is skipped, since it has no date. */
export function liftLog(plan) {
  const out = [];
  for (const [id, actual] of Object.entries(plan?.actuals ?? {})) {
    const lifts = actual?.lifts ? normalizeLifts(actual.lifts) : null;
    if (!lifts) continue;
    const at = locate(plan, id);
    const date = at ? dateOf(plan.start, at.absWeek, at.day) : null;
    if (!date) continue;
    out.push({ id, date, session: lifts.session, kg: lifts.kg });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
}

/** The heaviest set of one lift in each session that did it, oldest first,
    newest `limit` of them: `{ id, date, kg }`. */
export function topSetSeries(plan, exerciseId, limit = 10) {
  const prefix = `${exerciseId}-`;
  const rows = [];
  for (const entry of liftLog(plan)) {
    const weights = Object.entries(entry.kg).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    if (weights.length) rows.push({ id: entry.id, date: entry.date, kg: Math.max(...weights) });
  }
  return rows.slice(-limit);
}

/** What one set weighed the last time it was logged (before `before`, a date, when
    given): the hint shown in an empty box. 0 when there is none. */
export function lastKg(plan, exerciseId, setNo, { before } = {}) {
  const key = `${exerciseId}-${setNo}`;
  const rows = liftLog(plan).filter((e) => e.kg[key] && (!before || e.date < before));
  return rows.length ? rows[rows.length - 1].kg[key] : 0;
}

/** Which session comes next in the rotation, from the one logged last. */
export function nextInRotation(plan) {
  const log = liftLog(plan);
  if (!log.length) return ROTATION[0];
  const last = log[log.length - 1].session;
  const at = ROTATION.indexOf(last);
  return ROTATION[(at + 1) % ROTATION.length];
}

/** The line a logged session carries in its note. */
export const liftNote = (template) => `${template.code} ${template.name}`;

/** A plan's actuals with every `lifts` field held to the allowlist, so a plan file
    edited by hand cannot carry anything else in it. Returns the same object when
    nothing needed changing, so a clean plan loads as it was. */
export function cleanActualLifts(actuals) {
  if (!actuals || typeof actuals !== 'object') return actuals;
  let out = actuals;
  for (const [id, a] of Object.entries(actuals)) {
    if (!a || typeof a !== 'object' || !('lifts' in a)) continue;
    const clean = normalizeLifts(a.lifts);
    if (JSON.stringify(clean) === JSON.stringify(a.lifts)) continue;
    if (out === actuals) out = { ...actuals };
    const { lifts, ...rest } = a;
    out[id] = clean ? { ...rest, lifts: clean } : rest;
  }
  return out;
}
