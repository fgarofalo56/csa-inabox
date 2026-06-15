/**
 * Purview auto-onboarding — every Loom item, when created, is best-effort
 * registered as a Microsoft Purview catalog asset (Atlas entity) so owners and
 * stewards see it in Governance + Catalog with lineage, ownership, and (after a
 * scan) classifications — without anyone manually registering it.
 *
 * Best-effort + non-blocking (called as `void autoOnboardToPurview(...)`, mirror
 * of the AI-Search `upsertLoomDoc` hook): a missing Purview account or a 403
 * never blocks or fails item creation. When `LOOM_PURVIEW_ACCOUNT` is unset the
 * call is a cheap no-op (no network).
 *
 * The Atlas entity uses the core `DataSet` type (always present) with a stable
 * `loom://` qualifiedName so re-creates upsert (no duplicates). Scan-based
 * classification/tagging is a deeper follow-up; this establishes the asset +
 * ownership so it surfaces immediately.
 */
import { registerAtlasEntity, ensureClassificationDefs, deleteAtlasEntityByQualifiedName } from './purview-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

/**
 * Stable `loom://` qualifiedName for an item's Purview Atlas entity. The same
 * value is used on onboard (create) and offboard (delete) so the two operate
 * on exactly one entity (Atlas dedupes on qualifiedName).
 */
function itemQualifiedName(item: WorkspaceItem, tenantId: string): string {
  return `loom://${tenantId}/${item.workspaceId}/${item.itemType}/${item.id}`;
}

export async function autoOnboardToPurview(item: WorkspaceItem, tenantId: string): Promise<void> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) return; // not configured → silent no-op
  try {
    // Carry the item's Loom classifications + sensitivity into Purview so the
    // asset is tagged on arrival. The classification typedefs are created on
    // demand (idempotent) so attaching them succeeds.
    const state = (item.state || {}) as Record<string, unknown>;
    const raw = [
      ...(Array.isArray(state.classifications) ? (state.classifications as unknown[]) : []),
      ...(typeof state.sensitivityLabel === 'string' && state.sensitivityLabel ? [state.sensitivityLabel] : []),
    ].map((c) => String(c).trim()).filter(Boolean);
    const classifications = [...new Set(raw)];
    let withClass = classifications.length > 0;
    if (withClass) {
      // If the defs can't be created, still onboard the asset WITHOUT tags
      // rather than fail the whole registration.
      try { await ensureClassificationDefs(classifications); }
      catch { withClass = false; }
    }
    await registerAtlasEntity({
      typeName: 'DataSet',
      qualifiedName: itemQualifiedName(item, tenantId),
      displayName: item.displayName,
      owner: item.createdBy,
      comment: `Loom ${item.itemType}${item.description ? ` — ${item.description}` : ''}`,
      classifications: withClass ? classifications : undefined,
    });
  } catch {
    /* best-effort auto-onboard — never block or fail item creation */
  }
}

/**
 * Symmetric offboard hook — when a Loom item is deleted (hard-delete or
 * recycle-bin purge), best-effort soft-delete its Purview Atlas entity so the
 * external catalog graph reconciles in lock-step with Loom's own Weave edges
 * (`reconcileThreadEdgesOnDelete`). Mirror of `autoOnboardToPurview`:
 *
 *   • Cheap no-op when `LOOM_PURVIEW_ACCOUNT` is unset (no network).
 *   • Called as `void offboardFromPurview(...)` — a missing account, a 403, or
 *     a "not found" never blocks or fails the delete.
 *   • Uses the same stable `loom://` qualifiedName so exactly the entity that
 *     was onboarded is the one retired. Atlas flips status → DELETED and
 *     RETAINS the entity (not a purge), preserving lineage history — the
 *     faithful 1:1 of the portal "Delete asset" action.
 */
export async function offboardFromPurview(item: WorkspaceItem, tenantId: string): Promise<void> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) return; // not configured → silent no-op
  try {
    await deleteAtlasEntityByQualifiedName('DataSet', itemQualifiedName(item, tenantId));
  } catch {
    /* best-effort offboard — never block or fail item deletion */
  }
}
