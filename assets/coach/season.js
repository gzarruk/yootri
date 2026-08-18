/* Generative weekly-volume model — a JS port of ../yootri-rnd/plan_model.py.
   That file is the reference implementation; tests/season.test.js pins this port
   to its numbers. Change the shape here only alongside a finding written back to
   ../yootri-rnd/FINDINGS.md.

   The model is generative rather than fitted. Weekly volume is:

       annual / 52 * multiplier(block, week)

   so `annual` is a *scale*, not a total the season sums to — the default blocks
   cover 27 of 52 weeks and spend ~56% of the budget. Never present the sum of a
   season as an annual figure. */

export const WEEKS_PER_YEAR = 52;

/* Round, hand-chosen starting values expressing a conventional periodization
   shape: a gentle prep block, three progressively heavier base blocks, build
   blocks that trade volume for intensity, then a taper into the race. Nothing
   here is fitted to any published table.

   load     — multiplier for the block's hardest loading week, as a multiple of
              the flat average week (annual / 52).
   recovery — 1-indexed weeks within the block that are recovery weeks.
   ramp     — optional per-block override; [1, 1] holds every loading week flat. */
export const DEFAULT_SEASON = {
  blocks: [
    { name: 'Prep', weeks: 4, load: 0.9, recovery: [], ramp: [1.0, 1.0] },
    { name: 'Base 1', weeks: 4, load: 1.3, recovery: [4] },
    { name: 'Base 2', weeks: 4, load: 1.4, recovery: [4] },
    { name: 'Base 3', weeks: 4, load: 1.5, recovery: [4] },
    // Build blocks hold volume roughly flat: intensity is what rises here, and
    // you cannot raise both at once.
    { name: 'Build 1', weeks: 4, load: 1.3, recovery: [4], ramp: [1.0, 1.0] },
    { name: 'Build 2', weeks: 4, load: 1.25, recovery: [4], ramp: [1.0, 1.0] },
    // Peak tapers — volume comes down into competition, it does not build.
    { name: 'Peak', weeks: 2, load: 1.1, recovery: [], ramp: [1.0, 0.8] },
    { name: 'Race', weeks: 1, load: 0.7, recovery: [] },
  ],
  ramp: [0.85, 1.0],
  recovery: 0.7,
  roundTo: 0.5,
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

export function blockOf(period, season = DEFAULT_SEASON) {
  const hit = season.blocks.find((b) => norm(b.name) === norm(period));
  if (!hit) {
    const names = season.blocks.map((b) => b.name).join(', ');
    throw new Error(`unknown period ${JSON.stringify(period)}; choose from [${names}]`);
  }
  return hit;
}

/** Weekly volume as a multiple of the flat average week. */
export function multiplier(period, week = 1, season = DEFAULT_SEASON) {
  const b = blockOf(period, season);
  const loading = [];
  for (let i = 1; i <= b.weeks; i++) if (!b.recovery.includes(i)) loading.push(i);

  // Blocks with a single loading pattern accept "all", so callers can ask for a
  // block that doesn't progress week to week without inventing a week number.
  const w = norm(week) === 'all' ? loading[0] : Number(week);
  if (!Number.isInteger(w) || w < 1 || w > b.weeks) {
    throw new Error(`${b.name} has weeks 1..${b.weeks}; got ${JSON.stringify(week)}`);
  }

  if (b.recovery.includes(w)) return season.recovery;

  const [lo, hi] = b.ramp ?? season.ramp;
  const pos = loading.indexOf(w);
  const frac = loading.length === 1 ? hi : lo + ((hi - lo) * pos) / (loading.length - 1);
  return b.load * frac;
}

/** Planned hours for one week. `annualHours` is a scale, not a total. */
export function weeklyHours(annualHours, period, week = 1, season = DEFAULT_SEASON) {
  if (!(annualHours >= 0)) throw new Error('annualHours must be >= 0');
  const hours = (annualHours / WEEKS_PER_YEAR) * multiplier(period, week, season);
  if (!season.roundTo) return hours;
  return Math.round(hours / season.roundTo) * season.roundTo;
}

export function seasonWeeks(season = DEFAULT_SEASON) {
  return season.blocks.reduce((a, b) => a + b.weeks, 0);
}

/** Expand the block model into a flat week-by-week list. */
function expand(season) {
  const out = [];
  for (const b of season.blocks) {
    for (let w = 1; w <= b.weeks; w++) {
      out.push({ block: b.name, week: w, recovery: b.recovery.includes(w) });
    }
  }
  return out;
}

/** Resolve the block model onto a concrete runway of `weeks`, landing the last
    week on the race.

    A short runway drops weeks from the *front*: the taper and race-specific work
    are what you cannot skip, whereas base volume is what you never got to build.
    A long runway pads the front with prep weeks rather than stretching the taper.

    Returns plain data — a plan stores this once rather than recomputing it, so a
    later change to the model never silently reshapes an athlete's saved season. */
export function fitToRace({ annualHours, weeks, season = DEFAULT_SEASON }) {
  const n = Number(weeks);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`a season needs at least one week; got ${JSON.stringify(weeks)}`);
  }

  const full = expand(season);
  let chosen;

  if (n <= full.length) {
    chosen = full.slice(full.length - n);
  } else {
    const prep = season.blocks[0];
    const pad = [];
    for (let i = 0; i < n - full.length; i++) {
      const w = (i % prep.weeks) + 1;
      pad.push({ block: prep.name, week: w, recovery: prep.recovery.includes(w) });
    }
    chosen = pad.concat(full);
  }

  return chosen.map((e, i) => ({
    ...e,
    absWeek: i,
    // Carry the multiplier, not just the resulting hours. Downstream rules need
    // to know whether a week is genuinely hard, and that cannot be inferred
    // reliably from volume — in a flat season half the weeks sit below the mean
    // by construction. A load at or above 1.0 is at or above a flat average week.
    load: multiplier(e.block, e.week, season),
    hours: weeklyHours(annualHours, e.block, e.week, season),
  }));
}

/** Total hours the season actually prescribes. Deliberately unrounded, and
    deliberately not equal to `annualHours` — see the note at the top. */
export function seasonHours(annualHours, season = DEFAULT_SEASON) {
  const raw = { ...season, roundTo: null };
  let total = 0;
  for (const b of season.blocks) {
    for (let w = 1; w <= b.weeks; w++) total += weeklyHours(annualHours, b.name, w, raw);
  }
  return total;
}
