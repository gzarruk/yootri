/* Weekly release: a season shown one week at a time, and the review that
   releases the next.

   The whole season still exists — blocks, weekly hours, every session — so the
   validator, the chart and the adaptation rules go on reading it exactly as
   before. What changes is what the athlete is shown: a plan carrying
   `release: { through }` shows sessions only up to that week, and the weeks
   after it as their block and planned hours. A plan without the field (every
   plan made before this) is shown whole, unchanged.

   When the released week has ended, `reviewWeek` says what happened to each of
   its sessions — logged, matched to a synced activity, or missed — and
   `proposeNextWeek` builds the draft that releases the next one. That draft
   goes through diff → apply like every other change: nothing is released
   until the athlete applies it.

   The judgement about next week is not new. It is the existing adaptation
   rules (`suggest` in adapt.js), read on the record the review has just
   completed: the logs, the synced matches it proposes, and the sessions that
   did not happen. No new coaching constant lives here.

   One thing the athlete can add: `ease`, which makes the released week's
   hardest session an easy one of the same length. It is never on by default.
   The page offers it beside the athlete's sleep and overnight heart rate when
   those are outside their usual range (overnight.js), and the coach passes it
   only when asked — but nothing here reads those figures. The choice is the
   athlete's; this only carries it out. */

import { weekCount, sessionsAt, setSessionsAt, refit, normalizeRelease } from './plan.js';
import { easySession, zoneRank } from './generate.js';
import { getActual, setActual, actualMinutes } from './actuals.js';
import { matchActivities } from './match.js';
import { suggest } from './adapt.js';
import { dateOf, weekIndexOf } from './calendar.js';
import { durToMin } from './duration.js';

export { normalizeRelease };

const weekKey = (absWeek) => `w${absWeek}`;

/** Is this week's content shown? Every week is, on a plan released whole. */
export function isReleased(plan, absWeek) {
  return !plan?.release || absWeek <= plan.release.through;
}

/**
 * Where a plan stands: `mode` is 'all' for a plan shown whole, 'weekly'
 * otherwise. A release is `due` once the last released week has ended and
 * there are weeks left. The week reviewed is the one released last; the week
 * released next is the one after it — or, back after a gap, this week, since
 * releasing weeks that are already over would only fill the calendar with
 * sessions nobody can do.
 */
export function releaseState(plan, { today } = {}) {
  const weeks = weekCount(plan);
  const current = weekIndexOf(plan.start, today);
  if (!plan.release) return { mode: 'all', current };
  const through = Math.min(plan.release.through, weeks - 1);
  const last = weeks - 1;
  const due = through < last && Number.isInteger(current) && current > through;
  return {
    mode: 'weekly',
    current,
    through,
    due,
    reviewWeek: through,
    nextWeek: Math.min(last, Math.max(through + 1, Number.isInteger(current) ? current : through + 1)),
  };
}

/**
 * What happened to each session of one week, as rows of
 * `{ id, day, date, disc, focus, plannedMin, status, source, minutes, activityId? }`.
 *
 * - `logged`: the athlete's own log (or the older `done` flag) — never second-guessed.
 * - `synced`: a synced activity that `matchActivities` pairs with it. Proposed,
 *   not written: it is written only when the release is applied.
 * - `not-logged`: nothing either way, on a day already past — `missed`.
 * - `upcoming`: a day not reached yet.
 *
 * `extra` is what was trained that week with no session to match.
 */
export function reviewWeek(plan, absWeek, { today } = {}) {
  const from = dateOf(plan.start, absWeek, 'Mon');
  const to = dateOf(plan.start, absWeek, 'Sun');
  const { proposals, extra } = matchActivities(plan, plan.activities ?? [], { from, to });
  const byId = new Map(proposals.map((x) => [x.sessionId, x]));

  const rows = sessionsAt(plan, absWeek)
    .filter((s) => durToMin(s.dur) > 0)
    .map((s) => {
      const date = dateOf(plan.start, absWeek, s.day);
      const base = { id: s.id, day: s.day, date, disc: s.disc, focus: s.focus, plannedMin: durToMin(s.dur) };
      const own = getActual(plan, s.id) ?? (plan.done?.[s.id] ? { status: 'done' } : null);
      if (own) return { ...base, status: own.status, source: 'logged', minutes: actualMinutes(plan, s) };
      const match = byId.get(s.id);
      if (match) {
        return { ...base, status: match.actual.status, source: 'synced', minutes: match.actual.min, activityId: match.activityId, actual: match.actual };
      }
      if (today && date < today) return { ...base, status: 'missed', source: 'not-logged', minutes: 0 };
      return { ...base, status: 'upcoming', source: 'not-logged', minutes: 0 };
    });

  const counts = { done: 0, partial: 0, missed: 0, sick: 0, upcoming: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;

  return {
    absWeek,
    from,
    to,
    ended: Boolean(today && to && today > to),
    rows,
    extra: extra.filter((x) => x.date >= from && x.date <= to),
    plannedMinutes: rows.reduce((a, r) => a + r.plannedMin, 0),
    doneMinutes: rows.reduce((a, r) => a + (r.minutes || 0), 0),
    counts,
  };
}

/**
 * The session `ease` would change: the week's highest zone (`zoneRank`), the
 * earliest on a tie — the nearest to the nights that prompted the question.
 * Never one already logged or on a day already gone, and never one that is as
 * easy as it gets already. Null when the week has nothing hard in it.
 */
export function hardestSession(plan, absWeek, { today } = {}) {
  let best = null;
  for (const s of sessionsAt(plan, absWeek)) {
    const easy = easySession(s);
    if (!easy || durToMin(s.dur) <= 0) continue;
    const rank = zoneRank(s.zone);
    if (rank <= zoneRank(easy.zone)) continue;
    if (getActual(plan, s.id) || plan.done?.[s.id]) continue;
    if (today && dateOf(plan.start, absWeek, s.day) < today) continue;
    if (!best || rank > best.rank) best = { s, rank };
  }
  return best ? best.s : null;
}

/**
 * The draft that releases the next week, and why it looks the way it does.
 *
 * It writes what the review found — synced matches as logged actuals, sessions
 * with nothing against them as missed — then asks the existing adaptation rules
 * about the week being released. If they propose a different week budget, that
 * week (and only that week) is pinned and rebuilt; otherwise it is released as
 * planned. Weeks before it are never touched. With `ease`, the released week's
 * hardest session is then made easy (see `hardestSession`); its hours stay.
 *
 * @returns {{ draft, nextWeek, review, change: null | {fromHours, toHours, reason}, eased: null | object, logged: number, missed: number }}
 */
export function proposeNextWeek(plan, { today, ease = false } = {}) {
  const state = releaseState(plan, { today });
  const reviewed = state.mode === 'weekly' ? state.reviewWeek : null;
  const nextWeek = state.mode === 'weekly' ? state.nextWeek : null;
  if (reviewed === null || nextWeek === null) throw new Error('this plan is not released week by week');

  const review = reviewWeek(plan, reviewed, { today });
  let draft = structuredClone(plan);
  const pendingActuals = [];
  for (const r of review.rows) {
    if (r.source === 'synced') pendingActuals.push({ id: r.id, actual: r.actual });
    else if (r.status === 'missed' && r.source === 'not-logged') pendingActuals.push({ id: r.id, actual: { status: 'missed' } });
  }
  // The rules below read the week as the review found it, so the logs go on
  // the draft now; applyDraft writes them to the stored plan from
  // `pendingActuals`, since it takes history from the stored plan, not a draft.
  for (const { id, actual } of pendingActuals) draft = setActual(draft, id, actual);
  const logged = pendingActuals.filter((x) => x.actual.activityId).length;
  const missed = pendingActuals.length - logged;

  // The rules suggest at most one budget per week (the lowest), so the first
  // one with an action for this week is the one to apply.
  const pick = suggest(draft, { week: nextWeek })
    .find((x) => x.action?.tool === 'set_week_budget' && x.action.input.week === nextWeek);

  let change = null;
  if (pick) {
    const fromHours = draft.season[nextWeek].hours;
    const toHours = Number(pick.action.input.hours);
    if (Number.isFinite(toHours) && toHours >= 0 && toHours !== fromHours) {
      draft = refit(
        { ...draft, weekBudgets: { ...(draft.weekBudgets ?? {}), [weekKey(nextWeek)]: toHours } },
        { from: nextWeek, to: nextWeek, keepBefore: nextWeek },
      );
      change = { fromHours, toHours, reason: pick.message, code: pick.code };
    }
  }

  let eased = null;
  const hard = ease ? hardestSession(draft, nextWeek, { today }) : null;
  if (hard) {
    const easy = easySession(hard);
    draft = setSessionsAt(draft, nextWeek, sessionsAt(draft, nextWeek).map((s) => (s.id === hard.id ? easy : s)));
    eased = {
      id: hard.id, day: hard.day, disc: hard.disc, dur: hard.dur,
      from: { focus: hard.focus, zone: hard.zone }, to: { focus: easy.focus, zone: easy.zone },
    };
  }

  draft.release = { through: nextWeek };
  draft.pendingActuals = pendingActuals;
  return { draft, nextWeek, review, change, eased, logged, missed };
}

