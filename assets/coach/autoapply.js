/* Applying the coach's own changes without a review, and writing them down.

   The athlete asked to be told what the coach changed, not to approve each
   change. This is the one gate every such change goes through, so the rule that
   protects the plan is in one place: the change is diffed and validated exactly
   as a reviewed one is, and one the validator calls impossible is refused —
   `error` still blocks, only the click is gone. A change that is applied leaves
   an entry in the change log with the weeks as they were, so asking the coach to
   undo it is exact.

   Pure: returns the new plan and the entry; the page stores both. The log lives
   on this device only (never on a plan, so never synced or exported). Entries
   say what changed in plain words — never why when the reason is a body figure,
   and never a sleep or heart-rate value. */

import { diffPlans, applyDraft } from './plan.js';

export const LOG_CAP = 30;
const SUMMARY_MAX = 280;
export const LOG_SOURCES = Object.freeze(['coach', 'garmin', 'release', 'rebalance', 'eased', 'match', 'revert']);

// What a change can alter besides a week's sessions.
const META_FIELDS = ['profile', 'season', 'weekBudgets', 'target', 'events', 'release'];
const wk = (i) => `w${i}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * @param {object} plan   the stored plan
 * @param {object} draft  a detached copy with the change made
 * @param {{now?: number, source: string, summary?: string, context?: string}} meta
 * @returns {{applied: true, plan: object, entry: object}
 *          | {applied: false, blocked: boolean, issues: object[]}}
 */
export function autoApply(plan, draft, { now = Date.now(), source, summary, context = '' } = {}) {
  const d = diffPlans(plan, draft);
  if (d.blocked) return { applied: false, blocked: true, issues: d.issues.filter((i) => i.level === 'error') };
  if (!d.weeks.length) return { applied: false, blocked: false, issues: [] };

  const before = {};
  for (const w of d.weeks) before[wk(w.absWeek)] = clone(plan.weeks?.[wk(w.absWeek)] ?? []);
  // A change can reshape more than its weeks (a split or a pin re-sizes the season),
  // so what it touched beyond them is kept too, for an exact undo.
  const beforeMeta = {};
  for (const f of META_FIELDS) {
    if (JSON.stringify(plan[f] ?? null) !== JSON.stringify(draft[f] ?? null)) beforeMeta[f] = clone(plan[f] ?? null);
  }
  const entry = {
    id: `c${now}-${d.weeks.map((w) => w.absWeek).join('.')}`,
    at: now,
    source,
    summary: String((summary ?? describe(d)) + (context ? ' ' + context : '')).slice(0, SUMMARY_MAX),
    weeks: d.weeks.map((w) => w.absWeek + 1),
    before,
    ...(Object.keys(beforeMeta).length ? { beforeMeta } : {}),
  };
  return { applied: true, plan: applyDraft(plan, draft, { now }), entry };
}

const hm = (m) => `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
function describe(d) {
  const w = d.weeks;
  if (w.length === 1) return `Week ${w[0].absWeek + 1}: ${hm(w[0].beforeMinutes)} → ${hm(w[0].afterMinutes)}.`;
  return `${w.length} weeks changed, ${d.totalDeltaMinutes >= 0 ? '+' : '−'}${hm(Math.abs(d.totalDeltaMinutes))} in all.`;
}

/** A draft that puts a logged change's weeks back as they were, or null when the
    entry kept no copy (a match, say, which changes no session). */
export function revertDraft(plan, entry) {
  const before = entry?.before;
  if (!before || !Object.keys(before).length) return null;
  const draft = clone(plan);
  for (const [key, sessions] of Object.entries(before)) draft.weeks[key] = clone(sessions);
  for (const [f, v] of Object.entries(entry.beforeMeta ?? {})) {
    if (v === null) delete draft[f]; else draft[f] = clone(v);
  }
  return draft;
}

const text = (s) => String(s ?? '').slice(0, SUMMARY_MAX);

/** The log an entry is added to, newest first and capped. */
export function appendLog(log, entry) {
  return normalizeChangeLog([entry, ...(Array.isArray(log) ? log : [])]).slice(0, LOG_CAP);
}

/** An allowlist, as everything a store reads back is. */
export function normalizeChangeLog(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e.id !== 'string' || !Number.isFinite(e.at) || !LOG_SOURCES.includes(e.source)) continue;
    const entry = {
      id: e.id.slice(0, 64),
      at: e.at,
      source: e.source,
      summary: text(e.summary),
      weeks: (Array.isArray(e.weeks) ? e.weeks : []).filter(Number.isInteger).slice(0, 60),
    };
    if (e.before && typeof e.before === 'object') entry.before = e.before;
    if (e.beforeMeta && typeof e.beforeMeta === 'object') entry.beforeMeta = e.beforeMeta;
    out.push(entry);
    if (out.length >= LOG_CAP) break;
  }
  return out;
}
