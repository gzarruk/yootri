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

/* The privacy notice's text is not in index.html: the footer panel and
   privacy.html both draw it from assets/privacy.js. The checks on what it says
   read it there. */
const PRIVACY = readFileSync(new URL('assets/privacy.js', ROOT), 'utf8');
const noticeText = () => PRIVACY.slice(PRIVACY.indexOf('export const PRIVACY_SECTIONS'), PRIVACY.indexOf('];', PRIVACY.indexOf('export const PRIVACY_SECTIONS')));

const OPEN = '<script';
const CLOSE = '</script';

/** The `<script type="module">` blocks, each tagged with the line it opens on.

   Scanned by hand rather than with `/<script\b[^>]*>([\s\S]*?)<\/script>/gi`,
   which is the obvious way and is wrong twice over: HTML tag names are
   case-insensitive, and a browser ends a script at `</script foo="bar">` just
   as readily as at `</script>`. Neither is likely in a file we write ourselves
   — but a scanner that quietly finds nothing would make every check below pass
   for the wrong reason, and CodeQL flags the regex form on sight. */
function moduleScripts(html = HTML) {
  const hay = html.toLowerCase();
  const out = [];
  let i = 0;
  for (;;) {
    const open = hay.indexOf(OPEN, i);
    if (open === -1) return out;
    i = open + OPEN.length;
    if (/[a-z0-9]/.test(hay[i] || '')) continue;   // `<scripts…>` is a different tag
    const attrsEnd = hay.indexOf('>', i);
    if (attrsEnd === -1) return out;               // an unclosed tag: nothing to read
    const close = hay.indexOf(CLOSE, attrsEnd + 1);
    if (close === -1) return out;                  // unterminated: nothing to read
    const closeEnd = hay.indexOf('>', close);
    if (closeEnd === -1) return out;
    if (/\btype\s*=\s*['"]?module\b/i.test(html.slice(i, attrsEnd))) {
      out.push({
        line: html.slice(0, open).split('\n').length,
        body: html.slice(attrsEnd + 1, close),
      });
    }
    i = closeEnd + 1;
  }
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

test('the script scanner is not fooled by tag case or a lax closing tag', () => {
  const found = moduleScripts(
    '<SCRIPT TYPE="module">const a = 1;</SCRIPT foo="bar">' +
    '<script type="module">const b = 2;</script >' +
    '<script>const c = 3;</script>' +
    '<scripts type="module">not a script tag</scripts>',
  );
  assert.deepEqual(found.map((s) => s.body), ['const a = 1;', 'const b = 2;']);
});

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
  for (const m of HTML.matchAll(/\b(?:href|src)\s*=\s*"([^"]+)"/gi)) refs.add(m[1]);
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

/** The sizes a .ico actually carries, read from its ICONDIR. A 0 byte means 256. */
function icoSizes(buf) {
  const count = buf.readUInt16LE(4);
  return new Set(Array.from({ length: count }, (_, i) => {
    const e = 6 + i * 16;
    return `${buf[e] || 256}x${buf[e + 1] || 256}`;
  }));
}

test('a favicon link that advertises a size really has that size', () => {
  /* `sizes` is a promise to the browser: it picks an icon on the strength of
     this attribute and only then downloads it. Advertise 32x32 and ship a file
     holding nothing but a 16x16 and the tab gets a blurry upscale — with no
     error anywhere to say so. This caught exactly that. */
  const links = [...HTML.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/gi)].map((m) => m[0]);
  assert.ok(links.length > 0, 'index.html declares no icon links — has the markup changed?');

  let checked = 0;
  for (const tag of links) {
    const sizes = tag.match(/\bsizes="([^"]+)"/i);
    const href = tag.match(/\bhref="([^"]+)"/i);
    if (!sizes || !href || !href[1].endsWith('.ico')) continue;
    const path = href[1].split(/[?#]/)[0].replace(/^\//, '');
    const have = icoSizes(readFileSync(new URL(path, ROOT)));
    for (const want of sizes[1].trim().split(/\s+/)) {
      assert.ok(have.has(want), `${path} is linked as sizes="${want}" but holds only ${[...have].join(', ')}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no sized .ico link found — has the markup changed?');
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

/* ---- the privacy notice cannot ship half-written ---- */

test('the privacy notice has a contact route and a named region', () => {
  /* Cloud sync makes this project the controller of somebody else's training
     data, and two facts in the notice cannot be derived from anything in the
     repo: how to reach the controller, and which region Firestore actually
     holds the data in. Blanking either is a failing test rather than a notice
     that quietly tells a user nothing — which is also what a fork hits until it
     puts its own values there (FIREBASE_SETUP.md, step 7). */
  for (const name of ['PRIVACY_CONTACT', 'PRIVACY_REGION']) {
    const m = PRIVACY.match(new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`));
    assert.ok(m, `${name} is gone from assets/privacy.js — was the privacy notice removed?`);
    assert.notEqual(m[1].trim(), '', `${name} is still blank; the privacy notice would publish a placeholder`);
  }
});

test('no cloud call runs without consent', () => {
  /* Consent is enforced at each call site rather than behind one wrapper, which
     is the safer shape but only while every site actually carries the guard. A
     new path that forgets it would sync silently and the app would look fine. */
  for (const fn of ['schedulePush', 'pushPlan', 'cloudDelete']) {
    const m = HTML.match(new RegExp(`function ${fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]{0,200})`));
    assert.ok(m, `${fn} is gone from index.html`);
    assert.match(m[1], /hasSyncConsent\(\)/, `${fn} no longer checks hasSyncConsent()`);
  }
});

/* ---- the Garmin bridge ---- */

test('the Garmin button is hidden until this browser is paired', () => {
  /* The published page must not advertise a flow no visitor can use: the
     button only appears once this browser holds a bridge address and token. */
  const m = HTML.match(/<button\b[^>]*\bid="garmin-btn"[^>]*>/);
  assert.ok(m, 'the Garmin button is gone from the toolbar');
  assert.match(m[0], /class="[^"]*\bhidden\b/, 'the Garmin button is visible before anything is paired');
});

test('the pairing token can only ever be sent to this computer', async () => {
  /* The token goes wherever the stored address says. An address that is not a
     loopback one — typed by mistake, or planted — must not be accepted. */
  assert.match(HTML, /const GARMIN_URL_RE = BRIDGE_URL_RE;/, 'the page no longer uses the engine\'s loopback rule');
  const { BRIDGE_URL_RE: re } = await import('../assets/coach/synced.js');
  for (const ok of ['http://127.0.0.1:8765', 'http://localhost:8765', 'http://127.0.0.1:18765']) {
    assert.equal(re.test(ok), true, ok);
  }
  for (const bad of ['https://evil.test', 'http://127.0.0.1.evil.test:8765', 'http://localhost:8765/x',
    'http://10.0.0.2:8765', 'http://localhost', 'http://127.0.0.1:8765@evil.test']) {
    assert.equal(re.test(bad), false, bad);
  }
});

test('if the page talks to the bridge, the privacy notice says what it keeps', () => {
  if (!HTML.includes('/v1/activities')) return;
  const notice = noticeText();
  assert.match(notice, /Garmin/, 'the notice does not mention synced Garmin activities');
  assert.match(notice, /heart rate/i, 'the notice does not say where heart rate is kept');
});

test('if heart-rate thresholds are kept, the privacy notice says where load figures go', () => {
  /* Load worked out from heart rate reaches the athlete's AI provider when the
     coach reads it. The notice has to say so before the page can do it. */
  if (!HTML.includes('yootri_hr_thresholds')) return;
  const notice = noticeText();
  assert.match(notice, /training load/i);
  assert.match(notice, /AI provider/);
});

test('heart-rate thresholds are kept in this browser, never on a plan', () => {
  if (!HTML.includes('yootri_hr_thresholds')) return;
  assert.equal(/plan\.hrThresholds|plan\.loadRefs\s*=\s*\{[^}]*(lthr|rest|max)/.test(HTML), false);
});

/* ---- sleep and overnight heart rate ----

   Daily measurements of the body, so they live where heart rate does: in this
   browser's own storage, never on a plan (which syncs and exports), never in
   what the coach is given, and gone when the athlete unticks the box or
   disconnects the bridge. */

test('sleep and overnight heart rate are kept in this browser, never on a plan', () => {
  if (!HTML.includes('/v1/overnight')) return;
  assert.match(HTML, /const GARMIN_OVERNIGHT_KEY = 'yootri_overnight';/);
  // The code, not its copy: the panel says "never written into a plan" in so many words.
  const code = (name) => fnBody(name).replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const name of ['syncOvernight', 'setOvernight', 'overnightSectionHTML', 'overnightReviewHTML']) {
    assert.doesNotMatch(code(name), /\bplan\b|persistPlan|cloudPush|coach/, `${name} reaches a plan or the coach`);
  }
  assert.doesNotMatch(HTML, /plan\.(overnight|nights|sleep|hrv)\b/i);
});

test('the coach is never given sleep or overnight heart rate', () => {
  assert.doesNotMatch(fnBody('coachContext'), /overnight|nights|sleep/i);
  for (const f of ['assets/coach/tools.js', 'assets/coach/agent.js', 'assets/coach/plan.js', 'assets/coach/portable.js']) {
    assert.doesNotMatch(readFileSync(new URL(f, ROOT), 'utf8'), /overnight\.js/, `${f} reads the nights`);
  }
});

test('disconnecting the bridge deletes the nights with the heart rate', () => {
  const at = HTML.indexOf("$('gm-forget')");
  assert.ok(at > 0, 'the disconnect handler is gone');
  const handler = HTML.slice(at, HTML.indexOf('});', at));
  assert.match(handler, /remove\(GARMIN_HR_KEY\)/);
  assert.match(handler, /remove\(GARMIN_OVERNIGHT_KEY\)/);
});

test('if the page reads nights, the privacy notice says what and where', () => {
  if (!HTML.includes('/v1/overnight')) return;
  const notice = noticeText();
  assert.match(notice, /sleep and overnight heart rate/i);
  assert.match(notice, /never synced/);
  assert.match(notice, /never given to the coach/);
});

test('nothing is made easy unless the athlete ticks the box', () => {
  // The nights may be shown beside the box; they never tick it.
  assert.match(HTML, /function openWeekReview\(\{ ease = false \} = \{\}\)/);
  const body = fnBody('openWeekReview');
  assert.match(body, /proposeNextWeek\(plan, \{ today, ease \}\)/);
  assert.match(body, /id="rv-ease"' \+ \(ease \? ' checked' : ''\)/);
  assert.doesNotMatch(body, /ease\s*[:=][^=]*offer/);
});

/* ---- the plan lifecycle ----

   These paths are page code, so like the consent guard above they are checked
   at their call sites. The rules themselves (which week a reset builds, what
   counts as an untouched stand-in) are engine functions with tests of their
   own in plan.test.js; what is pinned here is that the page asks them. */

/** The body of `function name(…) { … }` in the page, by brace matching. */
function fnBody(name) {
  const src = withoutComments(HTML);
  const at = src.search(new RegExp(`function ${name}\\s*\\(`));
  assert.ok(at !== -1, `${name} is gone from index.html`);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

test('Reset week builds the week the way a re-fit does', () => {
  // freshWeek carries the race day; generateWeek called directly would not.
  assert.match(HTML, /const freshSessions = \(w\) => freshWeek\(/);
});

test('creating or importing a season replaces whatever is stored, and only once it is finished', () => {
  for (const fn of ['doImport', 'finishWizard']) {
    const body = fnBody(fn);
    assert.match(body, /replaceCurrentPlan\(/, `${fn} no longer replaces the stored plan`);
  }
  const body = fnBody('replaceCurrentPlan');
  assert.ok(body.indexOf('clearPlans()') < body.indexOf('addPlan('), 'the old plan is cleared before the new one is adopted');
  assert.match(body, /armUndo\(/, 'a used season is replaced with an Undo');
  assert.match(fnBody('clearPlans'), /cloudDelete\(/, 'a plan already uploaded goes from the cloud too');
});

test('starting over keeps the chosen races and deletes nothing before the wizard finishes', () => {
  const dlg = fnBody('openStartOverDialog');
  assert.match(dlg, /upcomingEvents\(/);
  assert.match(dlg, /carryOver\(/);
  assert.match(dlg, /openWizard\(\{ restart: true, carry/);
  assert.doesNotMatch(dlg, /clearPlans\(|remove\(planKey|cloudDelete\(/, 'nothing is deleted before the wizard finishes');
  assert.match(fnBody('runPlanAction'), /act === 'startover'\) return openStartOverDialog\(\)/);
  assert.match(fnBody('popHtml'), /popRow\('startover'/);
  assert.doesNotMatch(withoutComments(HTML), /function deletePlan\b/);
});

test('the plan menu is one plan, not a list of them', () => {
  const menu = fnBody('popHtml');
  assert.doesNotMatch(menu, /plans\.map|data-pm="switch"|menuitemradio/);
  assert.doesNotMatch(withoutComments(HTML), /function (switchPlan|duplicatePlan|openNewPlanPanel)\b/);
  assert.doesNotMatch(fnBody('runPlanAction'), /'(switch|blank|dup)'/);
});

test('the untouched check is the engine’s, wherever the page asks it', () => {
  for (const fn of ['mergeCloudPlans']) {
    assert.match(fnBody(fn), /isUntouchedPlan\(/, `${fn} has its own idea of an untouched plan again`);
  }
  assert.match(HTML, /const currentPlanUntouched = \(\) => isUntouchedPlan\(/);
});

test('FTP and CSS can be entered without Garmin', () => {
  const body = fnBody('bioThresholdsHTML');
  assert.match(body, /id="bio-ftp"/);
  assert.match(body, /id="bio-css"/);
  assert.doesNotMatch(body, /synced\s*\?/, 'the fields must not wait for a sync');
});

test('Biometrics saves About you, the plan references and the heart-rate figures to three separate stores', () => {
  const body = fnBody('saveBiometrics');
  assert.match(body, /saveAthleteLocal\(next\)/, 'About you goes to this browser');
  assert.match(body, /saveLoadRefs\(refs\)/, 'FTP and CSS go on the plan');
  assert.match(body, /save\(HR_THRESHOLDS_KEY, hr\)/, 'heart-rate figures go to this browser');
  // Nothing is written until every value has been accepted.
  assert.ok(body.indexOf('if (refused.length)') < body.indexOf('saveAthleteLocal(next)'), 'a refused value must stop the whole save');
  // And the heart-rate figures never ride on the plan.
  assert.doesNotMatch(body, /plan\.(hr|lthr)/);
});

test('the About you and Paces panels are gone: the Biometrics page is their only home', () => {
  assert.doesNotMatch(HTML, /function openAthletePanel|function openPacesPanel/);
  assert.match(HTML, /data-page="biometrics"[\s\S]*id="bio-root"/);
});

/* ---- About you: the athlete record and its own consent ---- */

test('About you reaches the account only with both consents', () => {
  /* Weight and height are health data. Plan sync's consent did not cover them,
     so a write needs the second one too. Reading back and withdrawing need only
     sync consent: the stored copy itself says whether the second was given. */
  assert.match(fnBody('pushAthlete'), /hasSyncConsent\(\)[\s\S]*hasHealthConsent\(\)/);
  for (const fn of ['pullAthlete', 'withdrawCloudAthlete']) {
    assert.match(fnBody(fn), /hasSyncConsent\(\)/, `${fn} no longer checks hasSyncConsent()`);
  }
  assert.match(HTML, /const hasHealthConsent = \(\) =>\s*hasSyncConsent\(\) &&/,
    'health consent must never stand without sync consent');
});

test('About you is never put on a plan or handed to the coach', () => {
  const src = withoutComments(HTML);
  assert.doesNotMatch(src, /\bplan\.athlete\b/);
  assert.doesNotMatch(src, /athlete:\s*loadAthlete\(\)[\s\S]{0,40}persistPlan/);
  for (const m of src.matchAll(/createSession\(([^)]*)\)/g)) {
    assert.doesNotMatch(m[1], /athlete/i, 'the coach session must not be given About you');
  }
});

test('erasing cloud data takes About you with it', () => {
  const erase = HTML.match(/async eraseEverything\(\)\s*\{([\s\S]*?)const user = auth\.currentUser/);
  assert.ok(erase, 'eraseEverything is gone or reshaped');
  assert.match(erase[1], /deleteDoc\(doc\(db, 'users', uid, 'athlete', 'profile'\)\)/);
  assert.match(fnBody('eraseCloudData'), /forgetHealthConsent\(\)/);
});

test('the privacy notice describes About you and its separate consent', () => {
  const notice = noticeText();
  assert.match(notice, /\['About you\.'/);
  assert.match(notice, /health data/);
  assert.match(notice, /consent of its own/);
  assert.match(notice, /never in a plan export/);
});

test('the Firestore rules let each user reach only their own documents', () => {
  const rules = readFileSync(new URL('firestore.rules', ROOT), 'utf8');
  const blocks = [...rules.matchAll(/match \/users\/\{userId\}\/(\w+)\/\{\w+\}\s*\{([^}]*)\}/g)];
  assert.deepEqual(blocks.map((b) => b[1]).sort(), ['athlete', 'plans']);
  for (const [, path, body] of blocks) {
    assert.match(body, /request\.auth != null\s*&& request\.auth\.uid == userId/, `${path} is not owner-only`);
  }
});

test('a confirmation opens above the panel that asked for it', () => {
  // Both roots use a fixed backdrop and #panel-root comes later in the
  // document, so at equal z-index a question asked from a panel is buried.
  const at = (id) => HTML.indexOf(`<div id="${id}">`);
  assert.ok(at('panel-root') > at('dialog-root'), 'the roots were reordered; re-check this rule');
  const rule = HTML.match(/#dialog-root \.modal-backdrop\s*\{\s*z-index:\s*(\d+)/);
  const panel = HTML.match(/\.pnl-back \{[^}]*z-index:\s*(\d+)/);
  assert.ok(rule && panel);
  assert.ok(Number(rule[1]) > Number(panel[1]));
});

/* ---- long days and sessions a day ---- */

test('Plan setup reads the long days and the sessions-a-day cap', () => {
  // The form and the preview read one function; a field it forgets would be
  // shown and then silently dropped on Preview.
  const body = fnBody('setupProfile');
  assert.match(body, /longDays:\s*\{\s*Bike:\s*\$\('f-long-ride'\)\.value,\s*Run:\s*\$\('f-long-run'\)\.value\s*\}/);
  assert.match(body, /maxSessionsPerDay:\s*\$\('f-per-day'\)\.value/);
  const panel = fnBody('openSetupPanel');
  for (const id of ['f-long-ride', 'f-long-run', 'f-per-day']) assert.match(panel, new RegExp(`id="${id}"`));
});

/* ---- the onboarding wizard ---- */

test('the wizard saves through the same doors as everything else', () => {
  const body = fnBody('finishWizard');
  // About you goes to the athlete record, never onto the plan.
  assert.match(body, /saveAthleteLocal\(athleteFromAnswers\(/);
  assert.doesNotMatch(body, /built\.athlete|athlete:\s*athleteFromAnswers/);
  // The account copy only under both consents, the plan through addPlan after
  // the stand-in is dropped — the order every new plan follows.
  assert.match(body, /hasSyncConsent\(\)[\s\S]*pushAthlete\(\)/);
  assert.match(body, /replaceCurrentPlan\(built\)/);
});

test('the wizard is reachable from first visit, first sign-in and the plan switcher', () => {
  assert.match(fnBody('maybeShowFirstRun'), /maybeStartWizard\(\)/);
  assert.match(fnBody('pullFromCloud'), /maybeStartWizard\(\)/);
  assert.match(fnBody('openStartOverDialog'), /currentPlanUntouched\(\)\) return openWizard\(\)/);
  // It opens by itself only for somebody new, and never twice.
  assert.match(fnBody('maybeStartWizard'), /orientDone\(\)[\s\S]*planIsUntouched\(\)/);
});

test('every step the engine names has a body in the page', () => {
  const steps = HTML.match(/const WIZ_STEP_HTML = \{([\s\S]*?)\n  \};/);
  assert.ok(steps, 'WIZ_STEP_HTML is gone');
  for (const s of ['welcome', 'about', 'background', 'thresholds', 'week', 'races', 'goal']) {
    assert.match(steps[1], new RegExp(`\\n    ${s}\\(\\) \\{`), `no body for ${s}`);
  }
});

/* ---- weekly release ---- */

test('a week after the release horizon shows no sessions, on the board or in the month', () => {
  assert.match(fnBody('renderBoard'), /if \(!isReleased\(plan, state\.week\)\)/);
  assert.match(fnBody('renderCalendar'), /if \(!isReleased\(plan, w\.absWeek\)\) continue;/);
});

test('a release goes through applyDraft, with an undo, and nothing else writes it but the toggle in the plan’s … menu', () => {
  const body = fnBody('applyRelease');
  assert.match(body, /applyDraft\(plan, r\.draft/);
  assert.match(body, /pendingUndo = \{ kind: 'refit'/);
  const writes = withoutComments(HTML).match(/plan\.release = /g) || [];
  assert.equal(writes.length, 1, 'only toggleRelease sets the horizon directly');
  assert.match(fnBody('toggleRelease'), /plan\.release = /);
});

test('Plan setup and race changes keep the weeks already trained', () => {
  assert.match(fnBody('previewRefit'), /refit\(\{ \.\.\.plan, events \}, \{\s*profile, keepBefore: trainedWeeks\(\)/);
  assert.match(fnBody('applyEvents'), /keepBefore: trainedWeeks\(\)/);
});

/* ---- The redesign's tokens, icons and theme ---- */

const SHELL_CSS = readFileSync(new URL('assets/app-shell.css', ROOT), 'utf8');

test('icons are CSS masks: no icon font is loaded and no Phosphor class is left', () => {
  assert.ok(!/phosphor/i.test(HTML), 'index.html still loads or names Phosphor');
  assert.ok(!/\bclass="[^"]*\bph\b/.test(HTML) && !/class="ph /.test(HTML), 'a Phosphor `ph` class is still used');
  assert.ok(!/\bph-[a-z]/.test(HTML), 'a `ph-*` icon name is still used');
});

test('every icon the page names is drawn in app-shell.css', () => {
  const drawn = new Set([...SHELL_CSS.matchAll(/^\.(i-[a-z0-9-]+)\s*\{/gm)].map((m) => m[1]));
  // Literal uses ("ic i-x") and the names the page passes around ('i-x').
  const used = new Set([...HTML.matchAll(/\bi-[a-z][a-z0-9-]*/g)].map((m) => m[0]));
  const missing = [...used].filter((n) => !drawn.has(n));
  assert.deepEqual(missing, [], `icons used by index.html but not drawn: ${missing.join(', ')}`);
});

test('the theme is set before first paint and has two palettes', () => {
  const headEnd = HTML.indexOf('</head>');
  const early = HTML.slice(0, headEnd);
  assert.match(early, /<script>[\s\S]*data-theme[\s\S]*<\/script>/, 'no pre-paint theme script in <head>');
  assert.match(early, /app-shell\.css/, 'app-shell.css is not linked in <head>');
  assert.match(SHELL_CSS, /:root\s*\{[\s\S]*?--color-accent:/);
  assert.match(SHELL_CSS, /:root\[data-theme="light"\]\s*\{[\s\S]*?--color-accent:/);
});

test('the page paints with tokens, not colour literals, so both themes follow', () => {
  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:white|black)\b(?!-)/g) || [];
  // The only literals allowed are the fallbacks after a token in `.pnl`.
  // Anything else belongs in app-shell.css.
  assert.deepEqual(literals.filter((l) => !/^#1b1e2b$|^#e8e9f0$/i.test(l)), [], 'a colour literal crept into the page styles');
  assert.ok(!/DISC\s*=\s*\{[^}]*#[0-9a-f]{6}/i.test(HTML), 'discipline colours are hard-coded again');
});

/* ---- The shell: sidebar, pages and routes ---- */

test('every id in the static markup is unique', () => {
  // The markup only: the page script builds panels from templates that repeat
  // ids on purpose, because only one of them is ever in the document.
  const markup = HTML.slice(0, HTML.indexOf('<script type="module">'));
  const seen = new Map();
  for (const m of markup.matchAll(/\bid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('every sidebar route has a page, and every page has a route', () => {
  const routes = [...HTML.matchAll(/\bdata-route="([a-z]+)"/g)].map((m) => m[1]);
  const pages = new Set([...HTML.matchAll(/\bdata-page="([a-z]+)"/g)].map((m) => m[1]));
  assert.ok(routes.length >= 5, 'the sidebar lost its page links');
  for (const r of routes) {
    // Calendar is the week page in its Month view, not a page of its own.
    const page = r === 'calendar' ? 'week' : r;
    assert.ok(pages.has(page), `route "${r}" has no [data-page="${page}"]`);
  }
  for (const p of pages) assert.ok(routes.includes(p), `page "${p}" is not reachable from the sidebar`);
  const known = HTML.match(/const ROUTES = \[([^\]]*)\]/);
  assert.ok(known, 'the page script lost its ROUTES list');
  for (const r of routes) assert.ok(known[1].includes(`'${r}'`), `ROUTES does not know "${r}"`);
});

test('the dialog roots sit outside every page, so a hidden page cannot hide a dialog', () => {
  for (const id of ['modal-root', 'dialog-root', 'panel-root']) {
    const at = HTML.indexOf(`id="${id}"`);
    const mainEnd = HTML.indexOf('</main>');
    assert.ok(at > mainEnd, `#${id} is inside <main>, where a hidden page would hide it`);
  }
});

test('Plan setup, Coach and Garmin keep their ids in the sidebar, and the Garmin item starts hidden', () => {
  const side = HTML.slice(HTML.indexOf('<nav class="side"'), HTML.indexOf('</nav>'));
  for (const id of ['setup-btn', 'coach-btn', 'garmin-btn', 'theme-seg', 'account', 'mydata-btn']) {
    assert.ok(side.includes(`id="${id}"`), `#${id} is not in the sidebar`);
  }
  assert.match(side, /class="nav hidden" id="garmin-btn"/);
});

test('the app opens on the current week without writing the plan', () => {
  // applyRoute(…, true) is the boot call: it must return before persistPlan().
  const fn = HTML.slice(HTML.indexOf('function applyRoute('), HTML.indexOf('function navigate('));
  assert.ok(fn.indexOf('if (boot) return;') > -1 && fn.indexOf('if (boot) return;') < fn.indexOf('persistPlan()'),
    'booting must not persist: a reload is not an edit, and a write is a cloud push');
  assert.match(HTML, /applyRoute\(routeFromHash\(\), true\);\s*renderAll\(\);/);
});

/* ---- The phone layout ---- */

test('the phone has a tab bar with the four pages and a More sheet, and a day strip for the board', () => {
  const bar = HTML.slice(HTML.indexOf('<nav class="tabbar"'), HTML.indexOf('</nav>', HTML.indexOf('<nav class="tabbar"')));
  for (const r of ['week', 'status', 'biometrics', 'health']) assert.ok(bar.includes(`data-route="${r}"`), `the tab bar has no ${r} tab`);
  assert.ok(bar.includes('id="tab-more"'), 'the tab bar has no More button');
  assert.match(HTML, /id="dstrip"/);
  assert.match(HTML, /<meta name="viewport"[^>]*viewport-fit=cover/, 'the tab bar needs the safe-area inset');
});

test('the sidebar is the phone sheet, so nothing in it can be missing on a phone', () => {
  // One nav, two presentations: if the sheet were a copy it could drift from the sidebar.
  assert.equal((HTML.match(/<nav class="side"/g) || []).length, 1);
  assert.match(SHELL_CSS, /body\.more-open \.side-wrap \{ display: flex; \}/);
  assert.match(SHELL_CSS, /@media \(max-width: 760px\)[\s\S]*\.im-board \.im-col\.m-on \{ display: flex; \}/);
});

/* ---- Pairing the bridge from a link ---- */

test('a pairing link is read by the engine, saved to the one place a pairing lives, and removed from the address bar', () => {
  const body = fnBody('maybeOpenGarminSetup');
  assert.match(body, /parsePairing\(location\.hash\)/);
  assert.match(body, /save\(GARMIN_CONFIG_KEY, pairing\)/);
  // The fragment is replaced before anything else can show it.
  assert.ok(body.indexOf('history.replaceState') > -1 && body.indexOf('history.replaceState') < body.indexOf('save(GARMIN_CONFIG_KEY'),
    'the address bar is cleaned before the token is stored');
  assert.doesNotMatch(body, /setStatus\([^)]*token|console\.[a-z]+\([^)]*(pairing|token)/i, 'the token must never be shown or logged');
});

test('the loopback rule for a pairing is the engine\'s, not a copy', () => {
  assert.match(HTML, /const GARMIN_URL_RE = BRIDGE_URL_RE;/);
  assert.doesNotMatch(HTML, /GARMIN_URL_RE = \/\^http/, 'the page has its own loopback pattern again');
});

/* ---- The bridge's state in the page ---- */

test('the bridge is only asked about by a browser that has been paired', () => {
  const check = fnBody('checkBridge');
  assert.match(check, /if \(!cfg\)[\s\S]*?return/, 'checkBridge must stop before any request when nothing is paired');
  assert.ok(check.indexOf('if (!cfg)') < check.indexOf('bridgeFetch('), 'the pairing check comes first');
  // Every place it is started is gated on a pairing or follows one.
  assert.match(HTML, /if \(garminConfig\(\)\) checkBridge\(\);/);
  assert.match(HTML, /if \(garminConfig\(\) && Date\.now\(\) - bridgeCheckedAt > 30000\) checkBridge\(\)/);
});

test('the state is words, not only a colour, and comes from the engine', () => {
  assert.match(fnBody('checkBridge'), /bridgeState\(/);
  assert.match(fnBody('renderBridgeState'), /textContent = b\.label/);
  assert.match(HTML, /id="garmin-state" role="status"/);
  assert.match(HTML, /<div class="row"><span>Bridge<\/span><b id="gm-state">/);
});

test('the page asks for no annual hours and says nothing about them', () => {
  const src = withoutComments(HTML);
  assert.doesNotMatch(src, /f-annual|estimateAnnualHours|set_annual_hours|seasonFit|annualHours/);
  assert.doesNotMatch(HTML, /[Aa]nnual hours/);
});

/* ---- where a new plan starts ---- */

test('a plan the page makes on its own starts next Monday, not the Monday before today', () => {
  // `mondayOf(today)` is the Monday before today, which starts a plan six days
  // in the past on a Sunday. The default is dates.js's nextMonday.
  const line = HTML.split('\n').find((l) => /const defaultStart = /.test(l));
  assert.ok(line, 'the page still has a defaultStart');
  assert.match(line, /nextMonday\(/, 'defaultStart asks nextMonday');
  assert.doesNotMatch(line, /getDay|since|-since/, 'and no longer walks back to the Monday before');
  assert.match(HTML, /import \{[^}]*\bnextMonday\b[^}]*\} from '\.\/assets\/coach\/dates\.js'/, 'nextMonday is imported from dates.js');
});

/* ---- A and B races ---- */

test('races are called A and B on screen, and stored as primary and secondary', () => {
  assert.match(HTML, /PRIORITY_LABELS = \{ primary: 'A race \(target\)', secondary: 'B race \(fitness test\)' \}/);
  assert.match(HTML, /<option value="primary"/, 'the stored value is still primary');
  assert.match(HTML, /<option value="secondary"/, 'and secondary');
  assert.doesNotMatch(HTML, /value="a"|value="b"|priority: 'A'|priority: 'B'|'A race'\s*:|'B race'\s*:/, 'no stored key was renamed');
});

test('the event panel keeps what it does not show when a race is edited', () => {
  const body = HTML.slice(HTML.indexOf('function saveEventFromPanel'), HTML.indexOf('function saveEventFromPanel') + 900);
  assert.match(body, /\.\.\.\(state\.events\.find\(\(x\) => x\.id === id\) \|\| \{\}\)/, 'the saved event starts from the one being edited');
});

test('the wizard does not open on the shortest main race just because it is first in the list', () => {
  assert.doesNotMatch(HTML, /(?<!SECONDARY_)RACE_TYPES\[0\]/);
});

/* ---- the planner and heart rate ---- */

test('the page never hands a heart-rate store to what builds or re-sizes a season', () => {
  // The start fitness and the per-week figures are stored on the plan, which syncs
  // and exports. They are worked out from power, pace, swim pace and session effort
  // only, and nothing that takes a heart-rate store is called with one.
  for (const fn of ['startFitness', 'actualCtlAt', 'planSeason', 'planLevers', 'buildPlanFromAnswers', 'newPlan', 'refit', 'proposeNextWeek']) {
    const calls = [...HTML.matchAll(new RegExp(`\\b${fn}\\(([^;]*?)\\)\\s*[;)]`, 'g'))].map((m) => m[1]);
    for (const args of calls) assert.doesNotMatch(args, /hrById|hrThresholds|hrStore/, `${fn}(${args.slice(0, 60)}…)`);
  }
});

test('the engine modules that store a figure on a plan do not import the heart-rate store', () => {
  for (const file of ['startfit.js', 'backplan.js', 'targets.js', 'races.js']) {
    const src = readFileSync(new URL(`assets/coach/${file}`, ROOT), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /hrById|hrThresholds|activity_hr|normalizeHrThresholds/, file);
  }
});

/* ---- Phase 5: the target on screen ---- */

const section = (from, to) => {
  const a = HTML.indexOf(from);
  const b = HTML.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} is where this test looks`);
  return HTML.slice(a, b);
};

test('the wizard asks how hard to build, between the races and the goal', () => {
  assert.match(HTML, /ambition: 'How hard to build'/, 'the step has a title');
  const body = section('const WIZ_STEP_HTML = {', '  const WIZ_STEP_BIND = {');
  assert.match(body, /\n    ambition\(\) \{/);
  assert.match(body, /name="wz-amb"/, 'a choice among the levels');
  assert.match(body, /ambitionOptions\(r\.raceType\)/, 'offered for the race being built for, with the target each sets');
  assert.match(fnBody('readWizardStep'), /case 'ambition'/);
  assert.match(fnBody('readWizardStep'), /input\[name="wz-amb"\]:checked/);
});

test('the races step has a start date, and only a date the athlete changed it to is kept', () => {
  const body = section('const WIZ_STEP_HTML = {', '  const WIZ_STEP_BIND = {');
  assert.match(body, /id="wz-startdate"/);
  assert.match(fnBody('readWizardStep'), /v\('wz-startdate'\) !== nextMonday\(wizToday\(\)\)/, 'the default is not an answer');
  assert.match(HTML, /\['wz-racedate', 'wz-racetype', 'wz-startdate'\]/, 'the length is redrawn as the date is typed');
});

test('the review shows the target, where the athlete starts from, and a way to replace it', () => {
  const review = fnBody('wizReviewHTML');
  assert.match(review, /targetFactsHTML\(built\.target/);
  assert.match(review, /targetBlockHTML\(built\.target/);
  assert.match(review, /targetSparkHTML\(built\.season, built\.target\)/, 'the planned line against the target');
  assert.match(review, /startFitnessFor\(/, 'the sentence about where the start came from');
  assert.match(review, /id="wz-startctl"/);
  assert.match(review, /id="wz-startctl-set"/);
  assert.match(review, /planReview\(built, \{ levers: true \}\)/, 'what would help, only when the target cannot be reached');
  assert.match(HTML, /startCtlEntered = Number\(x\)/);
});

test('Plan setup shows the target and builds an old season to one only when asked', () => {
  const setup = fnBody('setupTargetHTML');
  assert.match(setup, /id="f-ambition"/);
  assert.match(setup, /id="f-startctl"/);
  assert.match(setup, /id="f-target-on"/, 'a plan sized the old way is offered a target, not given one');
  const preview = fnBody('previewRefit');
  assert.match(preview, /const upgrade = !plan\.target && !!\$\('f-target-on'\) && \$\('f-target-on'\)\.checked/);
  assert.match(preview, /upgrade: true/);
  assert.match(preview, /source: 'entered'/, 'a typed number is the athlete\'s own');
});

test('the review of a change says what the season is now built to, and whether it can be reached', () => {
  assert.match(fnBody('renderDiff'), /draftTargetHTML\(\)/);
  const body = fnBody('draftTargetHTML');
  assert.match(body, /leversFor\(draft\)/);
  assert.match(body, /This also builds the season to a target fitness/);
});

test('the event panel sets how hard to aim, for the main race, and the time a race is expected to take', () => {
  const panel = fnBody('openEventPanel');
  assert.match(panel, /id="ev-amb"/);
  assert.match(panel, /id="ev-time"/);
  const save = fnBody('saveEventFromPanel');
  assert.match(save, /ambition: isMain/, 'only the main race carries one');
  assert.match(save, /expectedMinutes: minutes > 0 \? minutes : undefined/, 'and it may be cleared');
  const apply = fnBody('applyEvents');
  assert.match(apply, /aimed\(plan\.events\) !== aimed\(next\)/, 'changing either re-sizes the season');
  assert.match(apply, /upgrade: true/, 'a change of race is one of the changes that builds a season to a target');
  assert.match(apply, /landingsDetail\(/, 'and a race whose taper changes moves the season even if its week does not');
});

test('the race this season is for is shown above the week and the month, with its target', () => {
  const at = HTML.indexOf('id="race-label"');
  assert.ok(at > 0 && at < HTML.indexOf('id="summary"'), 'above the summary, so above both views');
  assert.match(fnBody('renderAll'), /renderRaceLabel\(\)/);
  const body = fnBody('raceLabelHTML');
  assert.match(body, /fmtLongDate\(main\.date\)/);
  assert.match(body, /Target fitness/);
  assert.match(body, /the plan reaches about/, 'and says so when it falls short');
});

test('the Fitness chart marks the plan target on race day, and says so in words', () => {
  const chart = fnBody('fitnessChart');
  assert.match(chart, /plan\.target/);
  const section2 = section('/* ---- Fitness, fatigue and form', '/* ---- Init ---- */');
  assert.match(section2, /Plan target/);
  assert.match(section2, /The plan target is /, 'for a screen reader too');
});

test('where the athlete starts from is worked out with no heart-rate store', () => {
  const body = fnBody('startFor');
  assert.match(body, /startFitness\(/);
  assert.doesNotMatch(body, /hrById|hrThresholds|readHrStore|HR_/);
});

test('a change that moves only the target can still be applied', () => {
  const body = fnBody('renderDiff');
  assert.match(body, /const targetMoves = /);
  assert.match(body, /\(!d\.weeks\.length && !targetMoves\) \? ' disabled'/, 'Apply is not disabled when only the target moves');
  assert.match(body, /d\.weeks\.length \|\| targetMoves/, 'and it is wired up');
  assert.match(body, /No week changes, but what the season is built to does/);
});
