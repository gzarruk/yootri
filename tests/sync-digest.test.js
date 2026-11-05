import test from 'node:test';
import assert from 'node:assert/strict';
import { newPlan } from '../assets/coach/plan.js';
import { digest, digestNotices, latestPlan, plansUrl } from '../tools/sync/digest.mjs';
import { run } from '../tools/sync/run.mjs';
import { generateKeyPairSync } from 'node:crypto';

// Week 0 runs Mon 2026-10-05 to Sun 2026-10-11.
const START = '2026-10-05';
const base = (over = {}) => ({
  ...newPlan({ name: 'Season', startISO: START, raceDate: '2027-03-28', raceType: '70.3', now: 1 }), ...over,
});

test('a week-by-week plan is due for review once the released week is over', () => {
  const plan = base({ release: { through: 0 } });
  assert.equal(digest(plan, { today: '2026-10-11' }).release, null, 'Sunday: the week is not over');
  assert.deepEqual(digest(plan, { today: '2026-10-12' }).release, { reviewWeek: 0, nextWeek: 1 });
});

test('a plan released whole has nothing to review', () => {
  assert.equal(digest(base(), { today: '2026-10-20' }).release, null);
});

test('the notices are fixed sentences with a week number and nothing else', () => {
  const d = { release: { reviewWeek: 11, nextWeek: 12 }, suggestions: 2, current: 12 };
  const n = digestNotices(d);
  assert.deepEqual(n.map((x) => x.key), ['release-w11', 'suggestions-w12-2']);
  assert.equal(n[0].text, 'Week 12 is over. Open yootri to review it and release week 13.');
  assert.equal(n[1].text, '2 suggestions for this week are waiting in yootri.');
  assert.equal(digestNotices({ release: null, suggestions: 0, current: 3 }).length, 0);
  assert.equal(digestNotices({ release: null, suggestions: 1, current: 3 })[0].text, '1 suggestion for this week is waiting in yootri.');
});

test('the newest plan in a Firestore listing is read, and a bad record is skipped', () => {
  const doc = (updatedAt, data) => ({ fields: { updatedAt: { integerValue: String(updatedAt) }, data: { stringValue: data } } });
  const listing = { documents: [doc(5, JSON.stringify({ id: 'old' })), doc(9, JSON.stringify({ id: 'new' })), doc(12, '{broken')] };
  assert.equal(latestPlan(listing).id, 'new');
  assert.equal(latestPlan({}), null);
  assert.match(plansUrl('p-1', 'u1'), /\/projects\/p-1\/databases\/\(default\)\/documents\/users\/u1\/plans$/);
});

/* ---- inside the sync run ---- */

const cfg = { projectId: 'my-project-123', uid: 'AbCdEf1234567890', serviceAccount: '/k.json' };
const keys = () => { const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { client_email: 'x@y', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }; };
const harness = (plan, over = {}) => {
  const calls = []; const logs = []; const notes = []; const pushes = []; let note = {};
  const fetchFn = async (url, init = {}) => {
    const u = String(url); calls.push({ url: u, method: init.method ?? 'GET' });
    if (u.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
    if (u.endsWith('/plans')) {
      return { ok: true, status: 200, json: async () => ({ documents: plan ? [{ fields: {
        updatedAt: { integerValue: '9' }, data: { stringValue: JSON.stringify(plan) } } }] : [] }) };
    }
    if ((init.method ?? 'GET') === 'GET') return { ok: false, status: 404 };
    return { ok: true, status: 200 };
  };
  return { calls, logs, notes, pushes, opts: { argv: [], now: Date.UTC(2026, 9, 12, 8), fetchFn, readConfig: () => cfg, readKey: keys,
    fetchRuns: async () => ({ from: 'a', to: 'b', runs: [] }), log: (l) => logs.push(l), notify: (m) => notes.push(m),
    loadNote: () => note, saveNote: (n) => { note = n; }, push: (m) => pushes.push(m), ...over } };
};

test('after a good sync, a due review is said once and not again', async () => {
  const plan = base({ release: { through: 0 } });
  const h = harness(plan);
  await run(h.opts);
  assert.ok(h.notes.some((m) => /^Week 1 is over\./.test(m)));
  assert.equal(h.pushes.filter((m) => /Week 1 is over/.test(m)).length, 1);
  const again = harness(plan, { loadNote: h.opts.loadNote, saveNote: h.opts.saveNote });
  await run(again.opts);
  assert.equal(again.notes.filter((m) => /is over/.test(m)).length, 0);
});

test('a plan that cannot be read never fails the sync', async () => {
  const h = harness(null);
  const r = await run(h.opts);
  assert.equal(r.ok, true);
  const bad = harness(base(), { fetchFn: async (u, i = {}) => {
    if (String(u).endsWith('/plans')) throw new Error('boom');
    if (String(u).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
    return (i.method ?? 'GET') === 'GET' ? { ok: false, status: 404 } : { ok: true, status: 200 };
  } });
  assert.equal((await run(bad.opts)).ok, true);
  assert.ok(bad.logs.some((l) => /digest skipped/.test(l)));
});
