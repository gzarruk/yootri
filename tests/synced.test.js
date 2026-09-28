import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SYNC_SOURCES, SYNCED_DISCIPLINES, MAX_ACTIVITIES, KEEP_DAYS, FIRST_SYNC_DAYS, OVERLAP_DAYS,
  MAX_RANGE_DAYS, NAME_MAX,
  splitSynced, normalizeSyncedActivity, normalizeActivities, ingestSynced, mergeActivities,
  normalizeActivitySync, nextSyncWindow, nextActivitySync, mergeHrStore, hrLookup, asRunEffort,
  bridgeErrorMessage, BRIDGE_ERROR_CODES,
} from '../assets/coach/synced.js';
import { benchmarkCandidates } from '../assets/coach/activities.js';

/* Activities synced from the Garmin bridge (tools/garmin-bridge).

   The rule this module exists for: **heart rate crosses one boundary and no
   further.** The bridge sends it per activity; `splitSynced` hands it back
   separately so the page can keep it in this browser, and everything that can
   reach a stored plan — the plan-bound record, the normalizer `loadPlan` runs,
   a plan file somebody edited by hand — carries none of it. The run in the
   golden file has distinctive values (173 / 187) so the tests can look for the
   numbers, not just the key names. */

const GOLDEN = JSON.parse(readFileSync(
  new URL('../tools/garmin-bridge/tests/golden/activities-v1.json', import.meta.url), 'utf8'));
const RUN = GOLDEN.activities.find((a) => a.id === '1001');

const HR_KEY = /hr|heart/i;
const noHeartRate = (value) => {
  const text = JSON.stringify(value);
  assert.equal(text.includes('173'), false, 'the average is gone, not just its key');
  assert.equal(text.includes('187'), false, 'the maximum is gone too');
  for (const a of [].concat(value)) {
    for (const key of Object.keys(a ?? {})) assert.equal(HR_KEY.test(key), false, `key ${key}`);
  }
};

/* ---- the boundary ---- */

test('the golden file splits cleanly', () => {
  const out = GOLDEN.activities.map((raw) => splitSynced(raw));
  assert.equal(out.every(Boolean), true);
  const run = out.find((x) => x.activity.id === 'garmin:1001');
  assert.deepEqual(run.activity, {
    id: 'garmin:1001', source: 'garmin', date: '2026-09-01', time: '07:30', sport: 'running',
    disc: 'Run', name: 'Morning Run', durationS: 3600, movingS: 3550, distanceM: 12000, rpe: 6,
  });
  assert.deepEqual(run.hr, { id: 'garmin:1001', date: '2026-09-01', avg: 173, max: 187 });
});

test('heart rate never reaches the plan-bound record', () => {
  const { activity } = splitSynced(RUN);
  noHeartRate(activity);
});

test('an activity without heart rate has none to hand back', () => {
  const swim = GOLDEN.activities.find((a) => a.id === '3001');
  assert.equal(splitSynced(swim).hr, null);
});

test('the normalizer strips anything that is not on the allowlist', () => {
  const dirty = {
    ...splitSynced(RUN).activity,
    hr: { avg: 173, max: 187 }, avgHr: 173, averageHR: 173, heartRate: 187,
    load: 88, tss: 88, method: 'heart-rate', calories: 820, lat: 59.9,
  };
  const clean = normalizeSyncedActivity(dirty);
  noHeartRate(clean);
  for (const key of ['load', 'tss', 'method', 'calories', 'lat']) assert.equal(key in clean, false);
});

test('only the known fields survive, and nulls and a false race flag are left out', () => {
  const bike = splitSynced(GOLDEN.activities.find((a) => a.id === '2001')).activity;
  assert.deepEqual(bike, {
    id: 'garmin:2001', source: 'garmin', date: '2026-09-02', time: '09:00', sport: 'road_biking',
    disc: 'Bike', name: 'Z2 ride', durationS: 7200, movingS: 7000, distanceM: 60000,
    avgPowerW: 190, normPowerW: 205,
  });
  const leg = splitSynced(GOLDEN.activities.find((a) => a.id === '5005')).activity;
  assert.equal(leg.race, true);
});

test('containers and transitions are not activities', () => {
  for (const disc of ['Multisport', 'Transition']) {
    assert.equal(splitSynced({ ...RUN, disc }), null);
  }
});

test('an unknown discipline is kept as Other', () => {
  assert.equal(splitSynced({ ...RUN, disc: 'Yoga' }).activity.disc, 'Other');
});

test('junk comes back as null, never a throw', () => {
  for (const raw of [null, undefined, 42, 'x', [], {}, { ...RUN, id: '' }, { ...RUN, id: 'a b' },
    { ...RUN, date: '2026-13-40' }, { ...RUN, date: undefined }, { ...RUN, durationS: 0 },
    { ...RUN, durationS: -5 }, { ...RUN, durationS: 'long' }]) {
    assert.equal(splitSynced(raw), null, JSON.stringify(raw));
    assert.equal(normalizeSyncedActivity(raw), null);
  }
});

test('an unknown source is refused', () => {
  assert.equal(splitSynced(RUN, { source: 'strava' }), null);
  assert.equal(normalizeSyncedActivity({ ...splitSynced(RUN).activity, source: 'x' }), null);
  assert.deepEqual(SYNC_SOURCES, ['garmin']);
});

test('names are bounded and control characters removed', () => {
  const { activity } = splitSynced({ ...RUN, name: 'a\u0007' + 'b'.repeat(500) });
  assert.equal(activity.name.length, NAME_MAX);
  assert.equal(activity.name.startsWith('ab'), true);
});

test('implausible numbers are dropped rather than stored', () => {
  const { activity } = splitSynced({ ...RUN, avgPowerW: 9000, rpe: 42, distanceM: -1, movingS: 0 });
  for (const key of ['avgPowerW', 'rpe', 'distanceM', 'movingS']) assert.equal(key in activity, false);
});

test('the discipline list', () => {
  assert.deepEqual(SYNCED_DISCIPLINES, ['Swim', 'Bike', 'Run', 'Strength', 'Other']);
});

/* ---- a list of them ---- */

test('ingest splits a bridge response and counts what it refused', () => {
  const out = ingestSynced([...GOLDEN.activities, { junk: true }], { source: 'garmin' });
  assert.equal(out.activities.length, GOLDEN.activities.length);
  assert.equal(out.rejected, 1);
  assert.equal(out.hr.length, 2);
  noHeartRate(out.activities);
});

test('normalizeActivities dedupes, orders and caps', () => {
  const a = splitSynced(RUN).activity;
  const later = { ...a, name: 'Renamed' };
  const bike = splitSynced(GOLDEN.activities[1]).activity;
  const out = normalizeActivities([bike, a, later, null, 'x']);
  assert.deepEqual(out.map((x) => x.id), ['garmin:1001', 'garmin:2001']);
  assert.equal(out[0].name, 'Renamed', 'the later copy wins');
  assert.deepEqual(normalizeActivities('nope'), []);
  assert.deepEqual(normalizeActivities([a, bike], { cap: 1 }).map((x) => x.id), ['garmin:2001'],
    'a cap keeps the newest');
});

test('merge adds, updates and leaves unchanged ones alone', () => {
  const [run, bike] = ingestSynced(GOLDEN.activities).activities;
  const first = mergeActivities([], [run, bike], { today: '2026-09-27' });
  assert.deepEqual([first.added, first.updated, first.dropped], [2, 0, 0]);

  const again = mergeActivities(first.activities, [run, { ...bike, name: 'Longer ride' }],
    { today: '2026-09-27' });
  assert.deepEqual([again.added, again.updated], [0, 1]);
  assert.equal(again.activities.find((a) => a.id === bike.id).name, 'Longer ride');
});

test('merge prunes what is older than the keep window, and caps', () => {
  const [run] = ingestSynced(GOLDEN.activities).activities;
  const old = { ...run, id: 'garmin:1', date: '2025-01-01' };
  const out = mergeActivities([old], [run], { today: '2026-09-27', keepDays: KEEP_DAYS });
  assert.deepEqual(out.activities.map((a) => a.id), ['garmin:1001']);
  assert.equal(out.dropped, 1);

  const many = Array.from({ length: 5 }, (_, i) => ({ ...run, id: `garmin:${i}`, date: `2026-09-0${i + 1}` }));
  const capped = mergeActivities([], many, { today: '2026-09-27', cap: 3 });
  assert.deepEqual(capped.activities.map((a) => a.date), ['2026-09-03', '2026-09-04', '2026-09-05']);
});

test('merge does not mutate its inputs', () => {
  const [run] = ingestSynced(GOLDEN.activities).activities;
  const existing = [run];
  const snapshot = structuredClone(existing);
  mergeActivities(existing, [{ ...run, name: 'x' }], { today: '2026-09-27' });
  assert.deepEqual(existing, snapshot);
});

test('a full store of activities stays well inside one Firestore document', () => {
  const [run] = ingestSynced(GOLDEN.activities).activities;
  const full = Array.from({ length: MAX_ACTIVITIES }, (_, i) => ({
    ...run, id: `garmin:${10_000_000_000 + i}`, name: 'n'.repeat(NAME_MAX), avgPowerW: 250,
    normPowerW: 260, race: true,
  }));
  const bytes = JSON.stringify(normalizeActivities(full)).length;
  assert.ok(bytes < 400_000, `${bytes} bytes`);
});

/* ---- which window to ask for ---- */

test('the first sync reaches back half a year', () => {
  assert.deepEqual(nextSyncWindow(null, { today: '2026-09-27' }),
    { since: '2026-03-29', until: '2026-09-27' });
  assert.equal(FIRST_SYNC_DAYS, 182);
});

test('later syncs overlap the last one by a few days', () => {
  const sync = { source: 'garmin', from: '2026-03-29', through: '2026-09-20', at: 1 };
  assert.deepEqual(nextSyncWindow(sync, { today: '2026-09-27' }),
    { since: '2026-09-17', until: '2026-09-27' });
  assert.equal(OVERLAP_DAYS, 3);
});

test('a long gap is clamped to what the bridge will serve', () => {
  const sync = { source: 'garmin', from: '2023-01-01', through: '2024-01-01', at: 1 };
  const w = nextSyncWindow(sync, { today: '2026-09-27' });
  assert.equal(w.until, '2026-09-27');
  assert.equal((Date.parse(w.until) - Date.parse(w.since)) / 86400000, MAX_RANGE_DAYS);
});

test('coverage grows contiguously, and a gap starts it again', () => {
  const first = nextActivitySync(null, { source: 'garmin', since: '2026-03-29', until: '2026-09-20', at: 5 });
  assert.deepEqual(first, { source: 'garmin', from: '2026-03-29', through: '2026-09-20', at: 5 });

  const next = nextActivitySync(first, { source: 'garmin', since: '2026-09-17', until: '2026-09-27', at: 6 });
  assert.deepEqual(next, { source: 'garmin', from: '2026-03-29', through: '2026-09-27', at: 6 });

  const gap = nextActivitySync(first, { source: 'garmin', since: '2026-09-25', until: '2026-09-27', at: 7 });
  assert.deepEqual(gap, { source: 'garmin', from: '2026-09-25', through: '2026-09-27', at: 7 });
});

test('coverage never claims further back than activities are kept', () => {
  const s = nextActivitySync({ source: 'garmin', from: '2020-01-01', through: '2026-09-20', at: 1 },
    { source: 'garmin', since: '2026-09-17', until: '2026-09-27', at: 2 });
  assert.equal((Date.parse(s.through) - Date.parse(s.from)) / 86400000, KEEP_DAYS);
});

test('normalizeActivitySync is total', () => {
  assert.equal(normalizeActivitySync(null), null);
  assert.equal(normalizeActivitySync({ source: 'garmin', from: 'x', through: '2026-09-01' }), null);
  assert.equal(normalizeActivitySync({ source: 'garmin', from: '2026-09-02', through: '2026-09-01' }), null);
  assert.equal(normalizeActivitySync({ source: 'nope', from: '2026-09-01', through: '2026-09-02' }), null);
  assert.deepEqual(normalizeActivitySync({ source: 'garmin', from: '2026-09-01', through: '2026-09-02', at: 3, x: 1 }),
    { source: 'garmin', from: '2026-09-01', through: '2026-09-02', at: 3 });
});

/* ---- the device-only heart-rate store ---- */

test('the heart-rate store keeps plausible values keyed by activity', () => {
  const { hr } = ingestSynced(GOLDEN.activities);
  const store = mergeHrStore(null, hr, { today: '2026-09-27' });
  assert.deepEqual(store, {
    v: 1,
    byId: {
      'garmin:1001': { d: '2026-09-01', a: 173, m: 187 },
      'garmin:2001': { d: '2026-09-02', a: 135, m: 160 },
    },
  });
  assert.deepEqual(hrLookup(store).get('garmin:1001'), { avg: 173, max: 187 });
});

test('implausible heart rates are not kept', () => {
  const store = mergeHrStore(null, [
    { id: 'garmin:1', date: '2026-09-01', avg: 20, max: 300 },
    { id: 'garmin:2', date: '2026-09-01', avg: 180, max: 150 },
    { id: 'garmin:3', date: '2026-09-01', avg: null, max: 190 },
  ], { today: '2026-09-27' });
  assert.deepEqual(Object.keys(store.byId), ['garmin:3']);
  assert.deepEqual(store.byId['garmin:3'], { d: '2026-09-01', m: 190 });
});

test('the heart-rate store is pruned by date and not mutated', () => {
  const before = { v: 1, byId: { 'garmin:old': { d: '2024-01-01', a: 150 } } };
  const snapshot = structuredClone(before);
  const after = mergeHrStore(before, [], { today: '2026-09-27' });
  assert.deepEqual(after.byId, {});
  assert.deepEqual(before, snapshot);
  assert.deepEqual(mergeHrStore('garbage', [], { today: '2026-09-27' }), { v: 1, byId: {} });
});

/* ---- benchmarks from synced runs ---- */

test('a synced run can be offered as a benchmark', () => {
  const run = splitSynced({ ...RUN, distanceM: 10000, durationS: 2520 }).activity;
  const effort = asRunEffort(run);
  assert.deepEqual(effort, { date: '2026-09-01', distanceMeters: 10000, timeSeconds: 2520,
    type: 'running', title: 'Morning Run' });
  const [candidate] = benchmarkCandidates([effort], { today: '2026-09-27' });
  assert.equal(candidate.standard, '10k');
});

test('only runs with a distance are efforts', () => {
  const bike = splitSynced(GOLDEN.activities[1]).activity;
  assert.equal(asRunEffort(bike), null);
  assert.equal(asRunEffort({ ...splitSynced(RUN).activity, distanceM: undefined }), null);
  assert.equal(asRunEffort(null), null);
});

/* ---- what the page says when the bridge does not answer ---- */

test('every error code has a sentence', () => {
  for (const code of BRIDGE_ERROR_CODES) {
    const text = bridgeErrorMessage(code);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 20, code);
  }
  assert.ok(bridgeErrorMessage('something-new').length > 20, 'unknown codes still get a sentence');
});

test('an unreachable bridge on a secure page mentions Safari', () => {
  assert.match(bridgeErrorMessage('unreachable', { secure: true }), /Safari/);
  assert.match(bridgeErrorMessage('unreachable'), /make garmin/);
  assert.match(bridgeErrorMessage('auth_required'), /make garmin-login/);
});
