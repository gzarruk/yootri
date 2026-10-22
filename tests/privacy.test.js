import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  PRIVACY_VERSION, PRIVACY_CONTACT, PRIVACY_REGION,
  PRIVACY_SECTIONS, privacySectionsHtml, privacyRightsHtml,
} from '../assets/privacy.js';

/* The privacy notice is shown twice: in the app's footer panel and on its own
   page, privacy.html, whose address a third-party listing can point at. Both
   draw it from assets/privacy.js, so there is one text to keep true. */

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const HTML = read('index.html');

test('the notice is versioned and its two deployment facts are filled in', () => {
  assert.equal(PRIVACY_VERSION, '2026-10-11');
  assert.notEqual(PRIVACY_CONTACT.trim(), '');
  assert.notEqual(PRIVACY_REGION.trim(), '');
  const text = PRIVACY_SECTIONS().map(([head, body]) => `${head} ${body}`).join('\n');
  assert.ok(text.includes(PRIVACY_CONTACT), 'the contact route is in the notice');
  assert.ok(text.includes(PRIVACY_REGION), 'the region is in the notice');
  assert.doesNotMatch(text, /BEFORE PUBLISHING/, 'a placeholder marker is showing');
});

test('the markup is escaped text in the shape the panel has always drawn', () => {
  const html = privacySectionsHtml();
  assert.ok(html.startsWith('<div class="legal"><p><b>Who is responsible.</b> '));
  assert.ok(html.endsWith('</p></div>'));
  assert.equal(html.match(/<p>/g).length, PRIVACY_SECTIONS().length);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /Gustavo Zarruk/);
  assert.match(privacyRightsHtml(), /^<p class="legal-about"><b>Your rights\.<\/b> /);
  assert.match(privacyRightsHtml(), /Datatilsynet/);
});

test('on its own page the notice does not point at a button that is not there', () => {
  assert.match(privacyRightsHtml(), /Deletion is the button below\./, 'the app panel keeps its sentence');
  const alone = privacyRightsHtml({ standalone: true });
  assert.doesNotMatch(alone, /button below/);
  assert.match(alone, /Delete my cloud data/);
  assert.equal(privacyRightsHtml().replace('Deletion is the button below. ', ''), alone.replace(/Deletion is <b>.*?signed in\. /, ''),
    'the two differ only in the sentence about deletion');
});

test('the app takes the notice from the shared module and keeps no copy of its own', () => {
  assert.match(HTML, /from '\.\/assets\/privacy\.js'/);
  for (const name of ['PRIVACY_SECTIONS', 'PRIVACY_CONTACT', 'PRIVACY_REGION']) {
    assert.doesNotMatch(HTML, new RegExp(`const\\s+${name}\\s*=`), `${name} is defined in index.html again`);
  }
  assert.doesNotMatch(HTML, /const PRIVACY_VERSION\s*=/);
  assert.doesNotMatch(HTML, /Who is responsible\./, 'the notice text is back in index.html');
});

const PAGE = existsSync(new URL('../privacy.html', import.meta.url)) ? read('privacy.html') : '';

test('privacy.html is a standalone page drawn from the same module', () => {
  assert.notEqual(PAGE, '', 'privacy.html is missing');
  assert.match(PAGE, /^<!DOCTYPE html>/i);
  assert.match(PAGE, /<html lang="en">/);
  assert.match(PAGE, /<meta name="viewport"/);
  assert.match(PAGE, /<title>[^<]*[Pp]rivacy[^<]*<\/title>/);
  assert.match(PAGE, /<script type="module">[\s\S]*from '\.\/assets\/privacy\.js'/);
  assert.match(PAGE, /privacySectionsHtml\(\)/);
  assert.match(PAGE, /privacyRightsHtml\(\{ standalone: true \}\)/);
  assert.match(PAGE, /PRIVACY_VERSION/);
  assert.doesNotMatch(PAGE, /Who is responsible\./, 'the notice text is copied into the page');
});

test('privacy.html uses the Nocturne styles and only relative paths of its own', () => {
  assert.match(PAGE, /<link rel="stylesheet" href="assets\/nocturne\.css"/);
  assert.match(PAGE, /<link rel="icon" href="assets\/favicon\.svg"/);
  // Every href, src and import the page makes of its own is relative: it is
  // served from a custom domain today and has to survive being served from a path.
  const refs = [...PAGE.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3);
  for (const ref of refs) assert.doesNotMatch(ref, /^(?:[a-z][a-z0-9+.-]*:|\/)/i, `${ref} is not relative`);
  assert.doesNotMatch(PAGE, /from\s+['"](?:https?:)?\/\//, 'a module is imported from elsewhere');
  assert.doesNotMatch(PAGE, /fonts\.googleapis|fonts\.gstatic/, 'the notice page makes no third-party request');
});

test('privacy.html links back to the app and every file it names exists', () => {
  assert.match(PAGE, /<a [^>]*href="\.\/"[^>]*>/, 'no link back to the app');
  const refs = [...PAGE.matchAll(/\b(?:href|src)="([^"#]+)"/g)].map((m) => m[1]).filter((r) => r !== './');
  for (const ref of refs) assert.ok(existsSync(new URL(`../${ref}`, import.meta.url)), `${ref} is not in the repo`);
});

test('what the page and the module add says nothing about licence or price, and names one address', () => {
  for (const [where, text] of [['privacy.html', PAGE], ['privacy.js', read('assets/privacy.js')]]) {
    assert.doesNotMatch(text, /open[- ]source|\bfree\b|\bfreely\b|licen[cs]e|\bMIT\b/i, `${where} describes the licence or price`);
    const addresses = new Set(text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []);
    for (const a of addresses) assert.equal(a, PRIVACY_CONTACT, `${where} names ${a}`);
  }
});
