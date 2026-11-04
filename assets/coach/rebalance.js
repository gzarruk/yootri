/* Rebalancing a week after its runs are confirmed from Garmin.

   `proposeRebalance` says what the rest of the week could give up, as a list of
   independent proposals, each with a reason that is a number from code. It
   writes nothing; `applyProposals` turns the ones the athlete accepted into a
   draft that goes through the usual diff -> validate -> apply.

   Standing constraints: Friday's bike and Saturday's long run are the hard days,
   Wednesday is the lightest, swims stay easy, and the week stays within
   9-14 hours. Days already past, and sessions that are done or logged, are never
   touched. Every threshold here is the athlete's rule, not a fitted constant. */
import { durToMin, minToDur } from './duration.js';
import { dateOf } from './calendar.js';
import { freshWeek, setSessionsAt, sessionsAt } from './plan.js';
import { plannedLoad, zoneIntensity } from './fitness.js';
import { easySession } from './generate.js';

export const REBALANCE = Object.freeze({
  minHours: 9,
  maxHours: 14,
  hardIF: 0.85,          // a run at Z3 or above reads as hard
  shortenStepMin: 5,
  shortenMaxShare: 0.5,  // never cut a session by more than half
});

const round1 = (n) => Math.round(n * 10) / 10;
const load = (s) => plannedLoad(s) ?? 0;

export function proposeRebalance(plan, absWeek, { today } = {}) {
  const week = sessionsAt(plan, absWeek);
  const confirmed = week.filter((s) => s.status === 'confirmed' && s.source === 'garmin' && s.disc === 'Run');
  if (!confirmed.length) return { proposals: [], skipped: [] };

  const fresh = new Map(freshWeek(plan, absWeek).map((s) => [s.id, s]));
  const locked = (s) => !!plan.done?.[s.id] || !!plan.actuals?.[s.id]
    || (!!today && (dateOf(plan.start, absWeek, s.day) ?? '') < today);
  const free = (s) => !locked(s) && s.status !== 'confirmed';

  // How much more run load the week now carries than the placeholders did.
  const runsNow = confirmed.reduce((a, s) => a + load(s), 0);
  const runsWas = confirmed.reduce((a, s) => a + (fresh.has(s.id) ? load(fresh.get(s.id)) : 0), 0);
  const extra = round1(runsNow - runsWas);
  const hardRunBeforeFri = confirmed.some((s) => ['Wed', 'Thu', 'Fri'].includes(s.day)
    && (zoneIntensity(s.zone) ?? 0) >= REBALANCE.hardIF);

  const proposals = [];
  const skipped = [];
  const totalMin = week.reduce((a, s) => a + durToMin(s.dur), 0);
  const bike = week.find((s) => s.day === 'Fri' && s.disc === 'Bike');

  const propose = (s, kind, change, reason) => {
    const after = { ...s, ...change };
    proposals.push({ id: `${s.id}:${kind}`, kind, sessionId: s.id, change, reason,
      loadBefore: round1(load(s)), loadAfter: round1(load(after)) });
  };

  if ((extra > 0 || hardRunBeforeFri) && bike) {
    if (!free(bike)) skipped.push({ sessionId: bike.id, why: 'locked' });
    else {
      const easy = easySession(bike);
      if (easy && load(easy) < load(bike)) {
        const { id: _i, day: _d, dur: _u, ...change } = easy;
        propose(bike, 'ease', { ...change, paceZone: undefined },
          `Garmin's runs add ${extra} load this week; easing Friday's bike takes it from ${round1(load(bike))} to ${round1(load(easy))}.`);
      }
    }
  }

  // Over the ceiling: shorten Friday's bike by the excess, in steps, within the cap.
  const over = totalMin - REBALANCE.maxHours * 60;
  if (over > 0 && bike && free(bike)) {
    const dur = durToMin(bike.dur);
    const cut = Math.min(Math.ceil(over / REBALANCE.shortenStepMin) * REBALANCE.shortenStepMin, Math.floor(dur * REBALANCE.shortenMaxShare));
    if (cut > 0) {
      propose(bike, 'shorten', { dur: minToDur(dur - cut) },
        `The week is ${Math.round(totalMin)} min, over ${REBALANCE.maxHours} h; Friday's bike drops ${cut} min.`);
    }
    if (over > cut) skipped.push({ sessionId: bike.id, why: 'still-over-ceiling' });
  }

  // Wednesday stays the lightest day.
  const byDay = new Map();
  for (const s of week) if (s.disc !== 'Rest') byDay.set(s.day, (byDay.get(s.day) ?? 0) + load(s));
  const wed = byDay.get('Wed');
  if (wed !== undefined && [...byDay.entries()].some(([d, v]) => d !== 'Wed' && v < wed)) {
    const target = week.filter((s) => s.day === 'Wed' && free(s) && s.disc !== 'Run').map((s) => [s, easySession(s)])
      .find(([s, e]) => e && load(e) < load(s));
    if (target) {
      const { id: _i, day: _d, dur: _u, ...change } = target[1];
      propose(target[0], 'keep-light', { ...change, paceZone: undefined },
        `Wednesday is no longer the lightest day (load ${round1(wed)}); easing ${target[0].disc.toLowerCase()} brings it to ${round1(wed - load(target[0]) + load(target[1]))}.`);
    }
  }

  // The floor: say so rather than propose below it.
  const cutMin = proposals.filter((p) => p.change.dur).reduce((a, p) => a + durToMin(p.change.dur) - durToMin(week.find((s) => s.id === p.sessionId).dur), 0);
  if ((totalMin + cutMin) < REBALANCE.minHours * 60) skipped.push({ sessionId: null, why: 'below-floor' });
  return { proposals, skipped };
}

/** A draft in which only the accepted proposals are applied. */
export function applyProposals(plan, absWeek, proposals, acceptedIds) {
  const accepted = new Set(acceptedIds);
  const chosen = proposals.filter((p) => accepted.has(p.id));
  const next = structuredClone(plan);
  const week = sessionsAt(next, absWeek).map((s) => {
    const hits = chosen.filter((p) => p.sessionId === s.id);
    if (!hits.length) return s;
    const out = { ...s };
    for (const p of hits) for (const [k, v] of Object.entries(p.change)) { if (v === undefined) delete out[k]; else out[k] = v; }
    return out;
  });
  return setSessionsAt(next, absWeek, week);
}
