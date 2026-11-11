/* Mending a week that has more sessions on a day than the athlete prefers.

   Time is what limits a day; the session count is a preference. So this never
   loses a minute and never overfills a day: it first folds two sessions of one
   discipline on the same day into one (two strength blocks become one), and
   failing that moves the least important session to a day that has room. A day
   it cannot mend is left as it is — `validateWeek` only says anything about it
   when its time is over too.

   Pure: takes built sessions, returns a new list, keeps every id it keeps.
   Nothing here reads a week's budget, and the long ride and long run (the
   longest of each in the week) are never moved or folded. */

import { DAYS, allowedDays } from './profile.js';
import { durToMin, minToDur } from './duration.js';
import { sessionMax } from './generate.js';

// Least important first: strength, then swim, then an easy run, then an easy ride.
const TIER = { Strength: 0, Swim: 1, Run: 2, Bike: 3 };
const isWork = (s) => s.disc !== 'Rest' && durToMin(s.dur) > 0;

export function balanceWeek(sessions, { profile, closedDays = [] } = {}) {
  const cap = profile?.maxSessionsPerDay;
  const out = sessions.map((s) => ({ ...s }));
  if (!cap) return out;

  const avail = (d) => (closedDays.includes(d) ? 0 : profile.availability[d] || 0);
  const work = () => out.filter(isWork);
  const onDay = (d) => work().filter((s) => s.day === d);
  const minutes = (d) => onDay(d).reduce((a, s) => a + durToMin(s.dur), 0);
  const longest = new Set(['Bike', 'Run'].map((disc) => work().filter((s) => s.disc === disc)
    .sort((a, b) => durToMin(b.dur) - durToMin(a.dur))[0]?.id).filter(Boolean));

  let moved = true;
  while (moved) {
    moved = false;
    for (const day of DAYS) {
      const here = onDay(day);
      if (here.length <= cap) continue;

      // Fold two of one discipline into one, if the result is still a sensible session.
      const pair = here.flatMap((a, i) => here.slice(i + 1).map((b) => [a, b]))
        .find(([a, b]) => a.disc === b.disc && !longest.has(a.id) && !longest.has(b.id)
          && durToMin(a.dur) + durToMin(b.dur) <= sessionMax(a.disc));
      if (pair) {
        const [keep, drop] = pair;
        keep.dur = minToDur(durToMin(keep.dur) + durToMin(drop.dur));
        out.splice(out.indexOf(drop), 1);
        moved = true;
        break;
      }

      // Otherwise move the least important session to the day with the most room.
      const movable = here.filter((s) => !longest.has(s.id))
        .sort((a, b) => TIER[a.disc] - TIER[b.disc] || durToMin(a.dur) - durToMin(b.dur));
      for (const s of movable) {
        const mins = durToMin(s.dur);
        const to = allowedDays(profile, s.disc)
          .filter((d) => d !== day && onDay(d).length < cap && minutes(d) + mins <= avail(d))
          .sort((a, b) => (avail(b) - minutes(b)) - (avail(a) - minutes(a)) || DAYS.indexOf(a) - DAYS.indexOf(b))[0];
        if (!to) continue;
        s.day = to;
        // A day that gained a session is no longer a rest day.
        for (let i = out.length - 1; i >= 0; i--) if (out[i].disc === 'Rest' && out[i].day === to) out.splice(i, 1);
        moved = true;
        break;
      }
      if (moved) break;
    }
  }
  return out;
}
