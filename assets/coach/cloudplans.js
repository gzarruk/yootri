/* A plan deleted from the account is left behind as a small record, not removed.

   The page keeps a copy of every plan in the browser and uploads a local plan the
   account does not hold. So when one device removed a plan, any other device that
   still had it put it straight back, and two devices went on working on two plans
   under one name. A deletion is therefore written as `{ id, deleted: true,
   deletedAt }` in the plan's own document: every device reads it on its next
   pull and drops its copy, unless the copy was edited after the deletion (an edit
   made later is the athlete's newest word and wins). Pure: the page reads and
   writes the documents. */

export const tombstoneData = (id, now) => JSON.stringify({ id, deleted: true, deletedAt: now });

const isTombstone = (r) => r && typeof r === 'object' && r.deleted === true && typeof r.id === 'string' && Number.isFinite(r.deletedAt);

/** What the account's plan documents hold: the plans, and `{ id: deletedAt }` for the deleted ones. */
export function splitCloud(records) {
  const live = [];
  const tombstones = {};
  for (const r of records ?? []) {
    if (isTombstone(r)) tombstones[r.id] = r.deletedAt;
    else if (r && typeof r === 'object' && r.id && !r.deleted) live.push(r);
  }
  return { live, tombstones };
}

/** The ids of local plans that were deleted elsewhere and not edited since. */
export function droppedByTombstones(locals, tombstones) {
  return (locals ?? [])
    .filter((p) => p && Object.hasOwn(tombstones ?? {}, p.id) && (p.updatedAt || 0) <= tombstones[p.id])
    .map((p) => p.id);
}
