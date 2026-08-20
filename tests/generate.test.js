import test from 'node:test';
import assert from 'node:assert/strict';

import { generateWeek, weekMinutes, raceDemandMinutes } from '../assets/coach/generate.js';
import { normalizeProfile, DAYS } from '../assets/coach/profile.js';
import { durToMin } from '../assets/coach/duration.js';

const anyDay = (mins) => Object.fromEntries(DAYS.map((d) => [d, mins]));
const gen = (opts = {}) =>
  generateWeek({
    hours: opts.hours ?? 8,
    block: opts.block ?? 'Base 2',
    profile: normalizeProfile(opts.profile ?? { availability: anyDay(180) }),
  });

test('a generated week spends its budget exactly when there is room for it', () => {
  const { sessions, budgetMinutes } = gen({ hours: 8 });
  assert.equal(weekMinutes(sessions), budgetMinutes);
});

test('the budget is hit exactly across a wide range of hours', () => {
  // Whole 5-minute sessions still have to add up to the prescribed week — the
  // reconciliation pass exists to absorb rounding, so nothing here is "close
  // enough". A loose tolerance here would let that pass rot undetected.
  for (const hours of [4, 5, 6, 8, 9, 10, 12, 14, 16, 18, 20]) {
    const { sessions, budgetMinutes } = gen({ hours });
    assert.equal(weekMinutes(sessions), budgetMinutes, `drift at ${hours}h`);
  }
});

test('no day is scheduled beyond the time available on it', () => {
  const profile = { availability: { Mon: 0, Tue: 60, Wed: 60, Thu: 60, Fri: 60, Sat: 300, Sun: 180 } };
  const { sessions } = gen({ hours: 11, profile });
  const perDay = {};
  for (const s of sessions) perDay[s.day] = (perDay[s.day] ?? 0) + durToMin(s.dur);
  for (const d of DAYS) {
    assert.ok(
      (perDay[d] ?? 0) <= profile.availability[d],
      `${d}: scheduled ${perDay[d]} > available ${profile.availability[d]}`,
    );
  }
});

test('a day with no time available gets rest, not a workout', () => {
  const { sessions } = gen({ profile: { availability: { ...anyDay(120), Mon: 0 } } });
  const mon = sessions.filter((s) => s.day === 'Mon');
  assert.ok(mon.length > 0, 'the day should still appear');
  assert.ok(mon.every((s) => durToMin(s.dur) === 0), 'Monday must hold no training time');
});

test('an avoidDays constraint is never violated', () => {
  const { sessions } = gen({
    profile: {
      availability: anyDay(180),
      constraints: [{ disc: 'Swim', rule: 'avoidDays', value: ['Mon', 'Tue'] }],
    },
  });
  const swims = sessions.filter((s) => s.disc === 'Swim');
  assert.ok(swims.length > 0, 'swim should still be scheduled somewhere');
  assert.ok(!swims.some((s) => s.day === 'Mon' || s.day === 'Tue'));
});

test('a discipline with no allowed day is dropped and its time reallocated', () => {
  const { sessions, budgetMinutes } = gen({
    hours: 8,
    profile: {
      availability: anyDay(180),
      // "No pool this week" stated unambiguously. An empty onlyDays list is
      // deliberately *not* the way to say this — normalizeProfile treats that
      // as a malformed constraint and drops it, so a typo can't silently
      // delete a discipline from someone's plan.
      constraints: [{ disc: 'Swim', rule: 'avoidDays', value: DAYS }],
    },
  });
  assert.equal(sessions.filter((s) => s.disc === 'Swim').length, 0, 'no pool, no swim');
  // The freed time goes to the other disciplines rather than shrinking the week.
  assert.equal(weekMinutes(sessions), budgetMinutes);
});

test('a maxPerWeek constraint caps session count', () => {
  const { sessions } = gen({
    hours: 14,
    profile: {
      availability: anyDay(240),
      constraints: [{ disc: 'Swim', rule: 'maxPerWeek', value: 1 }],
    },
  });
  assert.ok(sessions.filter((s) => s.disc === 'Swim').length <= 1);
});

test('the long ride lands on the day with the most time', () => {
  const { sessions } = gen({
    hours: 12,
    profile: { availability: { Mon: 0, Tue: 60, Wed: 60, Thu: 60, Fri: 60, Sat: 360, Sun: 120 } },
  });
  const rides = sessions.filter((s) => s.disc === 'Bike');
  const longest = rides.reduce((a, b) => (durToMin(b.dur) > durToMin(a.dur) ? b : a));
  assert.equal(longest.day, 'Sat');
});

test('generation is deterministic', () => {
  const a = gen({ hours: 9 });
  const b = gen({ hours: 9 });
  assert.deepEqual(a.sessions, b.sessions);
});

test('an over-committed week fills the available time exactly and reports the shortfall', () => {
  // 20h asked for, 7h available. The engine must not invent time, and must not
  // leave real time on the table either.
  const capacity = 7 * 60;
  const { sessions, budgetMinutes, shortfallMinutes } = gen({
    hours: 20,
    profile: { availability: anyDay(60) },
  });
  assert.equal(weekMinutes(sessions), capacity, 'should fill exactly the time that exists');
  assert.equal(shortfallMinutes, budgetMinutes - capacity, 'the gap must be reported, not hidden');
});

test('planned time never exceeds the time the athlete actually has', () => {
  // The invariant that matters most. Checked across shapes rather than on one
  // fixture, because it is enforced in two places and both must hold.
  for (const perDay of [30, 45, 60, 90, 150]) {
    for (const hours of [6, 10, 14, 20]) {
      const capacity = perDay * 7;
      const { sessions } = gen({ hours, profile: { availability: anyDay(perDay) } });
      assert.ok(
        weekMinutes(sessions) <= capacity,
        `${hours}h into ${perDay}min/day: planned ${weekMinutes(sessions)} > capacity ${capacity}`,
      );
    }
  }
});

test('every session carries the fields the renderer expects', () => {
  const { sessions } = gen();
  for (const s of sessions) {
    assert.ok(DAYS.includes(s.day), `bad day: ${s.day}`);
    assert.equal(typeof s.disc, 'string');
    assert.equal(typeof s.focus, 'string');
    assert.equal(typeof s.dur, 'string');
    assert.equal(typeof s.zone, 'string');
    assert.equal(typeof s.id, 'string');
  }
});

test('session ids are unique within a week', () => {
  const { sessions } = gen({ hours: 14 });
  assert.equal(new Set(sessions.map((s) => s.id)).size, sessions.length);
});

test('no workout is shorter than a session worth doing', () => {
  const { sessions } = gen({ hours: 5 });
  const workouts = sessions.filter((s) => durToMin(s.dur) > 0);
  assert.ok(workouts.every((s) => durToMin(s.dur) >= 20), 'no token 5-minute sessions');
});

test('a build block shifts emphasis away from a base block', () => {
  const base = gen({ hours: 12, block: 'Base 2' }).sessions;
  const build = gen({ hours: 12, block: 'Build 1' }).sessions;
  const swimShare = (ss) =>
    ss.filter((s) => s.disc === 'Swim').reduce((a, s) => a + durToMin(s.dur), 0) / weekMinutes(ss);
  assert.notEqual(swimShare(base).toFixed(3), swimShare(build).toFixed(3));
});

/* Long-session anchoring.

   A 70.3 bike leg takes roughly three hours whether you train six hours a week
   or eighteen. Scaling the long ride with weekly volume gave the high-volume
   athlete the race-specific session and denied it to the one who needs it most.
   The long session is therefore anchored to race demand and stops growing once
   it gets there; extra volume goes into additional sessions instead. */

const longestOf = (sessions, disc) =>
  Math.max(...sessions.filter((s) => s.disc === disc).map((s) => durToMin(s.dur)));

test('the long ride stops growing once it meets race demand', () => {
  // Ample capacity on purpose. Under a capacity squeeze the engine is *supposed*
  // to keep filling available time, long ride included — that behaviour is
  // covered by the over-committed test above and would mask this one.
  const at = (h) => longestOf(gen({ hours: h, profile: { availability: anyDay(300) } }).sessions, 'Bike');
  const base = at(10);
  assert.ok(base >= 150, `a 10h week should already reach a race-length ride, got ${base}`);
  for (const h of [14, 18, 22]) {
    assert.ok(at(h) <= base + 5, `long ride kept growing at ${h}h: ${base} -> ${at(h)}`);
  }
});

test('extra weekly volume becomes extra sessions, not a longer long ride', () => {
  const rides = (h) => gen({ hours: h }).sessions.filter((s) => s.disc === 'Bike').length;
  assert.ok(rides(18) > rides(10), 'more time should buy more rides');
});

test('a small week cannot fit a race-length ride but still leans on it', () => {
  const { sessions } = gen({ hours: 6 });
  const longest = longestOf(sessions, 'Bike');
  assert.ok(longest < 165, 'a 6h week cannot hold a full race-length ride');
  assert.ok(longest / weekMinutes(sessions) > 0.2, 'the long ride should still dominate a small week');
});

test('race distance sets the long-session target', () => {
  const longFor = (raceType) => {
    const p = normalizeProfile({ availability: anyDay(300), raceType });
    return longestOf(generateWeek({ hours: 14, block: 'Base 2', profile: p }).sessions, 'Bike');
  };
  assert.ok(longFor('sprint') < longFor('70.3'), 'a sprint does not need a 70.3 long ride');
  assert.ok(longFor('70.3') < longFor('ironman'));
});

test('an unrecognised race distance falls back rather than breaking', () => {
  const p = normalizeProfile({ availability: anyDay(300), raceType: 'moon marathon' });
  const { sessions, budgetMinutes } = generateWeek({ hours: 12, block: 'Base 2', profile: p });
  assert.equal(weekMinutes(sessions), budgetMinutes);
});

/* Per-athlete discipline splits.

   The default split is one opinion about a 70.3. It is not the only defensible
   one, and it is exactly the kind of thing an athlete — or the coach agent on
   their behalf — needs to change without editing code. */

test('a profile can override the split for a block family', () => {
  const p = normalizeProfile({
    availability: anyDay(240),
    splits: { Base: { Bike: 0.5, Run: 0.3, Strength: 0.2 } },
  });
  const { sessions } = generateWeek({ hours: 12, block: 'Base 2', profile: p });
  assert.equal(sessions.filter((s) => s.disc === 'Swim').length, 0, 'the override has no swim');
});

test('an override on a specific block beats the family override', () => {
  const p = normalizeProfile({
    availability: anyDay(240),
    splits: {
      Base: { Bike: 0.5, Run: 0.3, Strength: 0.2 },
      'Base 3': { Swim: 0.2, Bike: 0.45, Run: 0.25, Strength: 0.1 },
    },
  });
  const early = generateWeek({ hours: 12, block: 'Base 1', profile: p }).sessions;
  const late = generateWeek({ hours: 12, block: 'Base 3', profile: p }).sessions;
  assert.equal(early.filter((s) => s.disc === 'Swim').length, 0, 'no swim in Base 1');
  assert.ok(late.filter((s) => s.disc === 'Swim').length > 0, 'swim arrives in Base 3');
});

test('an athlete who swims late and lifts early gets exactly that', () => {
  // The worked example: strength-led early season, swimming from Base 3, and
  // never more than three swims in a week.
  const p = normalizeProfile({
    availability: anyDay(240),
    constraints: [{ disc: 'Swim', rule: 'maxPerWeek', value: 3 }],
    splits: {
      Prep: { Bike: 0.4, Run: 0.28, Strength: 0.32 },
      'Base 1': { Bike: 0.44, Run: 0.3, Strength: 0.26 },
      'Base 2': { Bike: 0.46, Run: 0.31, Strength: 0.23 },
      'Base 3': { Swim: 0.16, Bike: 0.45, Run: 0.28, Strength: 0.11 },
      Build: { Swim: 0.18, Bike: 0.45, Run: 0.3, Strength: 0.07 },
    },
  });
  const swims = (block) =>
    generateWeek({ hours: 12, block, profile: p }).sessions.filter((s) => s.disc === 'Swim').length;
  const strengthShare = (block) => {
    const ss = generateWeek({ hours: 12, block, profile: p }).sessions;
    return ss.filter((s) => s.disc === 'Strength').reduce((a, s) => a + durToMin(s.dur), 0) / weekMinutes(ss);
  };

  assert.equal(swims('Prep'), 0);
  assert.equal(swims('Base 1'), 0);
  assert.ok(swims('Base 3') > 0, 'swimming starts at Base 3');
  assert.ok(swims('Build 1') <= 3, 'never more than three swims');
  assert.ok(strengthShare('Prep') > strengthShare('Build 1'), 'strength leads early, tapers later');
});

test('a malformed split override is ignored rather than obeyed', () => {
  const p = normalizeProfile({
    availability: anyDay(240),
    splits: { Base: { Bike: 'lots', Telepathy: 0.5 } },
  });
  const { sessions, budgetMinutes } = generateWeek({ hours: 10, block: 'Base 2', profile: p });
  assert.equal(weekMinutes(sessions), budgetMinutes, 'should fall back to a usable split');
});

test('rounding drift is absorbed by ordinary sessions, not the long one', () => {
  // Bike-only, so the drift left by 5-minute rounding has nowhere to go except
  // the rides themselves. It must not land on the race-anchored long ride.
  const p = normalizeProfile({
    availability: anyDay(240),
    constraints: ['Swim', 'Run', 'Strength'].map((disc) => ({ disc, rule: 'avoidDays', value: DAYS })),
  });
  const { sessions, budgetMinutes } = generateWeek({ hours: 10, block: 'Base 2', profile: p });
  assert.equal(weekMinutes(sessions), budgetMinutes, 'budget still has to balance');
  assert.equal(longestOf(sessions, 'Bike'), 165, 'the long ride should sit exactly on race demand');
});

test('the race-specific work a distance calls for is available to callers', () => {
  // The validator needs this to judge whether a plan's volume suits its race.
  // Owning it here keeps one definition of what a distance demands.
  assert.equal(raceDemandMinutes('sprint'), 145);   // 30 swim + 75 bike + 40 run
  assert.equal(raceDemandMinutes('ironman'), 525);
});

test('an unknown race distance falls back the same way generation does', () => {
  assert.equal(raceDemandMinutes('duathlon'), raceDemandMinutes('70.3'));
  assert.equal(raceDemandMinutes(undefined), raceDemandMinutes('70.3'));
});
