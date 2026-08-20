import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* index.html is the one file `npm test` cannot import: it is markup, and its
   module scripts touch the DOM on the way in. It is also where every engine
   module is actually wired up. With no build step and no bundler there is
   nothing between a rename in assets/coach/ and a live page that throws on
   load — the unit tests stay green because they never look at this file.

   So these tests read index.html as text and check the seams: that its module
   scripts parse, that every module they import exists, that every name they
   import is really exported, and that every asset the page asks the server for
   is in the repo. They are cheap and they only fail for real reasons. */

const ROOT = new URL('../', import.meta.url);
const HTML = readFileSync(new URL('index.html', ROOT), 'utf8');

/** The `<script type="module">` blocks, each tagged with the line it opens on. */
function moduleScripts() {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  for (let m; (m = re.exec(HTML)); ) {
    if (!/type\s*=\s*['"]module['"]/.test(m[1])) continue;
    out.push({ line: HTML.slice(0, m.index).split('\n').length, body: m[2] });
  }
  return out;
}

/* Comments are stripped before scanning for imports so that a commented-out
   import, or the word `import` in prose, is not mistaken for a real one. The
   `[^:]` guard keeps `https://` from being read as the start of a comment. */
function withoutComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Every static import in a script: what it binds, and where from. */
function staticImports({ body, line }) {
  const out = [];
  const re = /^[ \t]*import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (let m; (m = re.exec(withoutComments(body))); ) {
    out.push({ clause: (m[1] || '').trim(), spec: m[2], line });
  }
  return out;
}

/** The names an import clause binds, before any `as` rename. */
function namedBindings(clause) {
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (!braced) return [];
  return braced[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+as\s+/)[0].trim());
}

/** True when the clause also takes a default export (`import x, { y } from`). */
function bindsDefault(clause) {
  const head = clause.split('{')[0].trim().replace(/,$/, '');
  return head !== '' && !head.startsWith('*');
}

const SCRIPTS = moduleScripts();
const IMPORTS = SCRIPTS.flatMap(staticImports);
const LOCAL = IMPORTS.filter((i) => i.spec.startsWith('.'));

test('index.html still has module scripts to check', () => {
  // Without this the three tests below would pass by finding nothing at all.
  assert.ok(SCRIPTS.length > 0, 'no <script type="module"> found in index.html');
  assert.ok(LOCAL.length > 0, 'index.html imports nothing from assets/coach/');
});

test('every module script in index.html parses as an ES module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yootri-html-'));
  for (const { line, body } of SCRIPTS) {
    const file = join(dir, `script-at-line-${line}.mjs`);
    writeFileSync(file, body);
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(
      res.status, 0,
      `the <script> opening at index.html:${line} does not parse.\n` +
      `Line numbers below are relative to that tag.\n${res.stderr}`,
    );
  }
});

test('every module index.html imports is a file in the repo', () => {
  for (const { spec } of LOCAL) {
    assert.ok(existsSync(new URL(spec, ROOT)), `index.html imports ${spec}, which does not exist`);
  }
});

test('every name index.html imports is exported by the module it comes from', async () => {
  /* A rename in the engine is caught here rather than in the browser. The
     modules are imported for real — they are pure, so this costs nothing. */
  for (const { spec, clause } of LOCAL) {
    const mod = await import(new URL(spec, ROOT).href);
    for (const name of namedBindings(clause)) {
      assert.ok(name in mod, `index.html imports { ${name} } from ${spec}, which does not export it`);
    }
    if (bindsDefault(clause)) {
      assert.ok('default' in mod, `index.html imports a default from ${spec}, which has none`);
    }
  }
});

/* ---- what the page asks the server for ---- */

/** Paths that are ours to serve: not a URL, not protocol-relative, not an anchor. */
function isLocalPath(ref) {
  return ref !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(ref);
}

test('every local asset index.html references is in the repo', () => {
  const refs = new Set();
  for (const m of HTML.matchAll(/\b(?:href|src)\s*=\s*"([^"]+)"/g)) refs.add(m[1]);
  // The example plan is fetched, not linked, and a 404 there is just as broken.
  for (const m of HTML.matchAll(/\bfetch\(\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);

  const local = [...refs].filter(isLocalPath);
  assert.ok(local.length > 0, 'no local asset references found — has the markup changed?');

  for (const ref of local) {
    // GitHub Pages serves this repo at the domain root, so a leading `/` is the
    // repo root too. Query strings and fragments are the browser's business.
    const path = ref.split(/[?#]/)[0].replace(/^\//, '');
    assert.ok(existsSync(new URL(path, ROOT)), `index.html references ${ref}, which is not in the repo`);
  }
});

/* ---- the boundary CLAUDE.md draws ---- */

test('the engine never reaches into the page', () => {
  /* assets/coach/ is testable in Node precisely because it has no DOM. A
     `document` or `localStorage` on a branch the unit tests happen not to hit
     would not fail anything until an athlete found it. */
  const forbidden = /\b(document|window|localStorage|sessionStorage|navigator|alert)\b/;
  const dir = new URL('assets/coach/', ROOT);
  const modules = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(modules.length > 0, 'no engine modules found');
  for (const name of modules) {
    const src = withoutComments(readFileSync(new URL(name, dir), 'utf8'));
    const hit = src.match(forbidden);
    assert.equal(hit, null, `assets/coach/${name} uses \`${hit && hit[0]}\` — the engine must stay DOM-free`);
  }
});
