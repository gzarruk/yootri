import test from 'node:test';
import assert from 'node:assert/strict';

import { autoApply, revertDraft, appendLog, normalizeChangeLog, LOG_CAP } from '../assets/coach/autoapply.js';
import { newPlan } from '../assets/coach/plan.js';

/* The coach's own changes are applied without a review, but only through the
   same gate: a change that would make a week impossible is refused, and every
   change that is made is written down, with enough to take it back. */

const base = () => {
  const p = newPlan({ name: 'Auto', startISO: '2026-01-05', now: 1 });
  p.weeks.w0 = [
    { id: 'w0-0', day: 'Tue', disc: 'Run', focus: 'Easy aerobic', dur: '1:00', zone: 'Z2' },
    { id: 'w0-1', day: 'Thu', disc: 'Bike', focus: 'Endurance spin', dur: '1:00', zone: 'Z2' },
  ];
  p.profile = { ...p.profile, availability: Object.fromEntries(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => [d, 120])) };
  return p;
};
const edited = (p, fn) => { const d = structuredClone(p); fn(d.weeks.w0); return d; };

test('a change that keeps every week possible is applied and logged', () => {
  const p = base();
  const d = edited(p, (w) => { w[0].day = 'Wed'; });
  const r = autoApply(p, d, { now: 5, source: 'coach', summary: 'Moved Tuesday\'s run to Wednesday' });
  assert.equal(r.applied, true);
  assert.equal(r.plan.weeks.w0[0].day, 'Wed');
  assert.equal(r.entry.source, 'coach');
  assert.equal(r.entry.summary, 'Moved Tuesday\'s run to Wednesday');
  assert.deepEqual(r.entry.weeks, [1]);
  assert.equal(r.entry.before.w0[0].day, 'Tue', 'the week as it was is kept to take it back');
  assert.equal(r.entry.at, 5);
});

test('a change that would make a week impossible is refused and nothing is written', () => {
  const p = base();
  const d = edited(p, (w) => { w[0].dur = '25:00'; });
  const r = autoApply(p, d, { now: 5, source: 'coach' });
  assert.equal(r.applied, false);
  assert.equal(r.blocked, true);
  assert.ok(r.issues.length);
  assert.equal(p.weeks.w0[0].dur, '1:00');
});

test('a warning does not stop it', () => {
  const p = base();
  const d = edited(p, (w) => { w[0].dur = '2:30'; }); // over the day's 2h: guidance, not a wall
  assert.equal(autoApply(p, d, { now: 5, source: 'coach' }).applied, true);
});

test('a draft that changes nothing is not applied or logged', () => {
  const p = base();
  const r = autoApply(p, structuredClone(p), { now: 5, source: 'coach' });
  assert.equal(r.applied, false);
  assert.equal(r.blocked, false);
  assert.equal(r.entry, undefined);
});

test('a change is taken back from its log entry', () => {
  const p = base();
  const d = edited(p, (w) => { w[0].day = 'Wed'; });
  const { plan, entry } = autoApply(p, d, { now: 5, source: 'coach' });
  const undo = autoApply(plan, revertDraft(plan, entry), { now: 6, source: 'revert' });
  assert.equal(undo.applied, true);
  assert.equal(undo.plan.weeks.w0[0].day, 'Tue');
});

test('an entry with no record of the week cannot be reverted', () => {
  assert.equal(revertDraft(base(), { id: 'x', at: 1, source: 'garmin', summary: 's', weeks: [] }), null);
});

test('the log keeps the newest entries and drops unknown keys and oversize text', () => {
  let log = [];
  for (let i = 0; i < LOG_CAP + 5; i++) log = appendLog(log, { id: `e${i}`, at: i, source: 'coach', summary: 'x'.repeat(500), weeks: [1], hr: 140 });
  assert.equal(log.length, LOG_CAP);
  assert.equal(log[0].id, `e${LOG_CAP + 4}`, 'newest first');
  assert.ok(log[0].summary.length <= 280);
  assert.equal('hr' in log[0], false);
  assert.deepEqual(normalizeChangeLog('nonsense'), []);
  assert.deepEqual(normalizeChangeLog([{ nope: 1 }]), []);
});

test('a change that also re-sized the season is undone whole', () => {
  const p = base();
  p.season = [{ absWeek: 0, block: 'Prep', hours: 8 }];
  const d = edited(p, (w) => { w[0].day = 'Wed'; });
  d.season = [{ absWeek: 0, block: 'Prep', hours: 9 }];
  d.profile = { ...d.profile, splits: { Prep: { Bike: 1 } } };
  const { plan, entry } = autoApply(p, d, { now: 5, source: 'coach' });
  const undo = autoApply(plan, revertDraft(plan, entry), { now: 6, source: 'revert' });
  assert.equal(undo.plan.season[0].hours, 8);
  assert.equal(undo.plan.profile.splits, undefined);
});
