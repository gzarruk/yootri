/* Deterministic adaptation rules: what the logged weeks suggest doing next.

   This exists so that adaptation judgement lives in tested code rather than in
   the model's head. The engine already owns the plan's arithmetic; without this
   module, "you are overreaching, cut back 30%" would be a number the language
   model invented. Here the thresholds are explicit, the evidence is attached to
   every suggestion, and both are testable.

   Nothing here applies anything. Each suggestion carries an `action` naming a
   tool the athlete (or the coach, on their behalf) may choose to run.

   Most rules read the logged weeks. One does not: a budget the athlete's week
   cannot absorb flattens the season whether or not anybody has trained yet, so
   that rule takes its evidence from the shape of the plan and fires from week
   one. Everything below it needs history.

   Two principles shape the rules:

     1. **Silence is a valid answer.** Compliance of zero because nobody opened
        the app is not evidence that a plan is too hard. Rules only fire when
        enough of the window was actually logged to mean something.
     2. **Backing off needs less evidence than piling on.** Being wrong about a
        cutback costs a little fitness; being wrong about an increase costs an
        injury. The rules are deliberately asymmetric.

   The numbers below are hand-chosen and unfitted — see ../yootri-rnd/FINDINGS.md. */

import { weekCompliance, getActual, actualMinutes } from './actuals.js';
import { seasonFit, MIN_VARIATION_RETAINED } from './validate.js';
import { durToMin } from './duration.js';
import { weekCount } from './plan.js';
import { weeklyHistory, summarizeHistory, HISTORY_DISCIPLINES } from './history.js';
import { asRunEffort } from './synced.js';
import { benchmarkCandidates, STANDARD_DISTANCES } from './activities.js';
import { currentBenchmark, vdotFrom } from './paces.js';
import { resolveSplit } from './generate.js';
import { dateOf } from './calendar.js';
import { parseISO, toISO, addDays, mondayOf } from './dates.js';

export const THRESHOLDS = {
  under: 0.7,        // below this over the trailing window, propose easing off
  over: 1.15,        // above this, and comfortable, propose a little more
  lowRpe: 6,         // "comfortable" — below this on the Borg-style 1-10 scale
  rpeRise: 1.5,      // effort climbing this much at flat volume is worth a look
  flatVolume: 0.1,   // volume within ±10% counts as unchanged
  discLag: 0.5,      // a discipline this far behind…
  discOk: 0.9,       // …while the others are at least this well kept up
  minLogged: 0.5,    // fraction of a window's sessions that must be logged
  maxRamp: 1.1,      // never propose more than a 10%/week step up
  underWeeks: 2,     // evidence needed to propose easing off
  overWeeks: 3,      // evidence needed to propose adding load
};

/* The rules that read synced history (history.js) rather than the plan's own
   log. Stricter than the ones above, because history is evidence about the
   athlete rather than about the plan: they say nothing on fewer than
   `minCovered` synced weeks, never propose an increase, and never touch a week
   that has already started — rebuilding a week under way could move a session
   somebody has already logged. Hand-chosen and unfitted, like THRESHOLDS. */
export const HISTORY_THRESHOLDS = {
  lookback: 4,           // synced weeks read before the planned week
  minCovered: 3,         // …of which at least this many must be covered by a sync
  minWeeklyHours: 2,     // below this recorded average there is no baseline to plan from
  splitDrift: 0.10,      // share points off the block's split worth a mention
  splitMinHours: 10,     // …over at least this much recorded training
  splitRound: 0.05,      // proposed split weights come in steps of this
  longJump: 1.25,        // planned long session this much longer than the longest recorded…
  longJumpMinutes: 20,   // …and at least this many minutes longer
  bestEffortMargin: 0.5, // VDOT points a synced run must beat the current benchmark by
  bestEffortDays: 42,    // only efforts this recent are offered
};

const weekKey = (w) => `w${w}`;
const round1 = (n) => Math.round(n * 10) / 10;
const shiftISO = (iso, days) => toISO(addDays(parseISO(iso), days));
const pct = (x) => `${Math.round(x * 100)}%`;
const fmtMin = (m) => {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};
const fmtClock = (secs) => {
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const NOUN = { Swim: 'swim', Bike: 'ride', Run: 'run', Strength: 'strength session' };

/** Compliance rows for the `n` weeks before `week`, newest last. */
function window_(plan, week, n) {
  const rows = [];
  for (let i = Math.max(0, week - n); i < Math.min(week, weekCount(plan)); i++) {
    rows.push(weekCompliance(plan, i));
  }
  return rows;
}

/** Was enough of this window actually logged to draw any conclusion from it? */
function wellLogged(rows) {
  const sessions = rows.reduce((a, r) => a + r.sessions, 0);
  const logged = rows.reduce((a, r) => a + r.logged, 0);
  return sessions > 0 && logged / sessions >= THRESHOLDS.minLogged;
}

const totals = (rows) => {
  const planned = rows.reduce((a, r) => a + r.plannedMinutes, 0);
  const actual = rows.reduce((a, r) => a + r.actualMinutes, 0);
  return { planned, actual, ratio: planned > 0 ? actual / planned : 0 };
};

/** Planned and actual minutes per discipline across a range of weeks. */
function byDiscipline(plan, fromWeek, toWeek) {
  const out = {};
  for (let i = fromWeek; i < toWeek; i++) {
    for (const s of plan.weeks?.[weekKey(i)] ?? []) {
      const planned = durToMin(s.dur);
      if (!planned) continue;
      const row = (out[s.disc] = out[s.disc] ?? { planned: 0, actual: 0, logged: 0 });
      row.planned += planned;
      row.actual += actualMinutes(plan, s);
      if (getActual(plan, s.id) || plan.done?.[s.id]) row.logged++;
    }
  }
  return out;
}

const hoursOf = (plan, week) =>
  (plan.weeks?.[weekKey(week)] ?? []).reduce((a, s) => a + durToMin(s.dur), 0) / 60;

/**
 * What the recent past suggests doing about `week`.
 *
 * @param {object} plan
 * @param {{week: number}} opts  the week being planned (0-based, absolute)
 * @returns {{code, severity, message, evidence, action?}[]}
 */
export function suggest(plan, { week } = {}) {
  const out = [];
  const here = Math.max(0, Math.min(Number(week) || 0, weekCount(plan) - 1));

  /* --- Structural: the budget has outrun the week it has to fit in ------- */
  const fit = seasonFit(plan.season ?? [], plan.profile ?? {});
  if (fit && fit.retained < MIN_VARIATION_RETAINED) {
    out.push({
      code: 'season-flattened',
      severity: 'warn',
      message:
        `Every week is being capped at the ${round1(fit.capacityMinutes / 60)}h you have, ` +
        `so ${fit.clippedWeeks} of ${plan.season.length} weeks come out the same size and the ` +
        `season no longer builds or tapers.` +
        (fit.suggestedAnnualHours
          ? ` ${fit.suggestedAnnualHours} annual hours would give it its shape back.`
          : ''),
      evidence: {
        retained: round1(fit.retained * 100) / 100,
        capacityMinutes: fit.capacityMinutes,
        clippedWeeks: fit.clippedWeeks,
      },
      action: fit.suggestedAnnualHours
        ? { tool: 'set_annual_hours', input: { hours: fit.suggestedAnnualHours } }
        : null,
    });
  }

  /* --- Synced history. Before the week-one return: a plan's first week is
     exactly when what somebody trained before it matters most. ------------ */
  out.push(...historyRules(plan, here));

  // Everything below reads the logged past, and week one has none.
  if (here <= 0) return oneBudgetPerWeek(out);

  /* --- Doing consistently less than planned ----------------------------- */
  const shortWindow = window_(plan, here, THRESHOLDS.underWeeks);
  if (shortWindow.length >= THRESHOLDS.underWeeks && wellLogged(shortWindow)) {
    const t = totals(shortWindow);
    if (t.ratio < THRESHOLDS.under) {
      const avgHours = round1(t.actual / shortWindow.length / 60);
      out.push({
        code: 'under-compliance',
        severity: 'warn',
        message:
          `Over the last ${shortWindow.length} weeks you completed ${Math.round(t.ratio * 100)}% ` +
          `of what was planned (${round1(t.actual / 60)}h of ${round1(t.planned / 60)}h). ` +
          `Planning ${avgHours}h would match what you are actually doing.`,
        evidence: { weeks: shortWindow.length, ratio: round1(t.ratio), plannedMinutes: t.planned, actualMinutes: t.actual },
        action: { tool: 'set_week_budget', input: { week: here, hours: avgHours } },
      });
    }
  }

  /* --- Doing more than planned, comfortably ----------------------------- */
  const longWindow = window_(plan, here, THRESHOLDS.overWeeks);
  if (longWindow.length >= THRESHOLDS.overWeeks && wellLogged(longWindow)) {
    const t = totals(longWindow);
    const rpes = longWindow.map((r) => r.meanRpe).filter((x) => x != null);
    const meanRpe = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;

    if (t.ratio > THRESHOLDS.over && meanRpe != null && meanRpe < THRESHOLDS.lowRpe) {
      const planned = hoursOf(plan, here);
      // Round *down* to a tenth: rounding up could push the proposal past the
      // very ramp ceiling this line exists to enforce.
      const capped = Math.min(planned * THRESHOLDS.maxRamp, (t.actual / longWindow.length) / 60);
      const hours = Math.floor(capped * 10) / 10;
      out.push({
        code: 'over-compliance',
        severity: 'info',
        message:
          `You have beaten the plan for ${longWindow.length} weeks running ` +
          `(${Math.round(t.ratio * 100)}%) at an average effort of ${round1(meanRpe)}/10. ` +
          `There is room for a little more — ${hours}h this week.`,
        evidence: { weeks: longWindow.length, ratio: round1(t.ratio), meanRpe: round1(meanRpe) },
        action: { tool: 'set_week_budget', input: { week: here, hours } },
      });
    }

    /* --- Effort climbing while volume stays flat ------------------------ */
    if (rpes.length >= THRESHOLDS.overWeeks) {
      const rise = rpes[rpes.length - 1] - rpes[0];
      const vols = longWindow.map((r) => r.plannedMinutes);
      const spread = Math.max(...vols) - Math.min(...vols);
      const flat = Math.max(...vols) > 0 && spread / Math.max(...vols) <= THRESHOLDS.flatVolume;

      if (rise >= THRESHOLDS.rpeRise && flat) {
        const hours = round1(hoursOf(plan, here) * 0.7);
        out.push({
          code: 'effort-creep',
          severity: 'warn',
          message:
            `The same training is costing you more: effort has climbed from ` +
            `${round1(rpes[0])} to ${round1(rpes[rpes.length - 1])} out of 10 over ` +
            `${rpes.length} weeks at roughly unchanged volume. That usually means a ` +
            `recovery week is due — ${hours}h would do it.`,
          evidence: { rpeRise: round1(rise), from: round1(rpes[0]), to: round1(rpes[rpes.length - 1]), weeks: rpes.length },
          action: { tool: 'set_week_budget', input: { week: here, hours } },
        });
      }
    }
  }

  /* --- One discipline quietly falling behind ---------------------------- */
  const from = Math.max(0, here - THRESHOLDS.underWeeks);
  const disc = byDiscipline(plan, from, here);
  const rows = Object.entries(disc).filter(([, r]) => r.planned > 0);
  if (rows.length > 1 && wellLogged(window_(plan, here, THRESHOLDS.underWeeks))) {
    for (const [name, r] of rows) {
      const ratio = r.actual / r.planned;
      const others = rows.filter(([n]) => n !== name);
      const othersOk = others.length > 0 &&
        others.every(([, o]) => o.actual / o.planned >= THRESHOLDS.discOk);
      if (ratio < THRESHOLDS.discLag && othersOk) {
        out.push({
          code: 'discipline-lagging',
          severity: 'info',
          message:
            `${name} is the one falling behind — ${Math.round(ratio * 100)}% completed ` +
            `over the last ${here - from} weeks while everything else is on track. ` +
            `Either something is getting in the way of it, or its time is better spent elsewhere.`,
          evidence: { discipline: name, ratio: round1(ratio), plannedMinutes: r.planned, actualMinutes: r.actual },
        });
      }
    }
  }

  return oneBudgetPerWeek(out);
}

/* Two rules can each want to set the same week's budget. Offering both would
   ask the athlete to choose between numbers; the lower one is the proposal,
   because backing off needs less evidence than piling on. The others keep
   their message and lose their button. */
function oneBudgetPerWeek(list) {
  const lowest = new Map();
  for (const s of list) {
    if (s.action?.tool !== 'set_week_budget') continue;
    const held = lowest.get(s.action.input.week);
    if (!held || s.action.input.hours < held.action.input.hours) lowest.set(s.action.input.week, s);
  }
  return list.map((s) =>
    (s.action?.tool === 'set_week_budget' && lowest.get(s.action.input.week) !== s ? { ...s, action: null } : s));
}

/** Shares of a split's weights, over the planned disciplines. */
function sharesOf(weights) {
  const entries = HISTORY_DISCIPLINES.map((d) => [d, Math.max(0, Number(weights?.[d]) || 0)]);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  return Object.fromEntries(entries.map(([d, w]) => [d, total > 0 ? w / total : 0]));
}

/** Recorded shares as split weights in steps of `step`, summing to exactly 1,
    with every discipline in `keep` given at least one step. */
function roundedWeights(share, keep, step) {
  const units = Math.round(1 / step);
  const discs = HISTORY_DISCIPLINES.filter((d) => share[d] > 0 || keep.includes(d));
  const raw = discs.map((d) => ({ d, x: share[d] * units }));
  const got = raw.map(({ d, x }) => ({ d, n: Math.max(1, Math.floor(x)), rest: x - Math.floor(x) }));
  let left = units - got.reduce((a, g) => a + g.n, 0);
  for (const g of [...got].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    g.n++;
    left--;
  }
  while (left < 0) {
    const big = got.filter((g) => g.n > 1).sort((a, b) => b.n - a.n)[0];
    if (!big) break;
    big.n--;
    left++;
  }
  return Object.fromEntries(got.map((g) => [g.d, Math.round(g.n * step * 100) / 100]));
}

function historyRules(plan, here) {
  const out = [];
  const H = HISTORY_THRESHOLDS;
  const sync = plan.activitySync;
  const acts = plan.activities ?? [];
  if (!sync || !sync.through || !acts.length) return out;

  /* --- A synced run faster than the benchmark the paces come from -------- */
  const current = currentBenchmark(plan.benchmarks ?? []);
  const currentVdot = current ? vdotFrom(current) : null;
  const candidates = benchmarkCandidates(acts.map(asRunEffort).filter(Boolean),
    { today: sync.through, days: H.bestEffortDays, source: 'garmin' });
  const better = candidates.find((c) =>
    (currentVdot == null || c.vdot >= currentVdot + H.bestEffortMargin) && (!current || c.date > current.date));
  if (better) {
    const label = STANDARD_DISTANCES.find((d) => d.key === better.standard)?.label ?? 'run';
    out.push({
      code: 'best-effort',
      severity: 'info',
      message: current
        ? `Your ${label} on ${better.date} (${fmtClock(better.timeSeconds)}) is faster than the result your ` +
          'paces come from. Use it for your paces?'
        : `Your ${label} on ${better.date} (${fmtClock(better.timeSeconds)}) could set your training paces, ` +
          'which have no result to come from yet. Use it?',
      evidence: { date: better.date, standard: better.standard, timeSeconds: better.timeSeconds,
        vdot: round1(better.vdot), currentVdot: currentVdot == null ? null : round1(currentVdot) },
      action: null,
      offer: { kind: 'benchmark', candidate: better },
    });
  }

  /* --- Everything else is about the planned week, which must not have
         started, and needs enough covered weeks before it. -------------- */
  const monday = dateOf(plan.start, here, 'Mon');
  if (!monday || monday <= mondayOf(sync.through)) return out;
  const rows = weeklyHistory(acts, { from: shiftISO(monday, -7 * H.lookback), weeks: H.lookback, sync });
  const summary = summarizeHistory(rows);
  if (summary.coveredWeeks < H.minCovered) return out;

  const weeklyHours = rows.filter((r) => r.covered).map((r) => round1(r.minutes / 60));
  const avgHours = summary.avgMinutes / 60;
  const plannedHours = hoursOf(plan, here);
  const seen = `your last ${summary.coveredWeeks} synced weeks`;

  /* --- The plan asks for a bigger step than the recorded weeks support --- */
  const pinned = plan.weekBudgets?.[weekKey(here)] != null;
  if (!pinned && avgHours >= H.minWeeklyHours && plannedHours > avgHours * THRESHOLDS.maxRamp) {
    const hours = Math.floor(avgHours * THRESHOLDS.maxRamp * 10) / 10;
    out.push({
      code: 'plan-outruns-history',
      severity: 'warn',
      message:
        `${seen[0].toUpperCase() + seen.slice(1)} averaged ${round1(avgHours)}h. Week ${here + 1} plans ` +
        `${round1(plannedHours)}h — more than a ${pct(THRESHOLDS.maxRamp - 1)} step up from that. ` +
        `${hours}h would build from what you have actually been training.`,
      evidence: { weeks: H.lookback, coveredWeeks: summary.coveredWeeks, weeklyHours, avgHours: round1(avgHours),
        plannedHours: round1(plannedHours), missing: [] },
      action: { tool: 'set_week_budget', input: { week: here, hours } },
    });
  }

  /* --- Where the time has actually gone, against the block's split ------ */
  const block = plan.season?.[here]?.block;
  const planned = sharesOf(resolveSplit(block, plan.profile));
  const recorded = summary.share;
  if (block && summary.totalMinutes / 60 >= H.splitMinHours) {
    const drifting = HISTORY_DISCIPLINES.filter((d) => Math.abs(recorded[d] - planned[d]) >= H.splitDrift);
    if (drifting.length) {
      const scheduled = HISTORY_DISCIPLINES.filter((d) => planned[d] > 0);
      // A proposal that sets a scheduled discipline to nothing because it was
      // not recorded would take it out of the block. That is a conversation,
      // not a button.
      const proposable = scheduled.every((d) => recorded[d] > 0);
      out.push({
        code: 'split-drift',
        severity: 'info',
        message:
          `Over ${seen}, ` +
          drifting.map((d) => `${d.toLowerCase()} was ${pct(recorded[d])} of your training`).join(', ') +
          ` — ${block} plans ` + drifting.map((d) => pct(planned[d])).join(', ') + '.' +
          (proposable ? ' Matching the block to what you do is one option; the plan’s split is another.' : ''),
        evidence: { block, coveredWeeks: summary.coveredWeeks, totalHours: round1(summary.totalMinutes / 60),
          recorded, planned: Object.fromEntries(HISTORY_DISCIPLINES.map((d) => [d, Math.round(planned[d] * 1000) / 1000])) },
        action: proposable
          ? { tool: 'set_split', input: { block, weights: roundedWeights(recorded, scheduled, H.splitRound) } }
          : null,
      });
    }
  }

  /* --- A long session well beyond anything recorded ---------------------- */
  const sessions = plan.weeks?.[weekKey(here)] ?? [];
  for (const disc of HISTORY_DISCIPLINES) {
    const longest = summary.longest[disc];
    if (!longest) continue;
    const plannedLong = Math.max(0, ...sessions.filter((s) => s.disc === disc).map((s) => durToMin(s.dur)));
    if (plannedLong >= longest.minutes * H.longJump && plannedLong - longest.minutes >= H.longJumpMinutes) {
      out.push({
        code: 'long-session-jump',
        severity: 'info',
        message:
          `Week ${here + 1}’s longest ${NOUN[disc]} is ${fmtMin(plannedLong)}; the longest in ${seen} ` +
          `was ${fmtMin(longest.minutes)}, on ${longest.date}.`,
        evidence: { discipline: disc, longestPlanned: plannedLong, longestRecorded: longest.minutes,
          recordedOn: longest.date },
        action: null,
      });
    }
  }

  return out;
}
