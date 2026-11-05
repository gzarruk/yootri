/* Writing the feed to Firestore with a service account, and nothing else.

   REST only, signed with Node's own crypto, so the repo gains no dependency.
   The service account key is read by the caller from a file outside the repo and
   handed in; it is never logged. The document has the shape the page reads
   (`loadGarminFeed` in index.html): { updatedAt, checkedAt, data (a JSON
   string), hash }. */
import { createSign } from 'node:crypto';

const b64u = (x) => Buffer.from(x).toString('base64url');
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function buildJwt(sa, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3000 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key, 'base64url');
  return `${head}.${body}.${sig}`;
}

export async function accessToken(sa, { now = Date.now(), fetchFn = fetch } = {}) {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(sa, now) }),
  });
  if (!res.ok) throw new Error(`Google refused the service account (HTTP ${res.status}). Check the key file and that it belongs to this project.`);
  const json = await res.json();
  if (!json.access_token) throw new Error('Google returned no access token.');
  return json.access_token;
}

export const feedUrl = (projectId, uid) =>
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/garmin/feed`;

/** Only these two fields, so a note that the session ended never rewrites the runs or `checkedAt`. */
export const stateUrl = (projectId, uid) => `${feedUrl(projectId, uid)}?updateMask.fieldPaths=state&updateMask.fieldPaths=stateAt`;

export const toFields = (d) => ({ fields: {
  updatedAt: { integerValue: String(d.updatedAt) },
  checkedAt: { integerValue: String(d.checkedAt) },
  data: { stringValue: d.data },
  hash: { stringValue: d.hash },
  ...(d.state ? { state: { stringValue: d.state }, stateAt: { integerValue: String(d.stateAt) } } : {}),
} });

export async function readPrevious({ projectId, uid, token, fetchFn = fetch }) {
  const res = await fetchFn(feedUrl(projectId, uid), { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not read the existing feed (HTTP ${res.status}).`);
  const f = (await res.json()).fields ?? {};
  return { updatedAt: Number(f.updatedAt?.integerValue), hash: f.hash?.stringValue ?? null };
}

export async function writeFeed({ projectId, uid, token, doc, fetchFn = fetch }) {
  const res = await fetchFn(feedUrl(projectId, uid), {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(toFields(doc)),
  });
  if (!res.ok) {
    const hint = res.status === 403 ? ' The service account needs the "Cloud Datastore User" role.' : '';
    throw new Error(`Writing the feed failed (HTTP ${res.status}).${hint}`);
  }
}

export async function writeState({ projectId, uid, token, state, now, fetchFn = fetch }) {
  const res = await fetchFn(stateUrl(projectId, uid), {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { state: { stringValue: state }, stateAt: { integerValue: String(now) } } }),
  });
  if (!res.ok) throw new Error(`Writing the state failed (HTTP ${res.status}).`);
}
