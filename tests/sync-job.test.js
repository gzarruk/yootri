import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { slimWorkout, slimFeed, feedDocument, configProblems } from '../tools/sync/feed.mjs';
import { buildJwt, feedUrl, toFields } from '../tools/sync/firestore.mjs';
import { run } from '../tools/sync/run.mjs';
import { plistFor } from '../tools/sync/install.mjs';
import { runsByWeek } from '../assets/coach/syncweek.js';
import { newPlan } from '../assets/coach/plan.js';

const S = (type, end, value, target = 'no.target', lo = null, hi = null) => ({
  stepId: 999, stepOrder: 1, description: 'secret note', stepType: { stepTypeKey: type, stepTypeId: 3 },
  endCondition: { conditionTypeKey: end }, endConditionValue: value,
  targetType: { workoutTargetTypeKey: target }, targetValueOne: lo, targetValueTwo: hi, zoneNumber: null });
const garminWorkout = () => ({ workoutId: 42, ownerId: 7, workoutName: 'Speed Repeats', author: { fullName: 'A Person' },
  sportType: { sportTypeKey: 'running', sportTypeId: 1 },
  workoutSegments: [{ segmentOrder: 1, workoutSteps: [S('warmup', 'time', 300),
    { ...S('repeat', 'iterations', 8), numberOfIterations: 8, workoutSteps: [S('interval', 'distance', 800, 'pace.zone', 3.16, 3.04), S('recovery', 'time', 180)] }] }] });
const scheduled = () => ({ from: '2026-11-04', to: '2026-11-18', runs: [{ date: '2026-11-07', scheduleId: 11, title: 'Speed Repeats', workout: garminWorkout() }] });

test('slimWorkout keeps what the importer reads and drops ids, author and notes', () => {
  const s = slimWorkout(garminWorkout());
  const text = JSON.stringify(s);
  for (const gone of ['ownerId', 'A Person', 'secret note', 'stepId', '"workoutId"', 'segmentOrder']) assert.ok(!text.includes(gone), gone);
  assert.equal(s.workoutSegments[0].workoutSteps[1].workoutSteps.length, 2);
});

test('a slimmed feed still reads into runs the page can confirm', () => {
  const plan = newPlan({ name: 'T', startISO: '2026-11-02', now: 1 });
  const { byWeek, unreadable } = runsByWeek(plan, slimFeed(scheduled()));
  assert.equal(unreadable.length, 0);
  assert.equal(byWeek.get(0)[0].distanceM, 6400);
});

test('updatedAt moves only when the runs change; checkedAt always does', () => {
  const feed = slimFeed(scheduled());
  const a = feedDocument(feed, { now: 1000 });
  const b = feedDocument(feed, { now: 2000, previous: { updatedAt: a.updatedAt, hash: a.hash } });
  assert.equal(b.updatedAt, 1000);
  assert.equal(b.checkedAt, 2000);
  const c = feedDocument({ ...feed, runs: [] }, { now: 3000, previous: { updatedAt: a.updatedAt, hash: a.hash } });
  assert.equal(c.updatedAt, 3000);
});

test('config problems are sentences, and a good config has none', () => {
  assert.ok(configProblems(null)[0].includes('sync.json'));
  assert.equal(configProblems({ projectId: 'my-project-123', uid: 'AbCdEf1234567890', serviceAccount: '/k.json' }).length, 0);
  assert.equal(configProblems({}).length, 3);
});

test('the service-account JWT is signed RS256 over the right claims', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'sync@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const jwt = buildJwt(sa, 1_700_000_000_000);
  const [h, b, sig] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
  assert.equal(claims.exp - claims.iat, 3000);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, sig, 'base64url'));
});

test('the Firestore document has the shape the page reads', () => {
  assert.match(feedUrl('p-1', 'u1'), /\/projects\/p-1\/databases\/\(default\)\/documents\/users\/u1\/garmin\/feed$/);
  const f = toFields({ updatedAt: 5, checkedAt: 6, data: '{}', hash: 'h' }).fields;
  assert.deepEqual(f.updatedAt, { integerValue: '5' });
  assert.deepEqual(f.data, { stringValue: '{}' });
});

const cfg = { projectId: 'my-project-123', uid: 'AbCdEf1234567890', serviceAccount: '/k.json' };
const keys = () => { const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { client_email: 'x@y', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }; };
const harness = (over = {}) => {
  const calls = []; const logs = []; const notes = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    if (String(url).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
    if ((init.method ?? 'GET') === 'GET') return { ok: false, status: 404 };
    return { ok: true, status: 200 };
  };
  return { calls, logs, notes, opts: { argv: [], now: Date.UTC(2026, 10, 4), fetchFn, readConfig: () => cfg, readKey: keys,
    fetchRuns: async () => scheduled(), log: (l) => logs.push(l), notify: (m) => notes.push(m), ...over } };
};

test('a run writes the feed once and logs it', async () => {
  const h = harness();
  const r = await run(h.opts);
  assert.equal(r.ok, true);
  assert.equal(r.runs, 1);
  assert.equal(h.calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.match(h.logs[0], /ok runs=1/);
});

test('--dry-run fetches and prints but writes nothing and reads no key', async () => {
  const h = harness({ readKey: () => { throw new Error('should not read'); } });
  const r = await run({ ...h.opts, argv: ['--dry-run'] });
  assert.equal(r.dry, true);
  assert.equal(h.calls.length, 0);
});

test('an empty list is recorded as checked, not as a failure', async () => {
  const h = harness({ fetchRuns: async () => ({ from: 'a', to: 'b', runs: [] }) });
  const r = await run(h.opts);
  assert.equal(r.ok, true);
  assert.match(h.logs[0], /nothing published yet/);
});

test('failures write nothing, say so, and a rate limit is not retried', async () => {
  const h = harness({ fetchRuns: async () => { throw new Error('Could not read: Garmin returned 429 too many requests'); } });
  const r = await run(h.opts);
  assert.equal(r.ok, false);
  assert.equal(h.calls.filter((c) => c.method === 'PATCH').length, 0);
  assert.match(r.message, /rate limiting/);
  assert.equal(h.notes.length, 1);
  assert.match(h.logs[0], /FAILED/);
});

test('a missing config is reported in a sentence', async () => {
  const h = harness({ readConfig: () => { throw new Error('ENOENT'); } });
  const r = await run(h.opts);
  assert.equal(r.ok, false);
  assert.match(r.message, /sync\.json/);
});

test('the LaunchAgent runs at 00:20 daily, Sunday 23:30 and Monday 06:30, and escapes its paths', () => {
  const x = plistFor({ node: '/usr/bin/node', script: '/r/run.mjs', cwd: '/r', path: '/a&b:/c', logPath: '/l' });
  assert.match(x, /<key>Hour<\/key><integer>0<\/integer><key>Minute<\/key><integer>20<\/integer>/);
  assert.match(x, /<key>Weekday<\/key><integer>0<\/integer><key>Hour<\/key><integer>23<\/integer>/);
  assert.match(x, /<key>Weekday<\/key><integer>1<\/integer><key>Hour<\/key><integer>6<\/integer>/);
  assert.ok(x.includes('/a&amp;b:/c'));
});
