import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BRIDGE_ERROR_CODES, bridgeErrorMessage } from '../assets/coach/synced.js';

/* Wording yootri does not use about training: nothing it says may read as a
   medical claim or a promise about performance or health. This checks the
   words the workout export adds — the engine module, the bridge's error
   sentences, and the page's "Workouts to Garmin" section — not the whole app. */

const FORBIDDEN = [
  /injur/i, /readiness/i, /recovery monitor/i, /diagnos/i, /medical/i, /clinical/i,
  /guarantee/i, /prevent/i, /overtrain/i, /\bcure/i, /health score/i, /optimi[sz]e your/i,
];

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function surfaces() {
  const html = read('../index.html');
  const from = html.indexOf('/* ---- Workouts to Garmin');
  const to = html.indexOf('const MATCH_REASONS');
  assert.ok(from > 0 && to > from, 'the Workouts to Garmin section is still where this test looks');
  const privacy = html.match(/\['Workouts sent to Garmin\.',[\s\S]*?\],\n/);
  assert.ok(privacy, 'the privacy notice describes workouts');
  return {
    'workout.js': read('../assets/coach/workout.js'),
    'index.html workout section': html.slice(from, to),
    'privacy notice': privacy[0],
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
