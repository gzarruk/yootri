import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRequest, describeHttpError, runTurn, polishWeek, getProvider,
} from '../assets/coach/agent.js';

const anthropic = getProvider('anthropic');
import { createSession } from '../assets/coach/tools.js';
import { loadPlan } from '../assets/coach/plan.js';

const plan = () => loadPlan({
  id: 'p-1', name: 'T', start: '2026-01-05', weeks: {}, done: {}, view: { phase: 'Base', week: 0 },
});

/* A fake transport: hand it the responses the API would give, in order. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('fake fetch ran out of responses');
    if (next.httpError) {
      return { ok: false, status: next.httpError, json: async () => next.body ?? {}, text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => next };
  };
  fn.calls = calls;
  return fn;
}

const say = (text, extra = {}) => ({
  stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra,
});

/* Request shape */

test('the request targets the documented browser-access endpoint', () => {
  const { url, headers } = buildRequest({ apiKey: 'sk-test', messages: [] });
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  // Without this header the API rejects browser origins outright.
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
});

test('the request defaults to the cheapest model that can drive the tool loop', () => {
  // Opus was the old default and produced bills nobody expected. The default is
  // now the cheapest model in the list; anything else is an explicit choice.
  const { body } = buildRequest({ apiKey: 'k', messages: [] });
  assert.equal(body.model, anthropic.defaultModel);
  assert.equal(body.model, anthropic.models[0].id);
  assert.equal(body.model, 'claude-haiku-4-5-20251001');
});

test('an unknown model falls back rather than being sent as-is', () => {
  const { body } = buildRequest({ apiKey: 'k', messages: [], model: 'no-such-model' });
  assert.equal(body.model, anthropic.defaultModel);
});

test('thinking is left at its default rather than disabled', () => {
  // On this model, disabling thinking can make a tool call arrive as plain text
  // that silently never runs. Cost is controlled with effort instead.
  const { body } = buildRequest({ apiKey: 'k', messages: [] });
  assert.equal(body.thinking, undefined);
  assert.ok(['low', 'medium', 'high'].includes(body.output_config.effort));
});

test('max_tokens leaves room for thinking as well as the answer', () => {
  // Lowered along with the default model: this is a side panel, not an essay,
  // and the ceiling is what an unattended tool loop can spend per step.
  const { body } = buildRequest({ apiKey: 'k', messages: [] });
  assert.ok(body.max_tokens >= 2000, `too tight at ${body.max_tokens}`);
});

test('tools are only sent when there are tools to send', () => {
  assert.equal(buildRequest({ apiKey: 'k', messages: [] }).body.tools, undefined);
  const withTools = buildRequest({ apiKey: 'k', messages: [], tools: [{ name: 'x' }] });
  assert.equal(withTools.body.tools.length, 1);
});

/* Errors the athlete will actually hit */

test('http errors are explained in terms of what to do about them', () => {
  assert.match(describeHttpError(401), /key/i);
  assert.match(describeHttpError(429), /rate|slow|wait/i);
  assert.match(describeHttpError(529), /busy|overload|again/i);
  assert.match(describeHttpError(500), /Anthropic|server/i);
});

test('a refusal is surfaced rather than read as an empty answer', async () => {
  const fetchImpl = fakeFetch([{ stop_reason: 'refusal', content: [], stop_details: { category: 'cyber' } }]);
  const out = await runTurn({
    apiKey: 'k', session: createSession(plan()), messages: [{ role: 'user', content: 'hi' }], fetchImpl,
  });
  assert.equal(out.refused, true);
  assert.match(out.text, /declin|refus/i);
});

test('an http failure comes back as a message, not an exception', async () => {
  const fetchImpl = fakeFetch([{ httpError: 401 }]);
  const out = await runTurn({
    apiKey: 'bad', session: createSession(plan()), messages: [{ role: 'user', content: 'hi' }], fetchImpl,
  });
  assert.equal(out.error, true);
  assert.match(out.text, /key/i);
});

/* The tool loop */

test('a tool call is executed and its result fed back', async () => {
  const fetchImpl = fakeFetch([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'tu_1', name: 'get_plan_summary', input: {} },
    ] },
    say('Your season is 16 weeks.'),
  ]);
  const session = createSession(plan());
  const out = await runTurn({
    apiKey: 'k', session, messages: [{ role: 'user', content: 'how long is my plan?' }], fetchImpl,
  });

  assert.equal(out.text, 'Your season is 16 weeks.');
  assert.equal(fetchImpl.calls.length, 2);
  const followUp = fetchImpl.calls[1].body.messages;
  const toolResult = followUp.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'tu_1');
  assert.ok(toolResult.content.includes('totalWeeks'));
});

test('a write tool leaves a draft the athlete can review', async () => {
  const fetchImpl = fakeFetch([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'tu_1', name: 'set_annual_hours', input: { hours: 700 } },
    ] },
    say('Done — I have refitted the season.'),
  ]);
  const session = createSession(plan());
  const snapshot = JSON.stringify(session.plan);
  await runTurn({ apiKey: 'k', session, messages: [{ role: 'user', content: 'more hours' }], fetchImpl });

  assert.ok(session.draft, 'the model should have produced a draft');
  assert.equal(JSON.stringify(session.plan), snapshot, 'and must not have touched the stored plan');
});

test('a failed tool call is reported back so the model can correct itself', async () => {
  const fetchImpl = fakeFetch([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'tu_1', name: 'set_availability', input: { day: 'Blursday', minutes: 60 } },
    ] },
    say('Sorry — which day did you mean?'),
  ]);
  const out = await runTurn({
    apiKey: 'k', session: createSession(plan()), messages: [{ role: 'user', content: 'x' }], fetchImpl,
  });
  const toolResult = fetchImpl.calls[1].body.messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /Blursday/);
  assert.equal(out.error, undefined, 'a tool error is not a turn error');
});

test('several tool calls in one turn all get results, in one user message', async () => {
  const fetchImpl = fakeFetch([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'a', name: 'get_profile', input: {} },
      { type: 'tool_use', id: 'b', name: 'get_plan_summary', input: {} },
    ] },
    say('ok'),
  ]);
  await runTurn({
    apiKey: 'k', session: createSession(plan()), messages: [{ role: 'user', content: 'x' }], fetchImpl,
  });
  const last = fetchImpl.calls[1].body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content.length, 2, 'both results belong in the same message');
  assert.deepEqual(last.content.map((c) => c.tool_use_id), ['a', 'b']);
});

test('the loop stops rather than spinning forever on a stuck model', async () => {
  const spin = Array.from({ length: 40 }, () => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'x', name: 'get_profile', input: {} }],
  }));
  const fetchImpl = fakeFetch(spin);
  const out = await runTurn({
    apiKey: 'k', session: createSession(plan()), messages: [{ role: 'user', content: 'x' }], fetchImpl,
  });
  assert.ok(fetchImpl.calls.length < 40, 'must give up before exhausting the script');
  assert.match(out.text, /too many steps|gave up|stopped/i);
});

/* Prose polish never touches the numbers */

test('polishWeek rewrites wording and leaves every duration alone', async () => {
  const sessions = [
    { id: 's1', day: 'Sat', disc: 'Bike', dur: '2:45', zone: 'Z2', focus: 'Long ride' },
    { id: 's2', day: 'Sun', disc: 'Run', dur: '1:10', zone: 'Z2', focus: 'Long run' },
  ];
  const fetchImpl = fakeFetch([say(JSON.stringify({
    s1: 'Long ride — keep it conversational, this is your only real aerobic block',
    s2: 'Long run off tired legs',
  }))]);

  const out = await polishWeek({ apiKey: 'k', sessions, block: 'Base 2', fetchImpl });
  assert.equal(out[0].focus, 'Long ride — keep it conversational, this is your only real aerobic block');
  assert.equal(out[0].dur, '2:45', 'durations are the engine\'s, not the model\'s');
  assert.equal(out[1].dur, '1:10');
  assert.equal(out[0].day, 'Sat');
});

test('polishWeek returns the sessions unchanged if the model returns nonsense', async () => {
  const fetchImpl = fakeFetch([say('I would rather write a poem.')]);
  const sessions = [{ id: 's1', day: 'Sat', disc: 'Bike', dur: '2:45', zone: 'Z2', focus: 'Long ride' }];
  assert.deepEqual(await polishWeek({ apiKey: 'k', sessions, block: 'Base 2', fetchImpl }), sessions);
});

test('polishWeek cannot introduce a session that was not there', async () => {
  const fetchImpl = fakeFetch([say(JSON.stringify({ s1: 'ok', ghost: 'surprise interval session' }))]);
  const sessions = [{ id: 's1', day: 'Sat', disc: 'Bike', dur: '2:45', zone: 'Z2', focus: 'Long ride' }];
  const out = await polishWeek({ apiKey: 'k', sessions, block: 'Base 2', fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].focus, 'ok');
});

/* When the response is not what we expect */

test('a 200 that is not a message object explains itself', async () => {
  // A proxy, a captive portal, or a version skew can return 200 with a body
  // that is not a Message. Reading .stop_reason off it produced a bare
  // "Cannot read properties of undefined" with nothing to act on.
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) });
  const out = await runTurn({
    apiKey: 'k', session: createSession(plan()), messages: [{ role: 'user', content: 'hi' }], fetchImpl,
  });
  assert.equal(out.error, true);
  assert.doesNotMatch(out.text, /Cannot read properties/);
  assert.match(out.text, /unexpected|hello/i, `unhelpful message: ${out.text}`);
});

test('a 200 with no body at all is reported, not crashed on', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => undefined });
  const out = await runTurn({
    apiKey: 'k', session: createSession(plan()), messages: [{ role: 'user', content: 'hi' }], fetchImpl,
  });
  assert.equal(out.error, true);
  assert.doesNotMatch(out.text, /Cannot read properties/);
});

test('an api error body is surfaced even when the status looks fine', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } }),
  });
  const out = await runTurn({
    apiKey: 'k', session: createSession(plan()), messages: [{ role: 'user', content: 'hi' }], fetchImpl,
  });
  assert.equal(out.error, true);
  assert.match(out.text, /max_tokens too large/);
});

test('an http error includes what the API actually said', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 400,
    json: async () => ({ type: 'error', error: { type: 'invalid_request_error', message: 'tools.0.name: invalid' } }),
  });
  const out = await runTurn({
    apiKey: 'k', session: createSession(plan()), messages: [{ role: 'user', content: 'hi' }], fetchImpl,
  });
  assert.match(out.text, /tools.0.name: invalid/, `lost the detail: ${out.text}`);
});

/* The same loop, driven through the other provider */

test('the tool loop runs end to end on an openai-compatible endpoint', async () => {
  const openai = getProvider('openai-compatible');
  const calls = [];
  const responses = [
    { choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_plan_summary', arguments: '{}' } }],
    } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Sixteen weeks.' } }] },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => responses.shift() };
  };

  const out = await runTurn({
    apiKey: 'k', provider: openai, session: createSession(plan()),
    messages: [{ role: 'user', content: 'how long?' }], fetchImpl,
  });

  assert.equal(out.text, 'Sixteen weeks.');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/chat\/completions$/);

  // The follow-up must carry the assistant's tool_calls and a matching tool
  // message, or Chat Completions rejects the request outright.
  const followUp = calls[1].body.messages;
  const assistant = followUp.find((m) => m.role === 'assistant');
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  const toolMsg = followUp.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.ok(toolMsg.content.includes('totalWeeks'));
});

test('unparseable tool arguments are reported back to the model, not thrown', async () => {
  const openai = getProvider('openai-compatible');
  const responses = [
    { choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_week', arguments: '{"week":' } }],
    } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Let me retry.' } }] },
  ];
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => responses.shift() };
  };

  const out = await runTurn({
    apiKey: 'k', provider: openai, session: createSession(plan()),
    messages: [{ role: 'user', content: 'week 3?' }], fetchImpl,
  });

  assert.equal(out.text, 'Let me retry.');
  const toolMsg = sent[1].messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.match(toolMsg.content, /failed/i);
});

test('a request that never leaves the browser is explained, not swallowed', async () => {
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  const out = await runTurn({
    apiKey: 'k', session: createSession(plan()),
    messages: [{ role: 'user', content: 'hi' }], fetchImpl,
  });
  assert.equal(out.error, true);
  assert.match(out.text, /could not reach/i);
});
