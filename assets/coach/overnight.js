/* Sleep and overnight heart rate from the Garmin bridge, and how this week's
   nights compare with the athlete's own usual.

   The bridge reads them only when it was started with YOOTRI_GARMIN_OVERNIGHT=1
   and this browser opted in, and sends at most three numbers a night: minutes
   asleep, the overnight HRV average and the day's resting heart rate. They are
   daily measurements of the body — health data — so they live where heart rate
   lives: in this browser's own storage, never on a plan. A plan syncs and
   exports; a store that is never on one cannot do either. The store's shape is
   here, and `normalizeNight` is an allowlist, so a hand-edited store cannot
   carry anything else.

   `compareNights` is the only reading of them, and it is deliberately narrow.
   The last seven nights are set against the four weeks before them, figure by
   figure, and a figure is flagged only when it sits outside the athlete's own
   usual range in the direction that counts (less sleep, a lower HRV, a higher
   resting heart rate). It describes nights, not the athlete: it draws no
   conclusion about the body and names no condition. When two figures agree the
   weekly review *offers* to make next week's hardest session an easy one; the
   athlete decides, and nothing here changes a plan.

   Nothing here is fitted. The windows, the minimum counts and the width of the
   usual range are starting values, recorded as such. Pure: the page fetches and
   stores. */

import { parseISO, toISO, addDays } from './dates.js';

export const OVERNIGHT = Object.freeze({
  recentDays: 7,       // the nights compared…
  baselineDays: 28,    // …with the four weeks before them
  minRecent: 3,        // readings of a figure in those seven nights before it says anything
  minBaseline: 14,     // and in the four weeks before them
  band: 0.5,           // the usual range: the baseline mean ± band × its standard deviation
  agree: 2,            // figures that must be outside it together before anything is offered
  keepDays: 92,        // nights this browser keeps — the bridge's MAX_OVERNIGHT_DAYS
  maxRangeDays: 92,    // the widest window the bridge answers
  firstSyncDays: 42,   // a baseline and a week, with room to spare
  overlapDays: 3,      // a watch that synced late still has last night picked up
});

/* The three figures: their wire name, their stored name, the range a reading
   has to fall in to be one (the bridge's own, in overnight.py), and which way
   is the one that counts. HRV is compared on a log scale, as it is skewed. */
const FIGURES = Object.freeze([
  { key: 'sleepMin', short: 's', bounds: [60, 1200], counts: 'below', log: false, dp: 0 },
  { key: 'hrvMs', short: 'h', bounds: [5, 250], counts: 'below', log: true, dp: 0 },
  { key: 'restingHr', short: 'r', bounds: [25, 120], counts: 'above', log: false, dp: 1 },
]);
export const NIGHT_FIGURES = Object.freeze(FIGURES.map((f) => f.key));

const isoDay = (v) => {
  const d = parseISO(v);
  return d && toISO(d) === String(v) ? String(v) : null;
};
const shift = (iso, n) => toISO(addDays(parseISO(iso), n));
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

const reading = (v, [lo, hi]) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n >= lo && n <= hi ? n : null;
};

/** One night as `{date, sleepMin?, hrvMs?, restingHr?}`, or null when nothing in it is a reading. */
export function normalizeNight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = isoDay(raw.date);
  if (!date) return null;
  const out = { date };
  for (const f of FIGURES) {
    const v = reading(raw[f.key], f.bounds);
    if (v !== null) out[f.key] = v;
  }
  return Object.keys(out).length > 1 ? out : null;
}

/* ---- the store, in this browser only ------------------------------------ */

/** The store's nights, oldest first. Anything a night may not hold is left behind. */
export function overnightNights(store) {
  const held = store && typeof store === 'object' && store.byDate && typeof store.byDate === 'object' ? store.byDate : {};
  const out = [];
  for (const [date, e] of Object.entries(held)) {
    const night = normalizeNight(Object.fromEntries(FIGURES.map((f) => [f.key, e?.[f.short]]).concat([['date', date]])));
    if (night) out.push(night);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * The store after a sync: `{v: 1, through, byDate: {date: {s?, h?, r?}}}`.
 * A night synced again wins figure by figure — a figure that did not come this
 * time keeps the one already held. `until` is the last day asked for. Nights
 * older than `keepDays` are let go, and the input is never changed.
 */
export function mergeOvernight(store, nights, { today = null, until = null, keepDays = OVERNIGHT.keepDays } = {}) {
  const byDate = {};
  const put = (n) => {
    const night = normalizeNight(n);
    if (!night) return;
    const e = { ...(byDate[night.date] ?? {}) };
    for (const f of FIGURES) if (night[f.key] !== undefined) e[f.short] = night[f.key];
    byDate[night.date] = e;
  };
  for (const n of overnightNights(store)) put(n);
  for (const n of Array.isArray(nights) ? nights : []) put(n);
  const cutoff = isoDay(today) ? shift(today, -keepDays) : null;
  if (cutoff) for (const d of Object.keys(byDate)) if (d < cutoff) delete byDate[d];

  const held = isoDay(store?.through);
  const asked = isoDay(until);
  const through = held && asked ? (held > asked ? held : asked) : held || asked;
  return { v: 1, ...(through ? { through } : {}), byDate };
}

/** The window to ask the bridge for next, or null without a date. */
export function overnightSyncWindow(store, { today } = {}) {
  const until = isoDay(today);
  if (!until) return null;
  const held = isoDay(store?.through);
  let since = held ? shift(held, -OVERNIGHT.overlapDays) : shift(until, -OVERNIGHT.firstSyncDays);
  if (since > until) since = until;
  if (daysBetween(since, until) > OVERNIGHT.maxRangeDays) since = shift(until, -OVERNIGHT.maxRangeDays);
  return { since, until };
}

/* ---- this week against the athlete's own usual -------------------------- */

const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sdOf = (xs) => {
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/**
 * The last `recentDays` nights, up to and including `today`, against the
 * `baselineDays` before them.
 *
 * Per figure: `recent: {n, mean}`, `usual: {n, mean, lo, hi}` (null with too
 * few readings, or none to speak of a range in), `enough`, and `direction` —
 * 'below' or 'above' only when the recent mean is outside the usual range the
 * way that counts for that figure, else null. `outside` lists those figures;
 * `offer` is true when at least `agree` of them are.
 */
export function compareNights(store, { today } = {}) {
  const to = isoDay(today);
  const from = to ? shift(to, -(OVERNIGHT.recentDays - 1)) : null;
  const baseFrom = to ? shift(from, -OVERNIGHT.baselineDays) : null;
  const nights = to ? overnightNights(store) : [];
  const recentNights = nights.filter((n) => n.date >= from && n.date <= to);
  const usualNights = nights.filter((n) => n.date >= baseFrom && n.date < from);

  const figures = {};
  for (const f of FIGURES) {
    const scale = (v) => (f.log ? Math.log(v) : v);
    const unscale = (v) => (f.log ? Math.exp(v) : v);
    const recentVals = recentNights.map((n) => n[f.key]).filter((v) => v !== undefined).map(scale);
    const usualVals = usualNights.map((n) => n[f.key]).filter((v) => v !== undefined).map(scale);

    const recent = { n: recentVals.length, mean: recentVals.length ? round(unscale(meanOf(recentVals)), f.dp) : null };
    let usual = null;
    let lo = null;
    let hi = null;
    if (usualVals.length >= OVERNIGHT.minBaseline) {
      const m = meanOf(usualVals);
      const sd = sdOf(usualVals);
      if (sd > 0) {
        lo = unscale(m - OVERNIGHT.band * sd);
        hi = unscale(m + OVERNIGHT.band * sd);
        usual = { n: usualVals.length, mean: round(unscale(m), f.dp), lo: round(lo, f.dp), hi: round(hi, f.dp) };
      }
    }
    const enough = usual !== null && recent.n >= OVERNIGHT.minRecent;
    let direction = null;
    if (enough) {
      const r = unscale(meanOf(recentVals));
      if (f.counts === 'below' && r < lo) direction = 'below';
      if (f.counts === 'above' && r > hi) direction = 'above';
    }
    figures[f.key] = { recent, usual, enough, direction };
  }
  const outside = FIGURES.map((f) => f.key).filter((k) => figures[k].direction);
  return { from, to, figures, outside, offer: outside.length >= OVERNIGHT.agree };
}
