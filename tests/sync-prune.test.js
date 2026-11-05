import test from 'node:test';
import assert from 'node:assert/strict';
import { planPrune, tombstoneFields } from '../tools/sync/prune.mjs';

const doc = (id, updatedAt, extra = {}) => ({ name: `projects/p/databases/(default)/documents/users/u/plans/${id}`, fields: {
  name: { stringValue: 'Season' }, updatedAt: { integerValue: String(updatedAt) },
  data: { stringValue: JSON.stringify({ id, ...extra }) } } });

test('every plan but the one to keep is to be removed, and already-deleted ones are left alone', () => {
  const listing = { documents: [doc('p-keep', 9, { actuals: { a: 1 } }), doc('p-x', 5), doc('p-y', 7), doc('p-z', 1, { deleted: true, deletedAt: 1 })] };
  const r = planPrune(listing, 'p-keep');
  assert.deepEqual(r.remove.map((x) => x.id), ['p-x', 'p-y']);
  assert.equal(r.keep.id, 'p-keep');
});

test('it refuses when the plan to keep is not in the account', () => {
  assert.throws(() => planPrune({ documents: [doc('p-x', 5)] }, 'p-nope'), /not in the account/);
  assert.throws(() => planPrune({ documents: [] }, ''), /--keep/);
});

test('a removed plan becomes a tombstone the page knows how to read', () => {
  const f = tombstoneFields('p-x', 1234);
  assert.equal(f.fields.updatedAt.integerValue, '1234');
  assert.deepEqual(JSON.parse(f.fields.data.stringValue), { id: 'p-x', deleted: true, deletedAt: 1234 });
});
