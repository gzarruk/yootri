/* Confirming a week's runs from Garmin.

   Garmin Coach publishes one week at a time, so the plan holds placeholder
   runs. Given the runs Garmin has scheduled for a week, `confirmWeek` says what
   the week's sessions become. Pure: it returns a new list and never writes. The
   page / a job turns it into a draft and applies it through the usual flow.

   A Garmin run is { garminId, day, name, durationS, distanceM?, steps? }, where
   steps are [{ kind: 'warmup'|'run'|'walk'|'cooldown', sec, zone? }].

   Rules: a session the athlete logged, finished or edited is never touched; an
   empty list means "not published yet" and changes nothing; matching is by day,
   then by role (the longest run takes the long run). */
import { durToMin, minToDur } from './duration.js';
import { DAYS } from './profile.js';
import { freshWeek } from './plan.js';

const FIELDS = ['day', 'disc', 'focus', 'dur', 'zone', 'paceZone'];
const dayIdx = (d) => DAYS.indexOf(d);

/** The zone a run's steps read as: its main (longest run or walk-run) zone. */
export function zoneFromSteps(steps) {
  const main = (steps ?? []).filter((s) => s.kind === 'run' || s.kind === 'walk')
    .reduce((a, s) => (s.kind === 'run' && s.sec > (a?.sec ?? 0) ? s : a), null);
  return main?.zone ?? 'Z2';
}

const asSession = (base, g) => {
  const s = { ...base, day: g.day, disc: 'Run', focus: g.name || base.focus || 'Run',
    dur: minToDur(Math.round(g.durationS / 60)), zone: zoneFromSteps(g.steps),
    status: 'confirmed', source: 'garmin', garminId: g.garminId };
  delete s.paceZone;
  if (g.steps?.length) s.steps = g.steps.map((x) => ({ ...x }));
  else delete s.steps;
  return s;
};

export function confirmWeek(plan, absWeek, garminRuns, { prefix } = {}) {
  const key = `w${absWeek}`;
  const week = plan.weeks?.[key] ?? [];
  const runs = (garminRuns ?? []).filter((g) => g && g.garminId != null && DAYS.includes(g.day) && g.durationS > 0);
  if (!runs.length) {
    return { published: false, sessions: week.map((s) => ({ ...s })), changes: [], unmatched: [] };
  }
  const fresh = new Map(freshWeek(plan, absWeek).map((s) => [s.id, s]));
  const locked = (s) => {
    if (plan.done?.[s.id] || plan.actuals?.[s.id]) return true;
    const f = fresh.get(s.id);
    // Not what the generator made: the athlete edited it. A confirmed one is ours to update.
    return s.source !== 'garmin' && !!f && !FIELDS.every((k) => s[k] === f[k]);
  };
  const incoming = new Set(runs.map((g) => String(g.garminId)));
  const changes = [];
  let out = week.map((s) => ({ ...s }));

  // A confirmed run Garmin no longer lists goes back to its placeholder (or goes).
  out = out.flatMap((s) => {
    if (s.source !== 'garmin' || incoming.has(String(s.garminId)) || locked(s)) return [s];
    const f = fresh.get(s.id);
    changes.push({ id: s.id, kind: 'reverted' });
    return f ? [{ ...f }] : [];
  });

  const slots = () => out.filter((s) => s.disc === 'Run' && !locked(s)
    && (s.source !== 'garmin' || incoming.has(String(s.garminId))));
  const taken = new Set();
  const pending = [];
  // Re-syncs keep the same slot.
  for (const g of runs) {
    const same = out.find((s) => s.source === 'garmin' && String(s.garminId) === String(g.garminId) && !locked(s));
    if (same) { Object.assign(same, asSession(same, g)); taken.add(same.id); changes.push({ id: same.id, kind: 'updated' }); }
    else pending.push(g);
  }
  const free = () => slots().filter((s) => !taken.has(s.id));
  // 1. Same day.
  for (const g of [...pending]) {
    const s = free().find((x) => x.day === g.day);
    if (s) { Object.assign(s, asSession(s, g)); taken.add(s.id); pending.splice(pending.indexOf(g), 1); changes.push({ id: s.id, kind: 'confirmed' }); }
  }
  // 2. By role: the longest remaining run takes the longest free placeholder, then in day order.
  pending.sort((a, b) => b.durationS - a.durationS);
  const longest = pending[0];
  for (const g of [...pending]) {
    const f = free();
    if (!f.length) break;
    const s = g === longest
      ? f.reduce((a, b) => (durToMin(b.dur) > durToMin(a.dur) ? b : a))
      : f.reduce((a, b) => (dayIdx(a.day) <= dayIdx(b.day) ? a : b));
    Object.assign(s, asSession(s, g)); taken.add(s.id); pending.splice(pending.indexOf(g), 1); changes.push({ id: s.id, kind: 'moved' });
  }
  // 3. More Garmin runs than placeholders: add them.
  for (const g of pending) {
    const id = `${prefix ?? key}-g${g.garminId}`;
    out.push(asSession({ id }, g));
    changes.push({ id, kind: 'added' });
  }
  const unmatched = slots().filter((s) => !taken.has(s.id) && s.source !== 'garmin').map((s) => s.id);
  return { published: true, sessions: out, changes, unmatched };
}
