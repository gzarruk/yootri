/* Events the athlete puts on the calendar: races, and anything else worth
   seeing next to the training.

   A race carries a *priority*, and that is what the season model reads:

     primary   — the race the season is aimed at. There is never more than one,
                 whatever arrives from storage or from a plan file somebody else
                 wrote, because it is the single source of truth for the plan's
                 race date and distance.
     secondary — a race inside the build. It does not move the season's length;
                 it gets a taper week and a race week landed where it falls.
     null      — a marker. It draws on the calendar and changes nothing.

   Everything here is pure: a list goes in, a new list comes out. Nothing
   reaches into a plan, and dates stay ISO strings — the page formats them,
   because only the page knows the reader's locale. */

import { parseISO, toISO } from './dates.js';

const text = (v) => String(v ?? '').trim();

/** Race distances the race a season is *built for* may be given: an olympic, a
    70.3 or an ironman, shortest first. yootri plans endurance racing from the
    olympic up, so a sprint is not offered here: it is raced off a season built
    for one of these, not off a season of its own. (Olympic left this list when
    yootri went long-course only, and came back on 18 Oct 2026, when the
    fitness bands and the demand table already described it and a season could
    be built to arrive at its target.)

    These are stored names, not shown ones — a RACE_DEMAND key in generate.js,
    and what every plan already written carries. See RACE_TYPE_LABELS for what
    the athlete reads. */
export const RACE_TYPES = ['olympic', '70.3', 'ironman'];

/* Distances that were offered as a season's own race once and are not any more.
   They are still offerable as a secondary race, below. */
const RETIRED_RACE_TYPES = ['sprint'];

/** What each distance is called on screen.

    Kept apart from the stored name deliberately. The stored name is a key: it
    indexes RACE_DEMAND, it syncs to Firestore, it is written into every
    exported plan file, and it is what a season already under way is sized and
    validated by. The shown name is copy. Restyling the copy must not re-aim a
    plan, and it cannot, because nothing here is ever written down.

    A distance with no entry is shown as it is stored, which is what a distance
    out of a plan file this app did not write wants — inventing a display name
    for one would be inventing copy nobody asked for. */
const RACE_TYPE_LABELS = Object.assign(Object.create(null), {
  '70.3': 'IM 70.3',
  ironman: 'IRONMAN',
  sprint: 'Sprint',
  olympic: 'Olympic',
  '10k': '10 km',
  'half-marathon': 'Half marathon',
  marathon: 'Marathon',
  swimrun: 'Swim-Run',
});

/**
 * The name to show for a stored distance. Total: an unknown distance — from a
 * plan file this app did not write — comes back as itself rather than as
 * nothing, and a missing one as the empty string for a caller to fall back on.
 */
export function raceTypeLabel(raceType) {
  const stored = text(raceType);
  return RACE_TYPE_LABELS[stored] ?? stored;
}

/** Every distance a season can be *sized by* (see RACE_DEMAND in generate.js) —
    what is offered now, plus what was offered before.

    Separate from RACE_TYPES because they answer different questions. RACE_TYPES
    is what a picker may put in front of the athlete; this is what may reach
    `profile.raceType`. A plan is self-contained, so a season already built for
    a sprint has to keep saying "sprint" — stripping it would leave the primary
    race with no distance and silently re-read the season as the default one. */
export const KNOWN_RACE_TYPES = [...RACE_TYPES, ...RETIRED_RACE_TYPES];

/** Distances a *secondary* race may be given.

    Wider than KNOWN_RACE_TYPES, and it can afford to be: a secondary race is a
    label on a taper the season model has already decided the shape of. It never
    reaches `profile.raceType`, so it never has to have a RACE_DEMAND row —
    which is exactly why a standalone marathon can go in a build here and could
    not be the race the build is for. `normalizeEvent` enforces that boundary. */
export const SECONDARY_RACE_TYPES = [
  '10k', 'half-marathon', 'marathon', 'sprint', 'olympic', '70.3', 'ironman', 'swimrun',
];

/** Every distance that may be written down at all. A name in none of these
    lists is no distance: the generator would fall back without saying so. */
export const STORABLE_RACE_TYPES = [...new Set([...KNOWN_RACE_TYPES, ...SECONDARY_RACE_TYPES])];

/** How long a race takes and how hard it is raced, for each distance, as a
    typical mid-pack age-group athlete. Two things read it, and only for a race
    that is *not* the one the season is built for: whether the race gets a taper
    (one longer than `TAPER_MIN_MINUTES`) and how much load it adds to the
    athlete's fitness on the day.

    **Unfitted**, like every coaching number here, and it varies a great deal
    between athletes — the Ironman row especially, where the finishing time
    depends on fitness, goal and age more than on the distance. So an event may
    carry the athlete's own `expectedMinutes`, which wins over this table.

    `intensity` is a share of threshold for the whole race, squared and
    multiplied by the hours the way every other session is scored (load.js), so
    a race lands on the same scale as the training around it. */
export const RACE_NOMINAL = Object.freeze({
  '10k': Object.freeze({ minutes: 55, intensity: 0.95 }),
  'half-marathon': Object.freeze({ minutes: 110, intensity: 0.9 }),
  sprint: Object.freeze({ minutes: 75, intensity: 0.95 }),
  olympic: Object.freeze({ minutes: 150, intensity: 0.9 }),
  marathon: Object.freeze({ minutes: 240, intensity: 0.8 }),
  swimrun: Object.freeze({ minutes: 270, intensity: 0.8 }),
  '70.3': Object.freeze({ minutes: 330, intensity: 0.78 }),
  ironman: Object.freeze({ minutes: 750, intensity: 0.68 }),
});

/** A race of this many minutes or fewer gets no taper week: it is a hard day in
    the build, not an event to arrive fresh for. Over it, it does. */
export const TAPER_MIN_MINUTES = 120;

const EXPECTED_MINUTES = Object.freeze({ min: 20, max: 1200 });

/* A time the athlete typed, in whole minutes, or undefined when it is not one
   to believe: a number or a number in a box, between 20 minutes and 20 hours. */
export function believableMinutes(v) {
  if (typeof v === 'boolean' || v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= EXPECTED_MINUTES.min && n <= EXPECTED_MINUTES.max ? Math.round(n) : undefined;
}

/** How many minutes a race is expected to take: the athlete's own figure if
    they gave one, else the nominal time for its distance, else null. */
export function raceMinutes(event) {
  return believableMinutes(event?.expectedMinutes) ?? RACE_NOMINAL[event?.raceType]?.minutes ?? null;
}

/** Does this race get a taper week? A race whose length is not known does — it
    always did, and an unknown is not a reason to take a taper away. */
export function hasTaper(event) {
  const minutes = raceMinutes(event);
  return minutes === null || minutes > TAPER_MIN_MINUTES;
}

/** The load a race adds to the day it is on, on load.js's scale, or null when
    its distance and time are not known. */
export function raceLoad(event) {
  const minutes = raceMinutes(event);
  const row = RACE_NOMINAL[event?.raceType];
  if (minutes === null || !row) return null;
  return Math.round((minutes / 60) * row.intensity ** 2 * 1000) / 10;
}

/** How much the athlete wants from the race, which sets the fitness the season
    is built to arrive with (targets.js). Stored on the primary race as
    `ambition`. Ordered from least to most. These are stored names: the words
    the athlete reads are the page's. */
export const AMBITIONS = Object.freeze(['finish', 'intermediate', 'competitive']);

/** What a race with no ambition is read as. A plan made before ambitions
    existed gets this the next time it is re-fitted, in the draft the athlete
    sees. */
export const DEFAULT_AMBITION = 'intermediate';

export const EVENT_KINDS = ['race', 'other'];

/** What a race is to this season. Ordered hardest-commitment first, which is
    the order a picker wants to show them in. */
export const EVENT_PRIORITIES = ['primary', 'secondary'];

/* What a race is asking to be, before the distance rule below is applied.

   `goal: true` is what every plan written before priorities existed carries.
   Reading it here rather than migrating the record is what lets the field
   change with no schema bump: a stored plan, a plan file and a synced record
   all keep working, and the upgraded shape is written back the next time
   anything saves. */
function askedPriority(raw) {
  if (EVENT_PRIORITIES.includes(raw.priority)) return raw.priority;
  return raw.goal === true ? 'primary' : null;
}

/**
 * One event in canonical form, or null when it is not usable — a missing or
 * unparseable date, or no id to file it under. Total: bad input is dropped, not
 * thrown, because events arrive from storage and from imported plan files.
 *
 * @param {object} raw
 * @param {object} [opts]
 * @param {string} [opts.id] id to use when `raw` has none (a new event)
 */
export function normalizeEvent(raw, { id } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const eventId = text(raw.id) || text(id);
  const date = toISO(parseISO(raw.date));
  if (!eventId || !date) return null;

  const kind = EVENT_KINDS.includes(raw.kind) ? raw.kind : 'other';
  const raceType = kind === 'race' && STORABLE_RACE_TYPES.includes(raw.raceType) ? raw.raceType : null;

  // Only a race has a priority: a priority is an instruction to the season
  // model, and a non-race has nothing to instruct it with.
  let priority = kind === 'race' ? askedPriority(raw) : null;

  /* The guard on the whole two-list split. A distance the season model cannot
     be sized by must never become `profile.raceType` — `demandFor` would fall
     back to a 70.3 and build a season for a race nobody entered. So a primary
     marathon is demoted rather than dropped: the race is real and still wants
     its taper, it simply is not what the season is for.

     A race with no distance at all is left alone. `raceFieldsOf` hands back a
     null distance so the profile keeps the one it has, and demoting for want of
     a distance would move the season's date instead. */
  if (priority === 'primary' && raceType && !KNOWN_RACE_TYPES.includes(raceType)) {
    priority = 'secondary';
  }

  // An ambition belongs to the race the season is built for and nothing else —
  // a tune-up has no target of its own — so it goes with the priority.
  const ambition = priority === 'primary' && AMBITIONS.includes(raw.ambition) ? raw.ambition : undefined;
  // The athlete's own idea of how long the race will take them, for a race only.
  const expectedMinutes = kind === 'race' ? believableMinutes(raw.expectedMinutes) : undefined;

  return {
    id: eventId,
    name: text(raw.name),
    date,
    kind,
    raceType,
    priority,
    note: text(raw.note),
    ...(ambition ? { ambition } : {}),
    ...(expectedMinutes ? { expectedMinutes } : {}),
  };
}

/* A main race stood down to a tune-up. It keeps its taper; it loses the
   ambition, which was only ever the main race's. */
const standDown = ({ ambition: _ambition, ...ev }) => ({ ...ev, priority: 'secondary' });

/**
 * A whole list in canonical form: usable events only, one per id, in date
 * order, with at most one primary race.
 *
 * When a record claims two primary races the earliest wins and the other
 * becomes secondary — it is still a race on the calendar and still wants a
 * taper. That case only comes from data this app did not write (`upsertEvent`
 * stands the previous primary down before it gets here) so the rule just has to
 * be deterministic.
 */
export function normalizeEvents(list) {
  const seen = new Set();
  const events = (Array.isArray(list) ? list : [])
    .map((raw) => normalizeEvent(raw))
    .filter((ev) => {
      if (!ev || seen.has(ev.id)) return false;
      seen.add(ev.id);
      return true;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let claimed = false;
  return events.map((ev) => {
    if (ev.priority !== 'primary') return ev;
    if (claimed) return standDown(ev);
    claimed = true;
    return ev;
  });
}

/** The race the season is aimed at, or null when nothing is flagged. */
export function goalEvent(events) {
  return (Array.isArray(events) ? events : []).find((ev) => ev && ev.priority === 'primary') ?? null;
}

/** The races inside the build, in the order the list is already in — which
    `normalizeEvents` guarantees is date order. */
export function secondaryRaces(events) {
  return (Array.isArray(events) ? events : []).filter((ev) => ev && ev.priority === 'secondary');
}

/**
 * Add an event, or replace the one with the same id. Making an event the
 * primary race stands the previous primary down to secondary, so the invariant
 * holds by construction rather than by whoever normalizes last — and the race
 * being displaced keeps its taper rather than silently becoming a marker. An
 * event that cannot be stored leaves the list exactly as it was.
 */
export function upsertEvent(events, event) {
  const list = Array.isArray(events) ? events : [];
  let next = normalizeEvent(event);
  if (!next) return list;

  // A race made the main one without saying how hard to aim takes the ambition
  // of the race it replaces — or of itself, edited in place. Changing which
  // race the season is for is not changing how much the athlete wants from it.
  if (next.priority === 'primary' && !next.ambition) {
    const prior = list.find((ev) => ev && ev.id === next.id);
    const displaced = list.find((ev) => ev && ev.id !== next.id && ev.priority === 'primary');
    const kept = AMBITIONS.find((a) => a === (prior?.ambition ?? displaced?.ambition));
    if (kept) next = { ...next, ambition: kept };
  }

  const others = list
    .filter((ev) => ev && ev.id !== next.id)
    .map((ev) => (next.priority === 'primary' && ev.priority === 'primary' ? standDown(ev) : ev));

  return normalizeEvents([...others, next]);
}

export function removeEvent(events, id) {
  return normalizeEvents((Array.isArray(events) ? events : []).filter((ev) => ev && ev.id !== id));
}

/** Events keyed by the day they fall on, so a month grid is one lookup a day. */
export function eventsByDate(events) {
  const byDate = {};
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || !ev.date) continue;
    (byDate[ev.date] ??= []).push(ev);
  }
  return byDate;
}

/**
 * The profile fields the primary race owns. Either is null when that race does
 * not say, so a caller can fall back to what the profile already holds instead
 * of overwriting it with nothing. A secondary race never appears here — that is
 * the boundary that keeps a marathon out of `profile.raceType`.
 */
export function raceFieldsOf(events) {
  const goal = goalEvent(events);
  return { raceDate: goal?.date ?? null, raceType: goal?.raceType ?? null };
}

/**
 * The back-compat seed: a plan stored before events existed has its race date
 * on the profile and nothing on the calendar. Turning that into the primary
 * race means there is still only one place the race is recorded, and the
 * athlete sees the race they already entered rather than an empty calendar.
 */
export function seedEventsFromProfile(profile, { id } = {}) {
  const date = toISO(parseISO(profile?.raceDate));
  if (!date || !id) return [];
  return normalizeEvents([{
    id,
    name: 'Race day',
    date,
    kind: 'race',
    raceType: profile?.raceType,
    priority: 'primary',
  }]);
}
