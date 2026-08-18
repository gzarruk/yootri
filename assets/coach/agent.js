/* Talking to Claude directly from the browser, with the athlete's own API key.

   This repo is public and served statically, so no key can ever be committed.
   The athlete pastes their own; it lives in localStorage and goes straight to
   api.anthropic.com. That requires the `anthropic-dangerous-direct-browser-access`
   header — the API rejects browser origins without it. The name is a fair
   warning: anything that can run script on this page can read the key. For a
   bring-your-own-key tool that is a trade the key's owner is making knowingly,
   but it is why the key is never written into a plan and never synced.

   The division of labour is deliberate and enforced by construction: the model
   chooses *what* to change by calling tools; the engine decides *what that
   means* in minutes. Nothing here lets a model emit a duration. */

import { TOOL_DEFS, callTool } from './tools.js';

export const MODEL = 'claude-opus-5';
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const KEY_STORAGE = 'yootri_anthropic_key';

const MAX_TOOL_STEPS = 12;

export const SYSTEM_PROMPT = `You are a triathlon coach embedded in the athlete's own training planner.

You do not write training sessions yourself. A deterministic engine owns every number — hours, session lengths, ramp rates, discipline splits. You decide *what should change* and call the tools; the engine works out what that means in minutes and days.

How to work:
- Read before you write. get_plan_summary orients you; get_week and get_profile answer specifics; get_compliance tells you how training has actually been going. Do not guess at numbers you can look up.
- Make the smallest change that addresses what was asked. A bad week is set_week_budget, not a whole-season refit. Changing the season is for a change in circumstances, not a change in mood.
- Watch the scope of what you are asked. "This week" and "from now on" are different requests. Constraints and availability are standing rules that reshape every week in the season; week budgets affect one week. If someone describes a one-off ("no pool this week", "away next weekend") and the only tool that fits is a standing rule, do not silently make it permanent — adjust what you can and tell them plainly what you could not do.
- Your changes are staged as a draft. The athlete reviews a diff and decides whether to apply it. Say plainly what you changed and why; do not claim it is done.
- If a tool reports an error, read it and correct the call rather than repeating it.

Coaching judgement:
- When the numbers disagree with the athlete's plan, say so once, plainly, and then do what they asked. It is their training.
- Distinguish a missed session from illness. Missing sessions is a scheduling problem; being ill is not, and they do not call for the same change.
- Be concise. This is a side panel, not an essay. Lead with what you did or found.`;

/** Build the HTTP request. Pure, so the shape can be tested without a network. */
export function buildRequest({ apiKey, messages, tools, system, effort = 'medium', maxTokens = 16000 }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    // Thinking is left at its default (adaptive). Disabling it on this model can
    // make a tool call arrive as visible text that silently never runs; effort is
    // the right lever for cost.
    output_config: { effort },
    system: system ?? SYSTEM_PROMPT,
    messages,
  };
  if (tools && tools.length) body.tools = tools;

  return {
    url: API_URL,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
  };
}

export function describeHttpError(status) {
  if (status === 401 || status === 403) return 'That API key was rejected. Check it in Coach settings.';
  if (status === 429) return 'Rate limited — too many requests. Wait a moment and try again.';
  if (status === 529) return 'Anthropic is busy right now. Try again shortly.';
  if (status >= 500) return `Anthropic server error (${status}). Try again shortly.`;
  if (status === 400) return 'That request was rejected as malformed. This is a bug in yootri, not in your key.';
  return `Request failed (${status}).`;
}

const textOf = (content) =>
  (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

/** Pull the API's own error text out of a body, if it put one there. */
const apiErrorMessage = (body) =>
  (body && typeof body === 'object' && body.type === 'error' && body.error?.message) || null;

async function post({ apiKey, messages, tools, system, effort, maxTokens, fetchImpl }) {
  const { url, headers, body } = buildRequest({ apiKey, messages, tools, system, effort, maxTokens });
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });

  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = null; // not JSON at all — a proxy page, or an empty body
  }

  if (!res.ok) {
    // The API explains itself far better than a status code does; lead with its
    // words and keep the generic advice as context.
    const detail = apiErrorMessage(parsed);
    const err = new Error(detail ? `${describeHttpError(res.status)} (${detail})` : describeHttpError(res.status));
    err.status = res.status;
    throw err;
  }

  // A 200 is not a promise that the body is a Message. Version skew, a captive
  // portal, or a proxy can all return something else, and reading .stop_reason
  // off it produced a bare "Cannot read properties of undefined" with nothing
  // to act on. Fail here instead, saying what actually came back.
  const detail = apiErrorMessage(parsed);
  if (detail) throw new Error(`The API returned an error: ${detail}`);

  if (!parsed || typeof parsed !== 'object' || typeof parsed.stop_reason !== 'string') {
    const snippet = parsed === undefined || parsed === null
      ? 'an empty body'
      : JSON.stringify(parsed).slice(0, 200);
    throw new Error(
      `Unexpected reply from the API (HTTP ${res.status}): ${snippet}. ` +
      'If this persists, hard-reload the page — a stale cached script can cause it.',
    );
  }

  return parsed;
}

/**
 * Run one conversational turn to completion, executing any tools the model
 * calls. Mutating tools write into `session.draft`; the stored plan is never
 * touched here.
 *
 * Never throws — a failure comes back as `{ error: true, text }` so the panel
 * can show it like any other message.
 */
export async function runTurn({ apiKey, session, messages, fetchImpl = fetch, onText, effort = 'medium' }) {
  const convo = messages.slice();

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    let res;
    try {
      res = await post({ apiKey, messages: convo, tools: TOOL_DEFS, effort, fetchImpl });
    } catch (e) {
      return { error: true, text: e.message, messages: convo };
    }

    // Classifiers can decline with a normal 200 and an empty body; reading
    // content without checking would render that as a blank reply.
    if (res.stop_reason === 'refusal') {
      return {
        refused: true,
        text: 'Claude declined to answer that one. Try rephrasing it.',
        messages: convo,
      };
    }

    convo.push({ role: 'assistant', content: res.content });

    const calls = (res.content ?? []).filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) {
      const text = textOf(res.content);
      if (onText) onText(text);
      return { text, messages: convo };
    }

    // All results for one assistant turn go back in a single user message.
    const results = calls.map((c) => {
      const r = callTool(session, c.name, c.input);
      return {
        type: 'tool_result',
        tool_use_id: c.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      };
    });
    convo.push({ role: 'user', content: results });
  }

  return {
    text: 'I stopped after too many steps without reaching an answer. Try asking for something smaller.',
    messages: convo,
  };
}

/**
 * Rewrite only the human-readable wording of a generated week.
 *
 * The model is handed the sessions and asked for replacement `focus` text keyed
 * by id. Everything else — day, discipline, duration, zone — is copied from the
 * engine's output, so a hallucinated duration or an invented session simply has
 * nowhere to land.
 */
export async function polishWeek({ apiKey, sessions, block, fetchImpl = fetch }) {
  const brief = sessions
    .filter((s) => s.dur && s.dur !== '—')
    .map((s) => ({ id: s.id, day: s.day, disc: s.disc, dur: s.dur, zone: s.zone }));
  if (!brief.length) return sessions;

  const system =
    'You write the one-line title for each training session in a week. ' +
    'Reply with JSON only: an object mapping each session id to its new title. ' +
    'No prose, no code fence, no other keys. Titles are short, specific and ' +
    'coach-like — say what the session is for, not what it is called.';

  let res;
  try {
    res = await post({
      apiKey,
      system,
      effort: 'low',
      maxTokens: 4000,
      messages: [{
        role: 'user',
        content: `Block: ${block}\nSessions:\n${JSON.stringify(brief, null, 1)}`,
      }],
      fetchImpl,
    });
  } catch {
    return sessions; // wording is a nicety; never fail a week over it
  }
  if (res.stop_reason === 'refusal') return sessions;

  let map;
  try {
    map = JSON.parse(textOf(res.content));
  } catch {
    return sessions;
  }
  if (!map || typeof map !== 'object') return sessions;

  // Copy forward from the engine's sessions, taking only the wording. An id the
  // model invented has nothing to attach to and is dropped.
  return sessions.map((s) =>
    (typeof map[s.id] === 'string' && map[s.id].trim())
      ? { ...s, focus: map[s.id].trim().slice(0, 120) }
      : s);
}
