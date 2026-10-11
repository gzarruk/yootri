/* A planned bike session as a structured workout: warm-up, main set, cool-down,
   each with a power target.

   The generator only writes a focus ("Threshold intervals"), a zone label
   ("Z3–Z4") and a duration, so the structure is worked out here, when it is
   asked for, and never stored on the session. That is the same rule a Run
   card's pace follows: change the FTP and every future workout follows it,
   instead of last spring's fitness staying written into the plan.

   Targets are percentages of FTP first. Watts are added only when the athlete
   has set an FTP (plan.loadRefs.ftpW); without one the steps stay %FTP and say
   so, rather than guessing a number for somebody.

   The %FTP bands below are unfitted defaults — a reasonable reading of the
   usual power zones, not a measurement of anyone. Treat them as guesses.

   Pure: no DOM, no I/O. The Garmin bridge turns the result into Garmin's JSON
   and a FIT file; nothing here knows Garmin exists. */

import { durToMin } from './duration.js';
import { dateOf } from './calendar.js';

/** Most workouts one sync will send. Garmin rate-limits; a season is not one click. */
export const SYNC_CAP = 60;

/* Percent of FTP per zone. Unfitted. */
const BAND = {
  1: [45, 55],
  2: [56, 75],
  3: [76, 90],
  4: [91, 105],
  5: [106, 120],
};
const WARM = [50, 65];
const COOL = [45, 55];
const EASY = [50, 60];
const OPENER = [100, 110];

const WORK_S = 8 * 60;
const REST_S = 3 * 60;
const MAX_REPS = 8;
const MIN_STRUCTURED_S = 20 * 60;
const OPENERS = { count: 3, workS: 60, restS: 180 };

const round60 = (s) => Math.max(60, Math.round(s / 60) * 60);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Zone label -> the %FTP band it spans. "Z3–Z4" spans both; anything else is Z2. */
function bandOf(zone) {
  const nums = [...String(zone ?? '').matchAll(/Z([1-5])/g)].map((m) => Number(m[1]));
  if (!nums.length) return { lo: BAND[2], hi: BAND[2], span: BAND[2] };
  const low = Math.min(...nums);
  const high = Math.max(...nums);
  return { lo: BAND[low], hi: BAND[high], span: [BAND[low][0], BAND[high][1]] };
}

/** Whole watts for a %FTP range, or null when there is no usable FTP. */
export function pctToWatts(pct, ftpW) {
  const ftp = Number(ftpW);
  if (!Array.isArray(pct) || !Number.isFinite(ftp) || ftp <= 0) return null;
  return [Math.round((pct[0] * ftp) / 100), Math.round((pct[1] * ftp) / 100)];
}

const cleanFtp = (ftpW) => {
  const n = Number(ftpW);
  return Number.isFinite(n) && n >= 50 && n <= 600 ? Math.round(n) : null;
};

const step = (type, durationS, pct, ftp) => ({ type, durationS, pct: [...pct], watts: pctToWatts(pct, ftp) });
const repeat = (count, steps) => ({ type: 'repeat', count, steps });

/** Total seconds in a step list, repeats expanded. */
export function workoutSeconds(steps) {
  return steps.reduce(
    (sum, s) => sum + (s.type === 'repeat' ? s.count * workoutSeconds(s.steps) : s.durationS),
    0,
  );
}

/**
 * The structured workout for one planned bike session.
 * Returns { ok: true, name, steps, ftpW, durationS } or { ok: false, reason }.
 */
export function bikeWorkout(session, { ftpW = null } = {}) {
  if (!session || session.disc !== 'Bike') return { ok: false, reason: 'not-bike' };
  const total = durToMin(session.dur) * 60;
  if (!(total > 0)) return { ok: false, reason: 'no-duration' };

  const ftp = cleanFtp(ftpW);
  const band = bandOf(session.zone);
  const name = `Yootri ${session.focus || 'Bike'} ${session.dur}`.slice(0, 80);
  const done = (steps) => ({ ok: true, name, steps, ftpW: ftp, durationS: workoutSeconds(steps) });

  if (total < MIN_STRUCTURED_S) return done([step('interval', total, band.span, ftp)]);

  let warm = round60(clamp(total * 0.15, 300, 900));
  const cool = round60(clamp(total * 0.1, 300, 600));
  let main = total - warm - cool;
  const focus = String(session.focus ?? '');
  const middle = [];

  if (focus === 'Threshold intervals' && main >= WORK_S + REST_S) {
    const reps = Math.min(MAX_REPS, Math.floor(main / (WORK_S + REST_S)));
    let lead = main - reps * (WORK_S + REST_S);
    if (lead < 120) { warm += lead; lead = 0; }
    if (lead) middle.push(step('interval', lead, BAND[2], ftp));
    middle.push(repeat(reps, [step('interval', WORK_S, band.hi, ftp), step('recovery', REST_S, EASY, ftp)]));
  } else if (focus === 'Openers' && main >= 900) {
    const burst = OPENERS.count * (OPENERS.workS + OPENERS.restS);
    middle.push(step('interval', main - burst, band.span, ftp));
    middle.push(repeat(OPENERS.count, [
      step('interval', OPENERS.workS, OPENER, ftp),
      step('recovery', OPENERS.restS, EASY, ftp),
    ]));
  } else {
    middle.push(step('interval', main, band.span, ftp));
  }

  return done([step('warmup', warm, WARM, ftp), ...middle, step('cooldown', cool, COOL, ftp)]);
}

/** A short stable fingerprint of what would be sent: the workout, its date and FTP. */
export function workoutHash(workout, date) {
  const text = JSON.stringify({ n: workout.name, s: workout.steps, f: workout.ftpW ?? null, d: date });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * What one "sync workouts" would do, without doing it.
 *
 * Upcoming bike sessions (today or later) that are not already done or logged,
 * each marked new / changed / unchanged against `sent` — the device-local record
 * of what was pushed last time, keyed by session id. Past and finished sessions
 * come back in `skipped` with a reason. At most SYNC_CAP sessions that need
 * sending are returned; `capped` says there were more.
 */
export function planSyncSet(plan, { today, sent = {} } = {}) {
  const ftp = cleanFtp(plan?.loadRefs?.ftpW);
  const items = [];
  const skipped = [];
  let capped = false;
  let pending = 0;

  for (const w of plan?.season ?? []) {
    for (const s of plan.weeks?.[`w${w.absWeek}`] ?? []) {
      if (s?.disc !== 'Bike') continue;
      const date = dateOf(plan.start, w.absWeek, s.day);
      if (!date) { skipped.push({ id: s.id, date: null, reason: 'no-date' }); continue; }
      if (today && date < today) { skipped.push({ id: s.id, date, reason: 'past' }); continue; }
      if (plan.done?.[s.id] || plan.actuals?.[s.id]) { skipped.push({ id: s.id, date, reason: 'done' }); continue; }
      const workout = bikeWorkout(s, { ftpW: ftp });
      if (!workout.ok) { skipped.push({ id: s.id, date, reason: workout.reason }); continue; }

      const hash = workoutHash(workout, date);
      const previous = sent[s.id] ?? null;
      const status = !previous ? 'new' : previous.hash === hash && previous.date === date ? 'unchanged' : 'changed';
      if (status !== 'unchanged') {
        if (pending >= SYNC_CAP) { capped = true; continue; }
        pending++;
      }
      items.push({ id: s.id, date, session: s, workout, hash, status, previous });
    }
  }

  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { items, skipped, capped, noFtp: ftp === null };
}
