# Claude bridge

Lets the coach use the Claude Code that is signed in on **your own machine**
instead of an API key. For your own use, on your own computer.

It is a small Node program with no dependencies. It listens on `127.0.0.1`, takes
the one request the coach's *OpenAI-compatible* provider makes, runs `claude -p`
for it, and answers in that provider's format. Nothing in the page changes.

## Use

1. Have [Claude Code](https://claude.com/claude-code) installed and signed in
   (run `claude` once). Turns use that account's plan and its limits.
2. `make claude-bridge` (and `make dev` in another terminal). It prints three values.
3. In the coach: **Settings** → Provider **OpenAI-compatible**, then
   - **Base URL** `http://127.0.0.1:8766/v1`
   - **Model** `sonnet` (or `opus`). `haiku` is cheap but often declines to call the tools.
   - **API key** the token it printed. It is kept in `~/.config/yootri-claude-bridge/token`
     (readable by you only) so it survives a restart.

`make claude-bridge CLAUDE_PORT=8767 PORT=8001` changes the ports.

## What it does and does not do

- It answers only a request that carries the token, and only lets a page read the
  answer if the page's origin was allowed (`--allow-origin`, default
  `http://localhost:8000`). It serves one turn at a time.
- The CLI is started with its tools, MCP servers, settings, skills and session
  saving all off, in an empty temporary directory, so the model cannot read a file
  or run anything. The coach's own tools are described in the prompt and run by
  the page, as they do with an API key — still as a draft you review and apply.
- `ANTHROPIC_API_KEY` is removed from the CLI's environment: a key there would be
  billed in place of your subscription.
- It logs nothing and stores nothing but the token. The prompt holds your plan.
- It is slower than the API (each turn starts the CLI), and it is not a way to
  share an account: do not expose the port or the token.

Tests: `npm test` (`tests/claude-bridge.test.js`, no CLI and no network).
