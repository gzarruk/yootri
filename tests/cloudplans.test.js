import test from 'node:test';
import assert from 'node:assert/strict';
import { tombstoneData, splitCloud, droppedByTombstones } from '../assets/coach/cloudplans.js';

test('a deleted plan is a small record, not a plan', () => {
  const t = JSON.parse(tombstoneData('p-1', 1000));
  assert.deepEqual(t, { id: 'p-1', deleted: true, deletedAt: 1000 });
});

test('a cloud listing splits into plans and deletions, and ignores what is neither', () => {
  const plan = { id: 'p-a', name: 'A', updatedAt: 5 };
  const { live, tombstones } = splitCloud([
    plan, JSON.parse(tombstoneData('p-b', 9)), null, { name: 'no id' }, { id: 'p-c', deleted: true },
  ]);
  assert.deepEqual(live, [plan]);
  assert.deepEqual(tombstones, { 'p-b': 9 });
});

test('a device drops a plan that was deleted elsewhere, unless it was edited after the deletion', () => {
  const locals = [
    { id: 'p-old', updatedAt: 500 },     // deleted at 1000, not touched since: gone
    { id: 'p-edited', updatedAt: 2000 }, // edited after the deletion: the edit wins
    { id: 'p-live', updatedAt: 100 },    // never deleted
  ];
  assert.deepEqual(droppedByTombstones(locals, { 'p-old': 1000, 'p-edited': 1000 }), ['p-old']);
  assert.deepEqual(droppedByTombstones(locals, {}), []);
});
