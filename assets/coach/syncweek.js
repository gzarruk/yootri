/* From the Garmin feed to a week the athlete can accept.

   `weekSuggestions` turns the scheduled Coach runs (the bridge's `scheduled`
   output, carried to the page as a feed) into, per week of the plan: the
   confirmed draft, and the rebalance proposals that follow from it. Nothing is
   applied here — the page lists them, the athlete ticks what they accept, and
   the usual diff -> apply does the rest. Pure and total. */
import { setSessionsAt } from './plan.js';
import { weekIndexOf } from './calendar.js';
import { runFromGarmin } from './garminrun.js';
import { confirmWeek } from './confirm.js';
import { proposeRebalance, applyProposals } from './rebalance.js';

/** The feed's runs read into the engine's shape, grouped by plan week. */
export function runsByWeek(plan, feed) {
  const byWeek = new Map();
  const unreadable = [];
  for (const r of feed?.runs ?? []) {
    const run = runFromGarmin(r?.workout, { date: r?.date, scheduleId: r?.scheduleId });
    if (!run) { unreadable.push({ date: r?.date, title: r?.title }); continue; }
    const week = weekIndexOf(plan.start, r.date);
    if (week === null || week < 0 || !plan.weeks?.[`w${week}`]) continue;
    byWeek.set(week, [...(byWeek.get(week) ?? []), run]);
  }
  return { byWeek, unreadable };
}

/** One week of the feed: the plan with that week confirmed, what changed, and the proposals. */
export function weekSuggestions(plan, feed, week, { today } = {}) {
  const runs = runsByWeek(plan, feed).byWeek.get(week) ?? [];
  const result = confirmWeek(plan, week, runs);
  if (!result.published) return { published: false, plan, changes: [], unmatched: [], proposals: [], skipped: [] };
  const confirmed = setSessionsAt(plan, week, result.sessions);
  const { proposals, skipped } = proposeRebalance(confirmed, week, { today });
  return { published: true, plan: confirmed, changes: result.changes, unmatched: result.unmatched, proposals, skipped };
}

/** Weeks where the feed would change what the plan holds (already-confirmed weeks are quiet). */
export function pendingWeeks(plan, feed, opts) {
  const { byWeek } = runsByWeek(plan, feed);
  return [...byWeek.keys()].sort((a, b) => a - b).filter((week) => {
    const r = weekSuggestions(plan, feed, week, opts);
    return r.published && JSON.stringify(r.plan.weeks[`w${week}`]) !== JSON.stringify(plan.weeks[`w${week}`]);
  });
}

/**
 * The draft the athlete has chosen for one week. `confirm` false leaves the plan
 * as it is (a proposal on its own is meaningless without the runs it follows);
 * otherwise the confirmed runs go in, plus only the accepted proposals.
 */
export function draftForWeek(plan, feed, week, { confirm = true, accepted = [], today } = {}) {
  if (!confirm) return plan;
  const r = weekSuggestions(plan, feed, week, { today });
  return r.published ? applyProposals(r.plan, week, r.proposals, accepted) : plan;
}
