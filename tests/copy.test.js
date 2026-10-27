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

/* The page's own drawing of the target: the section between these two markers. */
function targetSection() {
  const html = read('../index.html');
  const from = html.indexOf('/* ---- Target: what the season was built to arrive with');
  const to = html.indexOf('/* ---- end of Target ---- */');
  assert.ok(from > 0 && to > from, 'the Target section is still where this test looks');
  return html.slice(from, to);
}

function surfaces() {
  const html = read('../index.html');
  const notice = read('../assets/privacy.js');   // the notice's text, shared by the app and privacy.html
  const from = html.indexOf('/* ---- Workouts to Garmin');
  const to = html.indexOf('const MATCH_REASONS');
  assert.ok(from > 0 && to > from, 'the Workouts to Garmin section is still where this test looks');
  const privacy = notice.match(/\['Workouts sent to Garmin\.',[\s\S]*?\],\n/);
  assert.ok(privacy, 'the privacy notice describes workouts');
  const relFrom = html.indexOf('/* ---- Weekly release');
  const wizFrom = html.indexOf('/* ---- Onboarding wizard');
  assert.ok(relFrom > 0 && wizFrom > relFrom, 'the weekly release section is still where this test looks');
  const aboutFrom = html.indexOf('/* ---- About you');
  assert.ok(wizFrom > 0 && aboutFrom > wizFrom, 'the onboarding wizard section is still where this test looks');
  const aboutTo = html.indexOf('/* ---- Training paces');
  assert.ok(aboutFrom > 0 && aboutTo > aboutFrom, 'the About you section is still where this test looks');
  const aboutNotice = notice.match(/\['About you\.',[\s\S]*?\],\n/);
  assert.ok(aboutNotice, 'the privacy notice describes About you');
  const nightsFrom = html.indexOf('/* ---- Sleep and overnight heart rate');
  assert.ok(nightsFrom > 0 && from > nightsFrom, 'the overnight section is still where this test looks');
  const nightsNotice = notice.match(/\['Sleep and overnight heart rate from Garmin\.',[\s\S]*?\],\n/);
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
    // The plan's target and the figure it starts from: the notes the athlete reads.
    'targets.js': read('../assets/coach/targets.js'),
    'startfit.js': read('../assets/coach/startfit.js'),
    'backplan.js': read('../assets/coach/backplan.js'),
    'index.html target section': targetSection(),
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

/* The Training status and Health indicator pages, the fitness cards and chart,
   and the Season panel show numbers worked out from training load. They sit
   closest to the body and to performance claims, so the list here is stricter
   than the one above: no recovery or readiness talk, no promise about what a
   number means for an athlete, and no named standard a reader could take as a
   target.

   The plan's own target is not that. It is the number the athlete chose to
   build the season to — read off the same illustrative bands the chart draws —
   shown as "Plan target" beside the planned line, and a screen can say so
   without naming anyone's time or qualifying standard. What stays barred is
   the vocabulary of a standard to aim at (kona, qualif, competitive, comfortabl)
   and any claim about what the number means for the athlete. The names of the
   three levels live in targets.js, not on these surfaces. */

const STRICTER = [
  ...FORBIDDEN,
  /recover/i, /wellness/i, /overreach/i, /\brisk/i, /\btreat/i, /therap/i, /rehab/i, /RED-S/i, /screen(?! reader)/i,
  /competitive/i, /kona/i, /qualif/i, /comfortabl/i, /enjoy/i, /worn down/i, /carrying too much/i, /earliest sign/i,
];

const fitnessSurfaces = () => {
  const html = read('../index.html');
  const pagesFrom = html.indexOf('<div class="page hidden" data-page="status"');
  const pagesTo = html.indexOf('<div class="page page-foot">');
  const scriptFrom = html.indexOf('/* ---- Fitness, fatigue and form');
  const scriptTo = html.indexOf('/* ---- Init ---- */');
  const cardsFrom = html.indexOf('<section class="stack ffm"');
  assert.ok(pagesFrom > 0 && pagesTo > pagesFrom, 'the Status and Health pages are still where this test looks');
  assert.ok(scriptFrom > 0 && scriptTo > scriptFrom, 'the fitness section is still where this test looks');
  assert.ok(cardsFrom > 0, 'the fitness cards are still where this test looks');
  return {
    html,
    section: html.slice(scriptFrom, scriptTo),
    surfaces: {
      'Status and Health pages': html.slice(pagesFrom, pagesTo),
      'fitness script': html.slice(scriptFrom, scriptTo),
      'fitness cards markup': html.slice(cardsFrom, cardsFrom + 600),
      'fitness.js': read('../assets/coach/fitness.js'),
      'preparation.js': read('../assets/coach/preparation.js'),
    },
  };
};

test('the fitness surfaces make no claim about the body or about performance', () => {
  for (const [where, text] of Object.entries(fitnessSurfaces().surfaces)) {
    for (const re of STRICTER) {
      const hit = text.match(re);
      assert.equal(hit, null, `${where} says "${hit && hit[0]}"`);
    }
  }
});

test('what is estimated or illustrative says so wherever it is shown', () => {
  const { section } = fitnessSurfaces();
  assert.match(section, /Planned and race-day figures are estimates/, 'the cards say which figures are estimates');
  assert.match(section, /<span class="tag tag-neutral">Estimate<\/span>/, 'the race-day card is tagged Estimate');
  assert.match(section, /CTL planned, estimated/, 'the planned CTL line is called an estimate in the legend');
  assert.match(section, /ATL planned, estimated/, 'and so is the planned ATL line');
  assert.match(section, /Predicted ATL is an estimate and is noisier than predicted CTL/, 'with the reason ATL reads rougher');
  assert.match(section, /Planned fitness \(an estimate\)/, 'the CTL chart is described as an estimate to a screen reader');
  assert.match(section, /Planned fatigue \(an estimate\)/, 'and the ATL chart');
  assert.match(section, /illustrative/i, 'the bands are called illustrative');
});

test('the fitness section only draws what fitness.js worked out, and stores nothing', () => {
  const { section } = fitnessSurfaces();
  assert.match(section, /fitnessSeries\(plan,/, 'the page asks the engine');
  assert.doesNotMatch(section, /SAMPLE|sampleChart/, 'a hand-written set of numbers is back');
  assert.doesNotMatch(section, /persistPlan|savePlanLocal|save\(|localStorage|plan\.[a-zA-Z]+\s*=[^=]/, 'the fitness section writes something');
});

test('race preparation says where a figure sits and never scores or judges it', () => {
  const { surfaces } = fitnessSurfaces();
  const text = surfaces['preparation.js'];
  // The word list above already bars readiness, recovery and risk. These bar the shape of a verdict.
  for (const re of [/\bscore/i, /\bready\b/i, /\bpass(ed)?\b/i, /on track/i, /good to go/i, /\bgrade/i]) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '');   // the header comment explains what is left out
    const hit = code.match(re);
    assert.equal(hit, null, `preparation.js says "${hit && hit[0]}"`);
  }
  const { section } = fitnessSurfaces();
  assert.match(section, /Race preparation/, 'the block is on the page');
  assert.match(section, /illustrative, not findings/, 'its references say they are illustrative');
});

test('what the page says about the plan target is held to the stricter list too', () => {
  const text = targetSection();
  for (const re of STRICTER) {
    const hit = text.match(re);
    assert.equal(hit, null, `the Target section says "${hit && hit[0]}"`);
  }
});

test('the chart shows the athlete\'s own plan target and names no standard to aim at', () => {
  const { section } = fitnessSurfaces();
  assert.match(section, /Plan target/);
  assert.doesNotMatch(section, /kona|qualif|standard/i);
  assert.doesNotMatch(section, /competitive|finish|intermediate/i, 'the level names are not on the chart');
});

test('what a target says never promises a result', () => {
  for (const [where, text] of [['targets.js', read('../assets/coach/targets.js')], ['the Target section', targetSection()]]) {
    for (const re of [/will (reach|qualify|finish|achieve|hit|make)/i, /you('| wi)ll (get|be)/i, /guarantee/i, /\bready\b/i]) {
      const hit = text.replace(/\/\*[\s\S]*?\*\//g, '').match(re);
      assert.equal(hit, null, `${where} says "${hit && hit[0]}"`);
    }
  }
});

/* The privacy notice and the page it has on its own (privacy.html), which a
   listing can link to, are held to the stricter list as a whole. */

test('the privacy notice page and its text make no claim about the body or about performance', () => {
  for (const [where, text] of [['privacy.js', read('../assets/privacy.js')], ['privacy.html', read('../privacy.html')]]) {
    for (const re of STRICTER) {
      const hit = text.match(re);
      assert.equal(hit, null, `${where} says "${hit && hit[0]}"`);
    }
  }
});

test('what the placeholder says is plain: it names what is missing and makes no claim', () => {
  const { section } = fitnessSurfaces();
  const from = section.indexOf('function basisPlaceholderHTML');
  const body = section.slice(from, section.indexOf('function ffmCardHTML'));
  assert.ok(from > 0 && body.length > 200, 'the placeholder is where this test looks');
  for (const re of [...STRICTER, /\bready\b/i, /on track/i, /good to go/i]) {
    const hit = body.match(re);
    assert.equal(hit, null, `the placeholder says "${hit && hit[0]}"`);
  }
  assert.match(body, /CTL and ATL appear once/);
});
