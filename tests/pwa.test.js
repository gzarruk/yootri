import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

/* What makes yootri installable and openable offline: the manifest, the icons it
   names, the service worker's list of files, and the tags that link them. The
   behaviour itself (install, offline reload) is a browser check — see the
   checklist at the bottom of this file. */

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const MANIFEST = JSON.parse(read('manifest.webmanifest'));
const HTML = read('index.html');
const SW = read('sw.js');

const pngSize = (rel) => {
  const b = readFileSync(new URL(rel, ROOT));
  assert.equal(b.subarray(1, 4).toString(), 'PNG', rel + ' is a PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

test('manifest: installable, relative, matches the app', () => {
  assert.equal(MANIFEST.display, 'standalone');
  assert.ok(MANIFEST.name && MANIFEST.short_name);
  for (const k of ['start_url', 'scope', 'id']) {
    assert.ok(!/^(\/|[a-z]+:)/i.test(MANIFEST[k]), `${k} must be relative (works on a sub-path)`);
  }
  assert.equal(MANIFEST.theme_color, '#161826');
  assert.equal(MANIFEST.background_color, '#161826');
});

test('manifest: 192, 512 and a maskable icon, all present at their stated size', () => {
  const by = (size, purpose) => MANIFEST.icons.find((i) => i.sizes === size && i.purpose === purpose);
  for (const [size, purpose] of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) {
    const icon = by(size, purpose);
    assert.ok(icon, `${size} ${purpose} icon listed`);
    assert.ok(!/^(\/|[a-z]+:)/i.test(icon.src), 'icon path is relative');
    assert.deepEqual(pngSize(icon.src), size.split('x').map(Number));
  }
  assert.deepEqual(pngSize('assets/apple-touch-icon.png'), [180, 180]);
});

test('index.html links the manifest and the iOS install tags', () => {
  assert.match(HTML, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(HTML, /<link rel="apple-touch-icon" href="assets\/apple-touch-icon\.png"/);
  assert.match(HTML, /<meta name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(HTML, /<meta name="apple-mobile-web-app-status-bar-style" content="[a-z-]+"/);
  assert.match(HTML, /<meta name="apple-mobile-web-app-title" content="yootri"/);
  assert.match(HTML, /<meta name="viewport" content="width=device-width, initial-scale=1\.0[^"]*viewport-fit=cover"/);
  assert.match(HTML, /navigator\.serviceWorker\.register\('sw\.js'\)/, 'the page registers sw.js by a relative path');
});

test('sw.js: every file it precaches exists, and nothing the page needs is left out', () => {
  const listed = [...SW.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]).filter((p) => !p.startsWith('http'));
  const shell = listed.slice(listed.indexOf('./'));
  for (const p of shell) if (p !== './') assert.ok(existsSync(new URL(p, ROOT)), `${p} is in the repo`);
  for (const f of readdirSync(new URL('assets/coach/', ROOT)).filter((f) => f.endsWith('.js'))) {
    assert.ok(shell.includes('assets/coach/' + f), `assets/coach/${f} is precached — the engine would not load offline without it`);
  }
  for (const p of ['index.html', 'privacy.html', 'manifest.webmanifest', 'assets/nocturne.css', 'assets/app-shell.css', 'assets/privacy.js']) {
    assert.ok(shell.includes(p), `${p} is precached`);
  }
});

test('sw.js: versioned cache, old caches cleaned, relative paths', () => {
  assert.match(SW, /const VERSION = '[^']+'/);
  assert.match(SW, /const CACHE = 'yootri-shell-' \+ VERSION/);
  assert.match(SW, /caches\.delete/);
  assert.doesNotMatch(SW, /(?:'|")\/(?:index|assets|manifest)/, 'no root-absolute paths: the site may sit under a sub-path');
});

test('sw.js: only this site and public CDN code are cached; user data is never touched', () => {
  assert.match(SW, /req\.method !== 'GET'\) return/, 'writes go straight to the network');
  assert.match(SW, /headers\.has\('authorization'\)\) return/);
  assert.match(SW, /cache === 'no-store'\) return/);
  assert.match(SW, /!same && !cdnAllowed\(url\)\) return/, 'every other origin is left alone');
  const origins = [...SW.matchAll(/\['(https:\/\/[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(origins.sort(), ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://www.gstatic.com']);
  const code = SW.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const host of ['firestore.googleapis.com', 'identitytoolkit', 'anthropic', 'openai', '127.0.0.1']) {
    assert.ok(!code.includes(host), `${host} is not named: it is never intercepted`);
  }
});

test('the Firebase SDK the page imports is a version the worker caches by path', () => {
  const urls = [...HTML.matchAll(/'(https:\/\/www\.gstatic\.com\/[^']+)'/g)].map((m) => new URL(m[1]).pathname);
  assert.ok(urls.length >= 3);
  for (const p of urls) assert.ok(p.startsWith('/firebasejs/'), p);
});

test('offline: sync and coach say so calmly', () => {
  assert.match(HTML, /OFFLINE_NOTE = 'Offline — saved on this device/);
  assert.match(HTML, /The coach needs a connection/);
});

/* Browser checklist (not automated — needs a real device or Lighthouse):
   1. `make dev`, then in the console `localStorage.yootri_sw = '1'` and reload:
      the service worker registers (the worker is off on localhost otherwise).
   2. Lighthouse → PWA: installable, manifest valid, works offline.
   3. DevTools → Network → Offline, reload: the app opens; sync reads "Offline —".
   4. iPhone Safari → Share → Add to Home Screen; Android Chrome → Install app.
   5. 360px wide: no sideways scroll on Week, Calendar, Fitness, Status. */
