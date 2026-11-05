/* What is ready in the plan, said once.

   After a good sync the job reads the athlete's synced plan, asks the engine's
   own questions of it (`releaseState`, `suggest`) and sends one fixed sentence
   for each thing that is newly ready: a week to review, suggestions waiting.
   It decides and changes nothing. The review itself, and every suggestion, is
   worked out again on the page when it is opened, because the page also sees
   what never leaves a browser (overnight figures, heart-rate load); this job
   does not, and the sentences carry a week number and a count, never a session,
   a run or a name. */
import { loadPlan } from '../../assets/coach/plan.js';
import { releaseState } from '../../assets/coach/review.js';
import { suggest } from '../../assets/coach/adapt.js';

const pad = (n) => String(n).padStart(2, '0');
/** The athlete's own calendar day, since a week ends when their Sunday does. */
export const localISO = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export const plansUrl = (projectId, uid) =>
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/plans`;

/** The most recently worked-on plan in a Firestore listing; a record that does not parse is skipped. */
export function latestPlan(listing) {
  let best = null;
  for (const d of listing?.documents ?? []) {
    const at = Number(d.fields?.updatedAt?.integerValue);
    let plan = null;
    try { plan = JSON.parse(d.fields?.data?.stringValue); } catch { /* skip it */ }
    if (plan && typeof plan === 'object' && (!best || at > best.at)) best = { at, plan };
  }
  return best?.plan ?? null;
}

export function digest(raw, { today }) {
  const plan = loadPlan(raw);
  const state = releaseState(plan, { today });
  const release = state.mode === 'weekly' && state.due ? { reviewWeek: state.reviewWeek, nextWeek: state.nextWeek } : null;
  const current = Number.isInteger(state.current) ? state.current : null;
  const suggestions = current === null || current < 0 ? 0 : suggest(plan, { week: current }).length;
  return { release, suggestions, current };
}

export function digestNotices(d) {
  const out = [];
  if (d.release) {
    out.push({ key: `release-w${d.release.reviewWeek}`,
      text: `Week ${d.release.reviewWeek + 1} is over. Open yootri to review it and release week ${d.release.nextWeek + 1}.` });
  }
  if (d.suggestions > 0) {
    out.push({ key: `suggestions-w${d.current}-${d.suggestions}`,
      text: `${d.suggestions} suggestion${d.suggestions === 1 ? '' : 's'} for this week ${d.suggestions === 1 ? 'is' : 'are'} waiting in yootri.` });
  }
  return out;
}

/**
 * Read the plan, say what is newly ready. Never throws: a plan that cannot be
 * read must not fail the sync that has already written the runs.
 */
export async function runDigest({ cfg, token, now, fetchFn = fetch, d }) {
  try {
    const res = await fetchFn(plansUrl(cfg.projectId, cfg.uid), { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const plan = latestPlan(await res.json());
    if (!plan) return;
    const found = digestNotices(digest(plan, { today: localISO(now) }));
    const note = d.loadNote();
    const sent = { ...(note.sent ?? {}) };
    for (const n of found) {
      if (sent[n.key]) continue;
      d.notify(n.text);
      await d.push(`yootri: ${n.text}`);
      sent[n.key] = now;
    }
    // What was said stays said; the list is trimmed to the newest so it never grows without end.
    const keep = Object.fromEntries(Object.entries(sent).sort((a, b) => b[1] - a[1]).slice(0, 30));
    d.saveNote({ ...note, sent: keep });
  } catch (e) {
    d.log(`${new Date(now).toISOString()} digest skipped: ${String(e?.message ?? e)}`);
  }
}
