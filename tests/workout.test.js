import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bikeWorkout, pctToWatts, workoutSeconds, workoutHash, planSyncSet, SYNC_CAP,
} from '../assets/coach/workout.js';

const bike = (over = {}) => ({ id: 'b1', day: 'Tue', disc: 'Bike', focus: 'Threshold intervals', dur: '1:30', zone: 'Z3–Z4', ...over });
const flat = (steps) => steps.flatMap((s) => (s.type === 'repeat' ? Array(s.count).fill(s.steps).flat() : [s]));

test('a bike session becomes warm-up, main set and cool-down that add up to its duration', () => {
  const w = bikeWorkout(bike(), { ftpW: 250 });
  assert.equal(w.ok, true);
  assert.equal(w.steps[0].type, 'warmup');
  assert.equal(w.steps.at(-1).type, 'cooldown');
  assert.ok(w.steps.some((s) => s.type === 'repeat'), 'threshold work is a repeat block');
  assert.equal(workoutSeconds(w.steps), 90 * 60);
});

test('every focus the generator writes sums to the planned time', () => {
  for (const focus of ['Endurance spin', 'Long ride', 'Threshold intervals', 'Race-pace hold', 'Openers']) {
    for (const dur of ['0:30', '0:45', '1:00', '1:30', '2:45', '5:00']) {
      const w = bikeWorkout(bike({ focus, dur, zone: 'Z2' }), { ftpW: 200 });
      assert.equal(workoutSeconds(w.steps), Number(dur.split(':')[0]) * 3600 + Number(dur.split(':')[1]) * 60, `${focus} ${dur}`);
    }
  }
});

test('%FTP becomes watts at the athlete\'s FTP, rounded', () => {
  assert.deepEqual(pctToWatts([91, 105], 250), [228, 263]);
  assert.equal(pctToWatts([50, 60], null), null);
  const w = bikeWorkout(bike(), { ftpW: 250 });
  const work = flat(w.steps).find((s) => s.type === 'interval');
  assert.deepEqual(work.watts, pctToWatts(work.pct, 250));
  assert.equal(w.ftpW, 250);
});

test('without an FTP the steps keep %FTP targets and carry no watts', () => {
  const w = bikeWorkout(bike(), {});
  assert.equal(w.ftpW, null);
  assert.ok(flat(w.steps).every((s) => s.watts === null && Array.isArray(s.pct)));
});

test('a zone range sets the steady band; a single zone does too', () => {
  const steady = (zone) => flat(bikeWorkout(bike({ focus: 'Long ride', zone }), {}).steps).find((s) => s.type === 'interval').pct;
  const z2 = steady('Z2');
  const z34 = steady('Z3–Z4');
  assert.ok(z34[1] > z2[1]);
});

test('an unknown focus or zone still yields a plain steady workout', () => {
  const w = bikeWorkout(bike({ focus: 'My own ride', zone: '—' }), { ftpW: 220 });
  assert.equal(w.ok, true);
  assert.equal(workoutSeconds(w.steps), 90 * 60);
});

test('a very short ride is a single steady step', () => {
  const w = bikeWorkout(bike({ focus: 'Endurance spin', dur: '0:15', zone: 'Z2' }), {});
  assert.equal(w.steps.length, 1);
  assert.equal(workoutSeconds(w.steps), 900);
});

test('only bike sessions with a duration are exported', () => {
  assert.equal(bikeWorkout({ ...bike(), disc: 'Run' }, {}).ok, false);
  assert.equal(bikeWorkout({ ...bike(), dur: '—' }, {}).ok, false);
  assert.equal(bikeWorkout(null, {}).ok, false);
});

test('generation is deterministic and the hash follows the content', () => {
  const a = bikeWorkout(bike(), { ftpW: 250 });
  const b = bikeWorkout(bike(), { ftpW: 250 });
  assert.deepEqual(a, b);
  assert.equal(workoutHash(a, '2026-10-13'), workoutHash(b, '2026-10-13'));
  assert.notEqual(workoutHash(a, '2026-10-13'), workoutHash(a, '2026-10-14'));
  assert.notEqual(workoutHash(a, '2026-10-13'), workoutHash(bikeWorkout(bike(), { ftpW: 260 }), '2026-10-13'));
});

const plan = (extra = {}) => ({
  start: '2026-10-05', // a Monday
  season: [{ absWeek: 0 }, { absWeek: 1 }],
  weeks: {
    w0: [bike({ id: 'a', day: 'Mon' }), { id: 'r', day: 'Tue', disc: 'Run', focus: 'Easy', dur: '0:45', zone: 'Z2' }],
    w1: [bike({ id: 'b', day: 'Wed' }), bike({ id: 'c', day: 'Fri', focus: 'Long ride', zone: 'Z2' })],
  },
  done: {},
  actuals: {},
  loadRefs: { ftpW: 250 },
  ...extra,
});

test('a sync takes upcoming bike sessions only, dated from the plan', () => {
  const set = planSyncSet(plan(), { today: '2026-10-07', sent: {} });
  assert.deepEqual(set.items.map((i) => [i.id, i.date, i.status]), [['b', '2026-10-14', 'new'], ['c', '2026-10-16', 'new']]);
  assert.deepEqual(set.skipped.map((s) => [s.id, s.reason]), [['a', 'past']]);
});

test('logged and done sessions are left alone', () => {
  const set = planSyncSet(plan({ done: { b: true }, actuals: { c: { status: 'done' } } }), { today: '2026-10-05', sent: {} });
  assert.deepEqual(set.items.map((i) => i.id), ['a']);
  assert.deepEqual(set.skipped.map((s) => [s.id, s.reason]).sort(), [['b', 'done'], ['c', 'done']]);
});

test('running a sync twice sends nothing new; a changed session is sent again', () => {
  const first = planSyncSet(plan(), { today: '2026-10-05', sent: {} });
  const sent = Object.fromEntries(first.items.map((i) => [i.id, { hash: i.hash, workoutId: 1, scheduleId: 2, date: i.date }]));
  const again = planSyncSet(plan(), { today: '2026-10-05', sent });
  assert.ok(again.items.every((i) => i.status === 'unchanged'));
  const edited = plan();
  edited.loadRefs = { ftpW: 270 };
  const changed = planSyncSet(edited, { today: '2026-10-05', sent });
  assert.ok(changed.items.every((i) => i.status === 'changed'));
  assert.equal(changed.items[0].previous.workoutId, 1);
});

test('a run is capped and says so', () => {
  const many = plan({ weeks: { w0: Array.from({ length: SYNC_CAP + 5 }, (_, i) => bike({ id: 'x' + i, day: 'Mon' })), w1: [] } });
  const set = planSyncSet(many, { today: '2026-10-05', sent: {} });
  assert.equal(set.items.filter((i) => i.status !== 'unchanged').length <= SYNC_CAP, true);
  assert.equal(set.capped, true);
});

test('with no FTP the set says targets are %FTP only', () => {
  const set = planSyncSet(plan({ loadRefs: undefined }), { today: '2026-10-05', sent: {} });
  assert.equal(set.noFtp, true);
});
