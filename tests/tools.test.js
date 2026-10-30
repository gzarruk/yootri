import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFS, createSession, callTool, sessionDiff } from '../assets/coach/tools.js';
import { loadPlan, newPlan, sessionsAt, weekCount } from '../assets/coach/plan.js';
import { setActual } from '../assets/coach/actuals.js';
import { durToMin } from '../assets/coach/duration.js';
import { loadThresholds, trainingLoad } from '../assets/coach/load.js';
import { PLAN_MODEL } from '../assets/coach/targets.js';

const basePlan = () => loadPlan({
  id: 'p-1', name: 'T', start: '2026-01-05', weeks: {}, done: {}, view: { phase: 'Base', week: 0 },
});
const call = (s, name, input) => callTool(s, name, input ?? {});
const parse = (r) => JSON.parse(r.content);

test('every tool declares a name, a description and a schema', () => {
  assert.ok(TOOL_DEFS.length > 0);
  for (const t of TOOL_DEFS) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.input_schema.type, 'object');
  }
});

test('no tool lets the model set a fitness, an ATL or where a season starts: CTL and ATL are read, never given', () => {
  const walk = (schema, path, hits) => {
    for (const [k, v] of Object.entries(schema?.properties ?? {})) {
      if (/^(ctl|atl|fitness|fatigue|start|startctl|startfitness|startsource)$/i.test(k)) hits.push(`${path}.${k}`);
      walk(v, `${path}.${k}`, hits);
      if (v?.items) walk(v.items, `${path}.${k}[]`, hits);
    }
  };
  const hits = [];
  for (const t of TOOL_DEFS) walk(t.input_schema, t.name, hits);
  assert.deepEqual(hits, []);
});

test('tool names are unique', () => {
  const names = TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('no tool can emit a session duration directly', () => {
  // The engine owns every number. If a tool took a duration, the model could
  // write "9:99" into a plan and the whole engine-owns-the-maths split is gone.
  for (const t of TOOL_DEFS) {
    const props = Object.keys(t.input_schema.properties ?? {});
    for (const p of props) {
      assert.ok(!/^(dur|duration|minutes_for_session)$/i.test(p),
        `${t.name} exposes a raw duration parameter (${p})`);
    }
  }
});

/* Reading */

test('get_plan_summary describes the season without dumping every session', () => {
  const s = createSession(basePlan());
  const out = parse(call(s, 'get_plan_summary'));
  assert.equal(out.totalWeeks, 16);
  assert.equal('annualHours' in out, false, 'no annual figure is shown any more');
  assert.ok(Array.isArray(out.blocks) && out.blocks.length > 0);
  assert.ok(!JSON.stringify(out).includes('"zone"'), 'summary should stay compact');
});

test('get_week returns the sessions for one week', () => {
  const s = createSession(basePlan());
  const out = parse(call(s, 'get_week', { week: 2 }));
  assert.equal(out.week, 2);
  assert.ok(out.sessions.length > 0);
  assert.ok(out.sessions.every((x) => x.day && x.disc));
});

test('get_week clamps rather than failing on a week that does not exist', () => {
  const s = createSession(basePlan());
  // Sixteen weeks, so the last one is week 16 — the number on the board, not
  // the engine's absWeek 15.
  assert.equal(parse(call(s, 'get_week', { week: 999 })).week, 16);
});

test('get_profile reports availability and constraints', () => {
  const s = createSession(basePlan());
  const out = parse(call(s, 'get_profile'));
  assert.ok(out.availability.Sat >= 0);
  assert.ok(Array.isArray(out.constraints));
});

test('get_compliance reports what has actually been done', () => {
  let plan = basePlan();
  for (const x of sessionsAt(plan, 0).filter((v) => durToMin(v.dur) > 0)) {
    plan = setActual(plan, x.id, { status: 'done', rpe: 7 });
  }
  const s = createSession(plan);
  // Week 1 is where the actuals are; ask about the week after it.
  const out = parse(call(s, 'get_compliance', { upto_week: 2, weeks: 1 }));
  assert.equal(out.ratio, 1);
  assert.equal(out.meanRpe, 7);
});

/* Writing — always into a draft */

test('a write tool never touches the stored plan', () => {
  const plan = basePlan();
  const snapshot = JSON.parse(JSON.stringify(plan));
  const s = createSession(plan);
  call(s, 'set_availability', { day: 'Sat', minutes: 360 });
  assert.deepEqual(s.plan, snapshot, 'the stored plan must be untouched');
  assert.ok(s.draft, 'the change should land in a draft');
});

test('reads reflect pending changes, so the model can see its own work', () => {
  const s = createSession(basePlan());
  call(s, 'set_availability', { day: 'Sat', minutes: 360 });
  assert.equal(parse(call(s, 'get_profile')).availability.Sat, 360);
});

test('set_availability changes one day and refits around it', () => {
  const s = createSession(basePlan());
  call(s, 'set_availability', { day: 'Wed', minutes: 0 });
  const prof = parse(call(s, 'get_profile'));
  assert.equal(prof.availability.Wed, 0);
  const wk = parse(call(s, 'get_week', { week: 3 }));
  assert.ok(wk.sessions.filter((x) => x.day === 'Wed' && x.minutes > 0).length === 0,
    'nothing should be scheduled on a day with no time');
});

test('set_constraint keeps a discipline off the days it cannot happen', () => {
  const s = createSession(basePlan());
  call(s, 'set_constraint', { discipline: 'Swim', rule: 'avoidDays', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] });
  const wk = parse(call(s, 'get_week', { week: 4 }));
  assert.equal(wk.sessions.filter((x) => x.disc === 'Swim').length, 0);
});

test('set_week_budget changes one week without disturbing the others', () => {
  const s = createSession(basePlan());
  const before = parse(call(s, 'get_week', { week: 5 })).plannedMinutes;
  const other = parse(call(s, 'get_week', { week: 6 })).plannedMinutes;
  call(s, 'set_week_budget', { week: 5, hours: 4 });
  assert.equal(parse(call(s, 'get_week', { week: 5 })).plannedMinutes, 240);
  assert.notEqual(before, 240);
  assert.equal(parse(call(s, 'get_week', { week: 6 })).plannedMinutes, other, 'week 6 untouched');
});

test('set_split expresses a per-block preference', () => {
  const s = createSession(basePlan());
  call(s, 'set_split', { block: 'Base 3', weights: { Bike: 0.5, Run: 0.3, Strength: 0.2 } });
  const prof = parse(call(s, 'get_profile'));
  assert.deepEqual(prof.splits['Base 3'], { Bike: 0.5, Run: 0.3, Strength: 0.2 });
});

test('move_session moves a session to another day', () => {
  const s = createSession(basePlan());
  const wk = parse(call(s, 'get_week', { week: 1 }));
  const target = wk.sessions.find((x) => x.minutes > 0);
  call(s, 'move_session', { week: 1, session_id: target.id, day: 'Sun' });
  const after = parse(call(s, 'get_week', { week: 1 }));
  assert.equal(after.sessions.find((x) => x.id === target.id).day, 'Sun');
});

/* Failing safely */

test('an unknown tool reports an error rather than throwing', () => {
  const s = createSession(basePlan());
  const r = call(s, 'delete_everything', {});
  assert.equal(r.isError, true);
  assert.match(r.content, /unknown tool/i);
});

test('nonsense input is rejected with a message the model can act on', () => {
  const s = createSession(basePlan());
  const r = call(s, 'set_availability', { day: 'Blursday', minutes: 60 });
  assert.equal(r.isError, true);
  assert.match(r.content, /Blursday|day/i);
  assert.equal(s.draft, null, 'a rejected call must not leave a half-made draft');
});

test('a tool that would make an impossible week still only writes a draft', () => {
  const s = createSession(basePlan());
  call(s, 'set_availability', { day: 'Mon', minutes: 0 });

  // Look the session up in the draft, the way the model would via get_week —
  // refitting regenerates weeks, so an id read from the stored plan beforehand
  // may since have been reused by a different session.
  const wk = parse(call(s, 'get_week', { week: 0 }));
  const victim = wk.sessions.find((x) => x.minutes > 0);
  const moved = call(s, 'move_session', { week: 0, session_id: victim.id, day: 'Mon' });
  assert.equal(moved.isError, false, moved.content);

  const d = sessionDiff(s);
  assert.ok(d.issues.some((i) => i.level === 'error'), 'the validator should catch it');
  assert.equal(d.blocked, true, 'and the apply must be blocked');
});

test('sessionDiff on an untouched session reports nothing to apply', () => {
  const s = createSession(basePlan());
  const d = sessionDiff(s);
  assert.deepEqual(d.weeks, []);
  assert.equal(d.blocked, false);
});

test('tool results are strings, as the API requires', () => {
  const s = createSession(basePlan());
  for (const name of ['get_plan_summary', 'get_profile']) {
    assert.equal(typeof call(s, name).content, 'string');
  }
});

test('the constraint tool warns that it is season-wide', () => {
  // Testing prose, which is unusual — but this description is load-bearing.
  // Without it a model turns "no pool this week" into "no pool ever", which is
  // exactly what happened the first time this was wired up.
  const t = TOOL_DEFS.find((x) => x.name === 'set_constraint');
  assert.match(t.description, /standing/i);
  assert.match(t.description, /whole season|every week/i);
  assert.match(t.description, /one-off|single-week/i);
});

test('the coach can read deterministic adaptation suggestions', () => {
  let plan = basePlan();
  for (const w of [0, 1]) {
    for (const x of sessionsAt(plan, w).filter((v) => durToMin(v.dur) > 0)) {
      plan = setActual(plan, x.id, { status: 'partial', min: Math.round(durToMin(x.dur) * 0.4) });
    }
  }
  const out = parse(call(createSession(plan), 'get_adaptation_suggestions', { week: 3 }));
  assert.ok(Array.isArray(out) && out.length > 0);
  assert.ok(out.some((x) => x.code === 'under-compliance'));
  assert.ok(out[0].evidence, 'the model should see the numbers, not just a verdict');
});

test('with nothing to say, the adaptation tool says so plainly', () => {
  const r = call(createSession(basePlan()), 'get_adaptation_suggestions', { week: 3 });
  assert.equal(r.isError, false);
  assert.match(r.content, /no suggestions/i);
});

/* Week numbering.

   The engine counts absWeek from 0; the athlete and the board count from 1.
   The tools speak the athlete's language, because a model given a 0-based
   interface turned "cut week 3" into a change to the week labelled Week 4. */

test('a week asked for by number comes back as the same number', () => {
  const s = createSession(basePlan());
  for (const w of [1, 2, 8, 16]) {
    assert.equal(parse(call(s, 'get_week', { week: w })).week, w, `week ${w}`);
  }
});

test('week 1 is the first week of the season, not the second', () => {
  const s = createSession(basePlan());
  const first = parse(call(s, 'get_week', { week: 1 }));
  // sessionsAt speaks the engine's language, so absWeek 0 is the same week.
  const engineFirst = sessionsAt(basePlan(), 0).filter((x) => durToMin(x.dur) > 0);
  assert.deepEqual(first.sessions.map((x) => x.id), engineFirst.map((x) => x.id));
});

test('pinning a budget changes the week the athlete named', () => {
  const s = createSession(basePlan());
  const before = parse(call(s, 'get_week', { week: 4 })).plannedMinutes;
  call(s, 'set_week_budget', { week: 3, hours: 4 });
  assert.equal(parse(call(s, 'get_week', { week: 3 })).plannedMinutes, 240, 'week 3 is the one that changed');
  assert.equal(parse(call(s, 'get_week', { week: 4 })).plannedMinutes, before, 'week 4 untouched');
});

test('what a tool says it did names the week the athlete would recognise', () => {
  const s = createSession(basePlan());
  assert.match(call(s, 'set_week_budget', { week: 3, hours: 4 }).content, /week 3\b/i);
  assert.match(call(createSession(basePlan()), 'regenerate_weeks', { from: 2, to: 4 }).content, /weeks 2–4/i);
});

test('the season summary marks block starts in the athlete numbering', () => {
  const out = parse(call(createSession(basePlan()), 'get_plan_summary'));
  // The first block starts at week 1, never week 0.
  assert.equal(out.blocks[0].startWeek, 1);
  assert.ok(out.blocks.every((b) => b.startWeek >= 1 && b.startWeek <= out.totalWeeks));
});

test('a suggested tool call is handed back in the numbering the tools accept', () => {
  // adapt.js works in absWeek; a suggestion the model copies verbatim must not
  // arrive a week early.
  let plan = basePlan();
  for (let w = 0; w < 3; w++) {
    for (const x of sessionsAt(plan, w).filter((v) => durToMin(v.dur) > 0)) {
      plan = setActual(plan, x.id, { status: 'partial', min: Math.round(durToMin(x.dur) * 0.4) });
    }
  }
  const out = parse(call(createSession(plan), 'get_adaptation_suggestions', { week: 3 }));
  const withAction = out.filter((x) => x.action?.input && 'week' in x.action.input);
  assert.ok(withAction.length, 'expected at least one actionable suggestion');
  for (const x of withAction) {
    assert.equal(x.action.input.week, 3, 'the suggestion should target the week asked about');
  }
});

test('get_plan_summary reports the week the season is sized by', () => {
  const p = newPlan({
    name: 'Fits', startISO: '2026-01-05', now: 0,
    profile: { availability: { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 } },
  });
  const out = parse(call(createSession(p), 'get_plan_summary'));
  assert.equal(out.fit.weeklyCapacityMinutes, 690);
  assert.equal(Math.max(...out.weeklyPlannedMinutes), 690, 'the biggest week is the week they have');
  for (const gone of ['suggestedAnnualHours', 'variationRetained', 'clippedWeeks']) {
    assert.equal(gone in out.fit, false, gone);
  }
});

test('get_plan_summary says when the volume outstrips the race', () => {
  const big = { Mon: 600, Tue: 600, Wed: 600, Thu: 600, Fri: 600, Sat: 600, Sun: 600 };
  const out = parse(call(createSession(newPlan({
    name: 'Overkill', startISO: '2026-01-05', now: 0,
    profile: { raceType: 'sprint', availability: big },
  })), 'get_plan_summary'));
  assert.equal(Math.round(out.fit.raceDemandMultiple), 29);
});

test('a plan in proportion to its race reports no multiple to worry about', () => {
  const out = parse(call(createSession(newPlan({
    name: 'Sane', startISO: '2026-01-05', now: 0,
    profile: { raceType: '70.3' },
  })), 'get_plan_summary'));
  assert.equal(out.fit.raceDemandMultiple, null);
});

/* The week's shape */

test('get_profile reports the week shape so the coach need not infer it', () => {
  const s = createSession(basePlan());
  const prof = parse(call(s, 'get_profile'));
  assert.ok('weekShape' in prof, 'the coach cannot steer what it cannot read');
  assert.equal(prof.weekShape.enabled, true);
  assert.equal(prof.weekShape.spread, 'proportional');
});

test('set_week_shape sends displaced hours where the athlete asked', () => {
  const s = createSession(basePlan());
  call(s, 'set_week_shape', { spread: 'weekend' });
  assert.equal(parse(call(s, 'get_profile')).weekShape.spread, 'weekend');
});

test('set_week_shape pins a day to a fixed figure', () => {
  const s = createSession(basePlan());
  call(s, 'set_availability', { day: 'Wed', minutes: 180 });
  call(s, 'set_week_shape', { pins: { Wed: 45 } });
  const wk = parse(call(s, 'get_week', { week: 3 }));
  const wed = wk.sessions.filter((x) => x.day === 'Wed').reduce((a, x) => a + x.minutes, 0);
  assert.ok(wed <= 45, `Wednesday holds ${wed} minutes against a 45-minute pin`);
});

test('set_week_shape can hand the week back to plain availability', () => {
  const s = createSession(basePlan());
  call(s, 'set_week_shape', { enabled: false });
  assert.equal(parse(call(s, 'get_profile')).weekShape.enabled, false);
});

test('set_week_shape rejects a spread policy it does not understand', () => {
  const s = createSession(basePlan());
  const r = call(s, 'set_week_shape', { spread: 'whenever' });
  assert.equal(r.isError, true);
  assert.equal(s.draft, null, 'a rejected call must not leave a half-made draft');
});

test('set_week_shape rejects a pin on something that is not a weekday', () => {
  const s = createSession(basePlan());
  const r = call(s, 'set_week_shape', { pins: { Funday: 60 } });
  assert.equal(r.isError, true);
  assert.equal(s.draft, null);
});

/* ---- training paces ---------------------------------------------------

   A read-only tool, so it takes no draft and changes nothing. It exists so the
   coach quotes the same number the panel shows: asked "what pace on Thursday?",
   a model without this answers from its own head, and its head does not know
   the athlete's benchmark. */

const withBenchmark = () => ({
  ...basePlan(),
  benchmarks: [{
    id: 'bm-1', date: '2026-06-15', distanceMeters: 10000, timeSeconds: 2520,
    source: 'manual', label: 'Sentrum 10K', current: true,
  }],
});

test('the paces tool reports the benchmark, the VDOT and the bands', () => {
  const out = parse(call(createSession(withBenchmark()), 'get_training_paces'));

  assert.equal(out.benchmark.distanceMeters, 10000);
  assert.equal(out.benchmark.timeSeconds, 2520);
  assert.equal(out.benchmark.date, '2026-06-15');
  assert.ok(Math.abs(out.vdot - 49.1) < 0.1);

  assert.deepEqual(Object.keys(out.zones), ['easy', 'threshold', 'interval', 'repetition']);
  assert.equal(out.zones.threshold.perKm, '4:19 - 4:32');
  assert.equal(out.zones.easy.perMile, '8:00 - 9:35');
});

test('the paces tool says plainly that there is no benchmark yet', () => {
  // Not an error: "the athlete has not entered a result" is a real answer, and
  // an error result invites the model to retry a tool that will never work.
  const out = call(createSession(basePlan()), 'get_training_paces');
  assert.equal(out.isError, false);
  assert.match(out.content, /no .*result|has not/i);
});

test('reading the paces leaves no draft behind', () => {
  const s = createSession(withBenchmark());
  call(s, 'get_training_paces');
  assert.equal(sessionDiff(s).weeks.length, 0);
  assert.equal(s.draft, null, 'a read never starts a draft');
});

test('the paces tool description says where the number came from', () => {
  // Tool descriptions are load-bearing safety text here: a model that thinks
  // the app measured this will speak about it very differently from one that
  // knows the athlete typed in a race result.
  const def = TOOL_DEFS.find((t) => t.name === 'get_training_paces');
  assert.ok(def, 'the tool is declared');
  assert.match(def.description, /entered|typed|imported/i);
});

/* ---- Events ---------------------------------------------------------------

   The one place the model can change what the season is *for* rather than how
   it is trained, so the two rules that hold everywhere here matter most: a
   write lands in the draft, and a refusal leaves nothing behind. */

// 20 weeks from a Monday start, aimed at a Sunday IRONMAN.
const racePlan = () => newPlan({
  name: 'Season', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: 'ironman', now: 1,
});
const eventsIn = (s) => parse(call(s, 'get_events')).events;
const idOf = (s, name) => eventsIn(s).find((e) => e.name === name).id;
const tuneUp = (over = {}) => ({
  name: 'Lisbon', date: '2027-01-24', kind: 'race', race_type: '70.3', priority: 'secondary', ...over,
});

test('get_events says what is on the calendar and where it falls', () => {
  const s = createSession(racePlan());
  const out = parse(call(s, 'get_events'));
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].priority, 'primary');
  assert.equal(out.events[0].week, 20, 'weeks count from 1, as the athlete sees them');
  assert.equal(out.events[0].weekday, 'Sun');
  assert.equal(out.events[0].raceTypeName, 'IRONMAN', 'named the way the app names it');
});

test('adding a tune-up race lands a taper week and a race week', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp());
  assert.equal(r.isError, false);
  assert.match(r.content, /week 12/i);
  assert.match(r.content, /taper/i);
  assert.equal(s.draft.season[11].block, 'Race');
  assert.equal(s.draft.season[10].block, 'Taper');
  assert.equal(weekCount(s.draft), 20, 'a tune-up race does not lengthen the season');
});

test('an event write goes into the draft, never into the plan', () => {
  const s = createSession(racePlan());
  const before = JSON.stringify(s.plan);
  call(s, 'add_event', tuneUp());
  assert.equal(JSON.stringify(s.plan), before);
  assert.ok(s.draft);
});

test('get_events reads the draft, so the model sees its own change', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp());
  const out = parse(call(s, 'get_events'));
  assert.equal(out.events.length, 2);
  assert.deepEqual(out.tunedUpWeeks, [{ raceWeek: 12, taperWeek: 11 }]);
  assert.deepEqual(out.noTaperBuilt, []);
});

test('get_events says which races got no taper, and why', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp({ name: 'Late', date: '2027-03-07' }));
  const out = parse(call(s, 'get_events'));
  assert.deepEqual(out.tunedUpWeeks, []);
  assert.deepEqual(out.noTaperBuilt, [{ week: 18, reason: 'in-primary-taper' }]);
});

test('a race with no taper built is said plainly when it is added', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ date: '2027-03-07' }));
  assert.equal(r.isError, false, 'the race is real; it just gets no separate taper');
  assert.match(r.content, /no separate taper week/i);
});

test('a marathon cannot be made the race the season is built around', () => {
  // The guard on the whole two-list split, at the boundary the model reaches
  // it through: profile.raceType keys RACE_DEMAND and a marathon has no row.
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ race_type: 'marathon', priority: 'primary' }));
  assert.equal(r.isError, true);
  assert.match(r.content, /secondary/, 'the refusal says what to do instead');
  assert.equal(s.draft, null, 'a rejected call leaves no draft behind');
});

test('a marathon is perfectly fine as a tune-up race', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ name: 'Sevilla', race_type: 'marathon' }));
  assert.equal(r.isError, false);
  assert.equal(s.draft.season[11].block, 'Race');
});

test('a date before the plan starts is refused with the reason', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ date: '2026-09-01' }));
  assert.equal(r.isError, true);
  assert.match(r.content, /2026-11-02/, 'it says what the start date actually is');
  assert.equal(s.draft, null);
});

test('a date nothing can read is refused rather than dropped', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ date: 'next spring' }));
  assert.equal(r.isError, true);
  assert.match(r.content, /YYYY-MM-DD/);
  assert.equal(s.draft, null);
});

test('a distance nothing knows is refused rather than silently dropped', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ race_type: 'moon marathon' }));
  assert.equal(r.isError, true);
  assert.equal(s.draft, null);
});

test('only a race can be the race the season is built around', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', { name: 'Wedding', date: '2027-01-24', kind: 'other', priority: 'primary' });
  assert.equal(r.isError, true);
  assert.equal(s.draft, null);
});

test('moving the primary race re-lengths the season', () => {
  const s = createSession(racePlan());
  const r = call(s, 'move_event', { event_id: idOf(s, 'Race day'), date: '2027-04-18' });
  assert.equal(r.isError, false);
  assert.equal(weekCount(s.draft), 24);
  assert.match(r.content, /24 weeks/);
  assert.equal(s.draft.profile.raceDate, '2027-04-18', 'the profile follows the race, not the other way round');
});

test('a race far enough out is landed but said to be a long runway', () => {
  const s = createSession(racePlan());
  const r = call(s, 'move_event', { event_id: idOf(s, 'Race day'), date: '2027-08-15' });
  assert.equal(r.isError, false);
  assert.match(r.content, /long runway/i);
});

test('promoting a race stands the previous one down to secondary', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp());
  const r = call(s, 'set_event_priority', { event_id: idOf(s, 'Lisbon'), priority: 'primary' });
  assert.equal(r.isError, false);
  const after = eventsIn(s);
  assert.equal(after.find((e) => e.name === 'Lisbon').priority, 'primary');
  assert.equal(after.find((e) => e.name === 'Race day').priority, 'secondary',
    'the athlete is still doing that race');
  assert.match(r.content, /secondary/);
  assert.equal(weekCount(s.draft), 12, 'the season now ends on the new primary race');
});

test('standing a race down to a marker takes back the taper built for it', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp());
  assert.equal(s.draft.season[11].block, 'Race');
  call(s, 'set_event_priority', { event_id: idOf(s, 'Lisbon'), priority: 'none' });
  assert.notEqual(s.draft.season[11].block, 'Race');
  assert.notEqual(s.draft.season[10].block, 'Taper');
});

test('removing the race the season is built around says what that means', () => {
  const s = createSession(racePlan());
  const r = call(s, 'remove_event', { event_id: idOf(s, 'Race day') });
  assert.equal(r.isError, false);
  assert.match(r.content, /keeps its current length/i);
  assert.equal(weekCount(s.draft), 20, 'the weeks already built are already trained');
  assert.equal(s.draft.profile.raceDate, null);
});

test('an id nothing holds is refused and points at get_events', () => {
  const s = createSession(racePlan());
  for (const [name, input] of [
    ['move_event', { event_id: 'nope', date: '2027-01-24' }],
    ['set_event_priority', { event_id: 'nope', priority: 'secondary' }],
    ['remove_event', { event_id: 'nope' }],
  ]) {
    const r = call(s, name, input);
    assert.equal(r.isError, true, name);
    assert.match(r.content, /get_events/, name);
    assert.equal(s.draft, null, `${name} left a draft behind`);
  }
});

test('a refused event write leaves an earlier draft exactly as it was', () => {
  // The rule that makes a confused model harmless: a rejected call is a no-op,
  // not a partial write on top of work the athlete has not seen yet.
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp());
  const staged = JSON.stringify(s.draft);
  call(s, 'add_event', tuneUp({ name: 'Bad', date: 'whenever' }));
  assert.equal(JSON.stringify(s.draft), staged);
});

test('an event change is something the athlete gets to approve', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp());
  const d = sessionDiff(s);
  assert.ok(d.weeks.length > 0);
  assert.equal(d.blocked, false);
});

test('get_plan_summary shows the calendar alongside the blocks', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp());
  const out = parse(call(s, 'get_plan_summary'));
  assert.deepEqual(out.events.map((e) => e.name), ['Lisbon', 'Race day']);
  assert.ok(out.blocks.some((b) => b.block === 'Taper'), 'and says where the tune-up landed');
});

/* ---- recorded training (synced activities) ---- */

import { adviceCall } from '../assets/coach/tools.js';
import { suggest } from '../assets/coach/adapt.js';
import { dateOf } from '../assets/coach/calendar.js';

const historyPlan = () => {
  const p = newPlan({ name: 'H', startISO: '2026-09-28', raceDate: '2027-06-27', raceType: '70.3', now: 1 });
  const add = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
  const activities = [];
  let id = 0;
  for (const monday of ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']) {
    activities.push({ id: `garmin:${++id}`, source: 'garmin', date: add(monday, 1), disc: 'Bike', durationS: 5400,
      distanceM: 45000, avgPowerW: 180, name: 'Tuesday ride' });
    activities.push({ id: `garmin:${++id}`, source: 'garmin', date: add(monday, 3), disc: 'Run', durationS: 3000,
      distanceM: 10000, rpe: 6 });
  }
  return { ...p, activities, activitySync: { source: 'garmin', from: '2026-08-01', through: '2026-09-27', at: 1 } };
};
const HR = new Map([['garmin:1', { avg: 173, max: 187 }], ['garmin:2', { avg: 151, max: 169 }]]);
const noHr = (text) => {
  assert.equal(/heart|"hr"|avgHr|maxHr/i.test(text), false, 'no heart-rate key');
  for (const v of ['173', '187', '151', '169']) assert.equal(text.includes(v), false, `no ${v}`);
};

test('the session can carry today and the device-only heart rate without the plan holding either', () => {
  const s = createSession(historyPlan(), { today: '2026-09-28', hrById: HR });
  assert.equal(s.today, '2026-09-28');
  assert.equal(s.device.hrById, HR);
  assert.equal('hr' in s.plan, false);
  assert.deepEqual(createSession(basePlan()).draft, null, 'the one-argument form still works');
});

test('get_training_history reports the synced weeks and what they add up to', () => {
  const s = createSession(historyPlan(), { today: '2026-09-28', hrById: HR });
  const r = call(s, 'get_training_history', { weeks: 4 });
  assert.equal(r.isError, false);
  const h = parse(r);
  assert.deepEqual(h.coverage, { from: '2026-08-01', through: '2026-09-27' });
  assert.equal(h.weeks.length, 4);
  assert.equal(h.summary.coveredWeeks, 4);
  assert.equal(h.summary.avgHours, 2.3);
  assert.equal(h.weeks[3].minutes.Bike, 90);
  assert.equal(s.draft, null, 'a read leaves no draft');
  noHr(r.content);
});

test('get_training_history says plainly when nothing has been synced', () => {
  const r = call(createSession(basePlan(), { today: '2026-09-28' }), 'get_training_history', {});
  assert.equal(r.isError, false);
  assert.match(r.content, /nothing has been synced/i);
});

test('get_activities lists synced activities, newest first, without heart rate', () => {
  let p = historyPlan();
  p = setActual(p, sessionsAt(p, 0)[0].id, { status: 'done', min: 90, activityId: 'garmin:1' });
  const s = createSession(p, { today: '2026-09-28', hrById: HR });
  const r = call(s, 'get_activities', { from: '2026-09-01', limit: 3 });
  assert.equal(r.isError, false);
  const list = parse(r).activities;
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((a) => a.date), ['2026-09-24', '2026-09-22', '2026-09-17']);
  assert.equal(list[1].discipline, 'Bike');
  assert.equal(list[1].distanceKm, 45);
  assert.equal(list[1].minutes, 90);
  assert.equal(list[1].avgPowerW, 180);
  noHr(r.content);
  const all = parse(call(s, 'get_activities', { from: '2026-08-01', discipline: 'Bike', limit: 100 })).activities;
  assert.equal(all.length, 4);
  assert.equal(all.find((a) => a.id === 'garmin:1').loggedAs, sessionsAt(p, 0)[0].id);
});

test('get_activities refuses a discipline it does not know', () => {
  const r = call(createSession(historyPlan(), { today: '2026-09-28' }), 'get_activities', { discipline: 'Rowing' });
  assert.equal(r.isError, true);
});

test('activity names reach the model marked as the athlete’s own words', () => {
  const r = call(createSession(historyPlan(), { today: '2026-09-28' }), 'get_activities', { from: '2026-09-01' });
  assert.equal(parse(r).activities.find((a) => a.name).name, 'Tuesday ride');
  assert.match(TOOL_DEFS.find((t) => t.name === 'get_activities').description, /not instructions/i);
});

test('a suggestion from history reaches the model with the week the athlete sees', () => {
  const s = createSession(historyPlan(), { today: '2026-09-28' });
  const list = parse(call(s, 'get_adaptation_suggestions', { week: 1 }));
  const budget = list.find((x) => x.code === 'plan-outruns-history');
  assert.ok(budget);
  assert.equal(budget.action.input.week, 1);
});

test('an advice card applies its action to the week it describes', () => {
  // adapt.js speaks 0-based weeks; the tools count from 1. adviceCall is the
  // one translation, used by the page's Preview button as well as the tool.
  const p = historyPlan();
  const [s] = suggest(p, { week: 1 }).filter((x) => x.code === 'plan-outruns-history');
  assert.ok(s, 'fixture: week 2 outruns history');
  const session = createSession(p);
  const call_ = adviceCall(s.action);
  assert.equal(call_.input.week, 2);
  const r = callTool(session, call_.tool, call_.input);
  assert.equal(r.isError, false, r.content);
  assert.deepEqual(Object.keys(session.draft.weekBudgets), ['w1'], 'the second week, as the card said');
});

test('adviceCall leaves an action without a week alone', () => {
  const a = { tool: 'set_split', input: { block: 'Base 1', weights: { Bike: 1 } } };
  assert.deepEqual(adviceCall(a), a);
  assert.equal(adviceCall(null), null);
});

test('a benchmark offer is passed through to the model', () => {
  const p = { ...historyPlan() };
  p.activities = [...p.activities, { id: 'garmin:fast', source: 'garmin', date: '2026-09-20', disc: 'Run',
    durationS: 2400, distanceM: 10000 }];
  const list = parse(call(createSession(p, { today: '2026-09-28' }), 'get_adaptation_suggestions', { week: 1 }));
  const offer = list.find((x) => x.code === 'best-effort');
  assert.ok(offer);
  assert.equal(offer.offer.kind, 'benchmark');
});

/* ---- training load ---- */

const loadPlanFixture = () => ({
  ...historyPlan(),
  loadRefs: { ftpW: 250 },
  benchmarks: [{ id: 'b', date: '2026-09-01', distanceMeters: 10000, timeSeconds: 2400, source: 'manual', current: true }],
});

test('get_training_load reports the two averages and what the figures rest on', () => {
  const s = createSession(loadPlanFixture(), { today: '2026-09-28' });
  const r = call(s, 'get_training_load', { weeks: 4 });
  assert.equal(r.isError, false, r.content);
  const t = parse(r);
  assert.equal(t.weeks.length, 4);
  assert.ok(t.chronic > 0 && t.acute > 0);
  assert.deepEqual(Object.keys(t.byMethod).sort(), ['pace', 'power']);
  assert.match(t.labels.chronic, /chronic training load/);
  assert.equal(s.draft, null);
});

test('get_training_load starts both averages from the level the window opened at, as the card and the planner do', () => {
  // The window opens on the first week that has sessions in it, so the two starts differ.
  const p = { ...loadPlanFixture(), activitySync: { source: 'garmin', from: '2026-08-31', through: '2026-09-27', at: 1 } };
  const args = { today: '2026-09-28', weeks: 4, thresholds: loadThresholds({ benchmarks: p.benchmarks, loadRefs: p.loadRefs }), sync: p.activitySync };
  const t = parse(call(createSession(p, { today: '2026-09-28' }), 'get_training_load', { weeks: 4 }));
  const warm = trainingLoad(p.activities, { ...args, warmStartDays: PLAN_MODEL.garmin.warmStartDays });
  const cold = trainingLoad(p.activities, args);
  assert.notEqual(warm.chronic, cold.chronic, 'the fixture tells the two starts apart');
  assert.equal(t.chronic, warm.chronic);
  assert.equal(t.acute, warm.acute);
});

test('get_training_load says what would let more sessions be scored', () => {
  const s = createSession({ ...historyPlan(), benchmarks: [] }, { today: '2026-09-28' });
  const t = parse(call(s, 'get_training_load', {}));
  assert.ok(t.missing.ftp > 0 || t.missing['run-threshold'] > 0);
  assert.ok(Array.isArray(t.howToScoreMore) && t.howToScoreMore.length > 0);
});

test('heart rate can score a session, and still never reaches the model', () => {
  const p = loadPlanFixture();
  p.activities = [...p.activities, { id: 'garmin:yoga', source: 'garmin', date: '2026-09-23', disc: 'Other', durationS: 3600 }];
  const hrById = new Map([['garmin:yoga', { avg: 173, max: 187 }]]);
  const hrThresholds = { lthr: 170, max: 190, rest: 50, trimp: 'male' };
  const s = createSession(p, { today: '2026-09-28', hrById, hrThresholds });
  const r = call(s, 'get_training_load', { weeks: 2 });
  assert.equal(parse(r).byMethod['heart-rate'], 1);
  noHr(r.content.replace(/"heart-rate"/g, '"hr-method"'));
  const acts = call(s, 'get_activities', { from: '2026-09-20' });
  const yoga = parse(acts).activities.find((x) => x.id === 'garmin:yoga');
  assert.equal(yoga.load.method, 'heart-rate');
  assert.equal(typeof yoga.load.value, 'number');
  noHr(acts.content.replace(/"heart-rate"/g, '"hr-method"'));
});

test('get_activities carries each session’s load and how it was worked out', () => {
  const s = createSession(loadPlanFixture(), { today: '2026-09-28' });
  const ride = parse(call(s, 'get_activities', { from: '2026-09-20', discipline: 'Bike' })).activities[0];
  assert.deepEqual(Object.keys(ride.load).sort(), ['method', 'value']);
  assert.equal(ride.load.method, 'power');
});

test('the load tool says it describes training, not the athlete', () => {
  const d = TOOL_DEFS.find((t) => t.name === 'get_training_load').description;
  assert.match(d, /training, not the athlete/i);
});

/* ---- long days and sessions a day ---- */

test('the coach can read the long days and the sessions-a-day cap', () => {
  const prof = parse(call(createSession(basePlan()), 'get_profile'));
  assert.deepEqual(prof.longDays, { Bike: null, Run: null });
  assert.equal(prof.maxSessionsPerDay, null);
});

test('set_session_preferences names the long days and caps sessions a day', () => {
  const s = createSession(basePlan());
  const r = call(s, 'set_session_preferences', { long_ride_day: 'Sun', long_run_day: 'Sat', max_sessions_per_day: 1 });
  assert.notEqual(r.isError, true);
  const prof = parse(call(s, 'get_profile'));
  assert.deepEqual(prof.longDays, { Bike: 'Sun', Run: 'Sat' });
  assert.equal(prof.maxSessionsPerDay, 1);
  const wk = parse(call(s, 'get_week', { week: 3 }));
  const perDay = {};
  for (const x of wk.sessions) if (x.minutes > 0) perDay[x.day] = (perDay[x.day] ?? 0) + 1;
  assert.ok(Object.values(perDay).every((n) => n <= 1), 'one session a day');
});

test('set_session_preferences clears a setting and leaves the rest alone', () => {
  const s = createSession(basePlan());
  call(s, 'set_session_preferences', { long_ride_day: 'Sun', long_run_day: 'Sat', max_sessions_per_day: 2 });
  call(s, 'set_session_preferences', { long_ride_day: 'none' });
  let prof = parse(call(s, 'get_profile'));
  assert.deepEqual(prof.longDays, { Bike: null, Run: 'Sat' });
  assert.equal(prof.maxSessionsPerDay, 2);
  call(s, 'set_session_preferences', { max_sessions_per_day: 0, long_run_day: null });
  prof = parse(call(s, 'get_profile'));
  assert.equal(prof.maxSessionsPerDay, null);
  assert.equal(prof.longDays.Run, null);
});

test('set_session_preferences refuses what it cannot use, and leaves no draft', () => {
  for (const input of [{ long_ride_day: 'Funday' }, { max_sessions_per_day: 5 }, {}]) {
    const s = createSession(basePlan());
    const r = call(s, 'set_session_preferences', input);
    assert.equal(r.isError, true, JSON.stringify(input));
    assert.equal(s.draft, null);
  }
});

/* ---- the weekly pattern ---- */

const PATTERN_INPUT = {
  pattern: { Run: ['Tue', 'Thu', 'Sat'], Swim: ['Fri', 'Sat', 'Sun'], Strength: ['Wed', 'Tue'] },
  counts: { Base: { Run: 3, Swim: 1, Strength: 2 }, Build: { Run: 3, Swim: 2, Strength: 1 } },
};
const work = (wk) => wk.sessions.filter((x) => x.minutes > 0);

test('the coach can read the weekly pattern, and an unset one is null', () => {
  const prof = parse(call(createSession(basePlan()), 'get_profile'));
  assert.equal(prof.weekPattern, null);
  assert.equal(prof.sessionCounts, null);
  const s = createSession(basePlan());
  call(s, 'set_week_pattern', PATTERN_INPUT);
  const after = parse(call(s, 'get_profile'));
  assert.deepEqual(after.weekPattern, PATTERN_INPUT.pattern);
  assert.deepEqual(after.sessionCounts, PATTERN_INPUT.counts);
});

test('set_week_pattern drafts a season that follows the pattern, and the diff shows it', () => {
  const s = createSession(basePlan());
  const r = call(s, 'set_week_pattern', PATTERN_INPUT);
  assert.notEqual(r.isError, true);
  assert.ok(s.draft, 'a draft, not a change to the plan');
  const base = s.draft.season.findIndex((w) => w.block.startsWith('Base') && !w.recovery);
  const wk = parse(call(s, 'get_week', { week: base + 1 }));
  const days = (disc) => work(wk).filter((x) => x.disc === disc).map((x) => x.day).sort();
  assert.deepEqual(days('Run'), ['Sat', 'Thu', 'Tue']);
  assert.equal(days('Swim').length, 1);
  assert.equal(days('Strength').length, 2);
  assert.ok(sessionDiff(s).weeks.length > 0);
});

test('set_week_pattern changes only what it is given: a discipline, a block, a count', () => {
  const s = createSession(basePlan());
  call(s, 'set_week_pattern', PATTERN_INPUT);
  call(s, 'set_week_pattern', { pattern: { Swim: ['Mon', 'Fri'] }, counts: { Base: { Swim: 2 } } });
  const prof = parse(call(s, 'get_profile'));
  assert.deepEqual(prof.weekPattern.Run, ['Tue', 'Thu', 'Sat']);
  assert.deepEqual(prof.weekPattern.Swim, ['Mon', 'Fri']);
  assert.deepEqual(prof.sessionCounts.Base, { Run: 3, Swim: 2, Strength: 2 });
  assert.deepEqual(prof.sessionCounts.Build, { Run: 3, Swim: 2, Strength: 1 });
});

test('an empty list or a null count takes that entry away; clear takes the lot', () => {
  const s = createSession(basePlan());
  call(s, 'set_week_pattern', PATTERN_INPUT);
  call(s, 'set_week_pattern', { pattern: { Strength: [] }, counts: { Build: { Swim: null } } });
  const prof = parse(call(s, 'get_profile'));
  assert.equal(prof.weekPattern.Strength, undefined);
  assert.equal(prof.sessionCounts.Base.Strength, undefined, 'a count with no days to take goes with them');
  assert.equal(prof.sessionCounts.Build.Swim, undefined);
  call(s, 'set_week_pattern', { clear: true });
  const gone = parse(call(s, 'get_profile'));
  assert.equal(gone.weekPattern, null);
  assert.equal(gone.sessionCounts, null);
});

test('set_week_pattern refuses what it cannot use, and leaves no draft', () => {
  for (const bad of [
    {},
    { pattern: { Run: ['Funday'] } },
    { pattern: { Rowing: ['Mon'] } },
    { pattern: { Run: 'Mon' } },
    { counts: { Base: { Run: 2 } } },                        // no days for the run to take
    { pattern: { Run: ['Tue', 'Thu'] }, counts: { Base: { Run: 3 } } },   // more than the list
    { pattern: { Run: ['Tue'] }, counts: { Base: { Run: 1.5 } } },
    { pattern: { Run: ['Tue'] }, counts: { Prep: { Run: 1 } } },
    { pattern: { Run: ['Tue'] }, counts: { Base: { Walking: 1 } } },
  ]) {
    const s = createSession(basePlan());
    const r = call(s, 'set_week_pattern', bad);
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.equal(s.draft, null, JSON.stringify(bad));
  }
});

test('the pattern tool is described as a standing rule, and keeps trained weeks', () => {
  const def = TOOL_DEFS.find((t) => t.name === 'set_week_pattern');
  assert.match(def.description, /standing/i);
  const plan = basePlan();
  const today = dateOf(plan.start, 3, 'Wed');
  const s = createSession(plan, { today });
  call(s, 'set_week_pattern', PATTERN_INPUT);
  for (const w of [0, 1, 2]) assert.deepEqual(s.draft.weeks[`w${w}`], plan.weeks[`w${w}`], `week ${w + 1} untouched`);
});

/* ---- weeks already trained are kept ---- */

test('a coach change reshapes the weeks to come, not the weeks already trained', () => {
  const plan = basePlan();
  const today = dateOf(plan.start, 3, 'Wed');   // week 4 as the athlete counts
  for (const [tool, input] of [
    ['set_availability', { day: 'Sat', minutes: 120 }],
    ['set_session_preferences', { max_sessions_per_day: 1 }],
  ]) {
    const s = createSession(plan, { today });
    call(s, tool, input);
    assert.ok(s.draft, `${tool} made a draft`);
    for (const w of [0, 1, 2]) {
      assert.deepEqual(s.draft.weeks[`w${w}`], plan.weeks[`w${w}`], `${tool}: week ${w + 1} untouched`);
      assert.deepEqual(s.draft.season[w], plan.season[w], `${tool}: week ${w + 1} keeps its planned hours`);
    }
  }
});

test('without a date the coach still refits the whole season, as before', () => {
  const plan = basePlan();
  const s = createSession(plan);
  call(s, 'set_availability', { day: 'Sat', minutes: 360 });
  assert.notDeepEqual(s.draft.weeks.w0, plan.weeks.w0);
});

/* ---- weekly release ---- */

const weeklyPlan = () => ({ ...basePlan(), release: { through: 0 } });

test('get_week_review says what happened in the last released week', () => {
  const plan = weeklyPlan();
  const s = createSession(plan, { today: dateOf(plan.start, 1, 'Tue') });
  const r = parse(call(s, 'get_week_review'));
  assert.equal(r.week, 1, 'weeks are counted from 1 at this boundary');
  assert.ok(r.sessions.length > 0);
  assert.ok(r.sessions.every((x) => x.status === 'missed'), 'nothing logged, nothing synced');
  assert.equal(r.release.due, true);
  assert.equal(r.release.next_week, 2);
});

test('release_next_week drafts the next week and nothing is released until applied', () => {
  const plan = weeklyPlan();
  const s = createSession(plan, { today: dateOf(plan.start, 1, 'Tue') });
  const r = call(s, 'release_next_week');
  assert.notEqual(r.isError, true, r.content);
  assert.deepEqual(s.draft.release, { through: 1 });
  assert.deepEqual(s.plan.release, { through: 0 }, 'the stored plan is untouched');
  assert.deepEqual(s.draft.weeks.w0, plan.weeks.w0, 'the reviewed week keeps its sessions');
});

test('release_next_week refuses when nothing is due, or the plan is shown whole', () => {
  const plan = weeklyPlan();
  const early = createSession(plan, { today: dateOf(plan.start, 0, 'Wed') });
  assert.equal(call(early, 'release_next_week').isError, true);
  assert.equal(early.draft, null);
  const whole = createSession(basePlan(), { today: dateOf(plan.start, 1, 'Tue') });
  assert.equal(call(whole, 'release_next_week').isError, true);
  assert.equal(call(createSession(plan), 'release_next_week').isError, true, 'no date, no release');
});

test('release_next_week eases the hardest session only when asked', () => {
  const base = basePlan();
  const build = base.season.findIndex((w) => w.block.startsWith('Build'));
  assert.ok(build > 0, 'the fixture has a Build block');
  // The weeks before it were trained as planned, so the release keeps its hours.
  let plan = { ...base, release: { through: build - 1 } };
  for (const w of [build - 2, build - 1]) {
    for (const x of sessionsAt(plan, w)) if (durToMin(x.dur) > 0) plan = setActual(plan, x.id, { status: 'done' });
  }
  const today = dateOf(plan.start, build, 'Mon');

  const plain = createSession(plan, { today });
  call(plain, 'release_next_week');
  assert.ok(sessionsAt(plain.draft, build).some((x) => /Z[3-5]/.test(x.zone)), 'the week has hard sessions');

  const asked = createSession(plan, { today });
  const r = call(asked, 'release_next_week', { ease: true });
  assert.notEqual(r.isError, true, r.content);
  assert.match(r.content, /easy/);
  const changed = sessionsAt(asked.draft, build).filter((x, i) => JSON.stringify(x) !== JSON.stringify(sessionsAt(plain.draft, build)[i]));
  assert.equal(changed.length, 1);
  assert.equal(changed[0].zone, 'Z2');
  assert.match(sessionsAt(plain.draft, build).find((x) => x.id === changed[0].id).zone, /Z[3-5]/);
});

test('the release tool says nothing of sleep or overnight heart rate, which the coach never sees', () => {
  const def = TOOL_DEFS.find((t) => t.name === 'release_next_week');
  assert.ok(def.input_schema.properties.ease, 'ease is an input');
  assert.doesNotMatch(JSON.stringify(def), /sleep|HRV|overnight|heart/i);
});

/* ---- Short races, an expected time, and Olympic as the race a season is for ---- */

test('an Olympic can be the race a season is built around', () => {
  const s = createSession(racePlan());
  const ok = call(s, 'add_event', tuneUp({ name: 'Cascais Olympic', date: '2027-06-13', race_type: 'olympic', priority: 'primary' }));
  assert.equal(ok.isError, false);
  assert.equal(s.draft.profile.raceType, 'olympic');
});

test('the refusal for a distance a season cannot be built around lists the ones it can', () => {
  const s = createSession(racePlan());
  const bad = call(s, 'add_event', tuneUp({ race_type: 'half-marathon', priority: 'primary' }));
  assert.equal(bad.isError, true);
  assert.match(bad.content, /Olympic/);
  assert.match(bad.content, /70\.3/);
  assert.equal(s.draft, null);
});

test('a 10 km tune-up is put on the calendar without a taper week or a race week', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ name: 'Parkrun', race_type: '10k', date: '2027-01-26' }));
  assert.equal(r.isError, false);
  assert.match(r.content, /no taper/i, 'it says plainly that nothing was built');
  assert.match(r.content, /own day/i);
  assert.equal(s.draft.season[12].block, racePlan().season[12].block, 'the week keeps the block it was in');
  assert.notEqual(s.draft.season[11].block, 'Taper');
});

test('get_events says which races got a taper and which only clear their own day', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp({ name: 'Parkrun', race_type: '10k', date: '2027-01-26' }));
  call(s, 'add_event', tuneUp({ name: 'Lisbon', date: '2027-02-14' }));
  const out = parse(call(s, 'get_events'));
  assert.deepEqual(out.tunedUpWeeks.map((w) => w.raceWeek), [15], 'only the 70.3 has a race week built');
  assert.deepEqual(out.raceDayOnlyWeeks, [13], 'the 10 km clears its day in week 13');
  assert.deepEqual(out.noTaperBuilt, [], 'and nothing was turned down');
});

test('an event shows the time the athlete expects it to take', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp({ race_type: '70.3', expected_minutes: 110 }));
  const ev = parse(call(s, 'get_events')).events.find((e) => e.name === 'Lisbon');
  assert.equal(ev.expectedMinutes, 110);
  assert.equal(ev.getsTaper, false, 'a 70.3 the athlete expects to finish inside two hours is not tapered for');
  assert.equal(s.draft.season[11].block !== 'Taper', true);
});

test('a race with no time given shows the nominal one, and that it gets a taper', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp());
  const ev = parse(call(s, 'get_events')).events.find((e) => e.name === 'Lisbon');
  assert.equal(ev.expectedMinutes, undefined, 'nothing the athlete said');
  assert.equal(ev.getsTaper, true);
});

test('an expected time that is not a believable one is refused with what would work', () => {
  const s = createSession(racePlan());
  for (const bad of [5, 3000, -10, 'long']) {
    const r = call(s, 'add_event', tuneUp({ expected_minutes: bad }));
    assert.equal(r.isError, true, String(bad));
    assert.match(r.content, /20|minutes/);
    assert.equal(s.draft, null);
  }
});

test('an expected time on something that is not a race is refused', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', { name: 'Wedding', date: '2027-01-24', kind: 'other', priority: 'none', expected_minutes: 90 });
  assert.equal(r.isError, true);
});

test('regenerating a week with a short race in it keeps the days after the race', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp({ name: 'Parkrun', race_type: '10k', date: '2027-01-26' }));
  call(s, 'regenerate_weeks', { from: 13, to: 13 });
  const week = s.draft.weeks.w12;
  assert.equal(week.find((x) => x.day === 'Tue').disc, 'Rest');
  assert.ok(week.filter((x) => ['Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(x.day) && x.disc !== 'Rest').length > 0);
});

test('moving a tune-up keeps what the athlete told us about it', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp({ expected_minutes: 110 }));
  call(s, 'move_event', { event_id: idOf(s, 'Lisbon'), date: '2027-02-14' });
  const ev = parse(call(s, 'get_events')).events.find((e) => e.name === 'Lisbon');
  assert.equal(ev.expectedMinutes, 110);
});

/* ---- a sprint is not a race a season is built around any more ---- */

test('the coach cannot make a sprint the race a season is built around', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ name: 'Sprint', race_type: 'sprint', priority: 'primary' }));
  assert.equal(r.isError, true);
  assert.match(r.content, /Olympic/, 'it says what a season can be built around');
  assert.match(r.content, /secondary/, 'and what to do with the sprint instead');
  assert.equal(s.draft, null, 'a rejected call leaves no draft behind');
});

test('nor can it promote a sprint that is already on the calendar', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp({ name: 'Sprint', race_type: 'sprint' }));
  const r = call(s, 'set_event_priority', { event_id: idOf(s, 'Sprint'), priority: 'primary' });
  assert.equal(r.isError, true);
  assert.equal(s.draft.profile.raceType, 'ironman', 'the season is still built for the ironman');
});

test('a sprint is still fine as a B race', () => {
  const s = createSession(racePlan());
  const r = call(s, 'add_event', tuneUp({ name: 'Sprint', race_type: 'sprint' }));
  assert.equal(r.isError, false);
});

test('a season already built for a sprint goes on being edited', () => {
  // A plan is self-contained: the race it was built for keeps its distance.
  const old = newPlan({ name: 'Old', startISO: '2026-11-02', raceDate: '2027-01-24', raceType: 'sprint', now: 1 });
  const s = createSession(old);
  const moved = call(s, 'move_event', { event_id: idOf(s, 'Race day'), date: '2027-02-07' });
  assert.equal(moved.isError, false);
  assert.equal(s.draft.profile.raceType, 'sprint', 'and it is still sized as a sprint');
  const again = call(s, 'set_event_priority', { event_id: idOf(s, 'Race day'), priority: 'primary' });
  assert.equal(again.isError, false, 'saying it is the main race again changes nothing');
});

/* ---- a season built to a target ---- */

import { targetCtl as targetOf } from '../assets/coach/targets.js';

const TWELVE_H = { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 };
const targetSeason = (over = {}) => newPlan({
  name: 'Season', startISO: '2026-11-02', raceDate: '2027-03-21', raceType: '70.3', ambition: 'intermediate',
  startFitness: { ctl: 50, source: 'estimate', asOf: '2026-11-01' }, profile: { availability: TWELVE_H }, now: 1, ...over,
});

test('the plan summary says what the season was built to arrive with', () => {
  const s = createSession(targetSeason());
  const out = parse(call(s, 'get_plan_summary'));
  assert.equal(out.target.ctl, 75);
  assert.equal(out.target.start.source, 'estimate');
  assert.equal(out.target.feasibility.feasible, true);
  assert.equal(parse(call(createSession(racePlan()), 'get_plan_summary')).target, null, 'a plan sized the old way has none');
});

test('get_target explains the target, where it started from and whether it can be reached', () => {
  const s = createSession(targetSeason());
  const out = parse(call(s, 'get_target'));
  assert.equal(out.targetFitness, 75);
  assert.equal(out.ambition, 'intermediate');
  assert.equal(out.startedFrom.fitness, 50);
  assert.match(out.startedFrom.how, /estimate/i);
  assert.equal(out.reachable, true);
  assert.equal(out.levers, null);
  assert.match(out.about, /training load/i, 'it says what the number is');
  assert.equal(s.draft, null, 'a read never starts a draft');
});

test('get_target says the target is the peak before the taper, and where race day comes out', () => {
  const out = parse(call(createSession(targetSeason()), 'get_target'));
  assert.equal(out.targetIs, 'peak');
  assert.match(out.about, /peak/i);
  assert.match(out.about, /taper/i);
  assert.equal(typeof out.raceDayAbout, 'number');
  assert.ok(out.raceDayAbout < out.targetFitness - 5, `race day ${out.raceDayAbout} is below the peak ${out.targetFitness}`);
});

test('get_target on a plan whose target was made for race day says so, and gives no race-day figure of its own', () => {
  const old = structuredClone(targetSeason());
  delete old.target.at;
  delete old.target.feasibility.raceCtl;
  const out = parse(call(createSession(old), 'get_target'));
  assert.equal(out.targetIs, 'race day');
  assert.match(out.about, /race day/i);
  assert.equal('raceDayAbout' in out, false);
});

test('changing the ambition says the season is now built to a peak, not to arrive at a number on race day', () => {
  const s = createSession(targetSeason());
  const r = call(s, 'set_event_details', { event_id: idOf(s, 'Race day'), ambition: 'competitive' });
  assert.equal(r.isError, false, r.content);
  assert.match(r.content, /peak/i);
  assert.match(r.content, /90/);
  assert.doesNotMatch(r.content, /target fitness of 90/i);
});

test('get_target says plainly when the target cannot be reached, and what would help', () => {
  const tight = targetSeason({
    raceType: 'ironman', raceDate: '2027-03-21', ambition: 'competitive',
    profile: { availability: { Mon: 0, Tue: 60, Wed: 60, Thu: 60, Fri: 60, Sat: 120, Sun: 90 } },
  });
  const out = parse(call(createSession(tight), 'get_target'));
  assert.equal(out.reachable, false);
  assert.equal(out.limitedBy, 'availability');
  assert.ok(out.reachesAbout < out.targetFitness);
  assert.ok(out.shortfall > 0);
  assert.ok(out.levers.distance, 'a different goal is offered');
  assert.match(out.advice, /different|shorter|later|more/i);
});

test('get_target on a plan with no target says how it was sized', () => {
  const out = parse(call(createSession(racePlan()), 'get_target'));
  assert.equal(out.targetFitness, null);
  assert.match(out.about, /not built to a target|set it in Plan setup/i);
});

test('a week pinned on a plan with a target re-sizes the rest of the season around it', () => {
  const s = createSession(targetSeason());
  const r = call(s, 'set_week_budget', { week: 9, hours: 4 });
  assert.equal(r.isError, false);
  assert.equal(s.draft.season[8].hours, 4);
  assert.deepEqual(s.draft.season.map((w) => w.ctl).every(Number.isFinite), true, 'with its fitness kept up to date');
  assert.ok(s.draft.target.feasibility.feasible, 'one light week is made up');
  assert.notDeepEqual(s.draft.season.slice(9).map((w) => w.hours), s.plan.season.slice(9).map((w) => w.hours));
});

test('a pin that puts the target out of reach is said to', () => {
  const s = createSession(targetSeason());
  for (let w = 4; w <= 13; w++) call(s, 'set_week_budget', { week: w, hours: 3 });
  const r = call(s, 'set_week_budget', { week: 14, hours: 3 });
  assert.equal(s.draft.target.feasibility.feasible, false);
  assert.match(r.content, /out of reach|cannot be reached|not be reached/i);
  assert.match(r.content, /pinned weeks|pins/i, 'and what is in the way');
});

test('a week pinned on a plan with no target is pinned and rebuilt as it always was', () => {
  const s = createSession(racePlan());
  call(s, 'set_week_budget', { week: 9, hours: 4 });
  assert.equal(s.draft.season[8].hours, 4);
  assert.equal('target' in s.draft, false);
});

test('changing the hours on a plan with a target re-sizes it to the target, and says if it cannot be reached', () => {
  const s = createSession(targetSeason());
  const r = call(s, 'set_availability', { day: 'Sat', minutes: 30 });
  assert.equal(r.isError, false);
  assert.equal(s.draft.target.ctl, 75);
  assert.ok(s.draft.season.every((w) => Number.isFinite(w.ctl)));
  assert.match(r.content, /refitted/);
});

test('an event can be given an ambition, and an expected time, after the fact', () => {
  const s = createSession(targetSeason());
  const main = idOf(s, 'Race day');
  const r = call(s, 'set_event_details', { event_id: main, ambition: 'competitive' });
  assert.equal(r.isError, false);
  assert.equal(s.draft.target.ctl, targetOf('70.3', 'competitive'), 'the season is re-sized to the new target');
  assert.match(r.content, /competitive|90/i);
  call(s, 'add_event', tuneUp({ name: 'Lisbon' }));
  const r2 = call(s, 'set_event_details', { event_id: idOf(s, 'Lisbon'), expected_minutes: 110 });
  assert.equal(r2.isError, false);
  assert.equal(parse(call(s, 'get_events')).events.find((e) => e.name === 'Lisbon').getsTaper, false);
});

test('an ambition is only for the race the season is built around, and a made-up one is refused', () => {
  const s = createSession(targetSeason());
  call(s, 'add_event', tuneUp({ name: 'Lisbon' }));
  assert.equal(call(s, 'set_event_details', { event_id: idOf(s, 'Lisbon'), ambition: 'finish' }).isError, true);
  assert.equal(call(s, 'set_event_details', { event_id: idOf(s, 'Race day'), ambition: 'fast' }).isError, true);
  assert.equal(call(s, 'set_event_details', { event_id: idOf(s, 'Race day'), expected_minutes: 5 }).isError, true);
  assert.equal(call(s, 'set_event_details', { event_id: idOf(s, 'Race day') }).isError, true, 'nothing to change');
});

test('a new main race can be given its ambition when it is added', () => {
  const s = createSession(targetSeason());
  const r = call(s, 'add_event', { name: 'Cascais', date: '2027-04-18', kind: 'race', race_type: 'ironman', priority: 'primary', ambition: 'finish' });
  assert.equal(r.isError, false);
  assert.equal(s.draft.target.ctl, targetOf('ironman', 'finish'));
});

test('a plan with no target stays sized as it was when the coach changes a race, unless it can start from its own history', () => {
  const s = createSession(racePlan());
  call(s, 'add_event', tuneUp());
  assert.equal('target' in s.draft, false, 'with nothing to say where the athlete starts, it is left alone');
});

test('no tool puts anything derived from heart rate on a plan with a target', () => {
  const s = createSession(targetSeason());
  call(s, 'set_week_budget', { week: 5, hours: 6 });
  call(s, 'set_event_details', { event_id: idOf(s, 'Race day'), ambition: 'finish' });
  const text = JSON.stringify(s.draft);
  for (const re of [/avgHr/i, /maxHr/i, /heart/i, /hrById/i, /trimp/i]) assert.doesNotMatch(text, re);
});
