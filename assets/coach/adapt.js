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

const weekKey = (w) => `w${w}`;
const round1 = (n) => Math.round(n * 10) / 10;

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

  // Everything below reads the logged past, and week one has none.
  if (here <= 0) return out;

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

  return out;
}
