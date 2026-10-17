/* Race preparation: plain facts about the weeks behind the athlete and the race
   ahead, set side by side. Nothing here decides anything.

     fitness   fitness on race day (fitness.js's projection) and the
               illustrative range for the distance
     long      how many long sessions of each discipline were synced in the
               last six weeks, and how many a block for this distance often has
     steady    weeks with at least three sessions among the last eight, over
               weeks the sync fully covered
     form      form on race day and the range often used on the day

   **No score and no verdict.** An item says where a figure sits (`against`
   for the two that have a range) and nothing about whether the athlete is good
   to go: that is the athlete's call, and a single number would be a standard to
   aim at. Sleep and overnight heart rate are not read, and nothing is stored: it
   is worked out when it is read from the plan, its synced activities and
   fitness.js.

   **Unfitted.** Every number in PREP is a starting value taken from a
   coaching rule of thumb, not a finding, and the page says "illustrative"
   beside each. A distance with no row (a marathon never reaches
   `profile.raceType`) has nothing to read. See docs/FINDINGS.md. */

import { FITNESS_BANDS, PLANNED, raceFormPosition } from './fitness.js';
import { trainingHistory } from './history.js';
import { parseISO, toISO, addDays } from './dates.js';

export const PREP = Object.freeze({
  longDays: 42,
  steadyWeeks: 8,
  steadySessions: 3,
  minCoveredWeeks: 3,
  // The length of a long session and how many of them a six-week block for the distance often has.
  long: Object.freeze({
    sprint: Object.freeze({ Bike: { min: 60, count: 2 }, Run: { min: 40, count: 2 }, Swim: { min: 25, count: 3 } }),
    olympic: Object.freeze({ Bike: { min: 90, count: 3 }, Run: { min: 60, count: 3 }, Swim: { min: 35, count: 4 } }),
    '70.3': Object.freeze({ Bike: { min: 180, count: 4 }, Run: { min: 90, count: 4 }, Swim: { min: 45, count: 4 } }),
    ironman: Object.freeze({ Bike: { min: 270, count: 5 }, Run: { min: 120, count: 5 }, Swim: { min: 60, count: 5 } }),
  }),
});

const DISCIPLINES = ['Bike', 'Run', 'Swim'];
const none = (reason) => ({ available: false, reason, raceType: null, items: [] });

/** "3h", "1h 30m", "45 min": the length a long session is held to. */
export function lengthLabel(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * @param {object} plan
 * @param {object} opts
 * @param {string} opts.today        an ISO date
 * @param {object} opts.fitness      what `fitnessSeries` returned for this plan
 * @returns {{ available: boolean, reason?: string, raceType: string|null, items: object[] }}
 */
export function racePreparation(plan, { today, fitness } = {}) {
  const raceType = plan?.profile?.raceType;
  const end = parseISO(today);
  if (!plan || !end || !Array.isArray(plan.activities)) return none('little-history');

  const history = trainingHistory(plan.activities, { today, weeks: PREP.steadyWeeks, sync: plan.activitySync });
  if (history.summary.coveredWeeks < PREP.minCoveredWeeks) return none('little-history');
  if (!fitness?.race) return none('no-race');
  const wanted = PREP.long[raceType];
  if (!wanted) return none('unknown-distance');

  const covered = history.weeks.filter((w) => w.covered && w.complete);
  const steady = covered.filter((w) => w.sessions >= PREP.steadySessions).length;

  const first = toISO(addDays(end, 1 - PREP.longDays));
  const longCount = (disc, min) => plan.activities.filter((a) =>
    a?.disc === disc && a.date >= first && a.date <= today && (Number(a.durationS) || 0) / 60 >= min).length;

  const band = FITNESS_BANDS.find((b) => b.key === raceType);
  const position = (v, lo, hi) => (v < lo ? 'below' : v > hi ? 'above' : 'within');

  const items = [
    {
      key: 'fitness', label: 'Fitness on race day', value: fitness.race.fit,
      reference: band ? { lo: band.lo, hi: band.hi } : null,
      against: band ? position(fitness.race.fit, band.lo, band.hi) : null,
      detail: 'The plan followed from today. An estimate.',
    },
    ...DISCIPLINES.map((disc) => ({
      key: `long-${disc}`, label: `${disc} sessions of ${lengthLabel(wanted[disc].min)} or more`,
      value: longCount(disc, wanted[disc].min), reference: wanted[disc].count,
      detail: 'Synced in the last 6 weeks.',
    })),
    {
      key: 'steady', label: `Weeks with ${PREP.steadySessions} or more sessions`, value: steady, reference: covered.length,
      detail: 'Of the last 8 weeks, those your sync covered.',
    },
    {
      key: 'form', label: 'Form on race day', value: fitness.race.form,
      reference: { lo: PLANNED.raceForm.low, hi: PLANNED.raceForm.high },
      against: raceFormPosition(fitness.race.form),
      detail: 'The plan followed from today. An estimate.',
    },
  ];
  return { available: true, raceType, items };
}
