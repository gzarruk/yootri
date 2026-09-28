/* Training load: one number per session, on a scale where an hour at threshold
   is 100, and the two running averages of it.

   Ported from GARMIN-CLAUDE's `analytics/common/load.py` and `pmc.py`. The
   formulas are the public ones:

     power       (bike)      hours × IF² × 100, IF = normalized power / FTP
     pace        (run)       hours × IF² × 100, IF = speed / threshold speed
     swim-pace   (swim)      hours × IF³ × 100, IF = speed / CSS
     session-rpe (strength)  minutes × RPE / (60 × 7) × 100
     heart-rate  (anything)  Banister TRIMP, as a share of an hour at LTHR × 100

   The most direct method the inputs allow wins, heart rate last. When none
   applies the answer is null with a list of what is missing — never an
   estimate — so a figure is always one the athlete could check.

   **Nothing here is stored.** Load is worked out when it is read, from the
   plan's activities, the plan's references (FTP, CSS), the running benchmark,
   and — for the heart-rate method — this browser's own heart-rate store and
   thresholds. That is what keeps heart-rate-derived numbers off a plan that
   syncs and exports. Only the two averages are exposed, named for what they
   are: chronic and acute training load. They describe training, not the
   athlete, and nothing here draws a conclusion from them.

   The coefficients are the published ones and the 42/7-day windows are the
   conventional ones; none has been fitted to anybody (see
   ../yootri-rnd/FINDINGS.md). */

import { parseISO, toISO, addDays, mondayOf } from './dates.js';
import { thresholdSpeedFrom } from './paces.js';

export const LOAD = Object.freeze({
  chronicDays: 42,
  acuteDays: 7,
  maxPlausible: 1000,
  thresholdRpe: 7,
  trimp: Object.freeze({ male: Object.freeze([0.64, 1.92]), female: Object.freeze([0.86, 1.67]) }),
});

const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const round1 = (n) => Math.round(n * 10) / 10;

/** `plan.loadRefs`: the athlete's FTP and CSS. Undefined when neither is usable. */
export function normalizeLoadRefs(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = compact({
    ftpW: num(raw.ftpW, 50, 600) && Math.round(Number(raw.ftpW)),
    cssSecPer100m: num(raw.cssSecPer100m, 50, 300) && Math.round(Number(raw.cssSecPer100m)),
  });
  return Object.keys(out).length ? out : undefined;
}

/** This browser's heart-rate thresholds. They must hang together: rest < LTHR < max. */
export function normalizeHrThresholds(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const max = num(raw.max, 100, 230);
  const rest = num(raw.rest, 25, 100);
  let lthr = num(raw.lthr, 80, 220);
  if (lthr !== undefined && ((max !== undefined && lthr >= max) || (rest !== undefined && lthr <= rest))) lthr = undefined;
  const trimp = raw.trimp in LOAD.trimp ? raw.trimp : undefined;
  const out = compact({ lthr, max, rest, trimp });
  return Object.keys(out).length ? out : undefined;
}

/** Everything a method might need, from wherever it lives. Missing is null. */
export function loadThresholds({ benchmarks = [], loadRefs = null, hrThresholds = null } = {}) {
  const refs = normalizeLoadRefs(loadRefs) ?? {};
  const hr = normalizeHrThresholds(hrThresholds) ?? {};
  return {
    runMps: thresholdSpeedFrom(benchmarks) ?? null,
    ftpW: refs.ftpW ?? null,
    cssMps: refs.cssSecPer100m ? 100 / refs.cssSecPer100m : null,
    lthr: hr.lthr ?? null,
    maxHr: hr.max ?? null,
    restHr: hr.rest ?? null,
    trimp: hr.trimp ?? null,
  };
}

function trimpOf(minutes, avg, t) {
  const [a, b] = LOAD.trimp[t.trimp];
  const hrr = Math.min(1, Math.max(0, (avg - t.restHr) / (t.maxHr - t.restHr)));
  return minutes * hrr * a * Math.exp(b * hrr);
}

/**
 * One activity's load: `{value, method, missing, note?}`. `value` is null when
 * no method applies; `missing` names what would let one.
 */
export function activityLoad(activity, thresholds = {}, hr = null) {
  const t = thresholds ?? {};
  const secs = Number(activity?.movingS || activity?.durationS) || 0;
  const hours = secs / 3600;
  const missing = [];
  let value = null;
  let method = null;
  let note;

  if (hours > 0) {
    const disc = activity.disc;
    if (disc === 'Bike') {
      const power = activity.normPowerW || activity.avgPowerW;
      if (!power) missing.push('power');
      else if (!t.ftpW) missing.push('ftp');
      else {
        const IF = power / t.ftpW;
        value = hours * IF * IF * 100;
        method = 'power';
        if (!activity.normPowerW) note = 'from average power; normalized power was not recorded';
      }
    } else if (disc === 'Run' || disc === 'Swim') {
      const threshold = disc === 'Run' ? t.runMps : t.cssMps;
      if (!activity.distanceM) missing.push('distance');
      else if (!threshold) missing.push(disc === 'Run' ? 'run-threshold' : 'css');
      else {
        const IF = activity.distanceM / secs / threshold;
        value = hours * (disc === 'Run' ? IF * IF : IF * IF * IF) * 100;
        method = disc === 'Run' ? 'pace' : 'swim-pace';
      }
    } else if (disc === 'Strength') {
      if (!activity.rpe) missing.push('rpe');
      else {
        value = (secs / 60) * activity.rpe / (60 * LOAD.thresholdRpe) * 100;
        method = 'session-rpe';
      }
    }

    if (value === null) {
      if (!hr?.avg) missing.push('heart-rate');
      else if (!t.lthr || !t.maxHr || !t.restHr || !t.trimp) missing.push('hr-thresholds');
      else {
        value = trimpOf(secs / 60, hr.avg, t) / trimpOf(60, t.lthr, t) * 100;
        method = 'heart-rate';
      }
    }
  }

  if (value !== null && !(value <= LOAD.maxPlausible)) {
    return { value: null, method: null, missing: [], note: `implausible (${Math.round(value)}); not counted` };
  }
  const out = { value: value === null ? null : round1(value), method, missing: value === null ? missing : [] };
  if (note && value !== null) out.note = note;
  return out;
}

/** Load summed per day, with a tally of how each activity was (or was not) scored. */
export function dailyLoads(activities, thresholds, hrById = new Map()) {
  const byDate = {};
  const byMethod = {};
  const missing = {};
  let scored = 0;
  let unscored = 0;
  for (const a of Array.isArray(activities) ? activities : []) {
    if (!a?.date) continue;
    const r = activityLoad(a, thresholds, hrById?.get?.(a.id) ?? null);
    if (r.value === null) {
      unscored++;
      for (const m of r.missing) missing[m] = (missing[m] ?? 0) + 1;
      continue;
    }
    scored++;
    byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
    byDate[a.date] = round1((byDate[a.date] ?? 0) + r.value);
  }
  return { byDate, scored, unscored, byMethod, missing };
}

/**
 * An exponentially weighted average over every day from `from` to `to`, a day
 * with no activity counting as zero. `k = 1 − e^(−1/days)`.
 */
export function ewma(byDate, { from, to, days }) {
  const k = 1 - Math.exp(-1 / days);
  const out = [];
  let v = 0;
  for (let d = parseISO(from), end = parseISO(to); d && end && d <= end; d = addDays(d, 1)) {
    const iso = toISO(d);
    v += k * ((byDate?.[iso] ?? 0) - v);
    out.push({ date: iso, value: v });
  }
  return out;
}

/**
 * What the coach and the page show: weekly load for the `weeks` full weeks
 * before today's, and the chronic and acute averages as of today.
 */
export function trainingLoad(activities, { today, weeks = 12, thresholds = {}, hrById = new Map(), sync = null } = {}) {
  const d = dailyLoads(activities, thresholds, hrById);
  const dates = (Array.isArray(activities) ? activities : []).map((a) => a?.date).filter(Boolean).sort();
  const start = sync?.from ?? dates[0] ?? today;
  const last = (series) => (series.length ? round1(series[series.length - 1].value) : 0);

  const thisMonday = mondayOf(today);
  const n = Math.max(1, Math.min(26, Math.floor(Number(weeks) || 1)));
  const rows = [];
  for (let i = n; i >= 1 && thisMonday; i--) {
    const monday = toISO(addDays(parseISO(thisMonday), -7 * i));
    const sunday = toISO(addDays(parseISO(monday), 6));
    let load = 0;
    for (const [date, v] of Object.entries(d.byDate)) if (date >= monday && date <= sunday) load += v;
    const inWeek = (activities ?? []).filter((a) => a?.date >= monday && a?.date <= sunday);
    const scored = inWeek.filter((a) => activityLoad(a, thresholds, hrById?.get?.(a.id) ?? null).value !== null).length;
    rows.push({ monday, load: round1(load), scored, unscored: inWeek.length - scored });
  }

  return {
    weeks: rows,
    chronic: last(ewma(d.byDate, { from: start, to: today, days: LOAD.chronicDays })),
    acute: last(ewma(d.byDate, { from: start, to: today, days: LOAD.acuteDays })),
    byMethod: d.byMethod,
    missing: d.missing,
    historyDays: start && today ? Math.max(0, Math.round((parseISO(today) - parseISO(start)) / 86400000)) : 0,
    labels: { chronic: `chronic training load (${LOAD.chronicDays}-day)`, acute: `acute training load (${LOAD.acuteDays}-day)` },
  };
}
