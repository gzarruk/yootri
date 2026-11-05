#!/usr/bin/env node
/* Leave one plan in the account: the others become deletion records.

     node tools/sync/prune.mjs --keep <plan id>          show what would go (changes nothing)
     node tools/sync/prune.mjs --keep <plan id> --yes    back them up, then remove them

   For an account that has collected several plans under one name, so each device
   works on a different one. A removed plan is not deleted from the account but
   replaced by a small record saying so (assets/coach/cloudplans.js), which every
   device reads on its next pull and drops its own copy. Run it only once the page
   that understands those records is live, or an older page would read them as
   plans. The plans are copied to ~/.config/yootri/backups first. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tombstoneData } from '../../assets/coach/cloudplans.js';
import { plansUrl } from './digest.mjs';
import { accessToken } from './firestore.mjs';
import { HOME_DIR } from './run.mjs';

const read = (d) => { let data = null; try { data = JSON.parse(d.fields?.data?.stringValue); } catch { /* unreadable */ } return data; };
const idOf = (d) => String(d.name).split('/').pop();

export function planPrune(listing, keepId) {
  if (!keepId) throw new Error('Say which plan to keep with --keep <plan id>.');
  const docs = (listing?.documents ?? []).map((d) => ({ d, data: read(d) })).filter((x) => x.data && !x.data.deleted);
  const keep = docs.find((x) => idOf(x.d) === keepId);
  if (!keep) throw new Error(`${keepId} is not in the account. Plans there: ${docs.map((x) => idOf(x.d)).join(', ') || 'none'}.`);
  const summary = (x) => ({ id: idOf(x.d), name: x.d.fields?.name?.stringValue, updatedAt: Number(x.d.fields?.updatedAt?.integerValue),
    activities: (x.data.activities ?? []).length, actuals: Object.keys(x.data.actuals ?? {}).length, doc: x.d });
  return { keep: summary(keep), remove: docs.filter((x) => x !== keep).map(summary) };
}

export const tombstoneFields = (id, now) => ({ fields: {
  name: { stringValue: 'Deleted plan' }, updatedAt: { integerValue: String(now) }, data: { stringValue: tombstoneData(id, now) } } });

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const keepId = argv[argv.indexOf('--keep') + 1];
  const yes = argv.includes('--yes');
  const cfg = JSON.parse(readFileSync(join(HOME_DIR, 'sync.json'), 'utf8'));
  const token = await accessToken(JSON.parse(readFileSync(cfg.serviceAccount, 'utf8')), { now: Date.now(), fetchFn: fetch });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const listing = await (await fetch(plansUrl(cfg.projectId, cfg.uid), { headers })).json();
  let plan;
  try { plan = planPrune(listing, keepId); } catch (e) { console.error(e.message); process.exit(2); }
  const line = (x) => `  ${x.id}  "${x.name}"  updated ${new Date(x.updatedAt).toISOString()}  ${x.activities} activities, ${x.actuals} logged`;
  console.log(`Keeping:\n${line(plan.keep)}\n${yes ? 'Removing' : 'Would remove'}:\n${plan.remove.map(line).join('\n') || '  nothing'}`);
  if (!yes || !plan.remove.length) { if (!yes) console.log('\nNothing changed. Add --yes to do it.'); process.exit(0); }
  const now = Date.now();
  const dir = join(HOME_DIR, 'backups'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `plans-${new Date(now).toISOString().slice(0, 10)}-${now}.json`);
  writeFileSync(file, JSON.stringify(plan.remove.map((x) => x.doc), null, 1), { mode: 0o600 });
  console.log(`Backed up to ${file}`);
  for (const x of plan.remove) {
    const res = await fetch(`${plansUrl(cfg.projectId, cfg.uid)}/${encodeURIComponent(x.id)}`, { method: 'PATCH', headers, body: JSON.stringify(tombstoneFields(x.id, now)) });
    console.log(`  ${x.id}: ${res.ok ? 'removed' : `FAILED (HTTP ${res.status})`}`);
  }
}
