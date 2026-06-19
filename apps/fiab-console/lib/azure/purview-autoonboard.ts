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
 * The Atlas entity uses a richer typeName per item type (see
 * `loomTypeToAtlasTypeName`) with `DataSet` as the universal fallback so every
 * item always registers successfully even when no specialised Atlas typedef
 * matches. Scan-based classification/tagging is a deeper follow-up; this
 * establishes the asset + ownership so it surfaces immediately.
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

/**
 * Map a Loom item type to the most specific Atlas typeName present on a
 * classic Microsoft Purview Data Map account.
 *
 * Rules:
 *   - Only use typeNames documented as built-in Atlas types on classic Data
 *     Map (no-vaporware: a fake typename creates the entity but breaks
 *     lineage-graph rendering).
 *   - `DataSet` is the Atlas base-type fallback — always present, always safe.
 *   - Fabric-specific typeNames (`fabric_*`) are included because the classic
 *     Data Map scanner ships them as built-in types even without a Fabric
 *     tenant being connected.
 *   - Non-data item types (notebooks, pipelines, reports, apps) fall through
 *     to `DataSet`; a `Process` entity is the correct Atlas type for pipelines
 *     at runtime but `DataSet` is fine for catalog registration.
 *
 * @see https://learn.microsoft.com/purview/concept-supported-data-stores
 */
export function loomTypeToAtlasTypeName(itemType: string): string {
  switch (itemType) {
    // ── Storage / lake ──────────────────────────────────────────────────────
    case 'lakehouse':          return 'fabric_lakehouse';
    case 'dataset':            return 'DataSet';
    case 'geo-dataset':        return 'DataSet';

    // ── Analytical stores ────────────────────────────────────────────────────
    case 'warehouse':          return 'fabric_warehouse';
    case 'kql-database':       return 'azure_data_explorer_database';
    case 'eventhouse':         return 'azure_data_explorer_database';
    case 'mirrored-database':  return 'DataSet';       // no dedicated built-in type

    // ── Relational / graph / vector ─────────────────────────────────────────
    case 'azure-sql-database': return 'azure_sql_db';
    case 'cosmos-gremlin-graph':return 'azure_cosmos_db';
    case 'cypher-graph':       return 'azure_cosmos_db';
    case 'gql-graph':          return 'azure_data_explorer_database'; // ADX-native
    case 'vector-store':       return 'azure_cognitive_search';

    // ── Semantic / reporting ─────────────────────────────────────────────────
    case 'semantic-model':     return 'DataSet';       // no built-in Atlas type
    case 'report':             return 'DataSet';

    // ── Data products ────────────────────────────────────────────────────────
    case 'data-product':       return 'DataSet';
    case 'data-product-instance': return 'DataSet';
    case 'data-product-template': return 'DataSet';

    // ── Everything else (pipelines, notebooks, apps, etc.) ──────────────────
    default:                   return 'DataSet';
  }
}

export async function autoOnboardToPurview(item: WorkspaceItem, tenantId: string): Promise<void> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) return; // not configured → silent no-op
  try {
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

    const typeName = loomTypeToAtlasTypeName(item.itemType);

    const upsertResult = await registerAtlasEntity({
      typeName,
      qualifiedName: itemQualifiedName(item, tenantId),
      displayName: item.displayName,
      owner: item.createdBy,
      comment: `Loom ${item.itemType}${item.description ? ` — ${item.description}` : ''}`,
      classifications: withClass ? classifications : undefined,
    });

    // Best-effort GUID write-back: stamp the Atlas GUID onto the Cosmos item's
    // state so the lineage drawer (guidFromItem) and edge-emit code can resolve
    // it without a separate Purview lookup. Isolated try/catch — a patch
    // failure MUST NOT undo the Atlas registration or surface an error.
    const guid = upsertResult.primaryGuid;
    if (guid && item.id && item.workspaceId) {
      try {
        const { itemsContainer } = await import('@/lib/azure/cosmos-client');
        const container = await itemsContainer();
        // Read → merge → replace (Cosmos SDK doesn't expose sparse PATCH for
        // nested paths in all versions; a full replace on the just-created item
        // is safe and avoids a separate PatchOperation dependency).
        const { resource: current } = await container
          .item(item.id, item.workspaceId)
          .read<WorkspaceItem>();
        if (current) {
          const next: WorkspaceItem = {
            ...current,
            state: { ...(current.state || {}), purviewGuid: guid },
            updatedAt: new Date().toISOString(),
          };
          await container.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
        }
      } catch {
        /* GUID write-back is best-effort — never block or surface an error */
      }
    }
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
 *   • The typeName used for delete must match the one used on registration;
 *     `loomTypeToAtlasTypeName` guarantees both use the same mapping.
 */
export async function offboardFromPurview(item: WorkspaceItem, tenantId: string): Promise<void> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) return; // not configured → silent no-op
  try {
    const typeName = loomTypeToAtlasTypeName(item.itemType);
    await deleteAtlasEntityByQualifiedName(typeName, itemQualifiedName(item, tenantId));
  } catch {
    /* best-effort offboard — never block or fail item deletion */
  }
}
