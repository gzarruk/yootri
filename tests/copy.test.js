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
