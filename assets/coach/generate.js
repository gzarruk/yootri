/* Turn one week's hour budget into actual sessions.

   This is the layer the reference model doesn't have: plan_model.py prescribes
   how many hours a week should hold, not what to do in them or on which days.

   Everything here is deterministic — same inputs, same output, no clock and no
   randomness — so a regenerated week is stable and a diff against it is
   meaningful. The engine never invents time: if the budget exceeds what the
   athlete actually has, it fills the available time and reports the shortfall
   rather than quietly scheduling a week that cannot happen. */

import { DAYS, allowedDays, maxPerWeek, weeklyAvailableMinutes } from './profile.js';
import { minToDur, durToMin, REST_DUR } from './duration.js';

const MIN_SESSION = 20; // below this it isn't a session, it's a gesture
const ROUND_TO = 5;

/* Per-discipline shaping. `pref` is the session length the generator aims for
   when deciding how many sessions a discipline's time should be split into;
   `long` weights that discipline's single longest session against its others. */
const DISC = {
  Swim: { pref: 50, min: 25, max: 120, long: 1.2 },
  Bike: { pref: 90, min: 30, max: 360, long: 2.0 },
  Run: { pref: 55, min: 20, max: 180, long: 1.8 },
  Strength: { pref: 45, min: 20, max: 75, long: 1.0 },
};

/* Share of the week each discipline takes, by block family. Hand-chosen to
   express a conventional shape — base builds aerobic volume, build trades some
   swim and strength time for run intensity, peak is bike-and-run specific.
   Not fitted to anything; see ../yootri-rnd/FINDINGS.md. */
const SPLITS = {
  Prep: { Swim: 0.25, Bike: 0.35, Run: 0.25, Strength: 0.15 },
  Base: { Swim: 0.22, Bike: 0.43, Run: 0.25, Strength: 0.1 },
  Build: { Swim: 0.18, Bike: 0.45, Run: 0.3, Strength: 0.07 },
  Peak: { Swim: 0.15, Bike: 0.47, Run: 0.33, Strength: 0.05 },
  Race: { Swim: 0.2, Bike: 0.4, Run: 0.4 },
};

/* Long-session targets, in minutes, by race distance.

   Anchored to race demand rather than to weekly volume. A 70.3 bike leg takes
   roughly three hours whether you train six hours a week or eighteen, so the
   long ride should stop growing once it reaches that — extra weekly volume is
   better spent on another session than on a fourth hour in the saddle. The
   athlete with less time needs the race-specific session *more*, not less.
   Strength has no race-day equivalent and so has no entry. */
const RACE_DEMAND = {
  sprint: { Swim: 30, Bike: 75, Run: 40 },
  olympic: { Swim: 45, Bike: 105, Run: 60 },
  '70.3': { Swim: 60, Bike: 165, Run: 100 },
  ironman: { Swim: 75, Bike: 300, Run: 150 },
};
const DEFAULT_RACE = '70.3';
// However long the race is, one session should not eat its whole discipline.
const MAX_LONG_SHARE = 0.7;

const demandFor = (raceType) => RACE_DEMAND[raceType] ?? RACE_DEMAND[DEFAULT_RACE];

const FOCUS = {
  Swim: { Prep: 'Technique drills', Base: 'Endurance sets', Build: 'Threshold sets', Peak: 'Race-pace sets', Race: 'Sharpen' },
  Bike: { Prep: 'Endurance spin', Base: 'Long ride', Build: 'Threshold intervals', Peak: 'Race-pace hold', Race: 'Openers' },
  Run: { Prep: 'Easy aerobic', Base: 'Long run', Build: 'Tempo', Peak: 'Race-pace brick run', Race: 'Shakeout' },
  Strength: { Prep: 'Core & stability', Base: 'Core & stability', Build: 'Power & durability', Peak: 'Maintenance', Race: 'Mobility' },
};

const ZONE = {
  Swim: { Prep: 'Z2', Base: 'Z2', Build: 'Z3–Z4', Peak: 'Z3', Race: 'Z2' },
  Bike: { Prep: 'Z2', Base: 'Z2', Build: 'Z3–Z4', Peak: 'Z3', Race: 'Z2' },
  Run: { Prep: 'Z2', Base: 'Z2', Build: 'Z3–Z4', Peak: 'Z3', Race: 'Z1–Z2' },
  Strength: { Prep: '—', Base: '—', Build: '—', Peak: '—', Race: '—' },
};

/** Map a block name onto its family, so "Base 1".."Base 3" share one shape. */
export function blockFamily(block) {
  const b = String(block ?? '');
  if (b.startsWith('Base')) return 'Base';
  if (b.startsWith('Build')) return 'Build';
  if (b.startsWith('Peak')) return 'Peak';
  if (b.startsWith('Race')) return 'Race';
  return 'Prep';
}

/** The discipline split for a block: an exact block override beats a family
    override, which beats the built-in default. */
export function resolveSplit(block, profile) {
  const family = blockFamily(block);
  return profile?.splits?.[block] ?? profile?.splits?.[family] ?? SPLITS[family];
}

const roundTo = (n, step = ROUND_TO) => Math.round(n / step) * step;

/** Total training minutes in a set of sessions. */
export function weekMinutes(sessions) {
  return sessions.reduce((a, s) => a + durToMin(s.dur), 0);
}

/** Decide how much of the week each discipline gets, dropping any that has
    nowhere to go or too little time to be worth scheduling, and giving its
    share back to the others. */
function discTargets(target, block, profile) {
  const split = resolveSplit(block, profile);
  let live = Object.keys(split).filter(
    (d) => allowedDays(profile, d).length > 0 && maxPerWeek(profile, d) > 0,
  );

  // Iterate: dropping a starved discipline raises everyone else's share, which
  // can rescue a discipline that was itself just under the bar.
  for (let guard = 0; guard < live.length + 1; guard++) {
    const sum = live.reduce((a, d) => a + split[d], 0);
    if (sum <= 0) return {};
    const targets = Object.fromEntries(live.map((d) => [d, (target * split[d]) / sum]));
    const starved = live.filter((d) => targets[d] < Math.max(MIN_SESSION, DISC[d].min));
    if (!starved.length) return targets;
    if (starved.length === live.length) {
      // Everything is starved: keep only the single biggest share so the week
      // holds one real session rather than a handful of token ones.
      const best = live.reduce((a, b) => (split[b] > split[a] ? b : a));
      return { [best]: target };
    }
    live = live.filter((d) => !starved.includes(d));
  }
  return {};
}

/** Split one discipline's time into individual session lengths, longest first.
    The first entry is the race-anchored long session where the discipline has
    one; everything else divides what is left. */
function sessionSizes(disc, minutes, profile, raceType) {
  const cfg = DISC[disc];
  const floor = Math.max(MIN_SESSION, cfg.min);
  const cap = Math.min(maxPerWeek(profile, disc), allowedDays(profile, disc).length);
  const demand = demandFor(raceType)[disc];

  if (!demand) {
    // No race-day equivalent (strength): even split, no long session.
    let n = Math.max(1, Math.min(cap, Math.round(minutes / cfg.pref)));
    while (n > 1 && minutes / n < floor) n--;
    return Array.from({ length: n }, () => Math.min(cfg.max, minutes / n));
  }

  const long = Math.min(demand, minutes * MAX_LONG_SHARE, cfg.max);
  const rest = minutes - long;

  let n = 1 + Math.max(0, Math.min(cap - 1, Math.round(rest / cfg.pref)));
  while (n > 1 && rest / (n - 1) < floor) n--;

  if (n === 1) return [Math.min(cfg.max, minutes)];
  return [long, ...Array.from({ length: n - 1 }, () => rest / (n - 1))].sort((a, b) => b - a);
}

/** Place sessions on days, never exceeding a day's available time. Disciplines
    with the longest single session are placed first so the long ride gets the
    big day before anything else claims it. */
function place(targets, profile, family, raceType) {
  const remaining = Object.fromEntries(DAYS.map((d) => [d, profile.availability[d] || 0]));
  const placed = [];

  const order = Object.keys(targets).sort(
    (a, b) => DISC[b].long * targets[b] - DISC[a].long * targets[a],
  );

  for (const disc of order) {
    const sizes = sessionSizes(disc, targets[disc], profile, raceType);
    const days = allowedDays(profile, disc);
    const used = new Set();

    for (const [rank, size] of sizes.entries()) {
      // Prefer a day this discipline isn't already on, so sessions spread out;
      // fall back to doubling up only if there's nowhere else with room.
      const pick = (pool) =>
        pool
          .filter((d) => remaining[d] >= Math.max(MIN_SESSION, DISC[disc].min))
          .sort((a, b) => remaining[b] - remaining[a] || DAYS.indexOf(a) - DAYS.indexOf(b))[0];

      const day = pick(days.filter((d) => !used.has(d))) ?? pick(days);
      if (!day) continue;

      const mins = Math.min(size, remaining[day], DISC[disc].max);
      if (mins < Math.max(MIN_SESSION, DISC[disc].min)) continue;

      remaining[day] -= mins;
      used.add(day);
      placed.push({ day, disc, minutes: mins, family, isLong: rank === 0 });
    }
  }
  return { placed, remaining };
}

/** Round to whole 5-minute blocks, then push the total back toward the budget
    using whatever day capacity is left. */
function reconcile(placed, remaining, target) {
  for (const s of placed) {
    const rounded = roundTo(s.minutes);
    const delta = rounded - s.minutes;
    if (delta <= remaining[s.day]) {
      remaining[s.day] -= delta;
      s.minutes = rounded;
    } else {
      s.minutes = Math.floor(s.minutes / ROUND_TO) * ROUND_TO;
      remaining[s.day] += s.minutes === 0 ? 0 : 0;
    }
  }

  const total = () => placed.reduce((a, s) => a + s.minutes, 0);
  const byLongest = [...placed].sort((a, b) => b.minutes - a.minutes);

  // Too little: grow the longest sessions that still have room on their day.
  // Grow the ordinary sessions before the race-anchored long one — the whole
  // point of anchoring it is that it stops growing once it meets race demand.
  const canGrow = (x) => remaining[x.day] >= ROUND_TO && x.minutes + ROUND_TO <= DISC[x.disc].max;
  let guard = 0;
  while (target - total() >= ROUND_TO && guard++ < 200) {
    const s = byLongest.find((x) => !x.isLong && canGrow(x)) ?? byLongest.find(canGrow);
    if (!s) break;
    s.minutes += ROUND_TO;
    remaining[s.day] -= ROUND_TO;
  }

  // Too much: shrink the longest sessions that can afford it.
  guard = 0;
  while (total() - target >= ROUND_TO && guard++ < 200) {
    const s = byLongest.find(
      (x) => x.minutes - ROUND_TO >= Math.max(MIN_SESSION, DISC[x.disc].min),
    );
    if (!s) break;
    s.minutes -= ROUND_TO;
    remaining[s.day] += ROUND_TO;
  }

  return placed;
}

/**
 * Generate one week of sessions.
 *
 * @param {object}  opts
 * @param {number}  opts.hours     planned hours for the week (from the season model)
 * @param {string}  opts.block     block name, e.g. "Base 2"
 * @param {object}  opts.profile   a normalized profile
 * @param {string} [opts.idPrefix] prefix for session ids; callers pass the week
 *                                 key so ids are unique across a whole plan
 * @returns {{sessions: object[], budgetMinutes: number, plannedMinutes: number, shortfallMinutes: number}}
 */
export function generateWeek({ hours, block, profile, idPrefix = 'w' }) {
  const family = blockFamily(block);
  const budgetMinutes = Math.max(0, Math.round((Number(hours) || 0) * 60));
  const capacity = weeklyAvailableMinutes(profile);
  const target = Math.min(budgetMinutes, capacity);

  const targets = discTargets(target, block, profile);
  const { placed, remaining } = place(targets, profile, family, profile.raceType);
  reconcile(placed, remaining, target);

  const work = placed
    .filter((s) => s.minutes > 0)
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || b.minutes - a.minutes);

  const sessions = [];
  const busy = new Set(work.map((s) => s.day));

  for (const day of DAYS) {
    for (const s of work.filter((x) => x.day === day)) {
      sessions.push({
        id: '',
        day,
        disc: s.disc,
        focus: FOCUS[s.disc][family],
        dur: minToDur(s.minutes),
        zone: ZONE[s.disc][family],
      });
    }
    if (!busy.has(day)) {
      sessions.push({
        id: '',
        day,
        disc: 'Rest',
        focus: 'Recovery & mobility',
        dur: REST_DUR,
        zone: '—',
      });
    }
  }

  sessions.forEach((s, i) => {
    s.id = `${idPrefix}-${i}`;
  });

  const plannedMinutes = weekMinutes(sessions);
  return {
    sessions,
    budgetMinutes,
    plannedMinutes,
    shortfallMinutes: Math.max(0, budgetMinutes - plannedMinutes),
  };
}
