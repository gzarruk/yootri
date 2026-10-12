import test from 'node:test';
import assert from 'node:assert/strict';

import {
  releaseState, isReleased, normalizeRelease, reviewWeek, proposeNextWeek, hardestSession,
} from '../assets/coach/review.js';
import { newPlan, loadPlan, applyDraft, refit, sessionsAt, weekCount } from '../assets/coach/plan.js';
import { setActual, getActual } from '../assets/coach/actuals.js';
import { dateOf } from '../assets/coach/calendar.js';
import { durToMin } from '../assets/coach/duration.js';

// Week 0 runs Mon 2026-10-05 to Sun 2026-10-11.
const START = '2026-10-05';
const weekly = (through = 0, over = {}) => ({
  ...newPlan({ name: 'Season', startISO: START, raceDate: '2027-03-28', raceType: '70.3', now: 1 }),
  release: { through },
  ...over,
});
const work = (plan, w) => sessionsAt(plan, w).filter((s) => durToMin(s.dur) > 0);
const synced = (id, date, disc, minutes) => ({
  id: `garmin:${id}`, source: 'garmin', date, time: '07:00', sport: disc.toLowerCase(), disc,
  name: disc, durationS: minutes * 60,
});

/* ---- the release horizon ---- */

test('a plan with no release field shows the whole season, as before', () => {
  const p = newPlan({ name: 'x', startISO: START, now: 1 });
  assert.equal(releaseState(p, { today: '2026-10-20' }).mode, 'all');
  assert.equal(isReleased(p, 12), true);
});

test('weeks after the release horizon are not released', () => {
  const p = weekly(1);
  assert.equal(isReleased(p, 0), true);
  assert.equal(isReleased(p, 1), true);
  assert.equal(isReleased(p, 2), false);
});

test('a release is due once the released week has ended', () => {
  assert.equal(releaseState(weekly(0), { today: '2026-10-08' }).due, false, 'still inside week 0');
  const s = releaseState(weekly(0), { today: '2026-10-12' });
  assert.equal(s.due, true);
  assert.equal(s.reviewWeek, 0);
  assert.equal(s.nextWeek, 1);
});

test('back after a gap, the next week released is this week, not the first missed one', () => {
  const s = releaseState(weekly(0), { today: '2026-10-28' });   // week 3
  assert.equal(s.reviewWeek, 0);
  assert.equal(s.nextWeek, 3);
});

test('nothing is due once race week is released', () => {
  const p = weekly(0);
  const last = weekCount(p) - 1;
  assert.equal(releaseState({ ...p, release: { through: last } }, { today: '2027-04-20' }).due, false);
});

test('a release horizon is a whole week inside the season, or absent', () => {
  assert.deepEqual(normalizeRelease({ through: 3 }, 26), { through: 3 });
  assert.deepEqual(normalizeRelease({ through: 40 }, 26), { through: 25 }, 'a shortened season pulls it in');
  for (const bad of [null, {}, { through: -1 }, { through: 1.5 }, { through: 'x' }]) {
    assert.equal(normalizeRelease(bad, 26), undefined, JSON.stringify(bad));
  }
});

test('loadPlan cleans the release horizon and keeps it idempotent', () => {
  const p = loadPlan({ ...weekly(0), release: { through: 999 } });
  assert.deepEqual(p.release, { through: weekCount(p) - 1 });
  assert.equal('release' in loadPlan({ ...weekly(0), release: { through: 'x' } }), false);
  assert.deepEqual(loadPlan(p), p);
});

test('applying a draft never takes the release horizon backwards', () => {
  // A coach draft taken before a week was released must not hide it again.
  const stored = weekly(3);
  const draft = { ...structuredClone(stored), release: { through: 1 } };
  assert.deepEqual(applyDraft(stored, draft).release, { through: 3 });
  assert.deepEqual(applyDraft(weekly(1), { ...structuredClone(weekly(1)), release: { through: 2 } }).release, { through: 2 });
});

/* ---- reviewing a week ---- */

test('the review says what happened to every session of the week', () => {
  let p = weekly(0);
  const [first, second, third] = work(p, 0);
  p = setActual(p, first.id, { status: 'done', min: 50 });
  const day = dateOf(START, 0, second.day);
  p = { ...p, activities: [synced('1', day, second.disc, durToMin(second.dur))] };
  const r = reviewWeek(p, 0, { today: '2026-10-12' });

  const row = (id) => r.rows.find((x) => x.id === id);
  assert.equal(row(first.id).status, 'done');
  assert.equal(row(first.id).source, 'logged');
  assert.equal(row(second.id).status, 'done');
  assert.equal(row(second.id).source, 'synced');
  assert.equal(row(third.id).status, 'missed');
  assert.equal(r.ended, true);
  assert.equal(r.rows.length, work(p, 0).length);
});

test('a day not yet reached is upcoming, not missed', () => {
  const r = reviewWeek(weekly(0), 0, { today: '2026-10-07' });   // Wednesday
  const statuses = new Set(r.rows.filter((x) => ['Thu', 'Fri', 'Sat', 'Sun'].includes(x.day)).map((x) => x.status));
  assert.deepEqual([...statuses], ['upcoming']);
  assert.equal(r.ended, false);
});

test('a synced activity with no session to match is listed as extra', () => {
  const p = { ...weekly(0), activities: [synced('9', '2026-10-05', 'Run', 45)] };   // Monday is a rest day
  const r = reviewWeek(p, 0, { today: '2026-10-12' });
  assert.equal(r.extra.length, 1);
  assert.equal(r.extra[0].activityId, 'garmin:9');
});

test('the review totals planned and done minutes', () => {
  let p = weekly(0);
  const [first] = work(p, 0);
  p = setActual(p, first.id, { status: 'partial', min: 30 });
  const r = reviewWeek(p, 0, { today: '2026-10-12' });
  assert.equal(r.plannedMinutes, work(p, 0).reduce((a, s) => a + durToMin(s.dur), 0));
  assert.equal(r.doneMinutes, 30);
  assert.equal(r.counts.partial, 1);
});

/* ---- proposing the next week ---- */

test('releasing logs what the review found and advances the horizon', () => {
  let p = weekly(0);
  const [first, second] = work(p, 0);
  const day = dateOf(START, 0, first.day);
  p = { ...p, activities: [synced('1', day, first.disc, durToMin(first.dur))] };
  const r = proposeNextWeek(p, { today: '2026-10-12' });
  assert.deepEqual(r.draft.release, { through: 1 });
  assert.equal(getActual(r.draft, first.id).activityId, 'garmin:1');
  assert.equal(getActual(r.draft, second.id).status, 'missed');
  assert.equal(r.nextWeek, 1);
});

test('the logs a release proposes are written when it is applied', () => {
  // applyDraft takes history from the stored plan, so a draft cannot rewrite
  // it; the review's logs travel as pendingActuals and are written at apply.
  let p = weekly(0);
  const [first, second] = work(p, 0);
  p = { ...p, activities: [synced('1', dateOf(START, 0, first.day), first.disc, durToMin(first.dur))] };
  const applied = applyDraft(p, proposeNextWeek(p, { today: '2026-10-12' }).draft);
  assert.equal(getActual(applied, first.id).activityId, 'garmin:1');
  assert.equal(applied.done[first.id], true);
  assert.equal(getActual(applied, second.id).status, 'missed');
  assert.equal('pendingActuals' in applied, false, 'the carrier field is never stored');
});

test('a log the athlete made after the review is not overwritten by it', () => {
  let p = weekly(0);
  const [, second] = work(p, 0);
  const draft = proposeNextWeek(p, { today: '2026-10-12' }).draft;
  p = setActual(p, second.id, { status: 'done', min: 40 });   // logged while the review was open
  assert.equal(getActual(applyDraft(p, draft), second.id).status, 'done');
});

test('releasing never changes a week before the one released', () => {
  const p = weekly(0);
  const r = proposeNextWeek(p, { today: '2026-10-12' });
  assert.deepEqual(sessionsAt(r.draft, 0), sessionsAt(p, 0));
});

test('with nothing to adjust, the next week is released as planned', () => {
  let p = weekly(0);
  for (const s of work(p, 0)) p = setActual(p, s.id, { status: 'done' });
  const r = proposeNextWeek(p, { today: '2026-10-12' });
  assert.equal(r.change, null);
  assert.deepEqual(sessionsAt(r.draft, 1), sessionsAt(p, 1));
});

test('two weeks well under plan bring the next week down to what was done', () => {
  // The existing under-compliance rule, read on the record the review just
  // completed — not a new opinion about how much to back off.
  let p = weekly(1);
  for (const w of [0, 1]) {
    for (const s of work(p, w)) p = setActual(p, s.id, { status: 'partial', min: Math.round(durToMin(s.dur) / 2) });
  }
  const r = proposeNextWeek(p, { today: '2026-10-19' });
  assert.equal(r.nextWeek, 2);
  assert.ok(r.change, 'a change was proposed');
  assert.ok(r.change.toHours < r.change.fromHours, `${r.change.fromHours} → ${r.change.toHours}`);
  assert.equal(r.draft.weekBudgets.w2, r.change.toHours);
  const minutes = sessionsAt(r.draft, 2).reduce((a, s) => a + durToMin(s.dur), 0);
  assert.ok(minutes <= r.change.toHours * 60 + 5, 'week 2 rebuilt to the new budget');
  assert.match(r.change.reason, /completed/);
});

/* ---- freezing the past in a refit ---- */

test('a refit with keepBefore leaves the weeks before it exactly as they were', () => {
  const p = weekly(0);
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 }, keepBefore: 3 });
  for (const w of [0, 1, 2]) {
    assert.deepEqual(sessionsAt(draft, w), sessionsAt(p, w), `week ${w} sessions`);
    assert.deepEqual(draft.season[w], p.season[w], `week ${w} season entry`);
  }
  assert.notDeepEqual(sessionsAt(draft, 5), sessionsAt(p, 5), 'later weeks are refitted');
});

/* ---- easing one session of the week released ---- */

// The first Build week of this plan: every ride, run and swim in it is Z3–Z4.
const BUILD = 14;
const buildMonday = dateOf(START, BUILD, 'Mon');
const beforeBuild = () => weekly(BUILD - 1);

test('the hardest session of a week is its highest zone, the earliest on a tie', () => {
  const h = hardestSession(beforeBuild(), BUILD, { today: buildMonday });
  const firstHard = sessionsAt(beforeBuild(), BUILD).find((s) => s.zone === 'Z3–Z4');
  assert.equal(h.id, firstHard.id);
  assert.equal(h.day, 'Tue');
});

test('an easy week has no hard session to ease', () => {
  assert.equal(hardestSession(weekly(0), 1, { today: '2026-10-12' }), null);
});

test('a session already logged, or on a day already gone, is never the one eased', () => {
  let p = beforeBuild();
  const first = hardestSession(p, BUILD, { today: buildMonday });
  p = setActual(p, first.id, { status: 'done' });
  assert.notEqual(hardestSession(p, BUILD, { today: buildMonday }).id, first.id);
  const wed = dateOf(START, BUILD, 'Wed');
  assert.ok(['Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(hardestSession(beforeBuild(), BUILD, { today: wed }).day));
});

test('easing changes that one session and leaves the rest of the week as it was', () => {
  const p = beforeBuild();
  const plain = proposeNextWeek(p, { today: buildMonday });
  const eased = proposeNextWeek(p, { today: buildMonday, ease: true });
  assert.equal(plain.eased, null, 'nothing is eased unless the athlete asks');

  const before = sessionsAt(plain.draft, BUILD);
  const after = sessionsAt(eased.draft, BUILD);
  assert.equal(after.length, before.length);
  const changed = after.filter((s, i) => JSON.stringify(s) !== JSON.stringify(before[i]));
  assert.equal(changed.length, 1);
  const [s] = changed;
  const was = before.find((x) => x.id === s.id);
  assert.equal(s.zone, 'Z2');
  assert.equal(s.dur, was.dur, 'the same length: the week keeps its hours');
  assert.equal(s.day, was.day);
  assert.deepEqual(eased.eased, {
    id: s.id, day: s.day, disc: s.disc, dur: s.dur,
    from: { focus: was.focus, zone: was.zone }, to: { focus: s.focus, zone: s.zone },
  });
  assert.equal(eased.draft.season[BUILD].hours, plain.draft.season[BUILD].hours);
});

test('the eased session is what the applied plan holds', () => {
  const p = beforeBuild();
  const r = proposeNextWeek(p, { today: buildMonday, ease: true });
  const applied = applyDraft(p, r.draft);
  assert.equal(sessionsAt(applied, BUILD).find((s) => s.id === r.eased.id).zone, 'Z2');
  assert.deepEqual(applied.release, { through: BUILD });
});

test('asking to ease a week with nothing hard in it changes nothing', () => {
  const p = weekly(0);
  const r = proposeNextWeek(p, { today: '2026-10-12', ease: true });
  assert.equal(r.eased, null);
  assert.deepEqual(sessionsAt(r.draft, 1), sessionsAt(proposeNextWeek(p, { today: '2026-10-12' }).draft, 1));
});
