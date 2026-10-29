import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOAD, normalizeLoadRefs, normalizeHrThresholds, loadThresholds, activityLoad, dailyLoads, ewma, trainingLoad, warmStart,
} from '../assets/coach/load.js';

/* Training load: one number per session on a common scale, where an hour at
   threshold is 100. Ported from GARMIN-CLAUDE's load.py and pmc.py, with the
   same rule it had: when the inputs for a method are missing, say which, and
   never estimate. Nothing here is stored — load is worked out when it is read,
   which is what keeps heart-rate-derived numbers off the plan. */

const T = {
  runMps: 4,        // 4:10/km threshold
  ftpW: 250,
  cssMps: 1,        // 1:40/100m
  lthr: 170, maxHr: 190, restHr: 50, trimp: 'male',
};
const a = (over) => ({ id: 'garmin:1', source: 'garmin', date: '2026-09-01', durationS: 3600, ...over });

/* ---- one activity ---- */

test('a ride with power: IF squared, by the hour', () => {
  const r = activityLoad(a({ disc: 'Bike', normPowerW: 200 }), T);
  assert.deepEqual(r, { value: 64, method: 'power', missing: [] });
});

test('a ride with only average power still scores, and says so', () => {
  const r = activityLoad(a({ disc: 'Bike', avgPowerW: 200 }), T);
  assert.equal(r.value, 64);
  assert.equal(r.method, 'power');
  assert.match(r.note, /average power/);
});

test('a run at threshold pace for an hour is 100, half an hour is 50', () => {
  assert.equal(activityLoad(a({ disc: 'Run', distanceM: 14400 }), T).value, 100);
  const half = activityLoad(a({ disc: 'Run', durationS: 1800, distanceM: 7200 }), T);
  assert.deepEqual(half, { value: 50, method: 'pace', missing: [] });
});

test('moving time is the run’s time when there is one', () => {
  const r = activityLoad(a({ disc: 'Run', durationS: 4000, movingS: 3600, distanceM: 14400 }), T);
  assert.equal(r.value, 100);
});

test('a swim at CSS for an hour is 100; slower is cubed down', () => {
  assert.equal(activityLoad(a({ disc: 'Swim', distanceM: 3600 }), T).value, 100);
  const slow = activityLoad(a({ disc: 'Swim', distanceM: 3240 }), T);
  assert.deepEqual(slow, { value: 72.9, method: 'swim-pace', missing: [] });
});

test('strength scores from the effort rating', () => {
  assert.deepEqual(activityLoad(a({ disc: 'Strength', rpe: 7 }), T), { value: 100, method: 'session-rpe', missing: [] });
  assert.equal(activityLoad(a({ disc: 'Strength', durationS: 2700, rpe: 5 }), T).value, 53.6);
  assert.equal(LOAD.thresholdRpe, 7);
});

test('heart rate is the fallback: an hour at threshold heart rate is 100', () => {
  const r = activityLoad(a({ disc: 'Other' }), T, { avg: 170, max: 185 });
  assert.deepEqual(r, { value: 100, method: 'heart-rate', missing: [] });
});

test('the TRIMP coefficients follow the set the athlete chose', () => {
  const male = activityLoad(a({ disc: 'Other' }), T, { avg: 150 }).value;
  const female = activityLoad(a({ disc: 'Other' }), { ...T, trimp: 'female' }, { avg: 150 }).value;
  assert.notEqual(male, female);
});

test('the most direct method wins', () => {
  const hr = { avg: 170 };
  assert.equal(activityLoad(a({ disc: 'Run', distanceM: 14400 }), T, hr).method, 'pace');
  assert.equal(activityLoad(a({ disc: 'Bike', normPowerW: 200 }), T, hr).method, 'power');
  assert.equal(activityLoad(a({ disc: 'Run', distanceM: 14400 }), { ...T, runMps: null }, hr).method, 'heart-rate');
  assert.equal(activityLoad(a({ disc: 'Bike', normPowerW: 200 }), { ...T, ftpW: null }, hr).method, 'heart-rate');
});

test('with nothing to go on, the answer is null and says what is missing', () => {
  const bare = { runMps: null, ftpW: null, cssMps: null, lthr: null, maxHr: null, restHr: null, trimp: null };
  const ride = activityLoad(a({ disc: 'Bike', normPowerW: 200 }), bare);
  assert.equal(ride.value, null);
  assert.equal(ride.method, null);
  assert.deepEqual(ride.missing, ['ftp', 'heart-rate']);
  assert.deepEqual(activityLoad(a({ disc: 'Run', distanceM: 10000 }), bare).missing, ['run-threshold', 'heart-rate']);
  assert.deepEqual(activityLoad(a({ disc: 'Strength' }), bare).missing, ['rpe', 'heart-rate']);
  assert.deepEqual(activityLoad(a({ disc: 'Other' }), bare, { avg: 150 }).missing, ['hr-thresholds']);
});

test('an impossible number is refused rather than counted', () => {
  const r = activityLoad(a({ disc: 'Bike', durationS: 36000, normPowerW: 600 }), { ...T, ftpW: 100 });
  assert.equal(r.value, null);
  assert.match(r.note, /implausible/);
  assert.equal(LOAD.maxPlausible, 1000);
});

/* ---- where the thresholds come from ---- */

test('thresholds come from the benchmark, the plan’s references and this browser', () => {
  const t = loadThresholds({
    benchmarks: [{ id: 'b', date: '2026-09-01', distanceMeters: 10000, timeSeconds: 2400, source: 'manual', current: true }],
    loadRefs: { ftpW: 250, cssSecPer100m: 100 },
    hrThresholds: { lthr: 170, max: 190, rest: 50, trimp: 'female' },
  });
  assert.ok(t.runMps > 3.8 && t.runMps < 4.4, `threshold ${t.runMps} m/s for a 40-minute 10 km`);
  assert.equal(t.ftpW, 250);
  assert.equal(t.cssMps, 1);
  assert.deepEqual([t.lthr, t.maxHr, t.restHr, t.trimp], [170, 190, 50, 'female']);
  assert.deepEqual(loadThresholds({}), { runMps: null, ftpW: null, cssMps: null, lthr: null, maxHr: null, restHr: null, trimp: null });
});

test('load references are cleaned: only plausible numbers survive', () => {
  assert.deepEqual(normalizeLoadRefs({ ftpW: '250', cssSecPer100m: 95, junk: 1 }), { ftpW: 250, cssSecPer100m: 95 });
  assert.equal(normalizeLoadRefs({ ftpW: 5000, cssSecPer100m: 10 }), undefined);
  assert.equal(normalizeLoadRefs(null), undefined);
});

test('heart-rate thresholds are cleaned, and must hang together', () => {
  assert.deepEqual(normalizeHrThresholds({ lthr: 170, max: 190, rest: 50, trimp: 'male', x: 1 }),
    { lthr: 170, max: 190, rest: 50, trimp: 'male' });
  assert.equal(normalizeHrThresholds({ lthr: 200, max: 190, rest: 50, trimp: 'male' }).lthr, undefined,
    'a threshold above the maximum is not kept');
  assert.equal(normalizeHrThresholds({ trimp: 'other' }), undefined);
});

/* A threshold heart rate is the divisor of every heart-rate load: an hour at it is 100.
   One far below the maximum makes that hour's TRIMP tiny and every session's load several
   times too large, which seeds CTL and ATL at a level no athlete trains at. A threshold of 80
   is the lowest the settings boxes take, and it passed while only rest < threshold < max was checked. */
test('a threshold heart rate far below the maximum is not kept; a plausible one is', () => {
  const base = { max: 185, rest: 55, trimp: 'male' };
  assert.equal(normalizeHrThresholds({ ...base, lthr: 80 }).lthr, undefined, '80 against a maximum of 185');
  assert.deepEqual(normalizeHrThresholds({ ...base, lthr: 80 }), base, 'the rest of the record is kept');
  const floor = Math.ceil(LOAD.lthrMinShareOfMax * 185);
  assert.equal(normalizeHrThresholds({ ...base, lthr: floor - 1 }).lthr, undefined, 'just under the floor');
  assert.equal(normalizeHrThresholds({ ...base, lthr: floor }).lthr, floor, 'the floor itself');
  assert.equal(normalizeHrThresholds({ ...base, lthr: 165 }).lthr, 165);
  assert.equal(normalizeHrThresholds({ lthr: 80, trimp: 'male' }).lthr, 80, 'with no maximum there is nothing to judge it against');
});

test('a mistyped threshold heart rate scores nothing, instead of inflating every session', () => {
  const t = loadThresholds({ hrThresholds: { lthr: 80, max: 185, rest: 55, trimp: 'male' } });
  const ride = a({ disc: 'Bike', durationS: 6150, movingS: 6150 });          // 1.71 h, no power: heart rate or nothing
  const r = activityLoad(ride, t, { avg: 140 });
  assert.equal(r.value, null);
  assert.deepEqual(r.missing, ['power', 'hr-thresholds']);
  // The same ride against a sensible threshold is an ordinary session.
  const ok = activityLoad(ride, loadThresholds({ hrThresholds: { lthr: 165, max: 185, rest: 55, trimp: 'male' } }), { avg: 140 });
  assert.ok(ok.value > 40 && ok.value < 180, `${ok.value}`);
});

/* ---- days and the two averages ---- */

test('an exponential average: day one is the load times k', () => {
  const k = 1 - Math.exp(-1 / 42);
  const series = ewma({ '2026-09-01': 100 }, { from: '2026-09-01', to: '2026-09-01', days: 42 });
  assert.equal(series.length, 1);
  assert.ok(Math.abs(series[0].value - 100 * k) < 1e-9);
});

test('a constant daily load converges to itself, and rest days decay it', () => {
  const byDate = {};
  const start = Date.parse('2025-01-01');
  for (let i = 0; i < 400; i++) byDate[new Date(start + i * 864e5).toISOString().slice(0, 10)] = 100;
  const s = ewma(byDate, { from: '2025-01-01', to: '2026-02-04', days: 42 });
  assert.ok(Math.abs(s[s.length - 1].value - 100) < 0.1);
  const after = ewma(byDate, { from: '2025-01-01', to: '2026-03-04', days: 7 });
  // Four idle weeks on a 7-day average: e^(-28/7) of where it was.
  assert.ok(Math.abs(after[after.length - 1].value - 100 * Math.exp(-4)) < 0.01);
});

test('daily loads add up and count what could not be scored', () => {
  const acts = [
    a({ id: 'garmin:1', disc: 'Bike', normPowerW: 200 }),
    a({ id: 'garmin:2', disc: 'Run', distanceM: 14400 }),
    a({ id: 'garmin:3', date: '2026-09-02', disc: 'Other' }),
  ];
  const d = dailyLoads(acts, T, new Map());
  assert.deepEqual(d.byDate, { '2026-09-01': 164 });
  assert.equal(d.scored, 2);
  assert.equal(d.unscored, 1);
  assert.deepEqual(d.byMethod, { power: 1, pace: 1 });
  assert.deepEqual(d.missing, { 'heart-rate': 1 });
});

test('trainingLoad reports the two averages, weekly totals and what is behind them', () => {
  const acts = [];
  for (let i = 0; i < 60; i++) {
    const date = new Date(Date.parse('2026-07-30') + i * 864e5).toISOString().slice(0, 10);
    acts.push(a({ id: `garmin:${i}`, date, disc: 'Run', distanceM: 14400 }));
  }
  const r = trainingLoad(acts, { today: '2026-09-28', weeks: 4, thresholds: T, hrById: new Map(),
    sync: { source: 'garmin', from: '2026-07-01', through: '2026-09-27' } });
  assert.equal(r.weeks.length, 4);
  assert.deepEqual(r.weeks.map((w) => w.load), [700, 700, 700, 700]);
  assert.ok(r.acute > r.chronic, 'a steady block raises the short average faster');
  assert.equal(r.historyDays, 89);
  assert.deepEqual(r.byMethod, { pace: 60 });
  assert.deepEqual(r.labels, { chronic: 'chronic training load (CTL, 42-day)', acute: 'acute training load (ATL, 7-day)' });
});

test('the load figures never carry heart rate', () => {
  const hr = new Map([['garmin:1', { avg: 173, max: 187 }]]);
  const r = trainingLoad([a({ id: 'garmin:1', disc: 'Other', date: '2026-09-20' })],
    { today: '2026-09-28', weeks: 2, thresholds: T, hrById: hr, sync: null });
  const text = JSON.stringify(r);
  assert.equal(/"(avg|max)"|heart_?rate"|hr"/i.test(text), false);
  assert.equal(text.includes('173'), false);
  assert.equal(text.includes('187'), false);
});

/* The averages can start from a value rather than from nothing. Without that,
   a few weeks of history read far below the athlete's real level, because the
   42-day average has not yet filled. */

test('an average can be started from a level instead of from zero', () => {
  const flat = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`2026-09-0${i + 1}`, 100]));
  const k = 1 - Math.exp(-1 / 42);
  const seeded = ewma(flat, { from: '2026-09-01', to: '2026-09-05', days: 42, seed: 100 });
  assert.equal(seeded.length, 5);
  for (const p of seeded) assert.ok(Math.abs(p.value - 100) < 1e-9, 'a flat load on a flat start stays flat');
  const cold = ewma(flat, { from: '2026-09-01', to: '2026-09-01', days: 42 });
  assert.ok(Math.abs(cold[0].value - 100 * k) < 1e-9, 'with no seed the first day is one step up from zero');
});

test('a seed is just the average the day before the first day', () => {
  const k = 1 - Math.exp(-1 / 42);
  const [p] = ewma({ '2026-09-01': 50 }, { from: '2026-09-01', to: '2026-09-01', days: 42, seed: 80 });
  assert.ok(Math.abs(p.value - (80 + k * (50 - 80))) < 1e-9);
});

/* ---- starting an average from a level ---- */

test('a warm start is the mean daily load of the first days of the window', () => {
  const byDate = { '2026-09-01': 70, '2026-09-03': 70, '2026-09-20': 500 };
  assert.equal(warmStart(byDate, { from: '2026-09-01', to: '2026-09-30', days: 7 }), 20);
});

test('a window shorter than the warm-start span is averaged over its own days', () => {
  assert.equal(warmStart({ '2026-09-01': 60 }, { from: '2026-09-01', to: '2026-09-03', days: 7 }), 20);
});

test('no days to average, or no start date, is no warm start', () => {
  assert.equal(warmStart({ '2026-09-01': 60 }, { from: '2026-09-01', to: '2026-09-30', days: 0 }), 0);
  assert.equal(warmStart({ '2026-09-01': 60 }, { from: 'nope', to: '2026-09-30', days: 7 }), 0);
  assert.equal(warmStart(null, { from: '2026-09-01', to: '2026-09-30', days: 7 }), 0);
});

test('trainingLoad started warm is not read low on a short window; without the option it starts from zero as before', () => {
  const rides = Array.from({ length: 21 }, (_, i) => ({
    id: `g:${i}`, date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), disc: 'Bike', durationS: 3600, normPowerW: 250,
  }));
  const sync = { from: '2026-09-01', through: '2026-09-21' };
  const cold = trainingLoad(rides, { today: '2026-09-21', thresholds: T, sync });
  const warm = trainingLoad(rides, { today: '2026-09-21', thresholds: T, sync, warmStartDays: 7 });
  assert.ok(Math.abs(cold.chronic - 100 * (1 - Math.exp(-21 / 42))) < 0.1, `three weeks from zero reads ${cold.chronic}`);
  assert.equal(warm.chronic, 100, 'a steady 100 a day started at 100 stays there');
  assert.equal(warm.acute, 100);
});

test('trainingLoad stops at the last synced day: nothing after it is read as a day off', () => {
  const rides = Array.from({ length: 21 }, (_, i) => ({
    id: `g:${i}`, date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), disc: 'Bike', durationS: 3600, normPowerW: 250,
  }));
  const sync = { from: '2026-09-01', through: '2026-09-21' };
  const atSync = trainingLoad(rides, { today: '2026-09-21', thresholds: T, sync, warmStartDays: 7 });
  const later = trainingLoad(rides, { today: '2026-09-24', thresholds: T, sync, warmStartDays: 7 });
  assert.equal(later.chronic, atSync.chronic, 'three days with nothing synced hold fitness where it was');
  assert.equal(later.acute, atSync.acute, 'and fatigue');
  // With no sync record the window is whatever the activities say, as it always was: those days are days off.
  const unsynced = trainingLoad(rides, { today: '2026-09-24', thresholds: T, warmStartDays: 7 });
  assert.ok(unsynced.acute < atSync.acute, 'three days of nothing do pull fatigue down when nothing says they are unknown');
});
