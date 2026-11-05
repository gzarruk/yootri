#!/usr/bin/env node
/* Keep the Claude bridge running: a macOS LaunchAgent started at login.

     node tools/claude-bridge/install.mjs install [--port N] [--allow-origin URL]… | uninstall | status

   The same bridge, started the same way as `make claude-bridge` but with
   --quiet (no token in its log) and kept alive. It still listens on 127.0.0.1
   only, answers only a request carrying its token, and the plist holds no key:
   `bridge.mjs` removes ANTHROPIC_API_KEY from the CLI's environment itself.
   The PATH is written in at install time because launchd's own does not
   include `claude`. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reload } from '../launchd.mjs';

export const LABEL = 'com.yootri.claude-bridge';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const str = (s) => `<string>${esc(s)}</string>`;

export function plistFor({ node, script, cwd, path, logPath, port, origins }) {
  const args = [node, script, '--port', String(port), '--quiet', ...origins.flatMap((o) => ['--allow-origin', o])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key><array>${args.map(str).join('')}</array>
  <key>WorkingDirectory</key>${str(cwd)}
  <key>EnvironmentVariables</key><dict><key>PATH</key>${str(path)}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${str(logPath)}
  <key>StandardErrorPath</key>${str(logPath)}
</dict></plist>
`;
}

/** The pages allowed to use the coach: this machine's dev server and the published site (the CNAME). */
export function defaultOrigins(root, devPort = 8000) {
  const origins = [`http://localhost:${devPort}`];
  try {
    const host = readFileSync(join(root, 'CNAME'), 'utf8').trim();
    if (/^[a-z0-9.-]+$/i.test(host)) origins.push(`https://${host}`);
  } catch { /* no CNAME: the dev page only */ }
  return origins;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.platform !== 'darwin') { console.error('The LaunchAgent is macOS only. Elsewhere, start `make claude-bridge` from your own service manager.'); process.exit(2); }
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = { port: 8766, origins: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--port') opts.port = Number(rest[++i]);
    else if (rest[i] === '--allow-origin') opts.origins.push(rest[++i]);
  }
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const run = (args) => { try { return execFileSync('launchctl', args, { stdio: 'pipe' }).toString(); } catch { return null; } };
  if (cmd === 'install') {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) { console.error('  --port must be a port number.'); process.exit(2); }
    try { execFileSync('claude', ['--version'], { stdio: 'pipe' }); } catch { console.error('  Needs Claude Code on PATH, signed in: https://claude.com/claude-code'); process.exit(1); }
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, '..', '..');
    const origins = opts.origins.length ? opts.origins : defaultOrigins(root);
    const logPath = join(homedir(), 'Library', 'Logs', 'yootri-claude-bridge.log');
    mkdirSync(dirname(plist), { recursive: true }); mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(plist, plistFor({ node: process.execPath, script: join(here, 'bridge.mjs'), cwd: root, path: process.env.PATH, logPath, port: opts.port, origins }));
    if (!reload({ domain, label: LABEL, plist })) { console.error('launchctl refused the agent; the plist is at ' + plist); process.exit(1); }
    console.log(`Installed. The coach answers on http://127.0.0.1:${opts.port}/v1 from login on, for ${origins.join(', ')}.\nToken: ~/.config/yootri-claude-bridge/token   Log: ${logPath}`);
  } else if (cmd === 'uninstall') {
    run(['bootout', `${domain}/${LABEL}`]);
    if (existsSync(plist)) unlinkSync(plist);
    console.log('Removed.');
  } else if (cmd === 'status') {
    console.log(run(['print', `${domain}/${LABEL}`]) === null ? 'Not installed.' : 'Installed and loaded.');
  } else { console.error('usage: install.mjs install [--port N] [--allow-origin URL]… | uninstall | status'); process.exit(2); }
}
