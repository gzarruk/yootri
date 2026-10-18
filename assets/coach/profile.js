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

/* How displaced minutes are redistributed when the week's prescribed shape
   meets a day that cannot hold it. `proportional` hands them back in the shape's
   own proportions; the others exist because "put it on the weekend" and "give it
   to Wednesday" are things athletes actually say. A day name is also valid. */
export const SPREAD_MODES = ['proportional', 'weekend', 'even'];

export const DEFAULT_WEEK_SHAPE = { enabled: true, spread: 'proportional', pins: {} };

/* The disciplines an athlete can name a long-session day for. Swim and
   strength have no session that has to land on a particular day. Bike first:
   it is the one that takes the week's biggest day (see shape.js). */
export const LONG_DAY_DISCIPLINES = ['Bike', 'Run'];
/** The most sessions in a day an athlete can ask for; absent means no cap. */
export const MAX_SESSIONS_PER_DAY = 3;

export const DEFAULT_PROFILE = {
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

/* Optional steering for how a week's hours fall across its days. The common
   case needs none of this — a day set to 0 in `availability` is already a rest
   day, and its hours already reappear elsewhere. These are for saying *where*.

   Absent keys stay absent, exactly as splits do: writing defaults into every
   profile would rewrite every stored plan on load to say nothing. */
function normalizeWeekShape(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};

  if (raw.enabled === false) out.enabled = false;

  const spread = String(raw.spread ?? '');
  if (DAYS.includes(spread) || (SPREAD_MODES.includes(spread) && spread !== 'proportional')) {
    out.spread = spread;
  }

  const pins = {};
  for (const [day, v] of Object.entries(raw.pins ?? {})) {
    if (!DAYS.includes(day)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    pins[day] = clampMinutes(n);
  }
  if (Object.keys(pins).length) out.pins = pins;

  return Object.keys(out).length ? out : undefined;
}

/* Optional: the day the long ride and the long run should land on. A
   preference, not a constraint — when the day cannot hold the session the
   generator falls back and the validator says so (long-day-unavailable). */
function normalizeLongDays(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const disc of LONG_DAY_DISCIPLINES) if (DAYS.includes(raw[disc])) out[disc] = raw[disc];
  return Object.keys(out).length ? out : undefined;
}

/* Optional: how many sessions one day may hold. Absent is "as many as fit",
   which is what generation has always done — doubling up only when no other
   day has room. One is "no two-a-days". */
function normalizeSessionsPerDay(raw) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SESSIONS_PER_DAY ? n : undefined;
}

/** The week shape a profile is asking for, with every default filled in. */
export const resolveWeekShape = (profile) => ({
  ...DEFAULT_WEEK_SHAPE,
  ...(profile?.weekShape ?? {}),
});

/** Fill defaults, clamp nonsense, drop constraints we don't understand.
    Pure and idempotent: normalize(normalize(x)) deep-equals normalize(x). */
export function normalizeProfile(raw = {}) {
  const availability = {};
  for (const d of DAYS) {
    availability[d] = Object.hasOwn(raw.availability ?? {}, d)
      ? clampMinutes(raw.availability[d])
      : DEFAULT_PROFILE.availability[d];
  }

  const splits = normalizeSplits(raw.splits);
  const weekShape = normalizeWeekShape(raw.weekShape);
  const longDays = normalizeLongDays(raw.longDays);
  const maxSessionsPerDay = normalizeSessionsPerDay(raw.maxSessionsPerDay);

  return {
    raceDate: raw.raceDate ?? DEFAULT_PROFILE.raceDate,
    raceType: raw.raceType ?? DEFAULT_PROFILE.raceType,
    availability,
    constraints: (raw.constraints ?? []).map(normalizeConstraint).filter(Boolean),
    ...(splits ? { splits } : {}),
    ...(weekShape ? { weekShape } : {}),
    ...(longDays ? { longDays } : {}),
    ...(maxSessionsPerDay ? { maxSessionsPerDay } : {}),
    experience: raw.experience ?? DEFAULT_PROFILE.experience,
    notes: raw.notes ?? DEFAULT_PROFILE.notes,
  };
}

export function weeklyAvailableMinutes(profile) {
  return DAYS.reduce((a, d) => a + (profile.availability[d] || 0), 0);
}

/** The biggest week a season is built to: all the time the athlete said they
    have, down to the half hour (rounding up would plan past it). A season is
    sized by this and shaped by the block model, so it can never outrun the
    week it has to fit in. With no time entered the default week sizes it — the
    per-day rules already say what is wrong with a week that has no time. */
export function peakHoursFor(profile) {
  const minutes = weeklyAvailableMinutes(profile)
    || DAYS.reduce((a, d) => a + DEFAULT_PROFILE.availability[d], 0);
  return Math.max(0.5, Math.floor(minutes / 30) / 2);
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
