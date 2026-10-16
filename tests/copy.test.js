import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BRIDGE_ERROR_CODES, bridgeErrorMessage } from '../assets/coach/synced.js';

/* Wording yootri does not use about training: nothing it says may read as a
   medical claim or a promise about performance or health. This checks the
   words the workout export adds — the engine module, the bridge's error
   sentences, and the page's "Workouts to Garmin" section — and the words About
   you and the onboarding wizard add, which sit closest to the body: the
   athlete and onboarding modules, their panels and the About you privacy
   notice item — and, closest of all, what sleep and overnight heart rate add:
   the engine module, the bridge's mapper, the page's section and the notice
   item. Not the whole app. */

const FORBIDDEN = [
  /injur/i, /readiness/i, /recovery monitor/i, /diagnos/i, /medical/i, /clinical/i,
  /guarantee/i, /prevent/i, /overtrain/i, /\bcure/i, /health score/i, /optimi[sz]e your/i,
  // Garmin's own readings of the nights, which yootri neither reads nor repeats.
  /body battery/i, /sleep score/i, /hrv status/i, /stress level/i,
];

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function surfaces() {
  const html = read('../index.html');
  const from = html.indexOf('/* ---- Workouts to Garmin');
  const to = html.indexOf('const MATCH_REASONS');
  assert.ok(from > 0 && to > from, 'the Workouts to Garmin section is still where this test looks');
  const privacy = html.match(/\['Workouts sent to Garmin\.',[\s\S]*?\],\n/);
  assert.ok(privacy, 'the privacy notice describes workouts');
  const relFrom = html.indexOf('/* ---- Weekly release');
  const wizFrom = html.indexOf('/* ---- Onboarding wizard');
  assert.ok(relFrom > 0 && wizFrom > relFrom, 'the weekly release section is still where this test looks');
  const aboutFrom = html.indexOf('/* ---- About you');
  assert.ok(wizFrom > 0 && aboutFrom > wizFrom, 'the onboarding wizard section is still where this test looks');
  const aboutTo = html.indexOf('/* ---- Training paces');
  assert.ok(aboutFrom > 0 && aboutTo > aboutFrom, 'the About you section is still where this test looks');
  const aboutNotice = html.match(/\['About you\.',[\s\S]*?\],\n/);
  assert.ok(aboutNotice, 'the privacy notice describes About you');
  const nightsFrom = html.indexOf('/* ---- Sleep and overnight heart rate');
  assert.ok(nightsFrom > 0 && from > nightsFrom, 'the overnight section is still where this test looks');
  const nightsNotice = html.match(/\['Sleep and overnight heart rate from Garmin\.',[\s\S]*?\],\n/);
  assert.ok(nightsNotice, 'the privacy notice describes sleep and overnight heart rate');
  return {
    'workout.js': read('../assets/coach/workout.js'),
    'athlete.js': read('../assets/coach/athlete.js'),
    'index.html workout section': html.slice(from, to),
    'index.html About you section': html.slice(aboutFrom, aboutTo),
    'index.html onboarding wizard': html.slice(wizFrom, aboutFrom),
    'index.html weekly release': html.slice(relFrom, wizFrom),
    'review.js': read('../assets/coach/review.js'),
    'onboarding.js': read('../assets/coach/onboarding.js'),
    'privacy notice': privacy[0],
    'privacy notice, About you': aboutNotice[0],
    'index.html overnight section': html.slice(nightsFrom, from),
    'privacy notice, overnight': nightsNotice[0],
    'overnight.js': read('../assets/coach/overnight.js'),
    'bridge overnight.py': read('../tools/garmin-bridge/garmin_bridge/overnight.py'),
    'bridge messages': BRIDGE_ERROR_CODES.map((c) => bridgeErrorMessage(c)).join('\n'),
  };
}

test('workout export wording makes no medical or performance claims', () => {
  for (const [where, text] of Object.entries(surfaces())) {
    for (const re of FORBIDDEN) {
      const hit = text.match(re);
      assert.equal(hit, null, `${where} says "${hit && hit[0]}"`);
    }
  }
});

/* The Training status and Health indicator pages, the sample fitness cards and
   chart, and the Season panel show numbers that are not worked out from
   anything yet. They sit closest to the body and to performance claims, so the
   list here is stricter than the one above: no recovery or readiness talk, no
   promise about what a number means for an athlete, and no named standard a
   reader could take as a target. */

const STRICTER = [
  ...FORBIDDEN,
  /recover/i, /wellness/i, /overreach/i, /\brisk/i, /\btreat/i, /therap/i, /rehab/i, /RED-S/i, /screen/i,
  /competitive/i, /kona/i, /qualif/i, /comfortabl/i, /enjoy/i, /worn down/i, /carrying too much/i, /earliest sign/i,
];

test('the sample fitness surfaces make no claim about the body or about performance', () => {
  const html = read('../index.html');
  const pagesFrom = html.indexOf('<div class="page hidden" data-page="status"');
  const pagesTo = html.indexOf('<div class="page page-foot">');
  const sampleFrom = html.indexOf('/* ---- Sample fitness, fatigue and form');
  const sampleTo = html.indexOf('/* ---- Init ---- */');
  const cardsFrom = html.indexOf('<section class="stack ffm"');
  assert.ok(pagesFrom > 0 && pagesTo > pagesFrom, 'the Status and Health pages are still where this test looks');
  assert.ok(sampleFrom > 0 && sampleTo > sampleFrom, 'the sample fitness section is still where this test looks');
  assert.ok(cardsFrom > 0, 'the fitness cards are still where this test looks');
  const surfaces = {
    'Status and Health pages': html.slice(pagesFrom, pagesTo),
    'sample fitness script': html.slice(sampleFrom, sampleTo),
    'fitness cards markup': html.slice(cardsFrom, cardsFrom + 600),
  };
  for (const [where, text] of Object.entries(surfaces)) {
    for (const re of STRICTER) {
      const hit = text.match(re);
      assert.equal(hit, null, `${where} says "${hit && hit[0]}"`);
    }
  }
});

test('everything drawn from the sample says it is a sample', () => {
  const html = read('../index.html');
  // The cards, the chart and the Status page each carry the label, so a screenshot of any one of them says so.
  assert.match(html, /Sample numbers · calculations coming soon/);
  assert.match(html, /Sample data\. Fitness calculations are coming soon/);
  assert.match(html, /Preview with sample data/);
  assert.match(html, /<span class="tag tag-neutral">Sample<\/span>/, 'each fitness card is tagged Sample');
  assert.match(html, /aria-label="Sample data\. Planned fitness/, 'the chart is described as sample data to a screen reader');
});

test('the sample numbers never reach storage or the engine', () => {
  const html = read('../index.html');
  const from = html.indexOf('/* ---- Sample fitness, fatigue and form');
  const to = html.indexOf('/* ---- Init ---- */');
  const section = html.slice(from, to);
  assert.doesNotMatch(section, /persistPlan|savePlanLocal|save\(|localStorage|plan\.[a-z]+\s*=[^=]/, 'the sample section writes something');
});
