/* What was actually trained, week by week, from synced activities.

   The plan says what should happen and `actuals` says how each planned session
   went; this is the third view — everything the watch recorded, planned or
   not. It is what lets the rules in adapt.js, and the coach, start from the
   training somebody has really been doing rather than from the plan's opinion
   of it.

   The one distinction everything here is careful about: **a week with nothing
   in it is not the same as a week nobody synced.** `covered` is true only when
   every day of the week lies inside the span the plan has synced
   (`activitySync`), and summaries only ever average covered, finished weeks.
   Otherwise a gap in syncing would read as a week off, and a rule would cut
   the plan back for training that happened.

   Volume counts the four disciplines yootri plans. Anything else a watch
   records (a walk, a yoga class) is counted as a session and kept, but is not
   training volume here. */

import { parseISO, toISO, addDays, mondayOf } from './dates.js';

export const HISTORY_DISCIPLINES = Object.freeze(['Swim', 'Bike', 'Run', 'Strength']);
export const MAX_HISTORY_WEEKS = 26;

const shift = (iso, days) => toISO(addDays(parseISO(iso), days));
const minutesOf = (a) => Math.round((Number(a?.durationS) || 0) / 60);
const emptyDiscs = () =>
  Object.fromEntries(HISTORY_DISCIPLINES.map((d) => [d, { minutes: 0, sessions: 0, longest: 0 }]));

/**
 * One row per week, oldest first.
 *
 * @param {object[]} activities  as stored on `plan.activities`
 * @param {object} opts
 * @param {string} opts.from     any day of the first week; it is taken back to Monday
 * @param {number} opts.weeks
 * @param {object} [opts.sync]   `plan.activitySync`
 * @param {string} [opts.today]  a week ending on or after this is not complete
 */
export function weeklyHistory(activities, { from, weeks, sync = null, today = null } = {}) {
  const first = mondayOf(from);
  const n = Math.max(0, Math.floor(Number(weeks) || 0));
  if (!first || !n) return [];

  const rows = [];
  for (let i = 0; i < n; i++) {
    const monday = shift(first, 7 * i);
    const sunday = shift(monday, 6);
    rows.push({
      monday,
      minutes: 0,
      sessions: 0,
      byDisc: emptyDiscs(),
      covered: !!(sync && sync.from && sync.through && sync.from <= monday && sunday <= sync.through),
      complete: !today || sunday < today,
      _sunday: sunday,
      _longest: {},
    });
  }

  const last = rows[rows.length - 1]._sunday;
  for (const a of Array.isArray(activities) ? activities : []) {
    if (!a || !a.date || a.date < first || a.date > last) continue;
    const row = rows[Math.floor((parseISO(a.date) - parseISO(first)) / (7 * 86400000))];
    if (!row) continue;
    row.sessions++;
    if (!HISTORY_DISCIPLINES.includes(a.disc)) continue;
    const min = minutesOf(a);
    const d = row.byDisc[a.disc];
    row.minutes += min;
    d.minutes += min;
    d.sessions++;
    if (min > d.longest) {
      d.longest = min;
      row._longest[a.disc] = { minutes: min, date: a.date, id: a.id };
    }
  }
  // The longest sessions' dates and ids ride along for summarizeHistory, out
  // of sight: non-enumerable, so they are not part of what a row says.
  return rows.map(({ _sunday, _longest, ...r }) => Object.defineProperty(r, '_longest', { value: _longest }));
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Averages over the covered, finished weeks: weekly minutes, each discipline's
 * share of the recorded time, and the longest session of each discipline.
 */
export function summarizeHistory(rows) {
  const used = (Array.isArray(rows) ? rows : []).filter((r) => r.covered && r.complete);
  const totalMinutes = used.reduce((a, r) => a + r.minutes, 0);
  const share = {};
  const longest = {};
  for (const disc of HISTORY_DISCIPLINES) {
    const minutes = used.reduce((a, r) => a + r.byDisc[disc].minutes, 0);
    share[disc] = totalMinutes > 0 ? round3(minutes / totalMinutes) : 0;
    let best = null;
    for (const r of used) {
      const l = r._longest?.[disc];
      if (l && (!best || l.minutes > best.minutes)) best = l;
    }
    longest[disc] = best;
  }
  return {
    coveredWeeks: used.length,
    totalMinutes,
    avgMinutes: used.length ? Math.round(totalMinutes / used.length) : 0,
    share,
    longest,
  };
}

/**
 * The `weeks` full weeks before the one containing `today`, summarized — what
 * the coach reads before it proposes any volume.
 */
export function trainingHistory(activities, { today, weeks = 8, sync = null } = {}) {
  const n = Math.min(MAX_HISTORY_WEEKS, Math.max(1, Math.floor(Number(weeks) || 1)));
  const thisMonday = mondayOf(today);
  const rows = thisMonday
    ? weeklyHistory(activities, { from: shift(thisMonday, -7 * n), weeks: n, sync, today })
    : [];
  return {
    coverage: sync && sync.from && sync.through ? { from: sync.from, through: sync.through } : null,
    weeks: rows.map((r) => ({ ...r })),
    summary: summarizeHistory(rows),
  };
}
