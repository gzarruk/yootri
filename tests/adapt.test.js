import test from 'node:test';
import assert from 'node:assert/strict';

import { THRESHOLDS, suggest } from '../assets/coach/adapt.js';
import { loadPlan, sessionsAt } from '../assets/coach/plan.js';
import { setActual } from '../assets/coach/actuals.js';
import { TOOL_DEFS } from '../assets/coach/tools.js';
import { durToMin } from '../assets/coach/duration.js';

const base = () => loadPlan({
  id: 'p-1', name: 'T', start: '2026-01-05', weeks: {}, done: {}, view: { phase: 'Base', week: 0 },
});

const workouts = (plan, w) => sessionsAt(plan, w).filter((s) => durToMin(s.dur) > 0);

/** Log a whole week at `fraction` of its planned time, at a given RPE. */
function logWeek(plan, w, { fraction = 1, rpe = null, only = null } = {}) {
  let next = plan;
  for (const s of workouts(plan, w)) {
    if (only && s.disc !== only) {
      next = setActual(next, s.id, { status: 'done', rpe });
      continue;
    }
    const planned = durToMin(s.dur);
    next = setActual(next, s.id, {
      status: fraction >= 1 ? 'done' : (fraction === 0 ? 'missed' : 'partial'),
      min: fraction === 0 ? null : Math.round(planned * fraction),
      rpe,
    });
  }
  return next;
}

const codes = (list) => list.map((x) => x.code);

/** A plan whose weeks 1-3 hold identical training, so "flat volume" is a fact
    of the fixture rather than an assumption about what the generator produced. */
function flatWeeks(plan) {
  const next = JSON.parse(JSON.stringify(plan));
  const template = next.weeks.w1;
  for (const w of [1, 2, 3]) {
    next.weeks['w' + w] = template.map((s, i) => ({ ...s, id: `w${w}-${i}` }));
  }
  return next;
}

test('thresholds are exported so they can be tuned without reading the code', () => {
  assert.ok(THRESHOLDS.under > 0 && THRESHOLDS.under < 1);
  assert.ok(THRESHOLDS.over > 1);
});

test('an untouched plan produces no suggestions', () => {
  assert.deepEqual(suggest(base(), { week: 4 }), []);
});

test('a plan nobody has logged produces no suggestions', () => {
  // This is the false positive that matters. Zero compliance because the athlete
  // never opened the app is not evidence that their plan is too hard, and
  // telling them to cut back would be both wrong and insulting.
  const p = base();
  assert.deepEqual(suggest(p, { week: 6 }), [], 'silence is the correct output here');
});

test('one logged session is not enough to conclude anything', () => {
  const p = base();
  const s = workouts(p, 0)[0];
  const logged = setActual(p, s.id, { status: 'missed' });
  assert.deepEqual(suggest(logged, { week: 2 }), []);
});

/* Doing less than planned */

test('sustained under-compliance suggests cutting the next week back', () => {
  let p = base();
  p = logWeek(p, 0, { fraction: 0.5 });
  p = logWeek(p, 1, { fraction: 0.5 });
  const out = suggest(p, { week: 2 });
  const hit = out.find((x) => x.code === 'under-compliance');
  assert.ok(hit, `expected under-compliance, got ${codes(out)}`);
  assert.match(hit.message, /\d/, 'the message should carry the actual numbers');
  assert.ok(hit.evidence.ratio < THRESHOLDS.under);
});

test('the proposed cut is what was actually being done, not an arbitrary number', () => {
  let p = base();
  p = logWeek(p, 0, { fraction: 0.5 });
  p = logWeek(p, 1, { fraction: 0.5 });
  const hit = suggest(p, { week: 2 }).find((x) => x.code === 'under-compliance');
  const trailingActualHours = hit.evidence.actualMinutes / 2 / 60;
  assert.ok(Math.abs(hit.action.input.hours - trailingActualHours) < 0.3,
    `proposed ${hit.action.input.hours}h against a trailing average of ${trailingActualHours}h`);
  assert.equal(hit.action.input.week, 2);
});

test('keeping up with the plan produces no complaint', () => {
  let p = base();
  p = logWeek(p, 0, { fraction: 1 });
  p = logWeek(p, 1, { fraction: 1 });
  assert.ok(!codes(suggest(p, { week: 2 })).includes('under-compliance'));
});

/* Doing more than planned */

test('adding load needs more evidence than taking it away', () => {
  // Asymmetric on purpose: being wrong about backing off costs a little
  // fitness, being wrong about piling on costs an injury.
  let p = base();
  p = logWeek(p, 0, { fraction: 1.3, rpe: 4 });
  p = logWeek(p, 1, { fraction: 1.3, rpe: 4 });
  assert.ok(!codes(suggest(p, { week: 2 })).includes('over-compliance'),
    'two weeks should not be enough to add load');

  p = logWeek(p, 2, { fraction: 1.3, rpe: 4 });
  assert.ok(codes(suggest(p, { week: 3 })).includes('over-compliance'),
    'three weeks of comfortably beating the plan should be');
});

test('beating the plan while suffering does not suggest more', () => {
  let p = base();
  for (const w of [0, 1, 2]) p = logWeek(p, w, { fraction: 1.3, rpe: 9 });
  assert.ok(!codes(suggest(p, { week: 3 })).includes('over-compliance'));
});

test('an increase respects the ramp ceiling', () => {
  let p = base();
  for (const w of [0, 1, 2]) p = logWeek(p, w, { fraction: 1.4, rpe: 3 });
  const hit = suggest(p, { week: 3 }).find((x) => x.code === 'over-compliance');
  const planned = workouts(p, 3).reduce((a, s) => a + durToMin(s.dur), 0) / 60;
  assert.ok(hit.action.input.hours <= planned * 1.1 + 0.01,
    `${hit.action.input.hours}h exceeds a 10% ramp on ${planned}h`);
});

/* Effort creeping up at the same volume */

test('rising effort at flat volume suggests a recovery week', () => {
  let p = flatWeeks(base());
  p = logWeek(p, 1, { fraction: 1, rpe: 4 });
  p = logWeek(p, 2, { fraction: 1, rpe: 6 });
  p = logWeek(p, 3, { fraction: 1, rpe: 8 });
  const hit = suggest(p, { week: 4 }).find((x) => x.code === 'effort-creep');
  assert.ok(hit, `expected effort-creep, got ${codes(suggest(p, { week: 4 }))}`);
  assert.ok(hit.evidence.rpeRise >= THRESHOLDS.rpeRise);
});

test('rising effort while volume is also rising is not effort creep', () => {
  // Harder training feeling harder is not a warning sign; that is the plan.
  let p = base();
  p = logWeek(p, 1, { fraction: 1, rpe: 4 });
  p = logWeek(p, 2, { fraction: 1, rpe: 6 });
  p = logWeek(p, 3, { fraction: 1, rpe: 8 });
  assert.ok(!codes(suggest(p, { week: 4 })).includes('effort-creep'));
});

test('steady effort raises no alarm', () => {
  let p = flatWeeks(base());
  for (const w of [1, 2, 3]) p = logWeek(p, w, { fraction: 1, rpe: 6 });
  assert.ok(!codes(suggest(p, { week: 4 })).includes('effort-creep'));
});

test('effort creep is not reported without RPE to go on', () => {
  let p = flatWeeks(base());
  for (const w of [1, 2, 3]) p = logWeek(p, w, { fraction: 1 });
  assert.ok(!codes(suggest(p, { week: 4 })).includes('effort-creep'));
});

/* One discipline falling behind */

test('a single neglected discipline is called out on its own', () => {
  let p = base();
  for (const w of [0, 1]) p = logWeek(p, w, { fraction: 0, only: 'Swim' });
  const hit = suggest(p, { week: 2 }).find((x) => x.code === 'discipline-lagging');
  assert.ok(hit, `expected discipline-lagging, got ${codes(suggest(p, { week: 2 }))}`);
  assert.equal(hit.evidence.discipline, 'Swim');
  assert.match(hit.message, /Swim/);
});

test('a discipline that is merely a bit behind is left alone', () => {
  let p = base();
  for (const w of [0, 1]) p = logWeek(p, w, { fraction: 0.85, only: 'Swim' });
  assert.ok(!codes(suggest(p, { week: 2 })).includes('discipline-lagging'));
});

/* Shape of what comes back */

test('every suggestion carries the numbers that produced it', () => {
  let p = base();
  p = logWeek(p, 0, { fraction: 0.4 });
  p = logWeek(p, 1, { fraction: 0.4 });
  const out = suggest(p, { week: 2 });
  assert.ok(out.length > 0);
  for (const x of out) {
    assert.equal(typeof x.code, 'string');
    assert.ok(x.message.length > 10);
    assert.equal(typeof x.evidence, 'object');
    assert.ok(['info', 'warn'].includes(x.severity));
  }
});

test('any proposed action names a tool that actually exists', () => {
  let p = base();
  p = logWeek(p, 0, { fraction: 0.4 });
  p = logWeek(p, 1, { fraction: 0.4 });
  const names = new Set(TOOL_DEFS.map((t) => t.name));
  for (const x of suggest(p, { week: 2 })) {
    if (!x.action) continue;
    assert.ok(names.has(x.action.tool), `${x.code} proposes unknown tool ${x.action.tool}`);
  }
});

test('suggesting nothing mutates the plan', () => {
  let p = base();
  p = logWeek(p, 0, { fraction: 0.4 });
  const snap = JSON.parse(JSON.stringify(p));
  suggest(p, { week: 1 });
  assert.deepEqual(p, snap);
});

test('suggestions stop at the end of the season', () => {
  let p = base();
  p = logWeek(p, 0, { fraction: 0.4 });
  p = logWeek(p, 1, { fraction: 0.4 });
  assert.doesNotThrow(() => suggest(p, { week: 999 }));
});

test('when everything is behind, no single discipline is blamed', () => {
  // A discipline is only worth calling out if it is the outlier. If the whole
  // week is being missed, that is the under-compliance rule's job — naming
  // Swim as well would be three ways of saying the same thing.
  let p = base();
  for (const w of [0, 1]) p = logWeek(p, w, { fraction: 0.4 });
  const out = suggest(p, { week: 2 });
  assert.ok(codes(out).includes('under-compliance'), 'the general problem is reported');
  assert.ok(!codes(out).includes('discipline-lagging'), 'but not blamed on one discipline');
});
