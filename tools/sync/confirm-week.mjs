#!/usr/bin/env node
/* Confirm weeks of a plan from Garmin Coach runs, and propose the rebalance.

     node tools/sync/confirm-week.mjs plan.json scheduled.json [--today YYYY-MM-DD]

   plan.json is a stored plan (or an exported envelope's `plan`); scheduled.json is
   the output of `python -m garmin_bridge scheduled`. Prints one JSON object:
   { weeks: [{ week, published, changes, proposals, skipped }], plan }. `plan` is
   the draft with the confirmed runs in place; the rebalance proposals are only
   proposals — nothing here applies them. Reads two files, writes nothing. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPlan, setSessionsAt, sessionsAt } from '../../assets/coach/plan.js';
import { weekIndexOf } from '../../assets/coach/calendar.js';
import { runFromGarmin } from '../../assets/coach/garminrun.js';
import { confirmWeek } from '../../assets/coach/confirm.js';
import { proposeRebalance } from '../../assets/coach/rebalance.js';

export function confirmFromScheduled(plan, scheduled, { today } = {}) {
  const byWeek = new Map();
  const unreadable = [];
  for (const r of scheduled?.runs ?? []) {
    const run = runFromGarmin(r.workout, { date: r.date, scheduleId: r.scheduleId });
    const week = weekIndexOf(plan.start, r.date);
    if (!run) { unreadable.push({ date: r.date, title: r.title }); continue; }
    if (week === null || week < 0 || !plan.weeks?.[`w${week}`]) continue;
    byWeek.set(week, [...(byWeek.get(week) ?? []), run]);
  }
  let draft = plan;
  const weeks = [];
  for (const week of [...byWeek.keys()].sort((a, b) => a - b)) {
    const result = confirmWeek(draft, week, byWeek.get(week));
    if (result.published) draft = setSessionsAt(draft, week, result.sessions);
    const { proposals, skipped } = result.published ? proposeRebalance(draft, week, { today }) : { proposals: [], skipped: [] };
    weeks.push({ week, published: result.published, changes: result.changes, unmatched: result.unmatched, proposals, skipped });
  }
  return { weeks, unreadable, plan: draft };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--today');
  const today = flag >= 0 ? args.splice(flag, 2)[1] : undefined;
  const [planFile, schedFile] = args;
  if (!planFile || !schedFile) { console.error('usage: confirm-week.mjs plan.json scheduled.json [--today YYYY-MM-DD]'); process.exit(2); }
  const raw = JSON.parse(readFileSync(planFile, 'utf8'));
  const plan = loadPlan(raw.plan ?? raw);
  console.log(JSON.stringify(confirmFromScheduled(plan, JSON.parse(readFileSync(schedFile, 'utf8')), { today }), null, 1));
}
