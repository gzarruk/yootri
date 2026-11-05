/* The Garmin Coach feed, as it is written to the account.

   The bridge's `scheduled` output carries Garmin's whole workout record. The
   page needs only what `runFromGarmin` reads, so `slimWorkout` keeps exactly
   that: names, sport, step types, end conditions and targets — no ids, no
   author, no profile. Pure; nothing here touches the network or the disk. */
import { createHash } from 'node:crypto';

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

function slimStep(st) {
  const out = {
    ...pick(st, ['endConditionValue', 'targetValueOne', 'targetValueTwo', 'numberOfIterations']),
    stepType: { stepTypeKey: st?.stepType?.stepTypeKey },
    endCondition: { conditionTypeKey: st?.endCondition?.conditionTypeKey },
    targetType: { workoutTargetTypeKey: st?.targetType?.workoutTargetTypeKey },
  };
  if (Array.isArray(st?.workoutSteps)) out.workoutSteps = st.workoutSteps.map(slimStep);
  return out;
}

export function slimWorkout(w) {
  return {
    workoutName: String(w?.workoutName ?? '').slice(0, 80),
    sportType: { sportTypeKey: w?.sportType?.sportTypeKey },
    workoutSegments: (w?.workoutSegments ?? []).slice(0, 1).map((seg) => ({
      workoutSteps: (seg?.workoutSteps ?? []).map(slimStep),
    })),
  };
}

/** The bridge's output reduced to what the page reads. */
export function slimFeed(scheduled) {
  return {
    from: scheduled?.from ?? null,
    to: scheduled?.to ?? null,
    runs: (scheduled?.runs ?? []).map((r) => ({
      date: r.date, scheduleId: r.scheduleId, title: String(r.title ?? '').slice(0, 80),
      workout: slimWorkout(r.workout),
    })),
  };
}

export const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * The document to write. `checkedAt` always moves, so the page can tell a job
 * that stopped from a week that has not changed; `updatedAt` moves only when
 * the runs themselves did.
 */
export function feedDocument(feed, { now, previous = null }) {
  const data = JSON.stringify(feed);
  const hash = hashOf(data);
  const same = previous && previous.hash === hash && Number.isFinite(previous.updatedAt);
  return { updatedAt: same ? previous.updatedAt : now, checkedAt: now, data, hash, state: 'ok', stateAt: now };
}

export const AUTH_MESSAGE = 'Garmin needs you to sign in again. On your Mac, run `make garmin-login`.';

/** What a failed fetch means: Garmin ended the session (`auth`), is limiting us (`rate`), or something passing (`other`). */
export function failureKind(message) {
  const m = String(message ?? '');
  if (/not signed in|verification code|garmin-login|auth_required|mfa_required/i.test(m)) return 'auth';
  if (/429|rate limit|too many/i.test(m)) return 'rate';
  return 'other';
}

/** What is wrong with a sync config, in sentences, or [] when it can be used. */
export function configProblems(cfg) {
  const out = [];
  if (!cfg || typeof cfg !== 'object') return ['The sync config is missing: create ~/.config/yootri/sync.json.'];
  if (!/^[a-z][a-z0-9-]{4,60}$/.test(String(cfg.projectId ?? ''))) out.push('projectId must be the Firebase project id (see index.html).');
  if (!/^[A-Za-z0-9]{10,64}$/.test(String(cfg.uid ?? ''))) out.push('uid must be your Firebase user id (Authentication → Users).');
  if (typeof cfg.serviceAccount !== 'string' || !cfg.serviceAccount) out.push('serviceAccount must be the path to the service account key file.');
  return out;
}
