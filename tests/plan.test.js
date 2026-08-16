import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPlan, blockAt, weekCount, sessionsAt, setSessionsAt,
  refit, diffPlans, applyDraft, weekTotals,
} from '../assets/coach/plan.js';
import { normalizeProfile, DAYS } from '../assets/coach/profile.js';
import { durToMin } from '../assets/coach/duration.js';

const anyDay = (m) => Object.fromEntries(DAYS.map((d) => [d, m]));
const v2 = () => ({
  id: 'p-1', name: 'My 70.3', start: '2026-01-05',
  weeks: {}, done: {}, view: { phase: 'Base', week: 0 },
});

test('loadPlan migrates a v2 plan on the way in', () => {
  const p = loadPlan(v2());
  assert.equal(p.schema, 3);
  assert.equal(weekCount(p), 16);
});

test('loadPlan leaves a v3 plan alone', () => {
  const once = loadPlan(v2());
  assert.deepEqual(loadPlan(once), once);
});

test('blockAt reports which block a week belongs to', () => {
  const p = loadPlan(v2());
  assert.equal(blockAt(p, 0).block, p.season[0].block);
  assert.equal(blockAt(p, weekCount(p) - 1).block, 'Race');
});

test('blockAt clamps rather than returning undefined off the end', () => {
  const p = loadPlan(v2());
  assert.equal(blockAt(p, 999).absWeek, weekCount(p) - 1);
  assert.equal(blockAt(p, -5).absWeek, 0);
});

test('sessionsAt returns a copy, so callers cannot edit the plan by accident', () => {
  const p = loadPlan(v2());
  sessionsAt(p, 0)[0].dur = '9:99';
  assert.notEqual(sessionsAt(p, 0)[0].dur, '9:99');
});

test('setSessionsAt writes without mutating the plan it was given', () => {
  const p = loadPlan(v2());
  const before = JSON.parse(JSON.stringify(p));
  const next = setSessionsAt(p, 2, [{ id: 'x', day: 'Mon', disc: 'Run', dur: '1:00', focus: '', zone: '' }]);
  assert.equal(sessionsAt(next, 2).length, 1);
  assert.deepEqual(p, before, 'the original plan must be untouched');
});

/* Re-fitting produces a draft. Nothing is written until it is applied. */

test('refit returns a new plan and leaves the original alone', () => {
  const p = loadPlan(v2());
  const before = JSON.parse(JSON.stringify(p));
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  assert.notDeepEqual(draft.weeks, p.weeks, 'the draft should differ');
  assert.deepEqual(p, before, 'the source plan must be untouched');
});

test('refit rebuilds the season from the new profile', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  assert.ok(draft.profile.annualHours === 800);
  assert.ok(
    weekTotals(draft).reduce((a, b) => a + b, 0) > weekTotals(p).reduce((a, b) => a + b, 0),
    'a bigger budget should produce a bigger season',
  );
});

test('refit honours availability, so a squeezed week cannot overflow', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, availability: anyDay(45) } });
  for (const [i, mins] of weekTotals(draft).entries()) {
    assert.ok(mins <= 45 * 7, `week ${i} plans ${mins} against 315 available`);
  }
});

test('refit can be scoped to a range, leaving other weeks alone', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 900 }, from: 2, to: 4 });
  assert.deepEqual(sessionsAt(draft, 0), sessionsAt(p, 0), 'week 0 untouched');
  assert.deepEqual(sessionsAt(draft, 7), sessionsAt(p, 7), 'week 7 untouched');
  assert.notDeepEqual(sessionsAt(draft, 3), sessionsAt(p, 3), 'week 3 refitted');
});

/* The diff is what the athlete actually approves. */

test('an unchanged draft produces an empty diff', () => {
  const p = loadPlan(v2());
  const d = diffPlans(p, p);
  assert.deepEqual(d.weeks, []);
  assert.equal(d.totalDeltaMinutes, 0);
});

test('the diff reports per-week volume before and after', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  const d = diffPlans(p, draft);
  assert.ok(d.weeks.length > 0);
  for (const w of d.weeks) {
    assert.equal(typeof w.absWeek, 'number');
    assert.equal(w.deltaMinutes, w.afterMinutes - w.beforeMinutes);
  }
  assert.equal(
    d.totalDeltaMinutes,
    d.weeks.reduce((a, w) => a + w.deltaMinutes, 0),
  );
});

test('the diff names sessions added, removed and changed', () => {
  const p = loadPlan(v2());
  const week0 = sessionsAt(p, 0);
  const edited = [
    { ...week0[0], dur: '2:00' },                                        // changed
    ...week0.slice(1, -1),                                               // untouched
    { id: 'brand-new', day: 'Fri', disc: 'Run', dur: '0:40', focus: 'x', zone: 'Z2' }, // added
  ];                                                                     // last one dropped
  const d = diffPlans(p, setSessionsAt(p, 0, edited));
  const w = d.weeks.find((x) => x.absWeek === 0);
  assert.equal(w.added.length, 1);
  assert.equal(w.added[0].id, 'brand-new');
  assert.equal(w.removed.length, 1);
  assert.equal(w.changed.length, 1);
  assert.equal(w.changed[0].before.dur, week0[0].dur);
  assert.equal(w.changed[0].after.dur, '2:00');
});

test('the diff carries validation issues so the UI can warn before applying', () => {
  const p = loadPlan(v2());
  // One day deliberately over its available time.
  const over = [{ id: 'x', day: 'Mon', disc: 'Run', dur: '9:00', focus: '', zone: 'Z2' }];
  const d = diffPlans(p, setSessionsAt(p, 0, over));
  assert.ok(d.issues.some((i) => i.code === 'day-over-capacity' && i.level === 'error'));
  assert.equal(d.blocked, true, 'an impossible week must block the apply');
});

test('a merely questionable draft warns but does not block', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 2000 } });
  const d = diffPlans(p, draft);
  assert.equal(d.blocked, false);
});

/* Applying is the only thing that changes the stored plan. */

test('applyDraft returns the draft content with a fresh timestamp', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  const applied = applyDraft(p, draft, { now: 12345 });
  assert.deepEqual(applied.weeks, draft.weeks);
  assert.equal(applied.updatedAt, 12345);
  assert.equal(applied.id, p.id, 'identity is preserved');
});

test('applyDraft does not mutate either input', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  const snapP = JSON.parse(JSON.stringify(p));
  const snapD = JSON.parse(JSON.stringify(draft));
  applyDraft(p, draft, { now: 1 });
  assert.deepEqual(p, snapP);
  assert.deepEqual(draft, snapD);
});

test('completion flags survive an apply where the session survived', () => {
  const p = loadPlan(v2());
  const keep = sessionsAt(p, 0)[0].id;
  const withDone = { ...p, done: { [keep]: true } };
  const applied = applyDraft(withDone, setSessionsAt(withDone, 1, []), { now: 1 });
  assert.equal(applied.done[keep], true);
});

test('completion flags for sessions that no longer exist are dropped', () => {
  const p = loadPlan(v2());
  const withDone = { ...p, done: { 'ghost-session': true, ...{} } };
  const applied = applyDraft(withDone, withDone, { now: 1 });
  assert.equal(applied.done['ghost-session'], undefined, 'stale flags should not accumulate');
});
