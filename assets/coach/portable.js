/* Moving a plan in and out of the app as a file.

   A plan file is the *whole* record, not a template: profile, season, weeks and
   history together. That is deliberate. A season is only meaningful against the
   budget and the runway it was fitted to — hand back the weeks without the
   season and the chart plots them against somebody else's target curve, which
   is exactly the bug this module was written to end. So export writes
   everything, and import is its inverse.

   Two things do not travel:

   - **The conversation.** `chat` is local to the browser it happened in. A file
     gets mailed around and dropped in cloud drives, and nothing on the way back
     in has ever read it.
   - **The identity.** An imported plan always gets a fresh id, so importing your
     own export next to the original duplicates it rather than overwriting it.
     The cost is that carrying a plan to a second browser and *then* signing in
     leaves two records instead of merging them. Duplication is the failure worth
     having; silently replacing a season somebody is midway through is not.

   Reading is total: `readPlanFile` never throws. Every way a file can be wrong
   comes back as `{ ok: false, code, reason }`, and the reason is a sentence
   written to be shown to the athlete unedited — "not a valid plan file" tells
   somebody holding the wrong file nothing about which file is right. */

import { loadPlan, weekCount, weekTotals, pruneHistory, mintPlanId } from './plan.js';
import { parseISO } from './dates.js';

export const ENVELOPE_TYPE = 'im703-plan';
export const ENVELOPE_VERSION = 1;

const DEFAULT_ORIGIN = 'yootri.gzarruk.com';
const HELP = 'An import wants the .json file that "Export this plan" writes.';

/** The object written to a file. `plan` is the stored record minus the chat. */
export function exportEnvelope(plan, { from = DEFAULT_ORIGIN } = {}) {
  const { chat, ...shareable } = plan;
  return {
    _type: ENVELOPE_TYPE,
    version: ENVELOPE_VERSION,
    exportedFrom: from,
    plan: structuredClone(shareable),
  };
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code, reason) => ({ ok: false, code, reason });

/**
 * Parse the text of a plan file.
 * @returns {{ok: true, plan: object, upgraded: boolean} | {ok: false, code: string, reason: string}}
 */
export function readPlanFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('not-json', `That file isn't JSON. ${HELP}`);
  }

  if (!isObj(parsed)) return fail('not-an-object', `That file is valid JSON, but it isn't a plan. ${HELP}`);

  if (parsed._type !== undefined && parsed._type !== ENVELOPE_TYPE) {
    return fail('wrong-type', `That file says it was exported by "${parsed._type}", not by yootri.`);
  }

  // Accept both the envelope and a bare plan object: the plan is what matters,
  // and a file that has been unwrapped by hand is still the athlete's own plan.
  const src = isObj(parsed.plan) ? parsed.plan : parsed;

  if (!isObj(src.weeks)) return fail('no-weeks', `That plan has no weeks in it. ${HELP}`);
  if (!parseISO(src.start)) {
    return fail('bad-start',
      "That plan's start date is missing or unreadable, so there is no calendar to hang it on.");
  }

  // Which schema is this? Trust the stamp, but recognise a v3 record that lost
  // it — absolute week keys and a season are v3 by construction, and running the
  // legacy migration over one would reassign every session to the wrong week.
  const keys = Object.keys(src.weeks);
  const stamped = Number(src.schema) === 3;
  const current = stamped || (keys.some((k) => /^w\d+$/.test(k)) && Array.isArray(src.season));

  if (current && !(Array.isArray(src.season) && src.season.length)) {
    return fail('no-season',
      'That plan is missing its season — the block-by-block shape of the year — so its weeks have nothing to sit on.');
  }
  if (!current && keys.length && !keys.some((k) => /_\d+$/.test(k))) {
    return fail('unknown-weeks',
      "That plan's weeks are in a shape yootri does not recognise. It may have been edited by hand.");
  }

  let plan;
  try {
    plan = loadPlan(current && !stamped ? { ...src, schema: 3 } : src);
  } catch (e) {
    return fail('unreadable', `That plan could not be read: ${e.message}`);
  }

  // A truncated or hand-edited file can be short a week the season still lists.
  // Fill the hole rather than reject: an empty week renders, a missing one is a
  // crash halfway through a render.
  for (const w of plan.season) {
    const key = `w${w.absWeek}`;
    if (!Array.isArray(plan.weeks[key])) plan.weeks[key] = [];
  }

  return { ok: true, plan, upgraded: !current };
}

/**
 * Turn a plan that was just read out of a file into the record to store: its own
 * identity, no inherited conversation, and no history for sessions it does not
 * actually carry.
 */
export function adoptImported(plan, { now = Date.now(), id = mintPlanId(now), name } = {}) {
  const next = structuredClone(plan);
  next.id = id;
  next.name = String(name ?? plan.name ?? '').trim() || 'Imported plan';
  next.updatedAt = now;

  const history = pruneHistory(next.weeks, next);
  next.done = history.done;
  next.actuals = history.actuals;
  next.chat = [];

  return next;
}

/** The numbers worth showing before an import lands. */
export function summarizePlan(plan) {
  const profile = plan.profile ?? {};
  const blocks = [];
  for (const w of plan.season ?? []) if (blocks.at(-1) !== w.block) blocks.push(w.block);

  return {
    name: plan.name ?? '',
    start: plan.start ?? null,
    weeks: weekCount(plan),
    blocks,
    raceType: profile.raceType ?? null,
    raceDate: profile.raceDate ?? null,
    annualHours: profile.annualHours ?? null,
    plannedMinutes: weekTotals(plan).reduce((a, b) => a + b, 0),
    // `done` keeps false entries when a session is un-ticked, so count what is
    // actually marked rather than how many ids have ever been touched.
    doneCount: Object.values(plan.done ?? {}).filter(Boolean).length,
    actualCount: Object.keys(plan.actuals ?? {}).length,
  };
}
