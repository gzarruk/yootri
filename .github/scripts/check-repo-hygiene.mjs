#!/usr/bin/env node
/* Repository hygiene for a repo that is also a website.

   yootri is served by GitHub Pages straight from the root of this branch, so a
   file committed here is a file published at yootri.gzarruk.com. `npm test`
   checks the code; this checks the repository itself:

   - nothing .gitignore was written to keep out is tracked anyway (`.gitignore`
     does not untrack a file that is already committed — this is what notices),
   - no file here carries a credential,
   - the docs do not link at files that are not here,
   - CNAME, the one file holding the custom domain in place, still reads like a
     hostname.

   Runs anywhere, no dependencies:  node .github/scripts/check-repo-hygiene.mjs
*/

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const SELF = '.github/scripts/check-repo-hygiene.mjs';
const problems = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const lines = (out) => out.split('\n').filter(Boolean);

// Every path below is repo-relative, so the check reads the same wherever it
// is run from — a hook, a workflow step, or a shell three directories down.
process.chdir(git('rev-parse', '--show-toplevel').trim());

const tracked = lines(git('ls-files'));

/* What a fresh clone of this branch would contain once the working tree is
   committed: tracked files plus new ones that .gitignore does not exclude.
   Scanning that rather than the index means a credential or a broken link is
   caught before it is committed, not after — and running this locally with new
   files staged or not does not produce phantom failures. */
const present = new Set(lines(git('ls-files', '--cached', '--others', '--exclude-standard')));

/* ---- 1. nothing private slipped in ---- */

/* .gitignore lists the working notes and the machine-local settings that must
   never be published. Adding a path there does nothing if the file is already
   committed, and the repo is public the moment it is pushed. */
const leaked = lines(git('ls-files', '--cached', '--ignored', '--exclude-standard'));
for (const f of leaked) fail(f, 'is tracked but .gitignore says it should not be — `git rm --cached` it');

for (const f of tracked) {
  if (/(^|\/)\.DS_Store$/.test(f)) fail(f, 'is editor/OS noise and should not be tracked');
}

/* ---- 2. no credentials in tracked files ---- */

/* Deliberately absent: Firebase web API keys (`AIza…`). Those are public by
   design — index.html ships one, and Firestore rules are what actually guard
   the data. Flagging them would train everyone to ignore this check. */
const SECRETS = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, 'a private key block'],
  [/\bsk-[A-Za-z0-9_-]{24,}\b/, 'an OpenAI/Anthropic-style API key'],
  [/\bghp_[A-Za-z0-9]{30,}\b/, 'a GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, 'a GitHub fine-grained token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/, 'a Slack token'],
  [/"type"\s*:\s*"service_account"/, 'a Google service-account key'],
];

/** Text we can usefully scan: skips binaries and anything implausibly large. */
function readText(file) {
  try {
    if (statSync(file).size > 4_000_000) return null;
    const buf = readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

for (const f of present) {
  if (f === SELF) continue;               // this file is a list of the patterns
  const text = readText(f);
  if (text === null) continue;
  for (const [re, what] of SECRETS) {
    if (re.test(text)) fail(f, `looks like it contains ${what}`);
  }
}

/* ---- 3. the docs point at things that exist ---- */

/* A broken link in README is a broken link on the repo's front page. */
const paths = [...present];
for (const f of paths.filter((p) => p.endsWith('.md'))) {
  const text = readText(f);
  if (text === null) continue;
  const targets = [
    ...text.matchAll(/\]\(\s*([^)\s]+)/g),        // [text](target) and ![alt](target)
    ...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm), // [ref]: target
  ].map((m) => m[1]);

  for (const raw of targets) {
    const target = raw.replace(/^<|>$/g, '').split('#')[0];
    if (target === '') continue;                                  // a bare #anchor
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;    // a URL
    const path = target.startsWith('/')
      ? normalize(target.slice(1))
      : normalize(join(dirname(f), decodeURIComponent(target)));
    const rel = relative('.', path);
    if (!present.has(rel) && !paths.some((p) => p.startsWith(`${rel}/`))) {
      fail(f, `links to ${raw}, which is not in the repo`);
    }
  }
}

/* ---- 4. the custom domain survives ---- */

/* GitHub Pages rewrites or drops CNAME more readily than anyone expects, and
   when it goes wrong the site simply stops answering on its own domain. */
const cname = readText('CNAME');
if (cname === null) {
  fail('CNAME', 'is missing — the custom domain comes from this file');
} else {
  const hosts = cname.split('\n').map((l) => l.trim()).filter(Boolean);
  if (hosts.length !== 1) fail('CNAME', `should hold exactly one hostname, found ${hosts.length} lines`);
  else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(hosts[0])) {
    fail('CNAME', `"${hosts[0]}" is not a bare hostname — no scheme, no path, no trailing slash`);
  }
}

/* ---- verdict ---- */

if (problems.length) {
  console.error(`Repository hygiene: ${problems.length} problem(s).\n`);
  for (const p of problems) console.error(`  ✖ ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`Repository hygiene: clean (${present.size} files checked).`);
