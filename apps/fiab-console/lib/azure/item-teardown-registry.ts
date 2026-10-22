/**
 * Per-item-type backend teardown for the generic item DELETE (#5046).
 *
 * `DELETE /api/items/[type]/[id]` used to delete only the Cosmos doc, so every
 * backing Azure object the install/auto-bind path had created was orphaned (the
 * same leak class as the 526 idle Stream Analytics jobs). This module is the
 * single place that decides, per item type, whether a backend teardown runs and
 * what the route must report about it.
 *
 * SAFETY CONTRACT (each clause has a test that fails without it):
 *   1. RECORDED-ONLY. Teardown runs `teardownItemBackend(..., { recordedOnly })`,
 *      which deletes a resource only when the item's persisted state names it.
 *      No name is derived from the display name; a derived Stream Analytics job
 *      name is deleted only after its `loomItemId` ARM tag proves ownership.
 *   2. REGISTERED TYPES ONLY. A type absent from `TEARDOWN_ITEM_TYPES` has no
 *      backing resource this code can identify, and the response says so
 *      (`teardown.status:'not_applicable'`) instead of implying a clean teardown.
 *   3. NEVER SILENT. Whatever teardown cannot remove comes back as `orphans`
 *      plus a `warning`, and is logged. A thrown teardown is an orphan list of
 *      "unknown", not a swallowed exception.
 *
 * DECISION - does the Cosmos delete proceed when teardown failed? YES. The doc
 * is deleted and the response carries the structured orphan list. Rationale:
 * blocking the delete would make a broken backend (RBAC drift, a paused pool)
 * turn into an undeletable item, which is the audit-B1 defect the eventstream
 * route was already fixed for; and keeping a half-deleted doc is worse than
 * reporting precisely what is left, because the doc's refs are only useful to
 * the same teardown that just failed. The orphan list names kind + ref + the
 * (truncated) error so an operator can remove each one by hand. Skipped rows
 * (shared pool, no recorded ref) are reported as `retained`, never as errors.
 */

import {
  teardownItemBackend,
  type TeardownItem,
  type TeardownOutcome,
  type TeardownResourceResult,
} from '@/lib/azure/resource-teardown';

/**
 * Item types whose backing resource a provisioner in `lib/install/provisioners`
 * (or the auto-bind engine) creates AND records on `state`. Each is torn down by
 * the matching `case` in `teardownItemBackend`.
 *
 * Deliberately NOT here: `workspace-monitor` (its database is a platform-wide
 * constant), `databricks-cluster` / `databricks-sql-warehouse` (own routes), and
 * every catalog-only type (kql-dashboard, report, semantic-model, dataset, ...).
 */
export const TEARDOWN_ITEM_TYPES: ReadonlySet<string> = new Set([
  'lakehouse',
  'warehouse',
  'kql-database',
  'eventhouse',
  'eventstream',
  'activator',
  'synapse-pipeline',
  'adf-pipeline',
  'data-pipeline',
  'mirrored-database',
  'mirrored-databricks',
  'databricks-job',
  'databricks-notebook',
  'notebook',
  'ml-model',
  'materialized-lake-view',
  'ai-search-index',
  'prompt-flow',
]);

export interface ItemDeleteTeardownReport {
  /** `ran` = teardown executed; `not_applicable` = type has no registered backend. */
  status: 'ran' | 'not_applicable';
  /** Resources teardown FAILED to remove (result==='error'). Non-empty => `warning` is set. */
  orphans: TeardownResourceResult[];
  /** Resources deliberately left in place (skipped), with the reason. */
  retained: TeardownResourceResult[];
  /** Resources removed or already gone. */
  removed: TeardownResourceResult[];
  /** Set iff something may have been left behind. States only what was observed. */
  warning?: string;
}

function summarize(rows: TeardownResourceResult[]): string {
  return rows.map((r) => `${r.kind} ${r.ref}${r.error ? ` (${r.error})` : ''}`).join('; ');
}

/**
 * Run the registered teardown for one item BEFORE its Cosmos doc is deleted
 * (the refs live on the doc). Never throws.
 */
export async function teardownForItemDelete(
  item: TeardownItem,
  tenantId: string,
): Promise<ItemDeleteTeardownReport> {
  if (!TEARDOWN_ITEM_TYPES.has(item.itemType)) {
    return { status: 'not_applicable', orphans: [], retained: [], removed: [] };
  }
  let outcome: TeardownOutcome;
  try {
    outcome = await teardownItemBackend(item, tenantId, { recordedOnly: true });
  } catch (e: any) {
    // teardownItemBackend is contracted not to throw. If it does, nothing is
    // known about what was removed, and the report says exactly that.
    const msg = (e?.message || String(e)).slice(0, 300);
    const orphan: TeardownResourceResult = {
      kind: item.itemType,
      ref: '(unknown)',
      result: 'error',
      error: `teardown threw before reporting: ${msg}`,
    };
    console.error(`[item-delete] teardown threw for ${item.itemType} ${item.id}: ${msg}`);
    return {
      status: 'ran',
      orphans: [orphan],
      retained: [],
      removed: [],
      warning: `Item deleted, but teardown threw before reporting, so it is unknown which backing resources remain: ${msg}`,
    };
  }
  const orphans = outcome.resources.filter((r) => r.result === 'error');
  const retained = outcome.resources.filter((r) => r.result === 'skipped');
  const removed = outcome.resources.filter((r) => r.result === 'deleted' || r.result === 'not_found');
  const warning = orphans.length
    ? `Item deleted, but ${orphans.length} backing resource(s) could not be removed and may still exist: ${summarize(orphans)}.`
    : undefined;
  if (warning) console.error(`[item-delete] ${item.itemType} ${item.id}: ${warning}`);
  return { status: 'ran', orphans, retained, removed, ...(warning ? { warning } : {}) };
}
