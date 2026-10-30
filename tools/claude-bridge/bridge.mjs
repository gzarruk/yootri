#!/usr/bin/env node
/* The Claude bridge behind `make claude-bridge`.

   The coach is bring-your-own-key and talks to a model from the page. This lets
   it talk to the Claude Code on *this machine* instead, so a turn is paid for
   by the subscription that is signed in to it rather than by an API key. It
   answers the one request the page's "OpenAI-compatible" provider makes —
   `POST /v1/chat/completions` — on 127.0.0.1, runs `claude -p` for it, and
   hands back a Chat Completions response. The page needs no change: set the
   provider's base URL to this address and paste the token as its key.

   What it is, and is not:
   - **Yours, on your machine.** It uses the `claude` you have already signed
     in, for your own use. It is not a way to share a subscription, and the
     app's published page is not meant to depend on it (there is no hosted
     version to point at).
   - **Off unless you start it, and not open to the machine.** It listens on
     loopback only, answers only a request that carries the token it printed,
     and lets a browser page read the answer only from an origin you allowed.
   - **The model gets no tools of its own.** The CLI is started with its tools,
     MCP servers, settings and slash commands off, in an empty directory, so
     nothing in this repo or your home configuration reaches the model and it
     cannot touch a file. The coach's tools are described in the prompt and run
     by the page, exactly as with an API key.
   - **Nothing is kept.** No session is saved, no conversation is logged, and
     the token file holds the token and nothing else.

   No dependencies; Node is already required for `npm test`.

       node tools/claude-bridge/bridge.mjs [--port 8766] [--allow-origin URL]… */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BRIDGE_SYSTEM, REPLY_SCHEMA, buildPrompt, toChatCompletion, errorBody, isModelName,
} from './translate.mjs';

export const DEFAULT_PORT = 8766;
export const DEFAULT_MODEL = 'sonnet';
const MAX_BODY = 4 * 1024 * 1024;       // a season of tool results is large; this is generous
const TURN_TIMEOUT_MS = 180_000;

/* ---- the CLI ---- */

/** Everything that keeps the model a plain model: no tools, settings, MCP or skills. */
export const claudeArgs = (model) => [
  '-p',
  '--output-format', 'json',
  '--json-schema', JSON.stringify(REPLY_SCHEMA),
  '--system-prompt', BRIDGE_SYSTEM,
  '--model', model,
  '--tools', '',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--disable-slash-commands',
  '--no-session-persistence',
];

/* A key in the environment makes the CLI bill that key instead of using the
   signed-in subscription — which is the opposite of what this is for. */
const childEnv = () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
};

/** Run one turn through the CLI. Resolves to the CLI's JSON result; rejects with a sentence. */
export function runClaude({ prompt, model, bin = 'claude', timeoutMs = TURN_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'yootri-claude-bridge-'));
    let child;
    try {
      child = spawn(bin, claudeArgs(model), { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`Could not start ${bin}: ${e.message}`));
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude did not answer in time.')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT'
        ? `Could not find "${bin}". Install Claude Code and sign in with it first.`
        : `Could not start ${bin}: ${e.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error(`Claude returned nothing readable.${err ? ' ' + err.trim().slice(0, 300) : ''}`)); }
    });
    child.stdin.on('error', () => {});   // a CLI that exits early closes the pipe
    child.stdin.end(prompt);
  });
}

/** What came back from the CLI as a reply, or why it is not one. */
export function readResult(result) {
  if (result?.is_error) {
    const why = String(result.result ?? '').slice(0, 300);
    const signedOut = /log ?in|auth|credential|api key/i.test(why);
    return { error: signedOut
      ? 'Claude Code is not signed in on this machine. Run `claude` and sign in, then try again.'
      : `Claude reported an error${why ? `: ${why}` : '.'}` };
  }
  if (result?.structured_output && typeof result.structured_output === 'object') return { reply: result.structured_output };
  // No structure: take the words rather than lose the turn.
  return { reply: null, text: typeof result?.result === 'string' ? result.result : '' };
}

/* ---- the token ---- */

const TOKEN_FILE = join(homedir(), '.config', 'yootri-claude-bridge', 'token');

/** The token the page presents as its "API key": made once, then kept for the next start. */
export function loadToken(file = TOKEN_FILE) {
  try {
    const t = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{48}$/.test(t)) return t;
  } catch { /* first run */ }
  const t = randomBytes(24).toString('hex');
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(file, t + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return t;
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/* ---- the server ---- */

/**
 * The request handler, with the CLI injected so tests never start one.
 * `run({ prompt, model })` resolves to the CLI's JSON result.
 */
export function createBridge({ token, origins = ['http://localhost:8000'], run = runClaude, defaultModel = DEFAULT_MODEL }) {
  let busy = Promise.resolve();   // one turn at a time: a subscription is not a parallel resource

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = origin && origins.includes(origin);
    const cors = allowed ? {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-private-network': 'true',
      vary: 'Origin',
    } : {};

    if (req.method === 'OPTIONS') {
      res.writeHead(allowed ? 204 : 403, cors);
      return res.end();
    }
    // A page from an origin that was not allowed gets nothing, not even a refusal it can read.
    if (origin && !allowed) return json(res, 403, errorBody('Origin not allowed.', 'forbidden'));

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || !sameToken(bearer, token)) {
      return json(res, 401, errorBody('That key was rejected. Paste the token the bridge printed.', 'unauthorized'), cors);
    }

    const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '');

    if (req.method === 'GET' && path === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: ['haiku', 'sonnet', 'opus'].map((id) => ({ id, object: 'model', owned_by: 'claude-code' })),
      }, cors);
    }

    if (req.method !== 'POST' || path !== '/v1/chat/completions') {
      return json(res, 404, errorBody('Not found. This bridge answers /v1/chat/completions only.', 'not_found'), cors);
    }

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return json(res, 413, errorBody('That request is too large.', 'too_large'), cors);
    }
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!body || !Array.isArray(body.messages)) {
      return json(res, 400, errorBody('Expected a chat completions request with a messages list.', 'bad_request'), cors);
    }
    // The model field is the athlete's choice in Coach settings: `sonnet`, `opus`, a full id.
    const model = body.model && isModelName(body.model) ? body.model : defaultModel;
    if (body.model && !isModelName(body.model)) {
      return json(res, 400, errorBody('That model name is not one this bridge can pass on.', 'bad_request'), cors);
    }

    const prompt = buildPrompt({ messages: body.messages, tools: body.tools });
    const turn = busy.then(() => run({ prompt, model }));
    busy = turn.catch(() => {});
    try {
      const out = readResult(await turn);
      if (out.error) return json(res, 502, errorBody(out.error), cors);
      return json(res, 200, toChatCompletion(out.reply, { model, fallbackText: out.text }), cors);
    } catch (e) {
      return json(res, 502, errorBody(e.message), cors);
    }
  });
}

/* ---- command line ---- */

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, origins: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = Number(argv[++i]);
    else if (argv[i] === '--allow-origin') opts.origins.push(argv[++i]);
    else if (argv[i] === '--quiet') opts.quiet = true;
    else if (/^\d+$/.test(argv[i])) opts.port = Number(argv[i]);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error('  --port must be a port number.');
    process.exit(2);
  }
  if (!opts.origins.length) opts.origins.push('http://localhost:8000');
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = parseArgs(process.argv.slice(2));
  const token = loadToken();
  const server = createBridge({ token, origins: opts.origins });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `  Port ${opts.port} is in use. Try --port.` : `  ${e.message}`);
    process.exit(1);
  });
  server.listen(opts.port, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${opts.port}/v1`;
    console.log(`
  Claude bridge on 127.0.0.1:${opts.port} — turns are paid for by the Claude Code signed in on this machine.

  In the coach: Settings → Provider "OpenAI-compatible"
      Base URL   ${base}
      Model      sonnet   (or haiku, opus)
      API key    ${opts.quiet ? '(in ~/.config/yootri-claude-bridge/token)' : token}

  Allowed pages: ${opts.origins.join(', ')}    Ctrl-C to stop.
`);
  });
}
