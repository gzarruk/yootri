/* Deterministic rules that gate anything written into a plan — whether it came
   from the generator, a drag-and-drop, or the coach agent.

   Two levels, and the distinction matters:
     error — the week is not physically possible (more training than hours in
             the day, a session on a day the athlete told us was impossible).
             An apply is blocked.
     warn  — the week is possible but questionable (a steep ramp, a stalled
             taper). Surfaced next to the diff and applied if the athlete says so.

   Coaching judgement stays advisory. The engine refuses to write impossibilities,
   not to overrule the person doing the training. */

import { DAYS, allowedDays } from './profile.js';
import { durToMin } from './duration.js';

const MIN_SESSION = 20;
const MAX_SESSION = 6 * 60;
const MAX_RAMP = 1.1; // classic 10%/week guidance
const MAX_LOADING_RUN = 4; // consecutive hard weeks before recovery is overdue
const MAX_BLOCK_STEP = 1.25; // a new block may re-step, but not double

const issue = (level, code, weekIndex, message) => ({ level, code, weekIndex, message });

const fmtH = (min) => `${(min / 60).toFixed(1).replace(/\.0$/, '')}h`;

/** Total training minutes in a week. */
export function totalMinutes(sessions) {
  return sessions.reduce((a, s) => a + durToMin(s.dur), 0);
}

/**
 * Check a single week in isolation.
 * @param {object[]} sessions
 * @param {{profile: object, budgetMinutes?: number, weekIndex?: number}} ctx
 */
export function validateWeek(sessions, { profile, budgetMinutes, weekIndex = 0 } = {}) {
  const out = [];

  const perDay = {};
  for (const s of sessions) perDay[s.day] = (perDay[s.day] ?? 0) + durToMin(s.dur);

  for (const d of DAYS) {
    const have = profile.availability[d] || 0;
    const used = perDay[d] ?? 0;
    if (used > have) {
      out.push(
        issue('error', 'day-over-capacity', weekIndex,
          `${d} is scheduled for ${fmtH(used)} but only ${fmtH(have)} is available.`),
      );
    }
  }

  for (const s of sessions) {
    const mins = durToMin(s.dur);
    if (mins === 0) continue; // rest entries are not sessions

    if (mins < MIN_SESSION) {
      out.push(
        issue('warn', 'session-too-short', weekIndex,
          `${s.disc} on ${s.day} is only ${mins} minutes — too short to be worth the trip.`),
      );
    }
    if (mins > MAX_SESSION) {
      out.push(
        issue('warn', 'session-too-long', weekIndex,
          `${s.disc} on ${s.day} is ${fmtH(mins)} — check that is deliberate.`),
      );
    }
    if (s.disc !== 'Rest' && !allowedDays(profile, s.disc).includes(s.day)) {
      out.push(
        issue('error', 'constraint-violated', weekIndex,
          `${s.disc} is scheduled on ${s.day}, which your constraints rule out.`),
      );
    }
  }

  if (Number.isFinite(budgetMinutes)) {
    const planned = totalMinutes(sessions);
    if (planned < budgetMinutes) {
      out.push(
        issue('warn', 'budget-shortfall', weekIndex,
          `Week plans ${fmtH(planned)} against a ${fmtH(budgetMinutes)} budget (${budgetMinutes} min).`),
      );
    }
  }

  return out;
}

/**
 * Check a whole season — the rules that only exist across weeks.
 * @param {{absWeek: number, block: string, recovery: boolean, sessions: object[]}[]} weeks
 */
export function validateSeason(weeks, { profile } = {}) {
  const out = [];

  weeks.forEach((w, i) => {
    if (profile) out.push(...validateWeek(w.sessions, { profile, weekIndex: w.absWeek ?? i }));
  });

  // Ramp is measured against the last *loading* week, and only within a block.
  // The 10%/week convention describes progression inside a build; a new block
  // deliberately re-steps, and the model's own Prep -> Base 1 transition is a
  // 23% step up out of an easy block. Flagging that taught the athlete to
  // ignore every warning the app would ever show. Block transitions get their
  // own, looser ceiling so the reset does not become a blind spot.
  let lastLoading = null;
  let lastBlock = null;
  let blockPeak = null;
  let prevBlockPeak = null;
  let enteredBlock = false;
  let loadingRun = 0;

  weeks.forEach((w, i) => {
    const idx = w.absWeek ?? i;
    const mins = totalMinutes(w.sessions);
    const block = String(w.block ?? '');

    if (lastBlock !== null && block !== lastBlock) {
      prevBlockPeak = blockPeak;
      blockPeak = null;
      lastLoading = null;
      enteredBlock = true;
    }
    lastBlock = block;

    if (w.recovery) {
      loadingRun = 0;
      return;
    }

    if (enteredBlock && prevBlockPeak !== null && mins > prevBlockPeak * MAX_BLOCK_STEP) {
      const pct = Math.round((mins / prevBlockPeak - 1) * 100);
      out.push(
        issue('warn', 'block-step-too-steep', idx,
          `${block} opens ${pct}% above the previous block's hardest week (${fmtH(prevBlockPeak)} → ${fmtH(mins)}).`),
      );
    }
    enteredBlock = false;

    // A week only accrues fatigue debt if it is actually hard. `load` is the
    // model's own multiplier against a flat average week; where it is missing
    // (hand-built weeks, migrated plans) fall back to counting every non-recovery
    // week, which is conservative rather than silently skipping the rule.
    const isLoading = typeof w.load === 'number' ? w.load >= 1 : true;

    if (isLoading) {
      loadingRun++;
      if (loadingRun > MAX_LOADING_RUN) {
        out.push(
          issue('warn', 'recovery-overdue', idx,
            `${loadingRun} hard weeks in a row without a recovery week.`),
        );
      }
    } else {
      loadingRun = 0;
    }

    if (lastLoading !== null && mins > lastLoading * MAX_RAMP) {
      const pct = Math.round((mins / lastLoading - 1) * 100);
      out.push(
        issue('warn', 'ramp-too-steep', idx,
          `Volume jumps ${pct}% over the previous loading week (${fmtH(lastLoading)} → ${fmtH(mins)}).`),
      );
    }
    lastLoading = mins;
    blockPeak = Math.max(blockPeak ?? 0, mins);
  });

  // The taper must actually taper: once into Peak/Race, volume only comes down.
  const taperFrom = weeks.findIndex((w) => /^(Peak|Race)/.test(String(w.block ?? '')));
  if (taperFrom !== -1) {
    for (let i = taperFrom + 1; i < weeks.length; i++) {
      const prev = totalMinutes(weeks[i - 1].sessions);
      const cur = totalMinutes(weeks[i].sessions);
      if (cur > prev) {
        out.push(
          issue('warn', 'taper-not-decreasing', weeks[i].absWeek ?? i,
            `Volume rises into race week (${fmtH(prev)} → ${fmtH(cur)}); the taper should only come down.`),
        );
      }
    }
  }

  return out;
}
