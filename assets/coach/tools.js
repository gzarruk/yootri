/* The typed surface the coach agent is allowed to touch.

   This is the safety boundary of the whole feature. The model never writes
   session data: it calls these tools, they call the engine, and the engine
   computes every number. The worst a confused or adversarial model can do is
   produce a draft that the validator rejects at the diff.

   Two rules hold for every tool here:

     1. Writes go into `session.draft`, never into `session.plan`.
     2. A rejected call leaves no draft behind — no half-applied state.

   Reads operate on the draft when one exists, so the model can see the
   consequences of its own pending changes before proposing them. */

import { loadPlan, blockAt, weekCount, sessionsAt, refit, diffPlans } from './plan.js';
import { normalizeProfile, DAYS, DISCIPLINES } from './profile.js';
import { generateWeek } from './generate.js';
import { trailingCompliance, weekCompliance } from './actuals.js';
import { suggest } from './adapt.js';
import { durToMin } from './duration.js';

const clone = (x) => structuredClone(x);
const weekKey = (w) => `w${w}`;
const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data), isError: false });
const fail = (msg) => ({ content: msg, isError: true });

/** A working session: the stored plan, plus whatever the model has proposed. */
export function createSession(plan) {
  return { plan, draft: null };
}

/** The plan a read should see: the draft if there is one, else the stored plan. */
const current = (s) => s.draft ?? s.plan;

/** Start (or continue) a draft. */
const draftOf = (s) => s.draft ?? clone(s.plan);

const clampWeek = (plan, w) => Math.max(0, Math.min(Number(w) || 0, weekCount(plan) - 1));

/** Regenerate a range of weeks from the draft's own profile and season. */
function rebuild(draft, from, to) {
  for (const w of draft.season) {
    if (w.absWeek < from || w.absWeek > to) continue;
    draft.weeks[weekKey(w.absWeek)] = generateWeek({
      hours: w.hours,
      block: w.block,
      profile: draft.profile,
      idPrefix: weekKey(w.absWeek),
    }).sessions;
  }
  return draft;
}

const summariseWeek = (plan, w) => {
  const info = blockAt(plan, w);
  const sessions = sessionsAt(plan, w);
  const c = weekCompliance(plan, w);
  return {
    week: w,
    block: info.block,
    recovery: info.recovery,
    plannedMinutes: c.plannedMinutes,
    actualMinutes: c.actualMinutes,
    sessions: sessions
      .filter((x) => durToMin(x.dur) > 0)
      .map((x) => ({ id: x.id, day: x.day, disc: x.disc, minutes: durToMin(x.dur), focus: x.focus })),
  };
};

export const TOOL_DEFS = [
  {
    name: 'get_plan_summary',
    description:
      'Overview of the whole season: number of weeks, the blocks and their lengths, planned hours per week, the athlete\'s annual hour budget and race details. Call this first to orient yourself before proposing anything.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_week',
    description:
      'The sessions in one week, with planned and actual minutes. Use it to check the effect of a change you just made, or to answer a question about a specific week.',
    input_schema: {
      type: 'object',
      properties: { week: { type: 'integer', description: 'Absolute week index, 0-based.' } },
      required: ['week'],
    },
  },
  {
    name: 'get_profile',
    description:
      'The athlete\'s constraints: how many minutes are available each weekday, discipline rules such as "no swimming on Mondays" or a weekly session cap, per-block discipline splits, annual hours and race distance.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_compliance',
    description:
      'How the recent past actually went: the ratio of completed to planned training over the preceding weeks, and mean RPE where it was recorded. Use this before suggesting the plan is too hard or too easy — say what the numbers show rather than guessing.',
    input_schema: {
      type: 'object',
      properties: {
        upto_week: { type: 'integer', description: 'Look at the weeks before this one.' },
        weeks: { type: 'integer', description: 'How many preceding weeks to average. Default 2.' },
      },
      required: ['upto_week'],
    },
  },
  {
    name: 'get_adaptation_suggestions',
    description:
      'Deterministic read of what the logged weeks suggest doing about a given week — falling behind, comfortably ahead, effort creeping up at the same volume, or one discipline being skipped. Each suggestion carries the numbers behind it. Prefer these to your own judgement about whether a plan is too hard: the thresholds here are consistent and testable, yours are not. An empty list means the evidence does not support saying anything, which is a real answer.',
    input_schema: {
      type: 'object',
      properties: { week: { type: 'integer', description: 'The week being planned, 0-based.' } },
      required: ['week'],
    },
  },
  {
    name: 'set_annual_hours',
    description:
      'Change the athlete\'s annual hour budget and refit the whole season to it. This is a scale, not a total the season sums to: a typical week is roughly annual hours divided by 52.',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'Annual training hours.' } },
      required: ['hours'],
    },
  },
  {
    name: 'set_availability',
    description:
      'Set how many minutes are available on one weekday, and refit the season around it. Zero makes it a rest day.',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: DAYS },
        minutes: { type: 'integer', description: 'Minutes available on that day.' },
      },
      required: ['day', 'minutes'],
    },
  },
  {
    name: 'set_week_budget',
    description:
      'Pin one specific week to a number of training hours and rebuild just that week. This is the right tool for a one-off — a busy week, travel, illness, a race. The pin sticks: later season-wide changes will not silently undo it.',
    input_schema: {
      type: 'object',
      properties: {
        week: { type: 'integer', description: 'Absolute week index, 0-based.' },
        hours: { type: 'number', description: 'Hours for that week.' },
      },
      required: ['week', 'hours'],
    },
  },
  {
    name: 'set_constraint',
    description:
      'Add a STANDING rule about when a discipline can happen: restrict it to certain days, keep it off certain days, or cap sessions per week. This applies to the whole season, every week, and refits all of them — use it only for something ongoing ("the pool is shut on Mondays", "never more than three swims a week"). For a one-off week, do NOT use this: use set_week_budget, and say in your reply that a single-week discipline change is not something you can make yet.',
    input_schema: {
      type: 'object',
      properties: {
        discipline: { type: 'string', enum: DISCIPLINES },
        rule: { type: 'string', enum: ['onlyDays', 'avoidDays', 'maxPerWeek'] },
        days: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'For onlyDays and avoidDays.' },
        count: { type: 'integer', description: 'For maxPerWeek.' },
      },
      required: ['discipline', 'rule'],
    },
  },
  {
    name: 'set_split',
    description:
      'Set how a block divides its time between disciplines — for example strength-led early season, or no swimming until Base 3. Weights are relative and are normalised; omit a discipline to leave it out of that block entirely.',
    input_schema: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'A block name such as "Base 3", or a family such as "Base".' },
        weights: {
          type: 'object',
          description: 'Discipline to relative weight, e.g. {"Bike": 0.5, "Run": 0.3, "Strength": 0.2}.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['block', 'weights'],
    },
  },
  {
    name: 'move_session',
    description:
      'Move one session to a different day of its week, keeping its duration and type. Use this for scheduling clashes rather than regenerating the week.',
    input_schema: {
      type: 'object',
      properties: {
        week: { type: 'integer' },
        session_id: { type: 'string' },
        day: { type: 'string', enum: DAYS },
      },
      required: ['week', 'session_id', 'day'],
    },
  },
  {
    name: 'regenerate_weeks',
    description:
      'Rebuild a range of weeks from the current profile and season, discarding manual edits in that range. Use it after changing constraints that should reshape existing weeks.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'integer', description: 'First week, 0-based.' },
        to: { type: 'integer', description: 'Last week, inclusive.' },
      },
      required: ['from', 'to'],
    },
  },
];

const HANDLERS = {
  get_plan_summary(s) {
    const p = current(s);
    const runs = [];
    for (const w of p.season) {
      const last = runs[runs.length - 1];
      if (last && last.block === w.block) last.weeks++;
      else runs.push({ block: w.block, weeks: 1, startWeek: w.absWeek });
    }
    return ok({
      totalWeeks: weekCount(p),
      annualHours: Math.round(p.profile.annualHours),
      raceType: p.profile.raceType,
      raceDate: p.profile.raceDate,
      startDate: p.start,
      blocks: runs,
      weeklyPlannedMinutes: p.season.map((w) => weekCompliance(p, w.absWeek).plannedMinutes),
    });
  },

  get_week(s, input) {
    const p = current(s);
    return ok(summariseWeek(p, clampWeek(p, input.week)));
  },

  get_profile(s) {
    const p = current(s);
    return ok({
      annualHours: Math.round(p.profile.annualHours),
      raceType: p.profile.raceType,
      raceDate: p.profile.raceDate,
      availability: p.profile.availability,
      constraints: p.profile.constraints,
      splits: p.profile.splits ?? null,
    });
  },

  get_compliance(s, input) {
    const p = current(s);
    const c = trailingCompliance(p, clampWeek(p, input.upto_week), Number(input.weeks) || 2);
    return ok({
      weeksConsidered: c.weeks,
      plannedMinutes: c.plannedMinutes,
      actualMinutes: c.actualMinutes,
      ratio: Number(c.ratio.toFixed(3)),
      meanRpe: c.meanRpe,
    });
  },

  get_adaptation_suggestions(s, input) {
    const p = current(s);
    const list = suggest(p, { week: clampWeek(p, input.week) });
    if (!list.length) {
      return ok('No suggestions: the logged weeks do not support saying anything yet.');
    }
    return ok(list.map((x) => ({
      code: x.code, severity: x.severity, message: x.message,
      evidence: x.evidence, action: x.action ?? null,
    })));
  },

  set_annual_hours(s, input) {
    const hours = Number(input.hours);
    if (!Number.isFinite(hours) || hours <= 0) return fail('hours must be a positive number.');
    const base = draftOf(s);
    s.draft = refit(base, { profile: { ...base.profile, annualHours: hours } });
    return ok(`Annual hours set to ${Math.round(hours)} and the season refitted.`);
  },

  set_availability(s, input) {
    if (!DAYS.includes(input.day)) {
      return fail(`"${input.day}" is not a weekday. Use one of: ${DAYS.join(', ')}.`);
    }
    const mins = Number(input.minutes);
    if (!Number.isFinite(mins) || mins < 0) return fail('minutes must be zero or more.');
    const base = draftOf(s);
    const availability = { ...base.profile.availability, [input.day]: Math.round(mins) };
    s.draft = refit(base, { profile: { ...base.profile, availability } });
    return ok(`${input.day} set to ${Math.round(mins)} minutes and the season refitted.`);
  },

  set_week_budget(s, input) {
    const base = draftOf(s);
    const week = clampWeek(base, input.week);
    const hours = Number(input.hours);
    if (!Number.isFinite(hours) || hours < 0) return fail('hours must be zero or more.');

    const draft = clone(base);
    // Pin it on the plan, not just on the resolved season, so a later refit in
    // the same turn does not quietly undo it.
    draft.weekBudgets = { ...(draft.weekBudgets ?? {}), [weekKey(week)]: hours };
    draft.season = draft.season.map((w) => (w.absWeek === week ? { ...w, hours } : w));
    rebuild(draft, week, week);
    s.draft = draft;
    return ok(`Week ${week} pinned to ${hours} hours and rebuilt. It will keep that budget through later changes.`);
  },

  set_constraint(s, input) {
    if (!DISCIPLINES.includes(input.discipline)) {
      return fail(`"${input.discipline}" is not a discipline. Use one of: ${DISCIPLINES.join(', ')}.`);
    }
    const rule = input.rule;
    let value;
    if (rule === 'maxPerWeek') {
      value = Number(input.count);
      if (!Number.isFinite(value) || value < 0) return fail('maxPerWeek needs a count of zero or more.');
    } else if (rule === 'onlyDays' || rule === 'avoidDays') {
      value = Array.isArray(input.days) ? input.days.filter((d) => DAYS.includes(d)) : [];
      if (!value.length) return fail(`${rule} needs at least one valid day.`);
    } else {
      return fail('rule must be onlyDays, avoidDays or maxPerWeek.');
    }

    const base = draftOf(s);
    const constraints = base.profile.constraints
      .filter((c) => !(c.disc === input.discipline && c.rule === rule))
      .concat([{ disc: input.discipline, rule, value }]);
    s.draft = refit(base, { profile: { ...base.profile, constraints } });
    return ok(`Constraint applied: ${input.discipline} ${rule}. Season refitted.`);
  },

  set_split(s, input) {
    if (!input.block || typeof input.weights !== 'object' || !input.weights) {
      return fail('set_split needs a block name and a weights object.');
    }
    const base = draftOf(s);
    const splits = { ...(base.profile.splits ?? {}), [input.block]: input.weights };
    const profile = normalizeProfile({ ...base.profile, splits });
    if (!profile.splits?.[input.block]) {
      return fail(`Those weights were not usable. Use discipline names (${DISCIPLINES.join(', ')}) with numbers above zero.`);
    }
    s.draft = refit(base, { profile });
    return ok(`Split set for ${input.block}. Season refitted.`);
  },

  move_session(s, input) {
    if (!DAYS.includes(input.day)) {
      return fail(`"${input.day}" is not a weekday. Use one of: ${DAYS.join(', ')}.`);
    }
    const base = draftOf(s);
    const week = clampWeek(base, input.week);
    const sessions = clone(base.weeks[weekKey(week)] ?? []);
    const hit = sessions.find((x) => x.id === input.session_id);
    if (!hit) return fail(`No session "${input.session_id}" in week ${week}. Call get_week first.`);

    hit.day = input.day;
    const draft = clone(base);
    draft.weeks[weekKey(week)] = sessions;
    s.draft = draft;
    return ok(`Moved ${hit.disc} to ${input.day} in week ${week}.`);
  },

  regenerate_weeks(s, input) {
    const base = draftOf(s);
    const from = clampWeek(base, input.from);
    const to = clampWeek(base, input.to);
    if (to < from) return fail('"to" must not be before "from".');
    s.draft = rebuild(clone(base), from, to);
    return ok(`Weeks ${from}–${to} rebuilt from the current profile.`);
  },
};

/**
 * Run one tool call. Never throws: a failure is reported back to the model as an
 * error result so it can correct itself, and leaves no partial draft behind.
 */
export function callTool(session, name, input = {}) {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool "${name}". Available: ${TOOL_DEFS.map((t) => t.name).join(', ')}.`);

  const before = session.draft;
  try {
    const result = handler(session, input ?? {});
    if (result.isError) session.draft = before; // a rejected call changes nothing
    return result;
  } catch (e) {
    session.draft = before;
    return fail(`${name} failed: ${e.message}`);
  }
}

/** What the athlete would be approving, if they applied the session now. */
export function sessionDiff(session) {
  if (!session.draft) return { weeks: [], issues: [], blocked: false, totalDeltaMinutes: 0 };
  return diffPlans(session.plan, session.draft);
}
