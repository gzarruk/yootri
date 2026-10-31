import test from 'node:test';
import assert from 'node:assert/strict';

import { generateWeek } from '../assets/coach/generate.js';
import { normalizeProfile, DAYS } from '../assets/coach/profile.js';
import { durToMin } from '../assets/coach/duration.js';

/* A fixed week, as data. This is a fixture and the shape of the data, not a
   default: nothing in the engine is tuned toward it (CLAUDE.md). Availability is
   illustrative, so these tests check structure and sums, not exact minutes. */

const AVAIL = { Mon: 0, Tue: 90, Wed: 90, Thu: 120, Fri: 75, Sat: 240, Sun: 240 };
const PATTERN = {
  Run: ['Tue', 'Thu', 'Sat'],
  Bike: ['Wed', 'Thu', 'Sun'],
  Strength: ['Wed', 'Tue', 'Fri'],
  Swim: ['Fri', 'Sat', 'Sun'],
};
const COUNTS = {
  Base: { Run: 3, Bike: 3, Strength: 3, Swim: 1 },
  'Base 3': { Strength: 2, Swim: 2 },
  Build: { Run: 3, Bike: 3, Strength: 1, Swim: 2 },
  Peak: { Run: 3, Bike: 3, Strength: 1, Swim: 2 },
};
const fixture = (extra = {}) => normalizeProfile({
  availability: AVAIL,
  longDays: { Bike: 'Sun', Run: 'Sat' },
  constraints: [{ disc: 'Swim', rule: 'maxPerWeek', value: 2 }],
  weekPattern: PATTERN,
  sessionCounts: COUNTS,
  ...extra,
});

const work = (r) => r.sessions.filter((s) => s.disc !== 'Rest');
const daysOf = (r, disc) => work(r).filter((s) => s.disc === disc).map((s) => s.day)
  .sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
const longest = (r, disc) => work(r).filter((s) => s.disc === disc)
  .sort((a, b) => durToMin(b.dur) - durToMin(a.dur))[0];
const sameSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());

/** What every pattern week must satisfy, whatever the block. */
function holds(r, profile, closed = []) {
  const perDay = {};
  for (const s of work(r)) perDay[s.day] = (perDay[s.day] ?? 0) + durToMin(s.dur);
  for (const [d, m] of Object.entries(perDay)) {
    assert.ok(m <= profile.availability[d], `${d} holds ${m} of ${profile.availability[d]}`);
    assert.ok(!closed.includes(d), `${d} is closed`);
  }
  // The total is the target or a shortfall that says so — never invented time.
  assert.ok(r.plannedMinutes <= r.budgetMinutes + 4, `planned ${r.plannedMinutes} over ${r.budgetMinutes}`);
  assert.equal(r.shortfallMinutes, Math.max(0, r.budgetMinutes - r.plannedMinutes));
  const capacity = DAYS.filter((d) => !closed.includes(d)).reduce((a, d) => a + profile.availability[d], 0);
  assert.ok(r.plannedMinutes >= Math.min(r.budgetMinutes, capacity) - 4 || r.shortfallMinutes > 0);
  // Every day with nothing on it is a Rest session, and nothing else is.
  for (const d of DAYS) {
    const onDay = r.sessions.filter((s) => s.day === d);
    assert.equal(onDay.some((s) => s.disc === 'Rest'), !onDay.some((s) => s.disc !== 'Rest'), d);
  }
}

test('Base 1 and 2 follow the pattern: three strength, one swim, three runs, three rides', () => {
  const p = fixture();
  for (const block of ['Base 1', 'Base 2']) {
    const r = generateWeek({ hours: 8, block, profile: p });
    sameSet(daysOf(r, 'Strength'), ['Wed', 'Tue', 'Fri']);
    sameSet(daysOf(r, 'Swim'), ['Fri']);
    sameSet(daysOf(r, 'Run'), ['Tue', 'Thu', 'Sat']);
    sameSet(daysOf(r, 'Bike'), ['Wed', 'Thu', 'Sun']);
    assert.equal(longest(r, 'Run').day, 'Sat');
    assert.equal(longest(r, 'Bike').day, 'Sun');
    holds(r, p);
  }
});

test('Base 3 overrides strength and swim only', () => {
  const p = fixture();
  const r = generateWeek({ hours: 8, block: 'Base 3', profile: p });
  sameSet(daysOf(r, 'Strength'), ['Wed', 'Tue']);
  sameSet(daysOf(r, 'Swim'), ['Fri', 'Sat']);
  sameSet(daysOf(r, 'Run'), ['Tue', 'Thu', 'Sat']);
  sameSet(daysOf(r, 'Bike'), ['Wed', 'Thu', 'Sun']);
  holds(r, p);
});

test('Build, Peak and Taper have one strength session and two swims', () => {
  const p = fixture();
  for (const [block, hours] of [['Build 1', 9], ['Build 2', 9], ['Peak', 8], ['Taper', 6]]) {
    const r = generateWeek({ hours, block, profile: p });
    sameSet(daysOf(r, 'Strength'), ['Wed']);
    sameSet(daysOf(r, 'Swim'), ['Fri', 'Sat']);
    sameSet(daysOf(r, 'Run'), ['Tue', 'Thu', 'Sat']);
    sameSet(daysOf(r, 'Bike'), ['Wed', 'Thu', 'Sun']);
    holds(r, p);
  }
});

test('a 9 h Build week no longer has an oversized strength session, or a lone swim', () => {
  const r = generateWeek({ hours: 9, block: 'Build 1', profile: fixture() });
  const strength = work(r).filter((s) => s.disc === 'Strength');
  assert.equal(strength.length, 1);
  assert.ok(durToMin(strength[0].dur) <= 45, strength[0].dur);
  assert.equal(work(r).filter((s) => s.disc === 'Swim').length, 2);
});

test('the swim cap still caps: a pattern asking for three swims gets two, with no complaint', () => {
  const p = fixture({ sessionCounts: { ...COUNTS, Build: { ...COUNTS.Build, Swim: 3 } } });
  const r = generateWeek({ hours: 9, block: 'Build 1', profile: p });
  sameSet(daysOf(r, 'Swim'), ['Fri', 'Sat']);
});

test('a short race on Saturday closes Saturday and the weekend swim falls to Sunday', () => {
  const p = fixture();
  const r = generateWeek({ hours: 9, block: 'Build 1', profile: p, raceDay: 'Sat', raceOnly: true });
  sameSet(daysOf(r, 'Swim'), ['Fri', 'Sun']);
  assert.ok(!r.sessions.some((s) => s.day === 'Sat' && s.disc !== 'Rest'));
  holds(r, p, ['Sat']);
});

test('a taper race closes its day and every day after it; the slots simply go', () => {
  const p = fixture();
  const r = generateWeek({ hours: 6, block: 'Taper', profile: p, raceDay: 'Sat' });
  assert.ok(!r.sessions.some((s) => ['Sat', 'Sun'].includes(s.day) && s.disc !== 'Rest'));
  holds(r, p, ['Sat', 'Sun']);
});

test('a small week drops sessions in the documented order, never a sliver', () => {
  const p = fixture();
  const r = generateWeek({ hours: 2.5, block: 'Base 1', profile: p });
  const floor = { Swim: 25, Bike: 30, Run: 20, Strength: 20 };
  for (const s of work(r)) assert.ok(durToMin(s.dur) >= floor[s.disc], `${s.disc} ${s.dur}`);
  // The long ride and long run stay, and so does each discipline's only session.
  assert.ok(longest(r, 'Bike'), 'a ride is left');
  assert.ok(longest(r, 'Run'), 'a run is left');
  holds(r, p);
  const kept = (disc) => work(r).filter((s) => s.disc === disc).length;
  // Extra strength goes before anything else does.
  assert.ok(kept('Strength') <= 1 || kept('Bike') === 3);
});

test('a recovery week is the same pattern with sessions turned into days off', () => {
  const p = fixture();
  const normal = generateWeek({ hours: 8, block: 'Base 1', profile: p });
  const easy = generateWeek({ hours: 5.5, block: 'Base 1', profile: p, recovery: true });
  // Ten slots: two go, extra strength first.
  assert.equal(work(normal).length, 10);
  assert.equal(work(easy).length, 8);
  sameSet(daysOf(easy, 'Strength'), ['Wed']);
  // The strength that stays is Mobility, which the generator already writes for Race.
  for (const s of work(easy).filter((x) => x.disc === 'Strength')) assert.equal(s.focus, 'Mobility');
  for (const s of work(normal).filter((x) => x.disc === 'Strength')) assert.notEqual(s.focus, 'Mobility');
  holds(easy, p);
});

test('under eight slots a recovery week gives up one', () => {
  const p = fixture({ sessionCounts: { Build: { Run: 2, Bike: 2, Strength: 1, Swim: 2 } } });
  const build = generateWeek({ hours: 8, block: 'Build 1', profile: p });
  const easy = generateWeek({ hours: 5.5, block: 'Build 1', profile: p, recovery: true });
  assert.equal(work(build).length, 7);
  assert.equal(work(easy).length, 6);
  holds(easy, p);
});

test('recovery does nothing without a pattern', () => {
  const plain = normalizeProfile({ availability: AVAIL });
  for (const block of ['Base 1', 'Build 1', 'Taper']) {
    assert.deepEqual(
      generateWeek({ hours: 7, block, profile: plain, recovery: true }),
      generateWeek({ hours: 7, block, profile: plain }),
    );
  }
});

test('a block with no counts is built as it always was, and a pattern-only profile stays valid', () => {
  const plain = normalizeProfile({ availability: AVAIL, longDays: { Bike: 'Sun', Run: 'Sat' } });
  const patternOnly = fixture({ sessionCounts: undefined });
  for (const block of ['Prep', 'Base 1', 'Race']) {
    const r = generateWeek({ hours: 8, block, profile: patternOnly });
    holds(r, patternOnly);
    // No counts anywhere: the pattern changes where sessions go, not whether the
    // week is built, so the totals are what the plain profile gets.
    const plainWeek = generateWeek({ hours: 8, block, profile: plain });
    assert.equal(r.budgetMinutes, plainWeek.budgetMinutes);
  }
});

test('with no counts the pattern still decides which days are tried first', () => {
  // Prep takes its sessions from the session sizes; the pattern only orders the days.
  const p = fixture({ sessionCounts: undefined });
  const r = generateWeek({ hours: 6, block: 'Prep', profile: p });
  const runs = daysOf(r, 'Run');
  assert.ok(runs.every((d) => PATTERN.Run.includes(d)), `runs on ${runs}`);
});

test('the pattern week is deterministic', () => {
  const p = fixture();
  assert.deepEqual(generateWeek({ hours: 8, block: 'Base 2', profile: p }), generateWeek({ hours: 8, block: 'Base 2', profile: p }));
});

test('a property sweep: every block, volume, race day and recovery flag holds the invariants', () => {
  const p = fixture();
  const floor = { Swim: 25, Bike: 30, Run: 20, Strength: 20 };
  for (const block of ['Prep', 'Base 1', 'Base 3', 'Build 2', 'Peak', 'Taper', 'Race'])
    for (let hours = 1; hours <= 16; hours += 1.5)
      for (const [raceDay, raceOnly] of [[null, false], ['Wed', false], ['Sat', true]])
        for (const recovery of [false, true]) {
          const r = generateWeek({ hours, block, profile: p, raceDay, raceOnly, recovery });
          const closed = raceDay ? (raceOnly ? [raceDay] : DAYS.slice(DAYS.indexOf(raceDay))) : [];
          holds(r, p, closed);
          for (const s of work(r)) assert.ok(durToMin(s.dur) >= floor[s.disc], `${block} ${hours} ${s.disc} ${s.dur}`);
        }
});
