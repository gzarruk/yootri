#!/usr/bin/env node
/* Fetch the Garmin Coach runs for the next two weeks and write them to the account.

     node tools/sync/run.mjs [--dry-run] [--days 14] [--config path]

   Reads ~/.config/yootri/sync.json: { "projectId", "uid", "serviceAccount" } —
   the service account key stays in a file outside the repo. Run on your own
   machine on a schedule (`make sync-install`). A failed run writes nothing and
   leaves the last good feed in place; an empty list means Garmin has not
   published the week yet, which is recorded as checked and is not an error. */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configProblems, feedDocument, slimFeed } from './feed.mjs';
import { accessToken, readPrevious, writeFeed } from './firestore.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
export const HOME_DIR = process.env.YOOTRI_GARMIN_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'yootri');

const iso = (d) => d.toISOString().slice(0, 10);

function bridge(from, to) {
  return new Promise((resolve, reject) => {
    execFile('uv', ['run', '--directory', join(REPO, 'tools', 'garmin-bridge'), 'python', '-m', 'garmin_bridge', 'scheduled', '--from', from, '--to', to],
      { maxBuffer: 16 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stdout || stderr || err.message).toString().trim().split('\n').slice(-2).join(' ')));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('The Garmin bridge did not return JSON.')); }
      });
  });
}

const defaults = {
  readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
  readKey: (path) => JSON.parse(readFileSync(path, 'utf8')),
  fetchRuns: bridge,
  log: (line) => { mkdirSync(HOME_DIR, { recursive: true }); appendFileSync(join(HOME_DIR, 'sync.log'), `${line}\n`); },
  notify: (msg) => {
    if (process.platform !== 'darwin') return;
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "yootri sync"`], () => {});
  },
};

export async function run({ argv = [], now = Date.now(), fetchFn = fetch, ...over } = {}) {
  const d = { ...defaults, ...over };
  const flag = (n) => argv.indexOf(n);
  const dry = flag('--dry-run') >= 0;
  const days = Number(argv[flag('--days') + 1]) || 14;
  const cfgPath = flag('--config') >= 0 ? argv[flag('--config') + 1] : join(HOME_DIR, 'sync.json');
  const stamp = new Date(now).toISOString();
  const fail = (msg) => { d.log(`${stamp} FAILED ${msg}`); d.notify(msg); return { ok: false, message: msg }; };
  try {
    let cfg;
    try { cfg = d.readConfig(cfgPath); } catch { cfg = null; }
    const problems = configProblems(cfg);
    if (problems.length) return fail(problems.join(' '));

    const today = new Date(now);
    const scheduled = await d.fetchRuns(iso(today), iso(new Date(now + days * 86400000)));
    const feed = slimFeed(scheduled);
    if (dry) return { ok: true, dry: true, runs: feed.runs.length, feed };

    const sa = d.readKey(cfg.serviceAccount);
    const token = await accessToken(sa, { now, fetchFn });
    const previous = await readPrevious({ projectId: cfg.projectId, uid: cfg.uid, token, fetchFn });
    const doc = feedDocument(feed, { now, previous });
    await writeFeed({ projectId: cfg.projectId, uid: cfg.uid, token, doc, fetchFn });
    d.log(`${stamp} ok runs=${feed.runs.length}${feed.runs.length ? '' : ' (nothing published yet)'}`);
    return { ok: true, runs: feed.runs.length, changed: doc.updatedAt === now };
  } catch (e) {
    const m = String(e?.message ?? e);
    return fail(/429|rate limit|too many/i.test(m) ? 'Garmin is rate limiting this connection; not retrying. Try again later.' : m);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await run({ argv: process.argv.slice(2) });
  if (r.dry) console.log(JSON.stringify(r.feed, null, 1));
  else console.log(r.ok ? `Wrote ${r.runs} run(s).` : `Failed: ${r.message}`);
  process.exit(r.ok ? 0 : 1);
}
