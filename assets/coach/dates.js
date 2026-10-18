/* Calendar arithmetic for season lengths.

   Everything here works in UTC day-numbers rather than local Date arithmetic.
   A training season routinely spans a daylight-saving change, and local
   midnight-to-midnight differences are 23 or 25 hours across those boundaries —
   enough for a naive `(b - a) / 86400000` to lose or gain a week over a long
   build. Weeks are the unit the whole plan is indexed by, so an off-by-one here
   would silently shift every session in the calendar. */

const DAY = 86400000;

/** "YYYY-MM-DD" -> a UTC-midnight Date. */
export function parseISO(s) {
  const [y, m, d] = String(s ?? '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

/** A UTC Date -> "YYYY-MM-DD". */
export function toISO(date) {
  if (!date) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(date, n) {
  return new Date(date.getTime() + n * DAY);
}

/** The Monday of the week containing `iso`. Weeks start on Monday throughout. */
export function mondayOf(iso) {
  const d = parseISO(iso);
  if (!d) return null;
  const since = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return toISO(addDays(d, -since));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "19 Oct 2026", for a sentence the athlete reads. Fixed English month names,
    not the locale's: the engine has no locale and its messages are plain text.
    Something that is not a date comes back as it came. */
export function sayDate(iso) {
  const d = parseISO(iso);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : String(iso);
}

/* The first Monday on or after `iso`. Internal: the two public starts below
   differ only in what they feed it. */
function mondayOnOrAfter(iso) {
  const d = parseISO(iso);
  if (!d) return null;
  const until = (8 - d.getUTCDay()) % 7; // 0 on a Monday
  return toISO(addDays(d, until));
}

/**
 * Where a new plan starts by default: the first Monday on or after tomorrow.
 *
 * Not `mondayOf(today)`. That is the Monday *before* today, which is right for
 * "which week is this date in" and wrong for "where does a plan begin": on a
 * Sunday it starts the plan six days ago, in a week that is over. A plan
 * starts on a Monday that has not happened yet, and not on today even when
 * today is one, since today is already under way.
 */
export function nextMonday(today) {
  const d = parseISO(today);
  if (!d) return null;
  return mondayOnOrAfter(toISO(addDays(d, 1)));
}

/**
 * A start date the athlete chose, made a Monday that is not in the past. It
 * snaps *forward* — a Tuesday goes to the next week, never back to the Monday
 * already gone — and a date before today goes to the first Monday on or after
 * today. Unlike the default, today itself is allowed when it is a Monday: the
 * athlete asked for it. A date that cannot be read gives the default.
 */
export function snapToMonday(iso, { today } = {}) {
  if (!parseISO(iso)) return today ? nextMonday(today) : null;
  const from = parseISO(today) && iso < today ? today : iso;
  return mondayOnOrAfter(from);
}

/**
 * How many whole weeks a season starting at `startISO` needs to reach — and
 * include — the week containing `raceISO`. Returns null when either date is
 * missing, so callers can fall back rather than get a plausible wrong number.
 */
export function weeksUntil(startISO, raceISO) {
  const a = mondayOf(startISO);
  const b = mondayOf(raceISO);
  if (!a || !b) return null;
  const weeks = Math.round((parseISO(b) - parseISO(a)) / (7 * DAY)) + 1;
  return Math.max(1, weeks); // a race already run is not a negative runway
}
