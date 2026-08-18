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
