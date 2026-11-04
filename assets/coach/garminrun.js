/* A Garmin Coach run, read into the engine's own shape.

   Input is what Garmin's workout detail returns (verified against a real Coach
   week): workoutSegments[].workoutSteps[], where a step is a warmup, interval,
   recovery, cooldown, an "other" step ended by the lap button, or a repeat group
   holding child steps. Lengths are time (seconds), distance (metres) or the lap
   button; targets are a pace range in m/s, a cadence range, or none.

   Output is what `confirmWeek` takes: { garminId, day, name, durationS,
   distanceM, steps }, with steps flattened to
   { kind: 'warmup'|'run'|'walk'|'cooldown'|'open', sec, meters?, zone? }.
   Garmin gives no total duration, so it is worked out here; a distance step with
   no pace target is timed at DEFAULT_MPS. Pure, and total: a malformed workout
   comes back as null, never a throw. */
import { weekdayOf } from './calendar.js';

// Unfitted: about 6:00 per km, used only to time a distance step that has no pace target.
export const DEFAULT_MPS = 2.8;

const KIND = { warmup: 'warmup', cooldown: 'cooldown', interval: 'run', recovery: 'walk', other: 'open' };

function leaf(st, defaultMps) {
  const type = st.stepType?.stepTypeKey;
  const kind = KIND[type];
  if (!kind) return null;
  const end = st.endCondition?.conditionTypeKey;
  const v = Number(st.endConditionValue);
  const t = st.targetType?.workoutTargetTypeKey;
  const lo = Number(st.targetValueOne), hi = Number(st.targetValueTwo);
  const pace = t === 'pace.zone' && lo > 0 && hi > 0 ? (lo + hi) / 2 : null;
  const out = { kind, sec: 0 };
  if (end === 'time' && v > 0) out.sec = v;
  else if (end === 'distance' && v > 0) { out.meters = v; out.sec = Math.round(v / (pace ?? defaultMps)); }
  else if (end !== 'lap.button') return null;
  if (kind === 'warmup' || kind === 'cooldown') out.zone = 'Z1';
  else if (kind === 'run') out.zone = pace ? 'Z3' : 'Z2';
  else if (kind === 'open') out.zone = 'Z2';
  return out;
}

function flatten(steps, defaultMps, depth = 0) {
  const out = [];
  for (const st of steps ?? []) {
    if (st.stepType?.stepTypeKey === 'repeat') {
      const n = Number(st.numberOfIterations ?? st.endConditionValue);
      if (!(n >= 1 && n <= 100) || depth > 3) return null;
      const inner = flatten(st.workoutSteps, defaultMps, depth + 1);
      if (!inner) return null;
      for (let i = 0; i < n; i++) out.push(...inner.map((x) => ({ ...x })));
    } else {
      const l = leaf(st, defaultMps);
      if (!l) return null;
      out.push(l);
    }
  }
  return out;
}

/**
 * @param {object} workout   Garmin's workout detail (get_workout_by_id)
 * @param {object} opts      { date: 'YYYY-MM-DD', scheduleId, defaultMps }
 */
export function runFromGarmin(workout, { date, scheduleId, defaultMps = DEFAULT_MPS } = {}) {
  if (!workout || typeof workout !== 'object') return null;
  if (workout.sportType?.sportTypeKey !== 'running') return null;
  const day = weekdayOf(date);
  const id = scheduleId ?? workout.workoutId;
  if (!day || id == null) return null;
  const steps = flatten(workout.workoutSegments?.[0]?.workoutSteps, defaultMps);
  if (!steps?.length) return null;
  const durationS = steps.reduce((a, s) => a + s.sec, 0);
  if (!(durationS > 0)) return null;
  const distanceM = Math.round(steps.reduce((a, s) => a + (s.meters ?? 0), 0)) || undefined;
  return {
    garminId: String(id), day, name: String(workout.workoutName ?? 'Run').slice(0, 60),
    durationS, ...(distanceM ? { distanceM } : {}), steps,
  };
}
