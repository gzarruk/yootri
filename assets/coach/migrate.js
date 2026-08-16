/* Moving a saved plan from schema v2 to v3.

   v2 stored a *sparse overlay*: only the weeks you had edited, keyed by
   "Phase_N", with everything else re-derived from a hardcoded template at render
   time. That worked while the template was fixed. It cannot survive a plan whose
   season is generated, because re-fitting changes block lengths — a
   phase-relative key would quietly reassign your edits to different calendar
   weeks, and regenerated sessions would orphan every completion flag.

   v3 therefore materializes all weeks under absolute keys ("w0".."w15").

   Two decisions worth knowing:

   - **Session ids are preserved exactly.** v2 ids are already stable and unique
     ("Base-0-3" from the template, "cus-..." for sessions you added), and `done`
     is keyed by them. Minting new ids would mean re-keying completion history,
     with a real chance of losing some. Keeping them costs nothing.

   - **The profile is inferred from the plan, not defaulted.** Availability is
     the most any weekday has ever been asked to hold, and the annual budget is
     whatever reproduces the plan's own total volume. A migrated plan opens
     looking exactly like it did yesterday — not re-planned, and not full of
     warnings about days that were fine before. */

import { LEGACY_PLAN_DATA } from './legacy-plan.js';
import { DAYS, normalizeProfile } from './profile.js';
import { durToMin } from './duration.js';
import { fitToRace } from './season.js';

export const SCHEMA_VERSION = 3;

/** The legacy phases, in order, with the week counts the app shipped. */
export const LEGACY_PHASES = Object.keys(LEGACY_PLAN_DATA).map((name) => ({
  name,
  weeks: LEGACY_PLAN_DATA[name].duration ?? LEGACY_PLAN_DATA[name].weeks.length,
}));

export const LEGACY_TOTAL_WEEKS = LEGACY_PHASES.reduce((a, p) => a + p.weeks, 0);

/** Flatten a phase-relative position onto an absolute week index. */
export function legacyAbsWeek(phase, week) {
  let acc = 0;
  for (const p of LEGACY_PHASES) {
    if (p.name === phase) return acc + (Number(week) || 0);
    acc += p.weeks;
  }
  return 0;
}

/* Mirrors template()/freshSessions() from the v2 index.html: short template
   arrays repeat to fill a longer phase. */
const legacyTemplate = (phase, week) => {
  const ws = LEGACY_PLAN_DATA[phase].weeks;
  return ws[week % ws.length];
};

const legacyFreshSessions = (phase, week) =>
  legacyTemplate(phase, week).days.map((s, i) => ({
    ...s,
    day: s.d,
    id: `${phase}-${week}-${i}`,
  }));

const perDayMinutes = (sessions) => {
  const out = {};
  for (const s of sessions) out[s.day] = (out[s.day] ?? 0) + durToMin(s.dur);
  return out;
};

/**
 * Migrate a stored plan to schema v3. Pure: never mutates its argument, and
 * returns an already-v3 plan unchanged.
 */
export function migratePlan(raw) {
  const src = structuredClone(raw);
  if (src.schema === SCHEMA_VERSION) return src;

  // 1. Materialize every week under an absolute key, preferring what was saved.
  const weeks = {};
  let abs = 0;
  for (const phase of LEGACY_PHASES) {
    for (let w = 0; w < phase.weeks; w++) {
      const saved = src.weeks?.[`${phase.name}_${w}`];
      weeks[`w${abs}`] =
        Array.isArray(saved) && saved.length ? saved : legacyFreshSessions(phase.name, w);
      abs++;
    }
  }

  const allWeeks = Object.values(weeks);

  // 2. Infer availability: the most any weekday has ever been asked to hold.
  //    Anything less would flag days that were working fine yesterday.
  const availability = Object.fromEntries(DAYS.map((d) => [d, 0]));
  for (const sessions of allWeeks) {
    const perDay = perDayMinutes(sessions);
    for (const d of DAYS) availability[d] = Math.max(availability[d], perDay[d] ?? 0);
  }

  // 3. Pick the annual budget that reproduces this plan's own volume. The model
  //    is proportional, so one probe fit is enough to solve for the scale.
  const planMinutes = allWeeks.flat().reduce((a, s) => a + durToMin(s.dur), 0);
  const PROBE = 1000;
  const probeMinutes = fitToRace({ annualHours: PROBE, weeks: LEGACY_TOTAL_WEEKS })
    .reduce((a, w) => a + w.hours * 60, 0);
  const annualHours = probeMinutes > 0 ? (PROBE * planMinutes) / probeMinutes : undefined;

  const profile = normalizeProfile({
    ...(src.profile ?? {}),
    annualHours,
    availability,
  });

  const season = fitToRace({ annualHours: profile.annualHours, weeks: LEGACY_TOTAL_WEEKS });

  return {
    id: src.id,
    name: src.name,
    schema: SCHEMA_VERSION,
    start: src.start,
    profile,
    season,
    weeks,
    done: src.done ?? {},
    actuals: src.actuals ?? {},
    chat: src.chat ?? [],
    chartmode: src.chartmode ?? 'weekly',
    charthidden: src.charthidden ?? {},
    view: { week: legacyAbsWeek(src.view?.phase ?? LEGACY_PHASES[0].name, src.view?.week ?? 0) },
    updatedAt: src.updatedAt ?? 0,
  };
}
