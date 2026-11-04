#!/usr/bin/env node
/* Keep the sync running: a macOS LaunchAgent, in local time.

     node tools/sync/install.mjs install | uninstall | status

   Local time means daylight saving needs no second schedule: 00:20 every day,
   23:30 on Sunday (the new week), 06:30 on Monday (a retry for a week Garmin
   posted late). launchd runs a job that was missed while the machine slept. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'com.yootri.sync';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const time = (h, m, wd) => `    <dict>${wd === undefined ? '' : `<key>Weekday</key><integer>${wd}</integer>`}<key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`;

export function plistFor({ node, script, cwd, path, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(script)}</string></array>
  <key>WorkingDirectory</key><string>${esc(cwd)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(path)}</string></dict>
  <key>StartCalendarInterval</key>
  <array>
${time(0, 20)}
${time(23, 30, 0)}
${time(6, 30, 1)}
  </array>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict></plist>
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.platform !== 'darwin') { console.error('The LaunchAgent is macOS only. On Linux, run `node tools/sync/run.mjs` from cron at 00:20, Sunday 23:30 and Monday 06:30.'); process.exit(2); }
  const cmd = process.argv[2];
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const run = (args) => { try { return execFileSync('launchctl', args, { stdio: 'pipe' }).toString(); } catch (e) { return null; } };
  if (cmd === 'install') {
    const here = dirname(fileURLToPath(import.meta.url));
    const logPath = join(homedir(), '.config', 'yootri', 'sync.log');
    mkdirSync(dirname(plist), { recursive: true }); mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(plist, plistFor({ node: process.execPath, script: join(here, 'run.mjs'), cwd: join(here, '..', '..'), path: process.env.PATH, logPath }));
    run(['bootout', `${domain}/${LABEL}`]);
    if (run(['bootstrap', domain, plist]) === null) { console.error('launchctl refused the agent; the plist is at ' + plist); process.exit(1); }
    console.log(`Installed. Runs at 00:20 daily, 23:30 Sunday and 06:30 Monday. Log: ${logPath}`);
  } else if (cmd === 'uninstall') {
    run(['bootout', `${domain}/${LABEL}`]);
    if (existsSync(plist)) unlinkSync(plist);
    console.log('Removed.');
  } else if (cmd === 'status') {
    console.log(run(['print', `${domain}/${LABEL}`]) === null ? 'Not installed.' : 'Installed and loaded.');
  } else { console.error('usage: install.mjs install | uninstall | status'); process.exit(2); }
}
