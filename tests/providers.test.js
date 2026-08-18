import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDERS, getProvider, resolveModel, describeTransportError,
} from '../assets/coach/providers.js';
import { TOOL_DEFS } from '../assets/coach/tools.js';

const anthropic = getProvider('anthropic');
const openai = getProvider('openai-compatible');

const req = (p, over = {}) => p.buildRequest({
  apiKey: 'k',
  baseUrl: undefined,
  model: p.defaultModel,
  messages: [{ role: 'user', content: 'hi' }],
  tools: undefined,
  system: 'SYS',
  maxTokens: 4000,
  ...over,
});

/* Registry */

test('every provider declares what the settings panel needs to draw it', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.id && p.label, 'id and label');
    assert.ok(p.defaultBaseUrl.startsWith('https://'), `${p.id} base url`);
    assert.ok(p.models.length, `${p.id} has models`);
    assert.ok(p.models.every((m) => m.id && m.label && m.note), `${p.id} models carry a cost hint`);
    assert.ok(p.models.some((m) => m.id === p.defaultModel), `${p.id} default is in its own list`);
    assert.ok(p.keyPlaceholder, `${p.id} key placeholder`);
  }
});

test('each provider stores its key under its own name', () => {
  const keys = PROVIDERS.map((p) => p.keyStorageKey);
  assert.equal(new Set(keys).size, keys.length, 'storage keys collide');
  // Switching provider must not destroy the other key, and the Anthropic one
  // keeps the name it already had so existing users are not logged out.
  assert.equal(anthropic.keyStorageKey, 'yootri_anthropic_key');
});

test('an unknown provider id falls back rather than throwing', () => {
  assert.equal(getProvider('nope').id, 'anthropic');
  assert.equal(getProvider(undefined).id, 'anthropic');
});

test('resolveModel keeps a listed model, replaces an unlisted one', () => {
  assert.equal(resolveModel(anthropic, 'claude-opus-5'), 'claude-opus-5');
  assert.equal(resolveModel(anthropic, 'made-up'), anthropic.defaultModel);
  assert.equal(resolveModel(anthropic, ''), anthropic.defaultModel);
});

test('an openai-compatible endpoint may name a model this list cannot know', () => {
  // Ollama and LM Studio serve whatever has been pulled locally.
  assert.equal(resolveModel(openai, 'llama3.1:70b'), 'llama3.1:70b');
});

/* Request shape */

test('the anthropic request keeps every detail the browser path depends on', () => {
  const { url, headers, body } = req(anthropic);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], 'k');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(body.system, 'SYS');
  assert.equal(body.thinking, undefined);
});

test('effort goes only to the models that accept the parameter', () => {
  // The live API answers a 400 here, not a shrug, so this cannot be sent blind.
  for (const m of anthropic.models) {
    const { body } = req(anthropic, { model: m.id, effort: 'low' });
    assert.equal(body.output_config?.effort, m.supportsEffort ? 'low' : undefined, m.id);
  }
});

test('every anthropic model states whether it takes an effort parameter', () => {
  for (const m of anthropic.models) {
    assert.equal(typeof m.supportsEffort, 'boolean', `${m.id} must declare supportsEffort`);
  }
});

test('the openai request is a chat completion with a bearer token', () => {
  const { url, headers, body } = req(openai);
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers.authorization, 'Bearer k');
  assert.equal(headers['x-api-key'], undefined);
  // No system field on this API — it is the first message instead.
  assert.equal(body.system, undefined);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'SYS');
  assert.equal(body.messages[1].content, 'hi');
});

test('effort is an Anthropic idea and is not leaked into the openai body', () => {
  assert.equal(req(openai, { effort: 'high' }).body.output_config, undefined);
});

test('a custom base url is honoured and its trailing slashes do not double up', () => {
  assert.equal(req(openai, { baseUrl: 'http://localhost:11434/v1/' }).url,
    'http://localhost:11434/v1/chat/completions');
  assert.equal(req(openai, { baseUrl: 'https://openrouter.ai/api/v1' }).url,
    'https://openrouter.ai/api/v1/chat/completions');
});

test('tools are only sent when there are tools to send', () => {
  for (const p of [anthropic, openai]) {
    assert.equal(req(p).body.tools, undefined, p.id);
    assert.equal(req(p, { tools: p.translateTools(TOOL_DEFS) }).body.tools.length, TOOL_DEFS.length, p.id);
  }
});

/* Tool translation from the canonical defs */

test('anthropic uses the canonical tool defs unchanged', () => {
  assert.deepEqual(anthropic.translateTools(TOOL_DEFS), TOOL_DEFS);
});

test('openai tools are re-wrapped, keeping name, description and schema', () => {
  const out = openai.translateTools(TOOL_DEFS);
  assert.equal(out.length, TOOL_DEFS.length);
  for (const [i, t] of out.entries()) {
    assert.equal(t.type, 'function');
    assert.equal(t.function.name, TOOL_DEFS[i].name);
    assert.equal(t.function.description, TOOL_DEFS[i].description);
    // input_schema is already plain JSON Schema, so this is a re-wrap.
    assert.deepEqual(t.function.parameters, TOOL_DEFS[i].input_schema);
  }
});

test('the translated tools still describe every tool the engine can run', () => {
  const names = openai.translateTools(TOOL_DEFS).map((t) => t.function.name);
  assert.deepEqual(names, TOOL_DEFS.map((t) => t.name));
});

/* Response parsing into the normalised shape */

test('a plain text reply normalises to an end turn', () => {
  const a = anthropic.parseResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: ' hello ' }] });
  assert.equal(a.stopReason, 'end');
  assert.equal(a.text, 'hello');
  assert.deepEqual(a.toolCalls, []);

  const o = openai.parseResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ' hello ' } }] });
  assert.equal(o.stopReason, 'end');
  assert.equal(o.text, 'hello');
  assert.deepEqual(o.toolCalls, []);
});

test('a tool call normalises to the same shape on both providers', () => {
  const a = anthropic.parseResponse({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'get_week', input: { week: 3 } }],
  });
  assert.equal(a.stopReason, 'tool_use');
  assert.deepEqual(a.toolCalls, [{ id: 'tu_1', name: 'get_week', input: { week: 3 } }]);

  const o = openai.parseResponse({
    choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_week', arguments: '{"week":3}' } }],
    } }],
  });
  assert.equal(o.stopReason, 'tool_use');
  assert.equal(o.toolCalls[0].id, 'call_1');
  assert.equal(o.toolCalls[0].name, 'get_week');
  // OpenAI hands arguments over as a JSON string; it must arrive parsed.
  assert.deepEqual(o.toolCalls[0].input, { week: 3 });
});

test('a refusal is distinguished from an empty answer', () => {
  assert.equal(anthropic.parseResponse({ stop_reason: 'refusal', content: [] }).stopReason, 'refusal');
  assert.equal(openai.parseResponse({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', refusal: 'I cannot help with that.' } }],
  }).stopReason, 'refusal');
  assert.equal(openai.parseResponse({
    choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: '' } }],
  }).stopReason, 'refusal');
});

test('tool arguments that are not valid JSON become a tool error, not a crash', () => {
  const o = openai.parseResponse({
    choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_week', arguments: '{"week":' } }],
    } }],
  });
  assert.equal(o.stopReason, 'tool_use');
  assert.deepEqual(o.toolCalls[0].input, {});
  assert.match(o.toolCalls[0].argError, /JSON/i);
});

test('tool arguments that parse to a non-object are refused too', () => {
  const o = openai.parseResponse({
    choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_week', arguments: '"just a string"' } }],
    } }],
  });
  assert.match(o.toolCalls[0].argError, /object/i);
});

test('absent tool arguments are treated as an empty input', () => {
  const o = openai.parseResponse({
    choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_plan_summary', arguments: '' } }],
    } }],
  });
  assert.deepEqual(o.toolCalls[0].input, {});
  assert.equal(o.toolCalls[0].argError, null);
});

/* Malformed bodies — a 200 is not a promise of the right shape */

test('a body that is not a message is reported as malformed with a snippet', () => {
  for (const [p, junk] of [[anthropic, { hello: 'world' }], [openai, { hello: 'world' }]]) {
    const r = p.parseResponse(junk);
    assert.equal(r.malformed, true, p.id);
    assert.match(r.snippet, /hello/, p.id);
  }
});

test('an empty body is described as empty rather than as undefined', () => {
  for (const p of [anthropic, openai]) {
    assert.equal(p.parseResponse(null).snippet, 'an empty body', p.id);
    assert.equal(p.parseResponse(undefined).snippet, 'an empty body', p.id);
  }
});

test('an openai body with no choices is malformed rather than a blank reply', () => {
  assert.equal(openai.parseResponse({ choices: [] }).malformed, true);
  assert.equal(openai.parseResponse({ choices: [{ finish_reason: 'stop' }] }).malformed, true);
});

/* Error mapping */

test('http errors are explained in terms of what to do about them', () => {
  assert.match(anthropic.describeHttpError(401), /key/i);
  assert.match(anthropic.describeHttpError(429), /rate|wait/i);
  assert.match(anthropic.describeHttpError(529), /busy|again/i);
  assert.match(anthropic.describeHttpError(500), /server/i);

  assert.match(openai.describeHttpError(401), /key/i);
  assert.match(openai.describeHttpError(429), /rate|credit/i);
  assert.match(openai.describeHttpError(500), /server/i);
  // Only the editable-base-url provider can plausibly hit a wrong endpoint.
  assert.match(openai.describeHttpError(404), /base URL|model/i);
});

test("the provider's own error text is preserved, not replaced", () => {
  assert.match(
    anthropic.describeHttpError(400, { type: 'error', error: { message: 'max_tokens too large' } }),
    /max_tokens too large/);
  assert.match(
    openai.describeHttpError(400, { error: { message: 'unknown model foo' } }),
    /unknown model foo/);
});

test('apiErrorMessage pulls the message out of each provider error shape', () => {
  assert.equal(anthropic.apiErrorMessage({ type: 'error', error: { message: 'boom' } }), 'boom');
  assert.equal(anthropic.apiErrorMessage({ stop_reason: 'end_turn' }), null);
  assert.equal(openai.apiErrorMessage({ error: { message: 'boom' } }), 'boom');
  assert.equal(openai.apiErrorMessage({ error: 'boom' }), 'boom');
  assert.equal(openai.apiErrorMessage({ choices: [] }), null);
});

test('a request that never arrives explains the browser-origin case', () => {
  const msg = describeTransportError(openai, new TypeError('Failed to fetch'));
  assert.match(msg, /Failed to fetch/);
  assert.match(msg, /browser/i);
  // It must say what to do, not just what broke.
  assert.match(msg, /local endpoint|proxy/i);
});

/* Conversation round trip */

test('the assistant turn is echoed back in the form each api expects', () => {
  const aRaw = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] };
  assert.deepEqual(anthropic.formatAssistant(anthropic.parseResponse(aRaw)),
    [{ role: 'assistant', content: aRaw.content }]);

  const oRaw = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }] };
  assert.deepEqual(openai.formatAssistant(openai.parseResponse(oRaw)),
    [{ role: 'assistant', content: 'hi' }]);
});

test('tool results go back as one user turn on anthropic and one message each on openai', () => {
  const results = [
    { id: 'a', content: 'first', isError: false },
    { id: 'b', content: 'second', isError: true },
  ];

  const a = anthropic.formatToolResults(results);
  assert.equal(a.length, 1);
  assert.equal(a[0].role, 'user');
  assert.equal(a[0].content.length, 2);
  assert.equal(a[0].content[0].tool_use_id, 'a');
  assert.equal(a[0].content[0].is_error, undefined);
  assert.equal(a[0].content[1].is_error, true);

  const o = openai.formatToolResults(results);
  assert.equal(o.length, 2);
  assert.deepEqual(o[0], { role: 'tool', tool_call_id: 'a', content: 'first' });
  assert.equal(o[1].tool_call_id, 'b');
});

test('an assistant turn carrying tool calls keeps them for the follow-up', () => {
  const raw = { choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_week', arguments: '{}' } }],
  } }] };
  const [msg] = openai.formatAssistant(openai.parseResponse(raw));
  // Chat Completions rejects a tool result whose call is not in the history.
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.content, '');
});
