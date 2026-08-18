/* One shape for several chat APIs.

   The coach is "bring your own key", and which API that key belongs to is the
   athlete's business. This module is the only place that knows what a given
   provider's wire format looks like; `agent.js` drives the tool loop against
   the normalised shape below and contains no provider-specific branching.

   `TOOL_DEFS` in tools.js stays canonical and stays Anthropic-native. Each
   provider translates from it, so there is exactly one definition of what a
   tool is and no chance of two lists drifting apart.

   ---------------------------------------------------------------------------
   CORS, and what was actually observed

   The brief for this work said to verify browser CORS empirically rather than
   assume it. That verification could NOT be completed in the environment this
   code was written in, and saying so is more useful than a guess:

   - api.anthropic.com — reachable from the command line (an invalid key
     returned a normal HTTP 401), but every browser request from a served
     origin failed with net::ERR_CONNECTION_RESET before any response existed.
   - api.openai.com — refused at the egress proxy entirely
     (net::ERR_TUNNEL_CONNECTION_FAILED, and CONNECT 403 from curl).

   Both are transport failures, not CORS decisions: a CORS rejection completes
   the request and blocks the *response*, which is a different observation.
   The sandbox therefore could not answer the question either way.

   What is known independently: the Anthropic path here is the one this app has
   always used, and it works from a browser precisely because of the
   `anthropic-dangerous-direct-browser-access` header below — that header exists
   for this case, and the API rejects browser origins without it.

   The OpenAI-compatible path is unverified from a browser. It is shipped rather
   than omitted because the same adapter also serves OpenRouter, Groq, Together,
   LM Studio and Ollama, and a local endpoint has no CORS problem at all. If the
   request fails in a way that looks like an origin block, `describeHttpError`
   and the transport-error text say so specifically and say what to do about it.
   Anyone self-hosting should re-run the check from their own origin. */

/** Normalised stop reasons. Everything downstream speaks only these. */
const STOP = { end: 'end', tool_use: 'tool_use', refusal: 'refusal' };

/* ---- Anthropic ---- */

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic',

  defaultBaseUrl: 'https://api.anthropic.com/v1',
  allowBaseUrlOverride: false,

  keyStorageKey: 'yootri_anthropic_key',
  keyPlaceholder: 'sk-ant-…',
  keyHint: 'From console.anthropic.com → API keys.',

  defaultModel: 'claude-haiku-4-5-20251001',
  models: [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', note: 'Cheapest. The default, and enough for this.' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Mid-priced. Better at awkward multi-step asks.' },
    { id: 'claude-opus-5', label: 'Opus 5', note: 'Most expensive by a wide margin.' },
  ],

  translateTools: (toolDefs) => toolDefs,

  buildRequest({ apiKey, baseUrl, model, messages, tools, system, maxTokens, effort = 'medium' }) {
    const body = {
      model,
      max_tokens: maxTokens,
      // Thinking is left at its default (adaptive). Disabling it on these models
      // can make a tool call arrive as visible text that silently never runs;
      // effort is the right lever for cost. This is an Anthropic-only concept,
      // which is why it is absorbed here rather than passed through agent.js.
      output_config: { effort },
      system,
      messages,
    };
    if (tools && tools.length) body.tools = tools;

    return {
      url: (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '') + '/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // The API rejects browser origins without this. The name is a fair
        // warning: anything that can run script on this page can read the key.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
    };
  },

  /** Pull the API's own error text out of a body, if it put one there. */
  apiErrorMessage: (body) =>
    (body && typeof body === 'object' && body.type === 'error' && body.error?.message) || null,

  parseResponse(json) {
    // A 200 is not a promise that the body is a Message. Version skew, a captive
    // portal, or a proxy can all return something else, and reading .stop_reason
    // off it produced a bare "Cannot read properties of undefined" with nothing
    // to act on. Report it as malformed instead, saying what actually came back.
    if (!json || typeof json !== 'object' || typeof json.stop_reason !== 'string') {
      return { malformed: true, snippet: snippetOf(json), raw: json };
    }
    const content = json.content ?? [];
    const toolCalls = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));

    let stopReason = STOP.end;
    if (json.stop_reason === 'refusal') stopReason = STOP.refusal;
    else if (json.stop_reason === 'tool_use' && toolCalls.length) stopReason = STOP.tool_use;

    return {
      stopReason,
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
      toolCalls,
      raw: json,
    };
  },

  /** The assistant turn, in the form this API wants it echoed back. */
  formatAssistant: (parsed) => [{ role: 'assistant', content: parsed.raw.content }],

  /** All results for one assistant turn go back in a single user message. */
  formatToolResults: (results) => [{
    role: 'user',
    content: results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    })),
  }],

  describeHttpError(status, body) {
    const detail = this.apiErrorMessage(body);
    const base =
      status === 401 || status === 403 ? 'That API key was rejected. Check it in Coach settings.'
      : status === 429 ? 'Rate limited — too many requests. Wait a moment and try again.'
      : status === 529 ? 'Anthropic is busy right now. Try again shortly.'
      : status >= 500 ? `Anthropic server error (${status}). Try again shortly.`
      : status === 400 ? 'That request was rejected as malformed. This is a bug in yootri, not in your key.'
      : `Request failed (${status}).`;
    return detail ? `${base} (${detail})` : base;
  },
};

/* ---- OpenAI-compatible (Chat Completions) ----

   One adapter, several endpoints: OpenAI itself, and anything that copies its
   Chat Completions shape — OpenRouter, Groq, Together, LM Studio, Ollama. That
   is why the base URL is editable and the model may be typed by hand: the model
   list below cannot know what a local server has pulled. */

const openaiCompatible = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible',

  defaultBaseUrl: 'https://api.openai.com/v1',
  allowBaseUrlOverride: true,

  keyStorageKey: 'yootri_openai_key',
  keyPlaceholder: 'sk-…',
  keyHint: 'Also works with OpenRouter, Groq, Together, LM Studio or Ollama — change the base URL. Local servers usually accept any placeholder key.',

  defaultModel: 'gpt-4o-mini',
  allowCustomModel: true,
  models: [
    { id: 'gpt-4o-mini', label: 'gpt-4o-mini', note: 'Cheapest of these. The default.' },
    { id: 'gpt-4o', label: 'gpt-4o', note: 'Costs noticeably more per turn.' },
  ],

  /* Anthropic's `input_schema` is already plain JSON Schema, so the translation
     is a re-wrap rather than a rewrite. */
  translateTools: (toolDefs) => toolDefs.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  })),

  buildRequest({ apiKey, baseUrl, model, messages, tools, system, maxTokens }) {
    // Chat Completions has no separate system field; it is the first message.
    const full = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const body = { model, max_tokens: maxTokens, messages: full };
    if (tools && tools.length) body.tools = tools;

    return {
      url: (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '') + '/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  },

  apiErrorMessage: (body) =>
    (body && typeof body === 'object' && (body.error?.message || (typeof body.error === 'string' ? body.error : null))) || null,

  parseResponse(json) {
    const choice = json && typeof json === 'object' ? json.choices?.[0] : null;
    if (!choice || !choice.message) {
      return { malformed: true, snippet: snippetOf(json), raw: json };
    }
    const msg = choice.message;

    // `arguments` arrives as a JSON *string*. A model that emits something
    // unparseable must surface as a tool error the model can correct, not as an
    // exception that kills the turn — so the failure is carried on the call.
    const toolCalls = (msg.tool_calls ?? [])
      .filter((c) => c && c.function)
      .map((c) => {
        let input = {};
        let argError = null;
        try {
          const raw = c.function.arguments;
          input = raw ? JSON.parse(raw) : {};
          if (!input || typeof input !== 'object') { argError = 'arguments were not a JSON object'; input = {}; }
        } catch (e) {
          argError = `arguments were not valid JSON (${e.message})`;
          input = {};
        }
        return { id: c.id, name: c.function.name, input, argError };
      });

    // Content filters and refusals surface differently here than on Anthropic.
    const refused = choice.finish_reason === 'content_filter' || typeof msg.refusal === 'string';

    let stopReason = STOP.end;
    if (refused) stopReason = STOP.refusal;
    else if (toolCalls.length) stopReason = STOP.tool_use;

    return {
      stopReason,
      text: (msg.refusal || msg.content || '').trim(),
      toolCalls,
      raw: json,
    };
  },

  formatAssistant: (parsed) => {
    const msg = parsed.raw.choices[0].message;
    return [{
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    }];
  },

  /** Each result is its own message here, unlike Anthropic's single user turn. */
  formatToolResults: (results) => results.map((r) => ({
    role: 'tool',
    tool_call_id: r.id,
    content: r.content,
  })),

  describeHttpError(status, body) {
    const detail = this.apiErrorMessage(body);
    const base =
      status === 401 || status === 403 ? 'That API key was rejected. Check it in Coach settings.'
      : status === 404 ? 'That endpoint was not found. Check the base URL and the model name in Coach settings.'
      : status === 429 ? 'Rate limited, or out of credit with your provider. Wait a moment and try again.'
      : status >= 500 ? `The provider returned a server error (${status}). Try again shortly.`
      : status === 400 ? 'That request was rejected as malformed. Check the model name in Coach settings.'
      : `Request failed (${status}).`;
    return detail ? `${base} (${detail})` : base;
  },
};

/* ---- Registry ---- */

export const PROVIDERS = [anthropic, openaiCompatible];

export const DEFAULT_PROVIDER_ID = anthropic.id;

export const getProvider = (id) =>
  PROVIDERS.find((p) => p.id === id) || anthropic;

/** A model id the provider actually lists, or its default. */
export function resolveModel(provider, model) {
  if (!model) return provider.defaultModel;
  if (provider.allowCustomModel) return model;
  return provider.models.some((m) => m.id === model) ? model : provider.defaultModel;
}

function snippetOf(body) {
  if (body === undefined || body === null) return 'an empty body';
  try { return JSON.stringify(body).slice(0, 200); } catch { return String(body).slice(0, 200); }
}

/** Shared wording for a request that never reached the provider at all. */
export function describeTransportError(provider, e) {
  const where = provider.allowBaseUrlOverride ? 'that base URL' : 'the API';
  return (
    `Could not reach ${where}: ${e.message}. ` +
    'If the address is right and your connection is fine, the provider may not ' +
    'allow calls from a browser page. A local endpoint (LM Studio, Ollama) or a ' +
    'CORS-enabled proxy will work where a direct call does not.'
  );
}
