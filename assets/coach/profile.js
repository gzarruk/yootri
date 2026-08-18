/* The athlete profile — everything the engine needs that the training model
   itself cannot know: how much time there is, when the race is, and what the
   week will not tolerate.

   Everything here is plain data and pure functions. `normalizeProfile` is the
   only entry point that should ever touch raw user or model input: it fills
   defaults, clamps nonsense, and drops constraints it does not understand, so
   downstream code can assume a complete, sane profile. */

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const MINUTES_IN_DAY = 24 * 60;
const RULES = ['onlyDays', 'avoidDays', 'maxPerWeek'];
export const DISCIPLINES = ['Swim', 'Bike', 'Run', 'Strength'];

export const DEFAULT_PROFILE = {
  annualHours: 500,
  raceDate: null,
  raceType: '70.3',
  // A defensible default week: something on most days, the long sessions at the
  // weekend, Monday off.
  availability: { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 },
  constraints: [],
  experience: 'intermediate',
  notes: '',
};

const clampMinutes = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), MINUTES_IN_DAY);
};

function normalizeConstraint(c) {
  if (!c || !RULES.includes(c.rule) || !c.disc) return null;
  if (c.rule === 'maxPerWeek') {
    const n = Number(c.value);
    if (!Number.isFinite(n) || n < 0) return null;
    return { disc: c.disc, rule: c.rule, value: Math.round(n) };
  }
  const days = (Array.isArray(c.value) ? c.value : [c.value]).filter((d) => DAYS.includes(d));
  if (!days.length) return null;
  return { disc: c.disc, rule: c.rule, value: days };
}

/* Optional per-athlete discipline splits, keyed by block name ("Base 3") or
   block family ("Base"). The default split is one defensible opinion about a
   70.3; it is not the only one. An athlete who lifts through the early season
   and only starts swimming at Base 3 should be able to say so as data, and the
   coach agent should be able to write it on their behalf — neither should
   require editing the engine. A weight of 0 means "none of this discipline". */
function normalizeSplits(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const [block, weights] of Object.entries(raw)) {
    if (!weights || typeof weights !== 'object') continue;
    const clean = {};
    for (const [disc, w] of Object.entries(weights)) {
      if (!DISCIPLINES.includes(disc)) continue;
      const n = Number(w);
      if (!Number.isFinite(n) || n < 0) continue;
      clean[disc] = n;
    }
    // An all-zero or entirely unrecognised split is not a preference, it is a
    // typo. Dropping it falls back to the default rather than emptying the week.
    if (Object.values(clean).reduce((a, b) => a + b, 0) > 0) out[block] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Fill defaults, clamp nonsense, drop constraints we don't understand.
    Pure and idempotent: normalize(normalize(x)) deep-equals normalize(x). */
export function normalizeProfile(raw = {}) {
  const availability = {};
  for (const d of DAYS) {
    availability[d] = Object.hasOwn(raw.availability ?? {}, d)
      ? clampMinutes(raw.availability[d])
      : DEFAULT_PROFILE.availability[d];
  }

  const annual = Number(raw.annualHours);
  const splits = normalizeSplits(raw.splits);

  return {
    annualHours: Number.isFinite(annual) && annual > 0 ? annual : DEFAULT_PROFILE.annualHours,
    raceDate: raw.raceDate ?? DEFAULT_PROFILE.raceDate,
    raceType: raw.raceType ?? DEFAULT_PROFILE.raceType,
    availability,
    constraints: (raw.constraints ?? []).map(normalizeConstraint).filter(Boolean),
    ...(splits ? { splits } : {}),
    experience: raw.experience ?? DEFAULT_PROFILE.experience,
    notes: raw.notes ?? DEFAULT_PROFILE.notes,
  };
}

export function weeklyAvailableMinutes(profile) {
  return DAYS.reduce((a, d) => a + (profile.availability[d] || 0), 0);
}

/** Days a discipline may be scheduled on, after constraints and after removing
    days with no time available at all. */
export function allowedDays(profile, disc) {
  let days = DAYS.filter((d) => (profile.availability[d] || 0) > 0);
  for (const c of profile.constraints) {
    if (c.disc !== disc) continue;
    if (c.rule === 'onlyDays') days = days.filter((d) => c.value.includes(d));
    if (c.rule === 'avoidDays') days = days.filter((d) => !c.value.includes(d));
  }
  return days;
}

/** Session cap for a discipline, or Infinity when uncapped. */
export function maxPerWeek(profile, disc) {
  const c = profile.constraints.find((x) => x.disc === disc && x.rule === 'maxPerWeek');
  return c ? c.value : Infinity;
}
