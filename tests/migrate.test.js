import test from 'node:test';
import assert from 'node:assert/strict';

import { migratePlan, LEGACY_PHASES, LEGACY_TOTAL_WEEKS, legacyAbsWeek } from '../assets/coach/migrate.js';
import { validateSeason } from '../assets/coach/validate.js';
import { durToMin } from '../assets/coach/duration.js';
import { DAYS } from '../assets/coach/profile.js';

/* A v2 plan as index.html actually stores one: a sparse overlay keyed by
   "Phase_N", session ids derived from the template ("Base-0-3") or minted for
   user-added sessions ("cus-..."), and a phase-relative view. */
const v2Plan = () => ({
  id: 'p-abc123',
  name: 'My 70.3',
  start: '2026-01-05',
  weeks: {
    Base_1: [
      { d: 'Tue', day: 'Tue', disc: 'Swim', focus: 'Threshold sets', dur: '0:50', zone: 'Z3', id: 'Base-1-2' },
      { d: 'Sat', day: 'Sat', disc: 'Bike', focus: 'Long ride', dur: '3:00', zone: 'Z2', id: 'Base-1-6' },
      { d: 'Sun', day: 'Sun', disc: 'Run', focus: 'Parkrun', dur: '0:30', zone: 'Z4', id: 'cus-lz3k2ab1' },
    ],
  },
  done: { 'Base-0-3': true, 'Base-1-2': true, 'cus-lz3k2ab1': true },
  chartmode: 'cumulative',
  charthidden: { Swim: true },
  view: { phase: 'Build', week: 2 },
  updatedAt: 1737000000000,
});

test('the legacy season is the 16 weeks the app shipped', () => {
  assert.equal(LEGACY_TOTAL_WEEKS, 16);
  assert.deepEqual(LEGACY_PHASES.map((p) => p.name), ['Base', 'Build', 'Peak', 'Taper']);
});

test('legacyAbsWeek flattens a phase-relative position', () => {
  assert.equal(legacyAbsWeek('Base', 0), 0);
  assert.equal(legacyAbsWeek('Build', 2), 8); // Base is 6 weeks
  assert.equal(legacyAbsWeek('Taper', 1), 15);
});

test('migration stamps the new schema version', () => {
  assert.equal(migratePlan(v2Plan()).schema, 3);
});

test('every week is materialized under an absolute key', () => {
  const p = migratePlan(v2Plan());
  const keys = Object.keys(p.weeks);
  assert.equal(keys.length, 16);
  assert.ok(keys.includes('w0') && keys.includes('w15'));
  assert.ok(!keys.some((k) => k.includes('_')), 'no phase-relative keys should survive');
});

test('an edited week survives the move verbatim', () => {
  const p = migratePlan(v2Plan());
  // Base_1 is absolute week 1.
  assert.deepEqual(p.weeks.w1, v2Plan().weeks.Base_1);
});

test('untouched weeks are filled in from the template rather than left empty', () => {
  const p = migratePlan(v2Plan());
  assert.ok(p.weeks.w0.length > 0);
  assert.ok(p.weeks.w9.length > 0);
  assert.ok(p.weeks.w0.some((s) => durToMin(s.dur) > 0), 'a real week, not all rest');
});

test('completion flags still point at sessions that exist', () => {
  const p = migratePlan(v2Plan());
  const ids = new Set(Object.values(p.weeks).flat().map((s) => s.id));
  for (const doneId of Object.keys(p.done)) {
    assert.ok(ids.has(doneId), `done flag ${doneId} lost its session`);
  }
});

test('session ids stay unique across the whole plan', () => {
  const all = Object.values(migratePlan(v2Plan()).weeks).flat().map((s) => s.id);
  assert.equal(new Set(all).size, all.length);
});

test('the saved view is rebased onto absolute weeks', () => {
  const p = migratePlan(v2Plan());
  assert.equal(p.view.week, 8);
  assert.equal(p.view.phase, undefined, 'phase is no longer part of the view');
});

test('a profile is synthesized from what the plan already asks for', () => {
  const p = migratePlan(v2Plan());
  assert.ok(p.profile.annualHours > 0);
  for (const d of DAYS) assert.ok(Number.isFinite(p.profile.availability[d]));
});

test('inferred availability covers every day the plan already uses', () => {
  // If it did not, the athlete would open a migrated plan full of errors about
  // days that were fine yesterday.
  const p = migratePlan(v2Plan());
  for (const [key, sessions] of Object.entries(p.weeks)) {
    const perDay = {};
    for (const s of sessions) perDay[s.day] = (perDay[s.day] ?? 0) + durToMin(s.dur);
    for (const d of DAYS) {
      assert.ok(
        (perDay[d] ?? 0) <= p.profile.availability[d],
        `${key} ${d}: needs ${perDay[d]} but profile allows ${p.profile.availability[d]}`,
      );
    }
  }
});

test('a migrated plan raises no validation errors', () => {
  const p = migratePlan(v2Plan());
  const weeks = p.season.map((w) => ({ ...w, sessions: p.weeks[`w${w.absWeek}`] }));
  const errors = validateSeason(weeks, { profile: p.profile }).filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], `migrated plan should be clean, got ${JSON.stringify(errors)}`);
});

test('a resolved season is stored alongside the weeks', () => {
  const p = migratePlan(v2Plan());
  assert.equal(p.season.length, 16);
  assert.equal(p.season.at(-1).block, 'Race');
  assert.deepEqual(p.season.map((w) => w.absWeek), [...Array(16).keys()]);
});

test('actuals and chat start empty rather than undefined', () => {
  const p = migratePlan(v2Plan());
  assert.deepEqual(p.actuals, {});
  assert.deepEqual(p.chat, []);
});

test('identity and display preferences are preserved', () => {
  const p = migratePlan(v2Plan());
  assert.equal(p.id, 'p-abc123');
  assert.equal(p.name, 'My 70.3');
  assert.equal(p.start, '2026-01-05');
  assert.equal(p.chartmode, 'cumulative');
  assert.deepEqual(p.charthidden, { Swim: true });
});

test('a never-edited plan still migrates to a full season', () => {
  const blank = { id: 'p-x', name: 'Fresh', start: '2026-01-05', weeks: {}, done: {}, view: { phase: 'Base', week: 0 } };
  const p = migratePlan(blank);
  assert.equal(Object.keys(p.weeks).length, 16);
  assert.equal(p.view.week, 0);
});

test('migration does not mutate the plan it was given', () => {
  const original = v2Plan();
  const snapshot = JSON.parse(JSON.stringify(original));
  migratePlan(original);
  assert.deepEqual(original, snapshot);
});

test('the migrated plan shares no state with the plan it came from', () => {
  // Not the same as "migration didn't mutate". The agent edits a staged clone of
  // the current plan; if migration handed back arrays still owned by the stored
  // plan, those edits would leak into the original before anyone hit Apply.
  const original = v2Plan();
  const snapshot = JSON.parse(JSON.stringify(original));
  const migrated = migratePlan(original);

  migrated.weeks.w1[0].dur = '9:99';
  migrated.weeks.w1.push({ id: 'injected', day: 'Mon', disc: 'Run', dur: '1:00', focus: '', zone: '' });
  migrated.done['injected'] = true;

  assert.deepEqual(original, snapshot, 'editing the migrated plan reached back into the original');
});

test('migrating an already-migrated plan changes nothing', () => {
  const once = migratePlan(v2Plan());
  assert.deepEqual(migratePlan(once), once);
});
