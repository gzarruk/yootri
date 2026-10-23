/* Plan-level operations: the boundary the UI and the coach agent both talk to.

   The rule this module exists to enforce is that **nothing edits a stored plan
   in place**. A change is made against a *draft* — a detached copy — which is
   then diffed, validated, shown to the athlete, and only written by applyDraft.

   That indirection is what makes an agent safe to point at a training plan. The
   model can propose whatever it likes; the worst it can do is produce a draft
   that gets rejected at the diff. It is also what makes an undo trivial, because
   the previous plan object is still intact. */

import { migratePlan } from './migrate.js';
import { normalizeProfile, peakHoursFor } from './profile.js';
import { fitToRace, planLandings } from './season.js';
import { generateWeek } from './generate.js';
import { validateSeason } from './validate.js';
import { durToMin, REST_DUR } from './duration.js';
import { DAYS } from './profile.js';
import { weeksUntil, parseISO, toISO } from './dates.js';
import { normalizeEvents, seedEventsFromProfile, goalEvent, AMBITIONS, DEFAULT_AMBITION } from './events.js';
import { planSeason, planLevers } from './backplan.js';
import { targetCtl } from './targets.js';
import { landingsDetail, raceClosure } from './races.js';
import { normalizeBenchmarks } from './paces.js';
import { normalizeActivities, normalizeActivitySync } from './synced.js';
import { normalizeLoadRefs } from './load.js';
import { setActual } from './actuals.js';

export { landingsOf, landingsDetail, raceDayFor, raceClosure } from './races.js';

const clone = (x) => structuredClone(x);
const weekKey = (absWeek) => `w${absWeek}`;

/** Bring a stored record up to date and make sure its profile is sane.

    Benchmarks are cleaned here too, which is a deliberate difference from
    `events`: the page normalizes those on its way into `state`, but benchmarks
    are read straight off the plan by the card renderer *and* by the coach tool.
    Cleaning them at the one door every reader comes through is what stops those
    two disagreeing about which result the paces came from.

    Synced activities are cleaned here for a stronger reason: this is the door a
    plan file, a cloud copy and local storage all come through, and the
    activity normalizer is an allowlist. A plan edited by hand to carry heart
    rate loses it here, before anything can sync or export it again. */
export function loadPlan(raw) {
  const p = migratePlan(raw);
  const target = normalizeTarget(p.target);
  const profile = normalizeProfile(p.profile);
  const benchmarks = normalizeBenchmarks(p.benchmarks);
  const activities = normalizeActivities(p.activities);
  const activitySync = normalizeActivitySync(p.activitySync) ?? undefined;
  const loadRefs = normalizeLoadRefs(p.loadRefs);
  const release = normalizeRelease(p.release, p.season?.length ?? 0);

  // Avoid handing back a needlessly different object for an already-clean plan,
  // so `loadPlan(loadPlan(x))` stays deep-equal to `loadPlan(x)`.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(profile, p.profile) && same(benchmarks, p.benchmarks)
    && same(activities, p.activities) && same(activitySync, p.activitySync)
    && same(loadRefs, p.loadRefs) && same(release, p.release) && same(target, p.target) && !('athlete' in p)) return p;
  const out = { ...p, profile, benchmarks, activities };
  // What the season was built to arrive with (normalizeTarget): kept if usable, absent if not.
  if (target) out.target = target;
  else delete out.target;
  // The release horizon (review.js): absent means the whole season is shown.
  if (release) out.release = release;
  else delete out.release;
  // The athlete record (athlete.js) is never plan content: it holds body
  // measurements, which sync only under their own consent, while a plan syncs
  // and exports under the ordinary one. Unknown top-level fields otherwise
  // travel, so this one is named and dropped.
  delete out.athlete;
  // No sync means no coverage — absent, not an empty span somebody could read
  // as "covered nothing". Load references likewise: absent until entered.
  if (activitySync) out.activitySync = activitySync;
  else delete out.activitySync;
  if (loadRefs) out.loadRefs = loadRefs;
  else delete out.loadRefs;
  return out;
}

/* ---- what a season was built to arrive with ------------------------------ */

const FEASIBILITY_STATUSES = ['build', 'hold'];
const LIMITING_FACTORS = ['availability', 'runway', 'ramp'];
const START_SOURCES = ['garmin', 'estimate', 'entered'];
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const tenth = (n) => Math.round(n * 10) / 10;

/**
 * A plan's `target`, cleaned: `{ ctl, start: { ctl, source, asOf?, coveredWeeks?,
 * scoredShare? }, feasibility? }`, or undefined when it cannot be used. Total: it
 * arrives from storage, a cloud copy and a plan file somebody edited, and must
 * never throw. An allowlist, like every other field a plan carries that someone
 * could put a stray value in: nothing derived from heart rate is stored here,
 * and a hand-edited file cannot put it back.
 *
 * `ctl` is the chronic training load the season was built to reach: the peak
 * before the taper when `at` is `'peak'`, and race day itself when `at` is absent,
 * which is how every target made before the peak existed reads. Only `'peak'` is
 * ever stored; `start` is the load the athlete started from and where that figure
 * came from (startfit.js); `feasibility` the planner's own record of whether the
 * target could be reached, how far short it came if not, and where race day comes
 * out when it was aimed at the peak (`raceCtl`; backplan.js).
 */
export function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw.start;
  if (!inRange(raw.ctl, 0.1, 400) || !s || typeof s !== 'object') return undefined;
  if (!inRange(s.ctl, 0, 400) || !START_SOURCES.includes(s.source)) return undefined;

  const start = { ctl: tenth(s.ctl), source: s.source };
  if (typeof s.asOf === 'string' && toISO(parseISO(s.asOf)) === s.asOf) start.asOf = s.asOf;
  if (inRange(s.coveredWeeks, 0, 60)) start.coveredWeeks = Math.round(s.coveredWeeks);
  if (inRange(s.scoredShare, 0, 1)) start.scoredShare = Math.round(s.scoredShare * 1000) / 1000;

  const out = { ctl: tenth(raw.ctl), start };
  if (raw.at === 'peak') out.at = 'peak';
  const f = raw.feasibility;
  if (f && typeof f === 'object' && typeof f.feasible === 'boolean' && FEASIBILITY_STATUSES.includes(f.status)
    && inRange(f.targetCtl, 0.1, 400) && inRange(f.achievableCtl, 0, 400) && inRange(f.shortfall, 0, 400)) {
    out.feasibility = {
      feasible: f.feasible,
      status: f.status,
      targetCtl: tenth(f.targetCtl),
      achievableCtl: tenth(f.achievableCtl),
      shortfall: tenth(f.shortfall),
      limitingFactor: LIMITING_FACTORS.includes(f.limitingFactor) ? f.limitingFactor : null,
    };
    if (inRange(f.raceCtl, 0, 400)) out.feasibility.raceCtl = tenth(f.raceCtl);
  }
  return out;
}

export const weekCount = (plan) => plan.season.length;

/**
 * What `planSeason` is given for a plan that has a target: its start, length,
 * profile, events, the fitness it was built from and to, and the weeks the
 * athlete pinned. Null for a plan with none, or with no race to aim at.
 */
export function targetInputOf(plan) {
  const t = normalizeTarget(plan?.target);
  const events = normalizeEvents(plan?.events);
  if (!t || !goalEvent(events) || !Array.isArray(plan?.season) || !plan.season.length) return null;
  return {
    start: plan.start, weeks: plan.season.length, profile: normalizeProfile(plan.profile), events,
    startCtl: t.start.ctl, targetCtl: t.ctl, targetAt: t.at === 'peak' ? 'peak' : 'raceDay', weekBudgets: plan.weekBudgets ?? {},
  };
}

/**
 * What would make a plan's target reachable when it is not: the earliest race
 * date, the highest lower ambition, the weekly hours, a shorter race that works
 * (backplan.js `planLevers`). Null when the target can be reached, or the plan
 * has none. Rebuilds the season several ways, so ask when it is to be shown.
 */
export function leversFor(plan) {
  const input = targetInputOf(plan);
  const f = normalizeTarget(plan?.target)?.feasibility;
  if (!input || !f || f.feasible) return null;
  return planLevers(input, { feasibility: f });
}

/**
 * A plan released one week at a time carries `release: { through }`, the last
 * week whose sessions are shown (review.js). A whole week inside the season, or
 * absent — which is every plan made before weekly release, shown whole as
 * before. A season that got shorter pulls the horizon in with it.
 */
export function normalizeRelease(raw, weeks) {
  const n = Number(raw?.through);
  if (!Number.isInteger(n) || n < 0 || !(weeks > 0)) return undefined;
  return { through: Math.min(n, weeks - 1) };
}

const clampWeek = (plan, absWeek) =>
  Math.max(0, Math.min(Number(absWeek) || 0, weekCount(plan) - 1));

/** Which block a week belongs to, clamped to the season rather than undefined. */
export function blockAt(plan, absWeek) {
  return plan.season[clampWeek(plan, absWeek)];
}

/** A *copy* of a week's sessions — callers must not be able to edit the plan
    just by holding a reference into it. */
export function sessionsAt(plan, absWeek) {
  return clone(plan.weeks[weekKey(clampWeek(plan, absWeek))] ?? []);
}

/** A new plan with one week replaced. Never mutates the input. */
export function setSessionsAt(plan, absWeek, sessions) {
  const next = clone(plan);
  next.weeks[weekKey(clampWeek(plan, absWeek))] = clone(sessions);
  return next;
}

/** An id for a session that has moved week. Deliberately unlike the generated
    `w{week}-{n}` ids, so regenerating the week it left cannot mint the same one
    a second time. */
const mintSessionId = (now = Date.now()) =>
  `mv-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Move a session onto a given week and weekday. Returns a new plan; the input
 * is untouched. Anything it cannot do — an id nothing holds, a week past the
 * end of the season, a weekday that does not exist — gives back the plan
 * exactly as it was: a drag that lands nowhere should do nothing, rather than
 * something approximate.
 *
 * Crossing a week boundary re-mints the session id and carries its completion
 * flag and logged actual across. That is not tidiness. Generated ids are
 * `w{week}-{n}`, so a session dragged out of week 3 still holds a week-3 id;
 * "Reset week" on week 3 mints that id again, and `done`, `actuals` and
 * `diffPlans` are all keyed by id — two live sessions sharing one silently
 * merges their history.
 *
 * @param {object} plan
 * @param {object} opts
 * @param {string} opts.id       session to move
 * @param {number} opts.toWeek   destination absolute week
 * @param {string} opts.day      destination weekday name
 * @param {function} [opts.mintId] injectable, so a test can name the new id
 */
export function moveSession(plan, { id, toWeek, day, mintId = mintSessionId } = {}) {
  const target = Number(toWeek);
  if (!DAYS.includes(day)) return plan;
  if (!Number.isInteger(target) || target < 0 || target >= weekCount(plan)) return plan;

  let from = null;
  for (const [key, sessions] of Object.entries(plan.weeks ?? {})) {
    if ((sessions ?? []).some((s) => s && s.id === id)) {
      from = Number(String(key).slice(1));
      break;
    }
  }
  if (!Number.isInteger(from)) return plan;

  const next = clone(plan);

  // Within one week only the day changes, so the id — and every reference to
  // it — can stay exactly where it is.
  if (from === target) {
    next.weeks[weekKey(target)] = next.weeks[weekKey(target)]
      .map((s) => (s.id === id ? { ...s, day } : s));
    return next;
  }

  const session = next.weeks[weekKey(from)].find((s) => s.id === id);
  next.weeks[weekKey(from)] = next.weeks[weekKey(from)].filter((s) => s.id !== id);

  const movedId = String(mintId());
  next.weeks[weekKey(target)] = [...(next.weeks[weekKey(target)] ?? []), { ...session, id: movedId, day }];

  for (const store of ['done', 'actuals']) {
    if (next[store] && id in next[store]) {
      next[store][movedId] = next[store][id];
      delete next[store][id];
    }
  }

  return next;
}

/** Total training minutes per week, indexed by absolute week. */
export function weekTotals(plan) {
  return plan.season.map((w) =>
    (plan.weeks[weekKey(w.absWeek)] ?? []).reduce((a, s) => a + durToMin(s.dur), 0),
  );
}

/* Where the races fall — `landingsOf`, `landingsDetail`, `raceDayFor` and
   `raceClosure` — is in races.js and handed back above. */

/**
 * One week's sessions, built afresh from the season the plan already stores.
 *
 * This is "Reset week": the same generator and the same race day a re-fit uses
 * for that week, so the two can never disagree about whether a race day is
 * clear. It reads the stored season rather than re-fitting it, which is what
 * keeps one week's reset from moving any other week.
 */
export function freshWeek(plan, absWeek) {
  const w = blockAt(plan, absWeek);
  return generateWeek({
    hours: w.hours,
    block: w.block,
    profile: plan.profile,
    idPrefix: weekKey(w.absWeek),
    ...raceClosure(plan, w.absWeek),
  }).sessions;
}

/* Size a season to a target, or say that it cannot be: null means "size it the
   old way". A season is built to a target when the plan already has one or the
   caller is upgrading it, there is a race to aim at, the race's distance has a
   band to take a target from, and there is a fitness to start from. Anything
   the planner cannot be given sensible input for is sized the old way too — a
   refit never throws a new kind of error. */
function solveSeason({ start, weeks, profile, events, weekBudgets, keep, frozen, anchorCtl, startInfo, upgraded, targetAt = 'peak' }) {
  const list = normalizeEvents(events);
  const main = goalEvent(list);
  if (!main || !startInfo || !(Number(startInfo.ctl) >= 0)) return null;
  const goal = targetCtl(profile.raceType, main.ambition);
  if (goal === null) return null;
  let result;
  try {
    result = planSeason({
      start, weeks, profile, events: list, startCtl: Number(startInfo.ctl), targetCtl: goal, targetAt,
      weekBudgets, keepBefore: keep, frozen, anchorCtl,
    });
  } catch {
    return null;
  }
  const target = normalizeTarget({ ctl: goal, at: targetAt === 'peak' ? 'peak' : undefined, start: startInfo, feasibility: result.feasibility });
  if (!target) return null;
  // A plan made before ambitions existed is read as the default level; written
  // onto the race, it is part of what the athlete sees when they apply this.
  const events2 = upgraded && !main.ambition
    ? list.map((e) => (e.id === main.id ? { ...e, ambition: DEFAULT_AMBITION } : e))
    : undefined;
  return { season: result.season, target, events: events2 };
}

/**
 * Re-fit the plan and hand back a draft. The stored plan is untouched.
 *
 * A plan with a `target` is re-sized to it, by backplan.js, from the fitness it
 * was built from. A plan with none is re-sized as it always was — **unless it
 * is being upgraded**, which only Plan setup, a change of race and the wizard
 * do: the weekly review and the coach's week-level tools leave a plan's sizing
 * as they found it, so one week's change never quietly re-sizes the season.
 *
 * @param {object} plan
 * @param {object} [opts]
 * @param {object} [opts.profile] replacement profile (availability, splits…)
 * @param {number} [opts.from]    first week to regenerate (default: all)
 * @param {number} [opts.to]      last week to regenerate, inclusive
 * @param {number} [opts.keepBefore] weeks before this one are kept exactly as
 *        they were, sessions and planned hours alike — the weeks already trained.
 *        A change to the profile or the race reshapes what is still to come, not
 *        the record of what was planned for the weeks behind it.
 * @param {boolean} [opts.upgrade] size a plan that has no target to one, from `start`
 * @param {object} [opts.start]   where the athlete starts: `startFitness`'s answer
 *        (kept as `target.start`); a plan with a target uses its own unless given
 * @param {number} [opts.anchorCtl] the athlete's fitness at the end of the last
 *        kept week, when it is known better than the plan's own figure for it
 */
export function refit(plan, {
  profile, from = 0, to = Infinity, weeks, keepBefore = 0, upgrade = false, start, anchorCtl,
} = {}) {
  const draft = clone(plan);
  draft.profile = normalizeProfile(profile ?? plan.profile);

  // The length is kept unless a caller passes one: the race date has not moved
  // just because the hours did, but when it *has* moved the runway genuinely changes.
  const n = Number.isFinite(weeks) && weeks > 0 ? Math.round(weeks) : weekCount(plan);
  const keep = Math.max(0, Math.floor(Number(keepBefore) || 0));
  const pinned = draft.weekBudgets ?? {};

  const wanted = plan.target || upgrade ? (start ?? plan.target?.start ?? null) : null;
  // A target made before it meant the peak has no `at`, and goes on being
  // re-sized for race day until somebody deliberately moves it: only Plan setup,
  // a change of race and the wizard pass `upgrade`. The weekly review and the
  // coach's week tools must never re-aim a season that is under way.
  const targetAt = plan.target && plan.target.at !== 'peak' && !upgrade ? 'raceDay' : 'peak';
  const frozen = (plan.season ?? []).slice(0, Math.min(keep, n));
  const solved = wanted ? solveSeason({
    start: draft.start, weeks: n, profile: draft.profile, events: draft.events, weekBudgets: pinned,
    keep: frozen.length, frozen,
    anchorCtl: Number.isFinite(anchorCtl) ? anchorCtl
      : (frozen.length && Number.isFinite(frozen.at(-1)?.ctl) ? frozen.at(-1).ctl : undefined),
    startInfo: wanted, upgraded: !plan.target, targetAt,
  }) : null;

  if (solved) {
    draft.season = solved.season;
    draft.target = solved.target;
    if (solved.events) draft.events = solved.events;
  } else {
    // Sized the old way. A target the season was not built to would only mislead.
    delete draft.target;

    // Re-resolve the season whenever the budget changes.
    draft.season = fitToRace({
      peakHours: peakHoursFor(draft.profile),
      weeks: n,
      // Tune-up races come out of the block they fall in. Read off the draft, so
      // a caller that changed the events and the profile in one go gets both.
      landings: landingsDetail(draft),
    });

    // Reapply any pinned per-week budgets on top. Without this, "make next week
    // 4 hours" followed by any change that refits the season would silently undo
    // itself — including two tool calls made by the coach in the same turn.
    draft.season = draft.season.map((w) => {
      const hours = Number(pinned[weekKey(w.absWeek)]);
      return Number.isFinite(hours) && hours >= 0 ? { ...w, hours } : w;
    });

    if (keep) {
      draft.season = draft.season.map((w) =>
        (w.absWeek < keep && plan.season?.[w.absWeek] ? { ...plan.season[w.absWeek], absWeek: w.absWeek } : w));
    }
  }

  const first = Math.max(0, from, keep);
  const last = Math.min(weekCount(draft) - 1, to);

  const build = (w) => generateWeek({
    hours: w.hours,
    block: w.block,
    profile: draft.profile,
    idPrefix: weekKey(w.absWeek),
    ...raceClosure(draft, w.absWeek),
  }).sessions;

  for (const w of draft.season) {
    const key = weekKey(w.absWeek);
    if (w.absWeek >= first && w.absWeek <= last) { draft.weeks[key] = build(w); continue; }
    // A re-size to a target changes later weeks' hours, and the chart reads
    // every week's sessions. A later week that is still exactly what the
    // generator made follows the new season; one the athlete has edited stays
    // as they left it.
    if (solved && w.absWeek >= keep && followsGenerator(plan, w.absWeek) && changed(plan.season?.[w.absWeek], w)) {
      draft.weeks[key] = build(w);
    }
  }
  return draft;
}

/* Is week `absWeek` of the stored plan still exactly what the generator makes
   for its own season entry? A week with nothing stored counts: there is no
   edit to protect. */
function followsGenerator(plan, absWeek) {
  const entry = plan.season?.[absWeek];
  const stored = plan.weeks?.[weekKey(absWeek)];
  if (!entry || !stored) return true;
  return sameJSON(stored, freshWeek(plan, absWeek));
}
const changed = (a, b) => !a || a.hours !== b.hours || a.block !== b.block;

const SESSION_FIELDS = ['day', 'disc', 'focus', 'dur', 'zone', 'paceZone'];
const sameSession = (a, b) => SESSION_FIELDS.every((f) => a[f] === b[f]);

/**
 * Compare two plans week by week. This is what the athlete approves, so it
 * reports volume deltas first (the headline) and per-session detail second.
 */
export function diffPlans(before, after) {
  const weeks = [];

  const count = Math.max(weekCount(before), weekCount(after));
  for (let i = 0; i < count; i++) {
    const b = before.weeks?.[weekKey(i)] ?? [];
    const a = after.weeks?.[weekKey(i)] ?? [];
    const byId = (list) => new Map(list.map((s) => [s.id, s]));
    const bIds = byId(b);
    const aIds = byId(a);

    const added = a.filter((s) => !bIds.has(s.id));
    const removed = b.filter((s) => !aIds.has(s.id));
    const changed = [];
    for (const [id, bs] of bIds) {
      const as = aIds.get(id);
      if (as && !sameSession(bs, as)) changed.push({ before: bs, after: as });
    }

    if (!added.length && !removed.length && !changed.length) continue;

    const mins = (list) => list.reduce((x, s) => x + durToMin(s.dur), 0);
    const beforeMinutes = mins(b);
    const afterMinutes = mins(a);
    weeks.push({
      absWeek: i,
      block: (after.season?.[i] ?? before.season?.[i])?.block ?? '',
      beforeMinutes,
      afterMinutes,
      deltaMinutes: afterMinutes - beforeMinutes,
      added,
      removed,
      changed,
    });
  }

  const issues = validateSeason(
    (after.season ?? []).map((w) => ({ ...w, sessions: after.weeks?.[weekKey(w.absWeek)] ?? [] })),
    {
      profile: after.profile,
      // A race the season could not build a taper for is a thing the athlete
      // needs told at the diff, where they are deciding — not left to be
      // noticed as a missing taper weeks later.
      refusedLandings: planLandings({
        weeks: weekCount(after),
        landings: landingsDetail(after),
      }).refused,
    },
  );

  return {
    weeks,
    issues,
    // Errors mean the week is not physically possible. Warnings are coaching
    // judgement and stay the athlete's call.
    blocked: issues.some((i) => i.level === 'error'),
    totalDeltaMinutes: weeks.reduce((a, w) => a + w.deltaMinutes, 0),
  };
}

/**
 * Completion flags and logged actuals, filtered down to sessions that `weeks`
 * still contains. A plan edited over a season would otherwise accumulate
 * references to sessions nobody can see — and a plan arriving from a file can
 * claim history for sessions it does not carry. Anything still present keeps
 * its history.
 */
export function pruneHistory(weeks, { done, actuals } = {}) {
  const live = new Set(Object.values(weeks ?? {}).flat().map((s) => s.id));
  const keep = (src) =>
    Object.fromEntries(Object.entries(src ?? {}).filter(([id]) => live.has(id)));
  return { done: keep(done), actuals: keep(actuals) };
}

/**
 * Commit a draft. The only function here that produces the plan you store.
 * Returns a new object; both inputs are left alone.
 */
export function applyDraft(plan, draft, { now = Date.now() } = {}) {
  const next = clone(draft);
  next.id = plan.id;
  next.name = plan.name;
  next.updatedAt = now;

  const history = pruneHistory(next.weeks, plan);
  next.done = history.done;
  next.actuals = history.actuals;

  // Chat is conversation state, not plan content. A draft is snapshotted when
  // the coach makes its first tool call — before it has replied — so taking the
  // transcript from the draft would rewind it and swallow the coach's own answer.
  next.chat = plan.chat ?? [];

  // Synced activities are history, like completions and logs, and for the same
  // snapshot reason: a sync that lands while the athlete is reading the diff
  // must not be rolled back by pressing Apply.
  next.activities = plan.activities ?? [];
  if (plan.activitySync) next.activitySync = plan.activitySync;
  else delete next.activitySync;
  // FTP and CSS are entered in a panel that writes straight to the plan, so the
  // same holds for them: a draft from before they were entered cannot undo them.
  if (plan.loadRefs) next.loadRefs = plan.loadRefs;
  else delete next.loadRefs;

  // Logs a draft proposes — the weekly review's synced matches and missed
  // sessions (review.js) — are written only now, through setActual, for a
  // session that still exists and never over a log the athlete has made since.
  // History above came from the stored plan; this is the one way a draft adds
  // to it, and the carrier field itself is never stored.
  const live = new Set(Object.values(next.weeks ?? {}).flat().map((s) => s?.id));
  let logged = next;
  for (const { id, actual } of draft.pendingActuals ?? []) {
    if (!live.has(id) || logged.actuals?.[id]) continue;
    logged = setActual(logged, id, actual);
  }
  delete logged.pendingActuals;

  // Weeks are released forward only. A draft taken before the last release
  // (a coach session, an open Plan setup) must not hide a week again.
  const horizons = [plan.release, draft.release].map((r) => normalizeRelease(r, weekCount(next))).filter(Boolean);
  if (horizons.length) logged.release = { through: Math.max(...horizons.map((r) => r.through)) };
  else delete logged.release;

  return logged;
}

/* ---- Starting a new season ------------------------------------------------
   A new plan is a separate record, so creating one never touches the plans you
   already have: their weeks, completions and logs stay exactly where they are.
   This is the "clean canvas" path — a fresh calendar for a new race, with the
   old season still there to look back on. */

export const FALLBACK_WEEKS = 16;

/** A plan id. Unique per record: two plans must never share one, or storing the
    second would overwrite the first. */
export const mintPlanId = (now = Date.now()) =>
  `p-${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Seven rest days: an empty week that still has somewhere to drop a session. */
const emptyWeek = (idPrefix) =>
  DAYS.map((day, i) => ({
    id: `${idPrefix}-${i}`,
    day,
    disc: 'Rest',
    focus: '',
    dur: REST_DUR,
    zone: '—',
  }));

/**
 * Build a new plan.
 *
 * @param {object}  opts
 * @param {string}  opts.name
 * @param {string}  opts.startISO   first Monday of the plan
 * @param {string} [opts.raceDate]  sizes the season; falls back to 16 weeks
 * @param {string} [opts.raceType]
 * @param {object} [opts.profile]   inherited availability/constraints/splits
 * @param {object[]} [opts.benchmarks] inherited running results
 * @param {object[]} [opts.activities] inherited synced activities
 * @param {object} [opts.activitySync] the days those activities cover
 * @param {object} [opts.loadRefs] inherited FTP and CSS
 * @param {string} [opts.ambition] what the athlete wants from the race (events.js `AMBITIONS`)
 * @param {object} [opts.startFitness] where the athlete starts, from `startFitness`. With
 *        it, and a race, the season is built to a target (backplan.js) and records it;
 *        without it, as it always was.
 * @param {'fitted'|'empty'} [opts.mode]
 */
export function newPlan({
  name, startISO, raceDate = null, raceType, profile, benchmarks, activities, activitySync, loadRefs,
  mode = 'fitted', id, now = Date.now(), ambition, startFitness,
} = {}) {
  // Carry the athlete's own constraints across — their week has not changed
  // just because the race has — but never the previous race.
  const base = normalizeProfile({
    ...(profile ?? {}),
    raceDate,
    ...(raceType ? { raceType } : {}),
  });

  // The race the season is built for is also the first thing on the calendar,
  // so there is one place it is recorded rather than two — and it is needed
  // *before* the weeks are built, because the last one is shaped around the day
  // the race is actually on.
  const events = seedEventsFromProfile(base, { id: `ev-${now.toString(36)}`, ambition });
  const dated = { start: startISO, events };

  const weeks = weeksUntil(startISO, raceDate) ?? FALLBACK_WEEKS;
  const solved = raceDate && startFitness
    ? solveSeason({ start: startISO, weeks, profile: base, events, weekBudgets: {}, keep: 0, frozen: [], startInfo: startFitness })
    : null;
  const season = solved ? solved.season : fitToRace({ peakHours: peakHoursFor(base), weeks, landings: landingsDetail(dated) });

  const built = {};
  for (const w of season) {
    const key = weekKey(w.absWeek);
    built[key] = mode === 'empty'
      ? emptyWeek(key)
      : generateWeek({
        hours: w.hours,
        block: w.block,
        profile: base,
        idPrefix: key,
        ...raceClosure(dated, w.absWeek),
      }).sessions;
  }

  return {
    id: id ?? mintPlanId(now),
    name: name || 'My plan',
    schema: 3,
    start: startISO,
    profile: base,
    season,
    weeks: built,
    events,
    ...(solved ? { target: solved.target } : {}),
    // Carried across for the same reason the constraints are: the athlete's
    // 10 km did not get slower because they picked a new race.
    benchmarks: normalizeBenchmarks(benchmarks),
    // And the synced history: what the athlete trained last month is still the
    // best evidence of what they can train next month, whichever race is next.
    activities: normalizeActivities(activities),
    ...(normalizeActivitySync(activitySync) ? { activitySync: normalizeActivitySync(activitySync) } : {}),
    ...(normalizeLoadRefs(loadRefs) ? { loadRefs: normalizeLoadRefs(loadRefs) } : {}),
    done: {},
    actuals: {},
    chat: [],
    chartmode: 'weekly',
    charthidden: {},
    view: { week: 0 },
    updatedAt: now,
  };
}

/* Structural equality for stored JSON. A key holding `undefined` is the same
   as an absent one, because that is what a trip through storage makes of it. */
function sameJSON(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = (o) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k) => sameJSON(a[k], b[k]));
}

const isEmpty = (x) => x == null || (Array.isArray(x) ? !x.length : !Object.keys(x).length);

/**
 * Is this the stand-in plan nobody has used yet?
 *
 * The page never has zero plans: a first visit, or deleting the last one, makes
 * a default "My plan". Creating a real season should replace that stand-in
 * rather than leave it behind, and a new device signing in should not upload
 * it. So "untouched" has to mean exactly that — every week is still what the
 * generator made, and nothing the athlete entered is on it. Moving around the
 * calendar (`view`) is not a touch; renaming it, editing a session, logging,
 * a race, a result or an FTP all are.
 */
export function isUntouchedPlan(plan) {
  if (!plan || !Array.isArray(plan.season) || !plan.season.length || !plan.weeks) return false;
  if (plan.name !== 'My plan') return false;
  for (const field of ['done', 'actuals', 'chat', 'events', 'benchmarks', 'activities', 'weekBudgets', 'loadRefs', 'target']) {
    if (!isEmpty(plan[field])) return false;
  }
  if (!sameJSON(normalizeProfile(plan.profile), normalizeProfile({ raceDate: null }))) return false;
  if (Object.keys(plan.weeks).length !== plan.season.length) return false;
  return plan.season.every((w) => sameJSON(plan.weeks[weekKey(w.absWeek)], freshWeek(plan, w.absWeek)));
}

/* ---- One plan per athlete ---------------------------------------------------

   The page holds a single active plan. Starting a new season deletes it and
   begins again, carrying over what is true of the athlete rather than of the
   season: results, thresholds, synced history, and the races still to come. */

/** Events on `today` or later, in date order. Past races are history. */
export function upcomingEvents(events, today) {
  return normalizeEvents(events).filter((e) => e.date >= today);
}

/**
 * What survives a restart. `keepIds` names the upcoming events the athlete
 * ticked; the rest of the plan — weeks, logs, chat, budgets, release horizon —
 * is deliberately absent, so nothing here can bring last season back.
 */
export function carryOver(plan, today, keepIds = []) {
  const keep = new Set(keepIds);
  const out = {
    events: upcomingEvents(plan.events, today).filter((e) => keep.has(e.id)),
    benchmarks: normalizeBenchmarks(plan.benchmarks),
    activities: normalizeActivities(plan.activities),
  };
  const sync = normalizeActivitySync(plan.activitySync);
  if (sync) out.activitySync = sync;
  const refs = normalizeLoadRefs(plan.loadRefs);
  if (refs) out.loadRefs = refs;
  return out;
}
