/**
 * #3669 — the link from a Databricks SQL warehouse back to the Loom item that
 * owns it, and the check that uses it.
 *
 * WHERE THE LINK LIVES. On the warehouse itself, as the custom tag
 * `loom_item_id` (`LOOM_OWNER_KEY`, shared with jobs and pipelines in
 * `databricks-resource-binding.ts`). Item `state` cannot carry it: `PATCH
 * /api/cosmos-items/[type]/[id]` replaces `state` wholesale, so anything
 * recorded there is a claim the item's own editor can rewrite. The warehouse tag
 * is written only by Loom code paths that are themselves authorized:
 *
 *   - `databricks-sql-warehouse/[id]/create` stamps it at birth (write-scoped on
 *     the item) and refuses a caller-supplied `loom_item_id` in `body.tags`;
 *   - `editWarehouse` always re-sends the current tags, so a scale or edit
 *     cannot drop it;
 *   - `admin/databricks-warehouses/adopt` stamps an existing warehouse
 *     (tenant admin, write-scoped on the target item).
 *
 * The tag is read LIVE from Databricks (`getWarehouse` → `tags.custom_tags`) on
 * every check, never from a cache, so a re-link or a deletion takes effect on the
 * next request.
 *
 * THE CHECK ({@link authorizeWarehouseTarget}). A caller may target a warehouse
 * when its tagged item sits in a workspace the caller can READ — the canonical
 * `authorizeItemWorkspace` ladder with `allowReadRoles`, given the item's own
 * `workspaceId` explicitly (that function ALLOWS when it is handed no workspace
 * and finds no item, so an empty `workspaceId` is refused here before it is
 * reached). A tenant admin goes through the same ladder for a tagged warehouse,
 * so the tenant boundary the resolver enforces still applies to them.
 *
 * An UNTAGGED warehouse (created before this change, outside Loom, or the
 * deployment-shared `loom-default`) and an ORPHANED one (its tag names no
 * warehouse item) belong to no item, so only a tenant admin may target them —
 * unchanged from before this change for admins, and the adopt route is how such
 * a warehouse is brought into an item. Every refusal a non-admin can see is the
 * same 404 body, so the response does not reveal which of "unknown", "untagged",
 * "orphaned" or "not readable" applied.
 *
 * CLOUD BOUNDARIES. Databricks SQL warehouses are the Commercial / GCC backend.
 * On GCC-High / IL5 / DoD the same item type is backed by a Synapse dedicated
 * SQL pool (`create/route.ts`), which this module does not touch; callers must
 * only reach it on the Databricks path.
 */
import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { getWarehouse, type Warehouse } from '@/lib/azure/databricks-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';
import { LOOM_OWNER_KEY } from '@/app/api/items/_lib/databricks-resource-binding';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** The Cosmos `itemType` whose items own Databricks SQL warehouses. */
export const WAREHOUSE_ITEM_TYPE = 'databricks-sql-warehouse';

/** Stable code on every refusal a non-admin can receive from this check. */
export const WAREHOUSE_NOT_AVAILABLE_CODE = 'warehouse_not_available';

/** Stable code when the link could not be read, so nothing was run. */
export const WAREHOUSE_UNVERIFIABLE_CODE = 'warehouse_unverifiable';

const NOT_AVAILABLE_ERROR =
  'This SQL warehouse is not available to you. Either it does not exist, it is not linked to a ' +
  'Loom SQL warehouse item, or you have no role in the workspace of the item it is linked to.';

const NOT_AVAILABLE_REMEDIATION =
  'Choose a warehouse created from a SQL warehouse item in a workspace you can open, or ask a ' +
  'workspace owner to share that workspace with you. A tenant admin can link an existing ' +
  'warehouse to an item with POST /api/admin/databricks-warehouses/adopt.';

/** True for any spelling of the owner key: trimmed, case-insensitive. */
export function isOwnerTagKey(key: unknown): boolean {
  return typeof key === 'string' && key.trim().toLowerCase() === LOOM_OWNER_KEY;
}

/**
 * Read the owner tag off a warehouse. `conflict` is true when the tag appears
 * with more than one distinct value — the warehouse then names no single owner
 * and is treated as unverifiable, never as the first or last value.
 */
export function warehouseOwnerTag(wh: Pick<Warehouse, 'tags'> | null | undefined): {
  value?: string;
  conflict: boolean;
} {
  const tags = Array.isArray(wh?.tags?.custom_tags) ? wh!.tags!.custom_tags! : [];
  const values = new Set(
    tags
      .filter((t) => isOwnerTagKey(t?.key) && typeof t?.value === 'string' && t.value.trim())
      .map((t) => t.value.trim()),
  );
  if (values.size > 1) return { conflict: true };
  const [value] = [...values];
  return { value, conflict: false };
}

/**
 * Load a `databricks-sql-warehouse` item by id WITHOUT authorizing. Cross-partition
 * on purpose: an item in a workspace the caller cannot read must still resolve,
 * so it can be REFUSED rather than mistaken for "no item".
 */
export async function loadWarehouseItemRaw(itemId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: cosmosIdFromLoomId(itemId) },
        { name: '@t', value: WAREHOUSE_ITEM_TYPE },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

export type WarehouseItemResolution =
  /** The warehouse is tagged and the tag names an existing warehouse item. */
  | { kind: 'bound'; warehouse: Warehouse; item: WorkspaceItem }
  /** The warehouse carries no owner tag. */
  | { kind: 'unbound'; warehouse: Warehouse }
  /** The tag names no `databricks-sql-warehouse` item. */
  | { kind: 'orphaned'; warehouse: Warehouse; itemId: string }
  /** Databricks answered 404 for this warehouse id. */
  | { kind: 'not_found' }
  /** Databricks or Cosmos could not be read, or the tag is ambiguous. */
  | { kind: 'unverifiable'; detail: string };

/**
 * Resolve a warehouse id to the Loom item its live `loom_item_id` tag names.
 * Read-only: never stamps, never edits.
 */
export async function resolveWarehouseItem(warehouseId: string): Promise<WarehouseItemResolution> {
  let warehouse: Warehouse;
  try {
    warehouse = await getWarehouse(warehouseId);
  } catch (e: unknown) {
    if ((e as { status?: number })?.status === 404) return { kind: 'not_found' };
    return { kind: 'unverifiable', detail: 'the warehouse could not be read from Databricks' };
  }
  const tag = warehouseOwnerTag(warehouse);
  if (tag.conflict) {
    return { kind: 'unverifiable', detail: `the warehouse carries more than one ${LOOM_OWNER_KEY} value` };
  }
  if (!tag.value) return { kind: 'unbound', warehouse };
  let item: WorkspaceItem | null;
  try {
    item = await loadWarehouseItemRaw(tag.value);
  } catch {
    return { kind: 'unverifiable', detail: 'the linked item could not be read' };
  }
  if (!item) return { kind: 'orphaned', warehouse, itemId: tag.value };
  return { kind: 'bound', warehouse, item };
}

export type WarehouseTargetVerdict =
  | { ok: true; warehouse: Warehouse; item?: WorkspaceItem }
  | { ok: false; res: NextResponse };

function notAvailable(): WarehouseTargetVerdict {
  return {
    ok: false,
    res: NextResponse.json(
      {
        ok: false,
        code: WAREHOUSE_NOT_AVAILABLE_CODE,
        error: NOT_AVAILABLE_ERROR,
        remediation: NOT_AVAILABLE_REMEDIATION,
      },
      { status: 404 },
    ),
  };
}

/**
 * May this session run work on this Databricks SQL warehouse? Read scope: the
 * caller needs any role on the workspace of the item the warehouse is linked to.
 */
export async function authorizeWarehouseTarget(
  session: SessionPayload,
  warehouseId: string,
): Promise<WarehouseTargetVerdict> {
  const r = await resolveWarehouseItem(warehouseId);

  if (r.kind === 'unverifiable') {
    return {
      ok: false,
      res: NextResponse.json(
        {
          ok: false,
          code: WAREHOUSE_UNVERIFIABLE_CODE,
          error: `Could not confirm which Loom item this SQL warehouse belongs to (${r.detail}), so nothing was run.`,
          remediation:
            'Retry. If it persists, check that the Console identity can read SQL warehouses in the ' +
            'Databricks workspace.',
        },
        { status: 502 },
      ),
    };
  }
  if (r.kind === 'not_found') return notAvailable();

  if (r.kind === 'bound') {
    const workspaceId = typeof r.item.workspaceId === 'string' ? r.item.workspaceId.trim() : '';
    // FAIL CLOSED: `authorizeItemWorkspace` allows when it has no workspace to check.
    if (!workspaceId) return notAvailable();
    const denied = await authorizeItemWorkspace(session, {
      workspaceId,
      itemId: r.item.id,
      itemType: WAREHOUSE_ITEM_TYPE,
      allowReadRoles: true,
      notFound: NOT_AVAILABLE_ERROR,
    });
    if (!denied) return { ok: true, warehouse: r.warehouse, item: r.item };
    // An ordinary refusal gets the coded body; a tenancy refusal (409) is a
    // different, true statement and passes through unchanged.
    return denied.status === 404 ? notAvailable() : { ok: false, res: denied };
  }

  // 'unbound' | 'orphaned' — no item, so no workspace to check against.
  if (isTenantAdmin(session)) return { ok: true, warehouse: r.warehouse };
  return notAvailable();
}
