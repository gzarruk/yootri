import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPlan, blockAt, weekCount, sessionsAt, setSessionsAt,
  refit, diffPlans, applyDraft, weekTotals, newPlan, pruneHistory, mintPlanId, moveSession,
  landingsOf, landingsDetail, raceDayFor, raceClosure, freshWeek, isUntouchedPlan,
  carryOver, upcomingEvents,
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

/** The plan's profile with every day's time scaled — a season is sized by the
    week the athlete has, so this is how a test asks for a bigger one. */
const roomier = (p, k) => ({
  ...p.profile,
  availability: Object.fromEntries(Object.entries(p.profile.availability).map(([d, m]) => [d, Math.round(m * k)])),
});

test('refit returns a new plan and leaves the original alone', () => {
  const p = loadPlan(v2());
  const before = JSON.parse(JSON.stringify(p));
  const draft = refit(p, { profile: roomier(p, 1.5) });
  assert.notDeepEqual(draft.weeks, p.weeks, 'the draft should differ');
  assert.deepEqual(p, before, 'the source plan must be untouched');
});

test('refit rebuilds the season from the new profile', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: roomier(p, 1.5) });
  assert.ok(draft.profile.availability.Sat > p.profile.availability.Sat);
  assert.ok(
    weekTotals(draft).reduce((a, b) => a + b, 0) > weekTotals(p).reduce((a, b) => a + b, 0),
    'a bigger week should produce a bigger season',
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
  const draft = refit(p, { profile: roomier(p, 1.8), from: 2, to: 4 });
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
  const draft = refit(p, { profile: roomier(p, 1.5) });
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
  const draft = refit(p, { profile: roomier(p, 4) });
  const d = diffPlans(p, draft);
  assert.equal(d.blocked, false);
});

/* Applying is the only thing that changes the stored plan. */

test('applyDraft returns the draft content with a fresh timestamp', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: roomier(p, 1.5) });
  const applied = applyDraft(p, draft, { now: 12345 });
  assert.deepEqual(applied.weeks, draft.weeks);
  assert.equal(applied.updatedAt, 12345);
  assert.equal(applied.id, p.id, 'identity is preserved');
});

test('applyDraft does not mutate either input', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: roomier(p, 1.5) });
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

test('logged actuals for sessions that no longer exist are dropped', () => {
  const p = loadPlan(v2());
  const keep = sessionsAt(p, 0)[0].id;
  const withLogs = { ...p, actuals: { [keep]: { status: 'done' }, 'ghost-session': { status: 'done' } } };
  const applied = applyDraft(withLogs, withLogs, { now: 1 });
  assert.deepEqual(applied.actuals, { [keep]: { status: 'done' } });
});

test('pruneHistory keeps only what the weeks it is given still contain', () => {
  const weeks = { w0: [{ id: 'a' }], w1: [{ id: 'b' }] };
  const out = pruneHistory(weeks, { done: { a: true, gone: true }, actuals: { b: { status: 'done' } } });
  assert.deepEqual(out.done, { a: true });
  assert.deepEqual(out.actuals, { b: { status: 'done' } });
});

test('pruneHistory copes with a plan that has no history at all', () => {
  assert.deepEqual(pruneHistory({ w0: [{ id: 'a' }] }), { done: {}, actuals: {} });
  assert.deepEqual(pruneHistory(undefined, { done: { a: true } }), { done: {}, actuals: {} });
});

test('mintPlanId does not hand out the same id twice in a millisecond', () => {
  const ids = new Set(Array.from({ length: 500 }, () => mintPlanId(1)));
  assert.equal(ids.size, 500, 'a repeat would overwrite the plan it collided with');
});

test('a per-week budget override survives a later refit', () => {
  // Two tool calls in one turn — "make next week 4h" then "no swimming" — must
  // not undo each other. A refit rebuilds the season from the profile, so an
  // override recorded on the plan has to be reapplied on top of it.
  const p = loadPlan(v2());
  const pinned = { ...p, weekBudgets: { w3: 4 } };
  const draft = refit(pinned, { profile: roomier(p, 1.8) });
  assert.equal(weekTotals(draft)[3], 240, 'week 3 should still be the pinned 4h');
  assert.notEqual(weekTotals(draft)[4], 240, 'other weeks follow the new budget');
});

test('week budget overrides are ignored when they name a week that is gone', () => {
  const p = loadPlan(v2());
  const pinned = { ...p, weekBudgets: { w99: 4 } };
  assert.doesNotThrow(() => refit(pinned, {}));
});

test('applying a draft keeps the conversation that happened while it was drafted', () => {
  // The draft is snapshotted when the coach calls its first tool — before it has
  // replied. Taking the chat from the draft therefore rewinds the transcript and
  // loses the coach's own answer. Chat is conversation state, like done and
  // actuals: it belongs to the plan being replaced, not to the proposal.
  const p = loadPlan(v2());
  const mid = refit(p, { profile: roomier(p, 1.5) });
  const withChat = {
    ...p,
    chat: [{ role: 'user', content: 'more hours' }, { role: 'coach', content: 'done' }],
  };
  const applied = applyDraft(withChat, mid, { now: 1 });
  assert.equal(applied.chat.length, 2);
  assert.equal(applied.chat[1].role, 'coach');
});

/* Starting a new season without losing the old one. */

test('newPlan sizes the season from the race date', () => {
  const p = newPlan({ name: 'Ironman 2027', startISO: '2026-08-17', raceDate: '2027-06-14' });
  assert.equal(weekCount(p), 44);
  assert.equal(p.season.at(-1).block, 'Race', 'the taper lands on race week');
});

test('newPlan falls back to a sensible length with no race date', () => {
  const p = newPlan({ name: 'Untitled', startISO: '2026-08-17' });
  assert.ok(weekCount(p) >= 8, `got ${weekCount(p)} weeks`);
  assert.equal(p.profile.raceDate, null);
});

test('a short runway keeps the race-specific end', () => {
  const p = newPlan({ name: 'Sprint', startISO: '2026-08-17', raceDate: '2026-10-05' });
  assert.equal(weekCount(p), 8);
  assert.equal(p.season.at(-1).block, 'Race');
});

test('newPlan inherits a profile when given one', () => {
  const mine = normalizeProfile({
    availability: { ...anyDay(120), Wed: 0 },
    constraints: [{ disc: 'Swim', rule: 'maxPerWeek', value: 2 }],
  });
  const p = newPlan({ name: 'Next', startISO: '2026-08-17', raceDate: '2027-01-04', profile: mine });
  assert.equal(p.season.reduce((a, w) => Math.max(a, w.hours), 0), 12, 'sized by the inherited week: 6 days of 2h');
  assert.equal(p.profile.availability.Wed, 0);
  assert.equal(p.profile.constraints.length, 1);
});

test('an inherited profile does not drag the old race date along with it', () => {
  const mine = normalizeProfile({ raceDate: '2026-09-01', raceType: 'olympic' });
  const p = newPlan({ name: 'Next', startISO: '2026-08-17', raceDate: '2027-01-04', raceType: 'ironman', profile: mine });
  assert.equal(p.profile.raceDate, '2027-01-04');
  assert.equal(p.profile.raceType, 'ironman');
});

test('a fitted plan arrives with training in it', () => {
  // A Sunday race, so the last week is a race week with six days before it.
  const p = newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-06', mode: 'fitted' });
  const totals = weekTotals(p);
  assert.ok(totals.every((m) => m > 0), 'every week should hold training');
});

test('a race early in the week leaves the rest of that week clear', () => {
  // 2026-12-07 is a Monday. Nothing is scheduled on race day or after it, so
  // the plan's last week is the race and nothing else — the openers belong to
  // the week before, which is where they already are.
  const p = newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-07', mode: 'fitted' });
  const totals = weekTotals(p);
  assert.equal(totals.at(-1), 0, 'a Monday race has no week left after it');
  assert.ok(totals.slice(0, -1).every((m) => m > 0), 'every other week still holds training');
});

test('an empty plan arrives as a blank calendar of the right length', () => {
  const p = newPlan({ name: 'B', startISO: '2026-08-17', raceDate: '2026-12-07', mode: 'empty' });
  assert.equal(weekCount(p), weekCount(newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-07' })));
  assert.deepEqual(weekTotals(p), weekTotals(p).map(() => 0), 'no training anywhere');
  assert.ok(p.season.length > 0, 'but it still knows its block structure');
});

test('an empty plan still shows every day, so there is somewhere to drop a session', () => {
  const p = newPlan({ name: 'B', startISO: '2026-08-17', raceDate: '2026-12-07', mode: 'empty' });
  const week = sessionsAt(p, 0);
  assert.deepEqual(week.map((s) => s.day), DAYS);
  assert.ok(week.every((s) => s.disc === 'Rest'));
});

test('a new plan starts with no history of its own', () => {
  const p = newPlan({ name: 'C', startISO: '2026-08-17', raceDate: '2026-12-07' });
  assert.deepEqual(p.done, {});
  assert.deepEqual(p.actuals, {});
  assert.deepEqual(p.chat, []);
  assert.equal(p.schema, 3);
});

test('new plans get distinct ids so they cannot overwrite each other', () => {
  const a = newPlan({ name: 'A', startISO: '2026-08-17' });
  const b = newPlan({ name: 'B', startISO: '2026-08-17' });
  assert.notEqual(a.id, b.id);
});

test('refit can resize a season when the race date moves', () => {
  const p = newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-07' });
  const before = weekCount(p);
  const draft = refit(p, { profile: { ...p.profile, raceDate: '2027-03-01' }, weeks: 28 });
  assert.notEqual(before, 28, 'the fixture should actually be resized by this');
  assert.equal(weekCount(draft), 28);
  assert.equal(draft.season.at(-1).block, 'Race');
});

test('refit keeps the season length when not told otherwise', () => {
  const p = newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-07' });
  assert.equal(weekCount(refit(p, { profile: roomier(p, 1.4) })), weekCount(p));
});

/* ---- Moving a session ---------------------------------------------------- */

test('a session moved within its week just changes day', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const next = moveSession(p, { id: s.id, toWeek: 0, day: 'Fri' });
  const moved = sessionsAt(next, 0).find((x) => x.id === s.id);
  assert.equal(moved.day, 'Fri');
  assert.equal(moved.focus, s.focus, 'nothing else about it changes');
  assert.equal(moved.dur, s.dur);
});

test('a session moved to another week leaves the week it came from', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const next = moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' });

  assert.equal(sessionsAt(next, 0).some((x) => x.id === s.id), false, 'gone from week 0');
  const landed = sessionsAt(next, 1).find((x) => x.id === 'mv-1');
  assert.equal(landed.day, 'Tue');
  assert.equal(landed.focus, s.focus);
});

test('a session crossing weeks is given a new id', () => {
  // Generated ids are `w{week}-{n}`, so a session dragged out of week 0 keeps a
  // week-0 id. "Reset week" on week 0 then mints that same id again, and done
  // flags, logged actuals and the diff are all keyed by id — two live sessions
  // sharing one is a silent corruption.
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const moved = moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' });
  const reset = refit(moved, { from: 0, to: 0 });

  const ids = Object.values(reset.weeks).flat().map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'every live session has its own id');
});

test('a moved session keeps its tick and its log under the new id', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const withHistory = { ...p, done: { [s.id]: true }, actuals: { [s.id]: { status: 'done', min: 45 } } };

  const next = moveSession(withHistory, { id: s.id, toWeek: 2, day: 'Sat', mintId: () => 'mv-1' });

  assert.equal(next.done['mv-1'], true);
  assert.deepEqual(next.actuals['mv-1'], { status: 'done', min: 45 });
  assert.equal(next.done[s.id], undefined, 'the old id is not left behind');
  assert.equal(next.actuals[s.id], undefined);
});

test('a moved session with no history does not invent any', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const next = moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' });
  assert.deepEqual(next.done, {});
  assert.deepEqual(next.actuals, {});
});

test('moveSession does not mutate the plan it was given', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const before = JSON.stringify(p);
  moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' });
  assert.equal(JSON.stringify(p), before);
});

test('moving a session nobody has changes nothing', () => {
  const p = loadPlan(v2());
  assert.deepEqual(moveSession(p, { id: 'no-such-session', toWeek: 1, day: 'Tue' }), p);
});

test('a session cannot be moved off the end of the season', () => {
  // Silently clamping would drop it into the last week instead, which is not
  // what anybody dragging it meant.
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  assert.deepEqual(moveSession(p, { id: s.id, toWeek: weekCount(p), day: 'Tue' }), p);
  assert.deepEqual(moveSession(p, { id: s.id, toWeek: -1, day: 'Tue' }), p);
});

test('a session cannot be moved onto a day that does not exist', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  assert.deepEqual(moveSession(p, { id: s.id, toWeek: 1, day: 'Funday' }), p);
});

test('week volumes follow the session that moved', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const before = weekTotals(p);
  const next = weekTotals(moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' }));

  assert.equal(next[0], before[0] - durToMin(s.dur));
  assert.equal(next[1], before[1] + durToMin(s.dur));
});

test('a new plan starts with its race already on the calendar', () => {
  const p = newPlan({ name: 'Cascais', startISO: '2026-08-17', raceDate: '2027-07-25', raceType: 'ironman', now: 1 });
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0].date, '2027-07-25');
  assert.equal(p.events[0].raceType, 'ironman');
  assert.equal(p.events[0].priority, 'primary');
});

test('a new plan with no race date starts with an empty calendar', () => {
  const p = newPlan({ name: 'Base', startISO: '2026-08-17', now: 1 });
  assert.deepEqual(p.events, []);
});

/* ---- benchmarks -------------------------------------------------------

   A benchmark is the running result every pace on a Run card is derived from.
   It rides on the plan as a top-level field, the way `events` and `weekBudgets`
   do, so a v3 record passes through `migratePlan` carrying it untouched. */

const bm = (over = {}) => ({
  id: 'bm-1', date: '2026-06-15', distanceMeters: 10000, timeSeconds: 2520,
  source: 'manual', label: '', current: true, ...over,
});

test('a new plan starts with no benchmarks rather than no field', () => {
  // An absent field means every reader needs its own `?? []`; an empty array
  // means none of them do.
  assert.deepEqual(newPlan({ name: 'x', startISO: '2026-01-05' }).benchmarks, []);
});

test('a new season inherits the benchmarks, the way it inherits constraints', () => {
  // The athlete's 10k did not get slower because they picked a new race.
  const p = newPlan({ name: 'x', startISO: '2026-01-05', benchmarks: [bm()] });
  assert.deepEqual(p.benchmarks.map((b) => b.id), ['bm-1']);
  assert.equal(p.benchmarks[0].current, true);
});

test('loadPlan cleans the benchmarks it was handed', () => {
  // Unlike events, which the page normalizes, benchmarks are read by the coach
  // tool and by the card renderer directly. Cleaning them at the one door every
  // reader comes through is what stops the panel and the coach disagreeing.
  const p = loadPlan({
    ...newPlan({ name: 'x', startISO: '2026-01-05' }),
    benchmarks: [
      bm({ id: 'b', date: '2026-06-15' }),
      bm({ id: 'a', date: '2025-03-01' }),
      { id: 'junk', date: 'never' },
      null,
    ],
  });
  assert.deepEqual(p.benchmarks.map((b) => b.id), ['a', 'b'], 'junk dropped, date order');
  assert.deepEqual(p.benchmarks.filter((x) => x.current).map((x) => x.id), ['b'],
    'two claims to current resolve to the more recent');
});

test('loadPlan stays idempotent once benchmarks are on the plan', () => {
  const once = loadPlan({ ...newPlan({ name: 'x', startISO: '2026-01-05' }), benchmarks: [bm()] });
  assert.deepEqual(loadPlan(once), once);
});

test('applying a draft carries the benchmark it was built with', () => {
  const p = newPlan({ name: 'x', startISO: '2026-01-05' });
  const draft = { ...structuredClone(p), benchmarks: [bm()] };
  assert.deepEqual(applyDraft(p, draft).benchmarks.map((b) => b.id), ['bm-1']);
});

test('a changed pace zone shows up in the diff the athlete approves', () => {
  // paceZone is what a Run card resolves its pace from, so moving a session
  // from easy to threshold is a change worth seeing before it is applied.
  const before = newPlan({ name: 'x', startISO: '2026-01-05' });
  const after = structuredClone(before);
  const target = after.weeks.w0.find((s) => s.disc === 'Run');
  assert.ok(target, 'the fixture has a Run session to change');
  target.paceZone = 'interval';

  const d = diffPlans(before, after);
  assert.equal(d.weeks.length, 1);
  assert.equal(d.weeks[0].changed.length, 1);
  assert.equal(d.weeks[0].changed[0].after.paceZone, 'interval');
});

test('a v2 plan loads with an empty benchmark list, not a missing one', () => {
  // v2 predates benchmarks entirely, so there is nothing to carry across — but
  // the field is present, so no reader downstream needs its own fallback.
  assert.deepEqual(loadPlan(v2()).benchmarks, []);
});

/* ---- More than one race in a season ---------------------------------------

   The primary race fixes the runway and keeps the model's own peak and race
   week. Every other race the athlete marked `secondary` gets a landing: one
   taper week and one race week, out of the block it falls in. */

// A 20-week plan from a Monday start, aimed at a Sunday IRONMAN.
const twoRacePlan = ({ tuneUp = '2027-01-24', priority = 'secondary' } = {}) => {
  const base = newPlan({
    name: 'Season', startISO: '2026-11-02', raceDate: '2027-03-21',
    raceType: 'ironman', now: 1,
  });
  return {
    ...base,
    events: [
      ...base.events,
      { id: 'ev-tune', name: 'Lisbon', date: tuneUp, kind: 'race', raceType: '70.3', priority },
    ],
  };
};

test('landingsOf reports the weeks the tune-up races fall in', () => {
  const p = twoRacePlan();
  assert.deepEqual(landingsOf(p), [11], '2027-01-24 is week 11 of a plan starting 2026-11-02');
  assert.deepEqual(landingsOf({ start: '2026-11-02', events: [] }), []);
  assert.deepEqual(landingsOf({}), []);
});

test('the race the season is built for is not a landing', () => {
  // It is the week the whole runway already ends on. Landing it again would
  // splice a taper over the peak that was built to arrive at it.
  const p = newPlan({ name: 'A', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: 'ironman', now: 1 });
  assert.deepEqual(landingsOf(p), []);
});

test('a marker race is not a landing', () => {
  const p = twoRacePlan({ priority: null });
  assert.deepEqual(landingsOf(p), []);
});

test('refit lands the tune-up races the plan carries', () => {
  const p = twoRacePlan();
  const drafted = refit(p, {});
  assert.equal(drafted.season[11].block, 'Race', 'the tune-up race week');
  assert.equal(drafted.season[10].block, 'Taper');
  assert.equal(drafted.season.at(-1).block, 'Race', 'and the season still ends on the primary');
  assert.equal(weekCount(drafted), weekCount(p), 'the season did not get longer for it');
});

test('adding a tune-up race is a change the athlete gets to review', () => {
  const before = newPlan({ name: 'A', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: 'ironman', now: 1 });
  const after = refit(twoRacePlan(), {});
  const d = diffPlans(before, after);
  assert.ok(d.weeks.length > 0, 'the weeks it landed on changed');
  assert.ok(d.weeks.some((w) => w.absWeek === 11));
  assert.equal(d.blocked, false, 'a tune-up race is not impossible, just a decision');
});

test('a race the season cannot build a taper for is reported at the diff', () => {
  // Two weeks before the primary race is inside its own peak and race week.
  const before = newPlan({ name: 'A', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: 'ironman', now: 1 });
  const after = refit(twoRacePlan({ tuneUp: '2027-03-07' }), {});
  const hit = diffPlans(before, after).issues.find((i) => i.code === 'race-in-primary-taper');
  assert.ok(hit, 'the athlete is told while they are deciding, not weeks later');
});

test('raceDayFor finds the day a race is actually on', () => {
  const p = twoRacePlan();
  assert.equal(raceDayFor(p, 11), 'Sun', '2027-01-24 is a Sunday');
  assert.equal(raceDayFor(p, weekCount(p) - 1), 'Sun', 'and so is the primary race');
  assert.equal(raceDayFor(p, 4), null);
});

test('a race the model refused a taper for still clears its own day', () => {
  // They are racing that day either way. Whether a taper was built for it is a
  // separate question from whether the week should schedule training on it.
  const p = twoRacePlan({ tuneUp: '2027-03-07' });
  assert.equal(raceDayFor(p, 17), 'Sun');
});

test('a marker race does not clear a day', () => {
  const p = twoRacePlan({ priority: null });
  assert.equal(raceDayFor(p, 11), null);
});

test('a tune-up race week is built around the race day', () => {
  // 2027-01-23 is a Saturday, so the Sunday after it belongs to the race.
  const drafted = refit(twoRacePlan({ tuneUp: '2027-01-23' }), {});
  const week = drafted.weeks.w11;
  for (const day of ['Sat', 'Sun']) {
    assert.equal(
      week.filter((x) => x.day === day).reduce((a, x) => a + durToMin(x.dur), 0), 0,
      `${day} should be clear for the race`,
    );
  }
  assert.ok(week.some((x) => durToMin(x.dur) > 0), 'the days before it still hold the week');
});

/* ---- synced activities -------------------------------------------------- */

const syncedRun = (over = {}) => ({
  id: 'garmin:1001', source: 'garmin', date: '2026-01-06', time: '07:30', sport: 'running',
  disc: 'Run', name: 'Morning Run', durationS: 3600, movingS: 3550, distanceM: 12000, ...over,
});

test('a plan always has an activity list, even one that predates them', () => {
  assert.deepEqual(loadPlan(v2()).activities, []);
  assert.equal('activitySync' in loadPlan(v2()), false, 'no sync means no coverage, not an empty one');
});

test('loadPlan cleans the activities it was handed', () => {
  const p = loadPlan({ ...loadPlan(v2()), activities: [syncedRun(), { junk: true }, syncedRun({ name: 'Renamed' })] });
  assert.deepEqual(p.activities, [syncedRun({ name: 'Renamed' })]);
});

test('loadPlan takes heart rate back off a hand-edited plan', () => {
  const p = loadPlan({ ...loadPlan(v2()), activities: [{ ...syncedRun(), hr: { avg: 173, max: 187 }, avgHr: 173 }] });
  assert.equal(JSON.stringify(p.activities).includes('173'), false);
  assert.equal(JSON.stringify(p.activities).includes('187'), false);
});

test('loadPlan keeps a valid sync coverage and drops a broken one', () => {
  const base = loadPlan(v2());
  const good = { source: 'garmin', from: '2025-12-01', through: '2026-01-10', at: 5 };
  assert.deepEqual(loadPlan({ ...base, activitySync: good }).activitySync, good);
  assert.equal('activitySync' in loadPlan({ ...base, activitySync: { from: 'x' } }), false);
});

test('loadPlan stays idempotent once activities are on the plan', () => {
  const once = loadPlan({ ...loadPlan(v2()), activities: [syncedRun()],
    activitySync: { source: 'garmin', from: '2025-12-01', through: '2026-01-10', at: 5 } });
  assert.deepEqual(loadPlan(once), once);
});

test('a new season carries the synced history across, like benchmarks', () => {
  const sync = { source: 'garmin', from: '2025-12-01', through: '2026-01-10', at: 5 };
  const p = newPlan({ name: 'Next', startISO: '2026-02-02', activities: [syncedRun()], activitySync: sync });
  assert.deepEqual(p.activities, [syncedRun()]);
  assert.deepEqual(p.activitySync, sync);
  assert.deepEqual(newPlan({ name: 'Fresh', startISO: '2026-02-02' }).activities, []);
});

test('applyDraft keeps activities synced after the draft was taken', () => {
  // The coach snapshots a draft at its first tool call. A sync that lands while
  // the athlete is still reading the diff must not be rolled back by Apply.
  const p = loadPlan(v2());
  const draft = structuredClone(p);
  const synced = { ...p, activities: [syncedRun()],
    activitySync: { source: 'garmin', from: '2025-12-01', through: '2026-01-10', at: 5 } };
  const applied = applyDraft(synced, draft);
  assert.deepEqual(applied.activities, synced.activities);
  assert.deepEqual(applied.activitySync, synced.activitySync);
});

test('applyDraft does not invent coverage for a plan that never synced', () => {
  const p = loadPlan(v2());
  const applied = applyDraft(p, structuredClone(p));
  assert.equal('activitySync' in applied, false);
});

/* ---- training-load references (FTP, CSS) ---- */

test('load references are cleaned on the way in, and absent stays absent', () => {
  const base = loadPlan(v2());
  assert.equal('loadRefs' in base, false);
  const p = loadPlan({ ...base, loadRefs: { ftpW: 250, cssSecPer100m: 98, hr: 170 } });
  assert.deepEqual(p.loadRefs, { ftpW: 250, cssSecPer100m: 98 });
  assert.equal('loadRefs' in loadPlan({ ...base, loadRefs: { ftpW: 9999 } }), false);
  assert.deepEqual(loadPlan(p), p, 'idempotent');
});

test('a new season keeps the load references, like benchmarks', () => {
  const p = newPlan({ name: 'Next', startISO: '2026-02-02', loadRefs: { ftpW: 250 } });
  assert.deepEqual(p.loadRefs, { ftpW: 250 });
});

test('applyDraft keeps load references set after the draft was taken', () => {
  const p = loadPlan(v2());
  const draft = structuredClone(p);
  const applied = applyDraft({ ...p, loadRefs: { ftpW: 250 } }, draft);
  assert.deepEqual(applied.loadRefs, { ftpW: 250 });
});

/* ---- one week from the stored season (Reset week) ---- */

test('freshWeek keeps a race day clear, the way a re-fit does', () => {
  // Reset week used to call generateWeek without the race day, so resetting the
  // week of a tune-up scheduled training on the race and the day after it.
  const p = twoRacePlan({ tuneUp: '2027-01-23' });
  const week = freshWeek(p, 11);
  for (const day of ['Sat', 'Sun']) {
    assert.equal(
      week.filter((x) => x.day === day).reduce((a, x) => a + durToMin(x.dur), 0), 0,
      `${day} should be clear for the race`,
    );
  }
  const last = weekCount(p) - 1;
  assert.equal(
    freshWeek(p, last).filter((x) => x.day === 'Sun').reduce((a, x) => a + durToMin(x.dur), 0), 0,
    'and the primary race day too',
  );
});

test('freshWeek builds the same week a one-week re-fit writes', () => {
  // One rule for "rebuild this week", whichever button asked for it. The
  // fixture adds its tune-up without re-fitting, so fit it first: freshWeek
  // reads the stored season, it does not re-decide it.
  const p = refit(twoRacePlan(), {});
  for (const w of [0, 11, weekCount(p) - 1]) {
    assert.deepEqual(freshWeek(p, w), refit(p, { from: w, to: w }).weeks[`w${w}`], `week ${w}`);
  }
});

/* ---- the untouched stand-in ---- */

const blank = () => newPlan({ name: 'My plan', startISO: '2026-10-05', now: 7 });

test('a fresh stand-in plan is untouched, through storage and back', () => {
  assert.equal(isUntouchedPlan(blank()), true);
  assert.equal(isUntouchedPlan(loadPlan(JSON.parse(JSON.stringify(blank())))), true);
});

test('moving around the calendar does not count as a touch', () => {
  assert.equal(isUntouchedPlan({ ...blank(), view: { week: 5, view: 'month' }, updatedAt: 99 }), true);
});

test('anything the athlete did makes a plan touched', () => {
  const b = blank();
  const first = b.weeks.w0.find((x) => durToMin(x.dur) > 0);
  const touches = {
    'a session marked done': { done: { [first.id]: true } },
    'a logged actual': { actuals: { [first.id]: { status: 'done', min: 40 } } },
    'a coach conversation': { chat: [{ role: 'user', text: 'hi' }] },
    'an event': { events: [{ id: 'e', name: 'Race', date: '2026-12-06', kind: 'race', raceType: '70.3', priority: 'primary' }] },
    'a running result': { benchmarks: [bm()] },
    'a synced activity': { activities: [syncedRun()] },
    'an FTP': { loadRefs: { ftpW: 250 } },
    'a pinned week': { weekBudgets: { w3: 4 } },
    'a new name': { name: 'Roth 2027' },
    'a profile change': { profile: { ...b.profile, availability: { ...b.profile.availability, Sat: 400 } } },
    'an edited session': { weeks: { ...b.weeks, w0: b.weeks.w0.map((x) => (x.id === first.id ? { ...x, dur: '0:10' } : x)) } },
    'a removed session': { weeks: { ...b.weeks, w2: b.weeks.w2.slice(1) } },
  };
  for (const [what, over] of Object.entries(touches)) {
    assert.equal(isUntouchedPlan({ ...b, ...over }), false, what);
  }
});

test('an empty-calendar plan is not mistaken for the stand-in', () => {
  assert.equal(isUntouchedPlan(newPlan({ name: 'My plan', startISO: '2026-10-05', mode: 'empty' })), false);
});

test('a missing or malformed plan is never untouched', () => {
  assert.equal(isUntouchedPlan(null), false);
  assert.equal(isUntouchedPlan({}), false);
});

/* ---- the athlete record is not plan content ---- */

test('loadPlan drops an athlete record put on a plan', () => {
  // Body measurements are health data and sync only under their own consent;
  // a plan syncs and exports under the ordinary one. So the field never
  // survives the door every stored, synced and imported plan comes through.
  const p = loadPlan({ ...blank(), athlete: { weightKg: 71.4, sex: 'male' } });
  assert.equal('athlete' in p, false);
  assert.deepEqual(loadPlan(p), p, 'still idempotent');
});

/* ---- One plan per athlete ---- */

const ev = (id, date, priority, kind = 'race') => ({
  id, name: id, date, kind, raceType: kind === 'race' ? '70.3' : null, priority, note: '',
});

test('upcomingEvents keeps today and later, in date order, and drops the past', () => {
  const events = [ev('late', '2027-06-01', 'primary'), ev('past', '2026-09-01', 'secondary'),
    ev('today', '2026-10-16', null, 'other'), ev('mid', '2027-03-01', 'secondary')];
  assert.deepEqual(upcomingEvents(events, '2026-10-16').map((e) => e.id), ['today', 'mid', 'late']);
});

test('carryOver brings the athlete\'s facts and the chosen future events, never the weeks or logs', () => {
  const base = newPlan({ name: 'Old', startISO: '2026-01-05', raceDate: '2026-06-07', raceType: '70.3', now: 5 });
  const p = {
    ...base,
    events: [ev('a', '2027-06-01', 'primary'), ev('b', '2027-03-01', 'secondary'), ev('gone', '2026-02-01', 'secondary')],
    done: { x: true }, actuals: { y: {} }, chat: [{ role: 'user' }], weekBudgets: { w1: 5 },
    benchmarks: [{ id: 'bm', distanceMeters: 10000, timeSeconds: 2700, date: '2026-05-01', source: 'manual', current: true }],
    loadRefs: { ftpW: 250 },
    activities: [], activitySync: undefined,
  };
  const c = carryOver(p, '2026-10-16', ['a', 'gone']);
  assert.deepEqual(c.events.map((e) => e.id), ['a'], 'only chosen ids, and only if still upcoming');
  assert.equal(c.events[0].id, 'a', 'ids are stable');
  assert.deepEqual(c.loadRefs, { ftpW: 250 });
  assert.equal(c.benchmarks.length, 1);
  for (const k of ['done', 'actuals', 'chat', 'weekBudgets', 'weeks', 'season', 'release']) assert.ok(!(k in c), k);
});
/* ---- A race short enough not to need a taper ------------------------------

   A tune-up of two hours or less (a 10 km, a half marathon) is a hard day in
   the build, not an event to arrive fresh for. It gets no taper week and no
   race week; the plan clears its own day, counts its load, and trains on. */

const tuneUpPlan = (raceType, tuneUp = '2027-01-26', extra = {}) => {      // a Tuesday, week 12
  const base = newPlan({ name: 'Season', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: 'ironman', now: 1 });
  return {
    ...base,
    events: [...base.events, { id: 'ev-t', name: 'Test', date: tuneUp, kind: 'race', raceType, priority: 'secondary', ...extra }],
  };
};

test('landingsDetail says, for each tune-up, whether it gets a taper', () => {
  assert.deepEqual(landingsDetail(tuneUpPlan('10k')), [{ absWeek: 12, taper: false }]);
  assert.deepEqual(landingsDetail(tuneUpPlan('half-marathon')), [{ absWeek: 12, taper: false }]);
  assert.deepEqual(landingsDetail(tuneUpPlan('70.3')), [{ absWeek: 12, taper: true }]);
  assert.deepEqual(landingsDetail(tuneUpPlan('olympic')), [{ absWeek: 12, taper: true }]);
  assert.deepEqual(landingsDetail({ start: '2026-11-02', events: [] }), []);
  assert.deepEqual(landingsDetail({}), []);
});

test('landingsOf still gives the weeks alone', () => {
  assert.deepEqual(landingsOf(tuneUpPlan('10k')), [12]);
});

test('the athlete\'s own expected time decides whether a race gets a taper', () => {
  assert.deepEqual(landingsDetail(tuneUpPlan('70.3', '2027-01-26', { expectedMinutes: 110 })), [{ absWeek: 12, taper: false }]);
  assert.deepEqual(landingsDetail(tuneUpPlan('10k', '2027-01-26', { expectedMinutes: 130 })), [{ absWeek: 12, taper: true }]);
});

test('raceClosure: which day a race closes and whether it closes what follows', () => {
  assert.deepEqual(raceClosure(tuneUpPlan('10k'), 12), { raceDay: 'Tue', raceOnly: true });
  assert.deepEqual(raceClosure(tuneUpPlan('70.3'), 12), { raceDay: 'Tue', raceOnly: false });
  assert.deepEqual(raceClosure(tuneUpPlan('10k'), 4), { raceDay: null, raceOnly: false });
  const p = tuneUpPlan('10k');
  assert.deepEqual(raceClosure(p, weekCount(p) - 1), { raceDay: 'Sun', raceOnly: false }, 'the main race always clears what follows');
});

test('two races in one week: the earlier day, and the week is cleared after it if either needs a taper', () => {
  const p = tuneUpPlan('10k');
  const both = { ...p, events: [...p.events, { id: 'ev-u', date: '2027-01-30', kind: 'race', raceType: '70.3', priority: 'secondary' }] };
  assert.deepEqual(raceClosure(both, 12), { raceDay: 'Tue', raceOnly: false });
  const two10k = { ...p, events: [...p.events, { id: 'ev-u', date: '2027-01-30', kind: 'race', raceType: '10k', priority: 'secondary' }] };
  assert.deepEqual(raceClosure(two10k, 12), { raceDay: 'Tue', raceOnly: true });
});

test('raceDayFor is unchanged: it still just names the day', () => {
  assert.equal(raceDayFor(tuneUpPlan('10k'), 12), 'Tue');
});

test('a 10 km tune-up changes no block of the season and clears only its own day', () => {
  const without = refit(newPlan({ name: 'Season', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: 'ironman', now: 1 }), {});
  const drafted = refit(tuneUpPlan('10k'), {});
  assert.deepEqual(drafted.season.map((w) => w.block), without.season.map((w) => w.block), 'no taper, no race week');
  assert.deepEqual(drafted.season.map((w) => w.hours), without.season.map((w) => w.hours));
  const week = drafted.weeks.w12;
  assert.equal(durToMin(week.find((s) => s.day === 'Tue').dur), 0, 'the race day is clear');
  for (const day of ['Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    assert.ok(durToMin(week.find((s) => s.day === day).dur) > 0, `${day} is still a training day`);
  }
});

test('a 70.3 tune-up still gets its taper and race week, and still clears the rest of its week', () => {
  const drafted = refit(tuneUpPlan('70.3'), {});
  assert.equal(drafted.season[12].block, 'Race');
  assert.equal(drafted.season[11].block, 'Taper');
  for (const day of ['Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    assert.equal(durToMin(drafted.weeks.w12.find((s) => s.day === day).dur), 0, day);
  }
});

test('freshWeek builds the same week a refit does for a short race', () => {
  const drafted = refit(tuneUpPlan('10k'), {});
  assert.deepEqual(freshWeek(drafted, 12), drafted.weeks.w12);
});

test('a short race in the last weeks is not refused for sitting in the main race\'s taper', () => {
  // Nothing is overwritten, so there is nothing to refuse; the day is still cleared.
  const p = tuneUpPlan('10k', '2027-03-09');                // week 18, Tuesday: inside the last three
  const d = diffPlans(refit(newPlan({ name: 'Season', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: 'ironman', now: 1 }), {}), refit(p, {}));
  assert.equal(d.issues.find((i) => i.code === 'race-in-primary-taper'), undefined);
  assert.equal(raceDayFor(p, 18), 'Tue');
});

test('a tapered race inside the main race\'s taper is still reported', () => {
  const p = tuneUpPlan('70.3', '2027-03-09');
  const base = newPlan({ name: 'Season', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: 'ironman', now: 1 });
  assert.ok(diffPlans(base, refit(p, {})).issues.find((i) => i.code === 'race-in-primary-taper'));
});
