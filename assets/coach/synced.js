/* Activities synced from the Garmin bridge (tools/garmin-bridge).

   The bridge runs on the athlete's own computer and answers the page on
   127.0.0.1; this module is what the page does with the answer. It is pure —
   the page does the fetching and the storage — so everything here is testable
   without a browser.

   **Heart rate crosses one boundary and no further.** The bridge sends average
   and maximum heart rate per activity. `splitSynced` is the only function that
   reads them: it hands them back *separately*, for the page to keep in this
   browser's own storage, and returns an activity that carries none of it. That
   activity is what goes on the plan, and a plan syncs to the cloud and exports
   to a file — so heart rate never being on a plan is what keeps it off both.
   `normalizeSyncedActivity` is an allowlist for the same reason: `loadPlan`
   runs it too, so a plan file somebody edited by hand cannot put a heart-rate
   field back.

   Activities are history, not plan content. Storing one changes no session, so
   it is written directly rather than through a draft — the same exception
   `commitBenchmarks` makes, for the same reason. */

import { parseISO, toISO, addDays } from './dates.js';

export const SYNC_SOURCES = Object.freeze(['garmin']);
export const SYNCED_DISCIPLINES = Object.freeze(['Swim', 'Bike', 'Run', 'Strength', 'Other']);

/* How much history a plan carries. A plan is stored as a single cloud document,
   so this is bounded by size as much as by use: 600 activities is about 140 KB,
   which leaves most of the document for the plan itself. */
export const MAX_ACTIVITIES = 600;
export const KEEP_DAYS = 400;

/* The first sync reaches back half a year; later ones overlap the last by a few
   days, so an activity uploaded late (a watch that synced the next morning) is
   still picked up. The bridge refuses a wider window than MAX_RANGE_DAYS. */
export const FIRST_SYNC_DAYS = 182;
export const OVERLAP_DAYS = 3;
export const MAX_RANGE_DAYS = 400;

export const NAME_MAX = 80;

/* Plausible heart rates. A value outside these is a sensor fault, and keeping
   it would only mislead whatever reads it later. */
const HR_AVG = [30, 240];
const HR_MAX = [30, 250];

const LEFT_OUT = new Set(['Multisport', 'Transition']);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const STORED_ID_RE = /^([a-z]+):([A-Za-z0-9_-]{1,40})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SPORT_RE = /^[a-z0-9_]{1,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

const isoDay = (v) => {
  const d = parseISO(v);
  return d && toISO(d) === String(v) ? String(v) : null;
};
const shiftDays = (iso, n) => toISO(addDays(parseISO(iso), n));
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

/** A positive integer no larger than `max`, or undefined. */
const bounded = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n) : undefined;
};

const cleanName = (v) => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(CONTROL, '').trim().slice(0, NAME_MAX);
  return s || undefined;
};

const cleanRpe = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 10) return undefined;
  return Math.round(n * 10) / 10;
};

/** Drop undefined keys, so a stored record never carries a null. */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * One activity as a plan may store it, or null. The allowlist: every key is
 * named here, and nothing else survives — least of all heart rate.
 */
export function normalizeSyncedActivity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = STORED_ID_RE.exec(String(raw.id ?? ''));
  if (!id || !SYNC_SOURCES.includes(id[1]) || raw.source !== id[1]) return null;
  const date = isoDay(raw.date);
  const durationS = bounded(raw.durationS, 2 * 86400);
  if (!date || !durationS) return null;
  if (LEFT_OUT.has(raw.disc)) return null;
  const disc = SYNCED_DISCIPLINES.includes(raw.disc) ? raw.disc : 'Other';
  const movingS = bounded(raw.movingS, 2 * 86400);
  const sport = String(raw.sport ?? '').trim().toLowerCase();

  return compact({
    id: raw.id,
    source: raw.source,
    date,
    time: TIME_RE.test(raw.time) ? raw.time : undefined,
    sport: SPORT_RE.test(sport) ? sport : undefined,
    disc,
    name: cleanName(raw.name),
    durationS,
    movingS: movingS && movingS <= durationS ? movingS : undefined,
    distanceM: bounded(raw.distanceM, 1_000_000),
    avgPowerW: bounded(raw.avgPowerW, 2500),
    normPowerW: bounded(raw.normPowerW, 2500),
    rpe: cleanRpe(raw.rpe),
    race: raw.race === true ? true : undefined,
  });
}

/**
 * Split one bridge record into what a plan may store and what stays in this
 * browser. The only reader of `hr`. Null when the record is not usable.
 */
export function splitSynced(raw, { source = 'garmin' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!SYNC_SOURCES.includes(source) || !ID_RE.test(String(raw.id ?? ''))) return null;
  const activity = normalizeSyncedActivity({
    id: `${source}:${raw.id}`,
    source,
    date: raw.date,
    time: raw.time,
    sport: raw.sport,
    disc: raw.disc,
    name: raw.name,
    durationS: raw.durationS,
    movingS: raw.movingS,
    distanceM: raw.distanceM,
    avgPowerW: raw.avgPowerW,
    normPowerW: raw.normPowerW,
    rpe: raw.rpe,
    race: raw.race,
  });
  if (!activity) return null;
  const avg = bounded(raw.hr?.avg, 400) ?? null;
  const max = bounded(raw.hr?.max, 400) ?? null;
  const hr = avg || max ? { id: activity.id, date: activity.date, avg, max } : null;
  return { activity, hr };
}

const byStart = (a, b) =>
  a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id);

/** Clean, deduplicated (a later copy wins), oldest first, the newest `cap` kept. */
export function normalizeActivities(list, { cap = MAX_ACTIVITIES } = {}) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const raw of list) {
    const a = normalizeSyncedActivity(raw);
    if (a) byId.set(a.id, a);
  }
  const out = [...byId.values()].sort(byStart);
  return cap > 0 && out.length > cap ? out.slice(out.length - cap) : out;
}

/** A bridge response's activities, split. `rejected` counts what was unusable. */
export function ingestSynced(list, { source = 'garmin' } = {}) {
  const activities = [];
  const hr = [];
  let rejected = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const split = splitSynced(raw, { source });
    if (!split) { rejected++; continue; }
    activities.push(split.activity);
    if (split.hr) hr.push(split.hr);
  }
  return { activities: normalizeActivities(activities, { cap: 0 }), hr, rejected };
}

/**
 * Fold a sync into what the plan already holds. An activity seen again replaces
 * the stored copy (Garmin lets you rename and edit); anything older than
 * `keepDays` before `today` is let go, and the newest `cap` are kept.
 */
export function mergeActivities(existing, incoming, { today = null, keepDays = KEEP_DAYS, cap = MAX_ACTIVITIES } = {}) {
  const held = new Map(normalizeActivities(existing, { cap: 0 }).map((a) => [a.id, a]));
  let added = 0;
  let updated = 0;
  for (const a of normalizeActivities(incoming, { cap: 0 })) {
    const before = held.get(a.id);
    if (!before) added++;
    else if (JSON.stringify(before) !== JSON.stringify(a)) updated++;
    held.set(a.id, a);
  }
  let all = [...held.values()].sort(byStart);
  const total = all.length;
  const cutoff = isoDay(today) ? shiftDays(today, -keepDays) : null;
  if (cutoff) all = all.filter((a) => a.date >= cutoff);
  if (cap > 0 && all.length > cap) all = all.slice(all.length - cap);
  return { activities: all, added, updated, dropped: total - all.length };
}

/* ---- which days a plan has synced --------------------------------------- */

/** `{source, from, through, at}`: the span of days the plan's activities cover. */
export function normalizeActivitySync(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = isoDay(raw.from);
  const through = isoDay(raw.through);
  if (!SYNC_SOURCES.includes(raw.source) || !from || !through || from > through) return null;
  const at = Number(raw.at);
  return compact({ source: raw.source, from, through, at: Number.isFinite(at) && at >= 0 ? at : undefined });
}

/** The window to ask the bridge for next. */
export function nextSyncWindow(sync, {
  today, overlapDays = OVERLAP_DAYS, firstSyncDays = FIRST_SYNC_DAYS, maxRangeDays = MAX_RANGE_DAYS,
} = {}) {
  const until = isoDay(today);
  if (!until) return null;
  const held = normalizeActivitySync(sync);
  let since = held ? shiftDays(held.through, -overlapDays) : shiftDays(until, -firstSyncDays);
  if (since > until) since = until;
  if (daysBetween(since, until) > maxRangeDays) since = shiftDays(until, -maxRangeDays);
  return { since, until };
}

/**
 * The coverage after a sync of `since`…`until`. Coverage only ever describes
 * one unbroken span: a sync that leaves a gap after the last one starts it
 * again, because "covered" has to mean every day in it was asked for. It never
 * reaches further back than activities are kept.
 */
export function nextActivitySync(prev, { source = 'garmin', since, until, at } = {}) {
  const s = isoDay(since);
  const u = isoDay(until);
  if (!s || !u || s > u) return normalizeActivitySync(prev);
  const held = normalizeActivitySync(prev);
  let from = s;
  let through = u;
  if (held && held.source === source && s <= shiftDays(held.through, 1) && u >= shiftDays(held.from, -1)) {
    from = held.from < s ? held.from : s;
    through = held.through > u ? held.through : u;
  }
  const floor = shiftDays(through, -KEEP_DAYS);
  if (from < floor) from = floor;
  return normalizeActivitySync({ source, from, through, at });
}

/* ---- heart rate, in this browser only ----------------------------------- */

const inRange = (v, [lo, hi]) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/**
 * The device-only heart-rate store: `{v: 1, byId: {id: {d, a?, m?}}}`. Pure —
 * the page reads and writes it. Implausible values are dropped, entries older
 * than `keepDays` are let go, and the input is never mutated.
 */
export function mergeHrStore(store, entries, { today = null, keepDays = KEEP_DAYS } = {}) {
  const byId = {};
  const put = (id, d, a, m) => {
    const avg = inRange(a, HR_AVG);
    const max = inRange(m, HR_MAX);
    if (!STORED_ID_RE.test(id) || !isoDay(d)) return;
    if (avg === null && max === null) return;
    if (avg !== null && max !== null && max < avg) return;
    byId[id] = compact({ d, a: avg ?? undefined, m: max ?? undefined });
  };
  const held = store && typeof store === 'object' && store.byId && typeof store.byId === 'object' ? store.byId : {};
  for (const [id, e] of Object.entries(held)) put(id, e?.d, e?.a, e?.m);
  for (const e of Array.isArray(entries) ? entries : []) put(String(e?.id ?? ''), e?.date, e?.avg, e?.max);
  const cutoff = isoDay(today) ? shiftDays(today, -keepDays) : null;
  if (cutoff) for (const [id, e] of Object.entries(byId)) if (e.d < cutoff) delete byId[id];
  return { v: 1, byId };
}

/** The store as a lookup: activity id → `{avg, max}`. */
export function hrLookup(store) {
  const out = new Map();
  for (const [id, e] of Object.entries(mergeHrStore(store, []).byId)) {
    out.set(id, { avg: e.a ?? null, max: e.m ?? null });
  }
  return out;
}

/* ---- benchmarks ---------------------------------------------------------- */

/**
 * A synced run in the shape `benchmarkCandidates` reads, or null. The timer
 * time (`durationS`) is the effort's time, not the moving time: a race is run
 * against the clock, and moving time would flatter it.
 */
export function asRunEffort(a) {
  if (!a || a.disc !== 'Run' || !(a.distanceM > 0) || !(a.durationS > 0)) return null;
  return { date: a.date, distanceMeters: a.distanceM, timeSeconds: a.durationS, type: 'running', title: a.name ?? '' };
}

/* ---- what the page says when the bridge does not answer ----------------- */

const MISMATCH = 'This page and the Garmin bridge disagree about how to talk to each other. '
  + 'Update both to the same version of yootri.';

const BRIDGE_MESSAGES = {
  unreachable: 'The Garmin bridge did not answer. Start it with `make garmin` in a terminal on this computer, then sync again.',
  not_configured: 'This browser is not paired with a Garmin bridge yet. Start the bridge with `make garmin` and open the setup link it prints.',
  unauthorized: 'The bridge did not accept this browser’s pairing token. Paste the token `make garmin` prints into the Garmin setup panel again.',
  forbidden_origin: 'The bridge does not allow this page. Use yootri from http://localhost:8000, or start the bridge with `--allow-origin` set to this page’s address.',
  bad_host: 'The bridge only answers at 127.0.0.1 or localhost. Check the address in the Garmin setup panel.',
  not_found: MISMATCH,
  method_not_allowed: MISMATCH,
  bad_request: MISMATCH,
  bad_response: MISMATCH,
  api_version: MISMATCH,
  auth_required: 'The bridge is not signed in to Garmin. Run `make garmin-login` in a terminal, then sync again.',
  mfa_required: 'Garmin wants a verification code. Run `make garmin-login` in a terminal, then sync again.',
  rate_limited: 'Garmin is limiting requests from this network for now. Wait 15–60 minutes, then sync again.',
  unavailable: 'Garmin Connect could not be reached. Try again in a few minutes.',
  garmin_error: 'Garmin Connect refused the request. If it keeps happening, Garmin may have changed something the bridge relies on.',
  internal: 'Something went wrong inside the bridge. The terminal running `make garmin` may say more.',
};

export const BRIDGE_ERROR_CODES = Object.freeze(Object.keys(BRIDGE_MESSAGES));

/** A sentence for the athlete. `secure`: the page was served over https. */
export function bridgeErrorMessage(code, { secure = false } = {}) {
  const base = BRIDGE_MESSAGES[code] ?? BRIDGE_MESSAGES.internal;
  if (code !== 'unreachable' || !secure) return base;
  return base + ' If it is running: Safari does not let a secure page reach this computer, so use yootri '
    + 'from http://localhost:8000 (`make dev`) there. Chrome and Edge ask once whether this page may reach '
    + 'devices on your local network — allow it.';
}
