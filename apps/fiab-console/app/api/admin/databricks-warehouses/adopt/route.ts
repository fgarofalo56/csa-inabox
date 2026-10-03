/**
 * Link existing Databricks SQL warehouses to Loom items (#3669).
 *
 *   GET  /api/admin/databricks-warehouses/adopt
 *        → { ok, warehouses: [{ id, name, state, linkedItemId, conflict, deploymentShared }] }
 *        Dry-run listing: every warehouse and the `loom_item_id` tag it carries
 *        today. Changes nothing.
 *
 *   POST /api/admin/databricks-warehouses/adopt
 *        body { warehouseId, itemId, dryRun? }   (dryRun defaults to TRUE)
 *        → { ok, dryRun, action: 'stamp' | 'none', warehouse, item }
 *        Writes only when `dryRun === false`: re-sends the warehouse's current
 *        tags plus `loom_item_id = itemId` through `editWarehouse`
 *        (`stampWarehouseOwner`), then re-reads the warehouse and reports success
 *        only if the read-back names THIS item.
 *
 * WHO. A tenant admin (`withTenantAdmin`), who must ALSO hold write access on the
 * target item's workspace through the canonical `authorizeItemWorkspace` ladder,
 * given the item's own `workspaceId` — so an admin cannot link a warehouse into a
 * workspace of another tenant the resolver would refuse them.
 *
 * WHAT IT REFUSES.
 *   - a warehouse already linked to a DIFFERENT item (409
 *     `warehouse_already_linked`) — moving a warehouse between items is not
 *     offered here;
 *   - a warehouse whose tag has more than one value (409 `warehouse_tag_conflict`);
 *   - a DEPLOYMENT-SHARED warehouse — `loom-default`, `loom-gov-default`, or the
 *     one `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` names (409
 *     `warehouse_deployment_shared`). Linking it would hand the deployment's
 *     shared compute to every reader of one item's workspace. It stays
 *     ADMIN-ONLY: only a tenant admin can target it from item-scoped routes, and
 *     a non-admin's AI functions run on Azure OpenAI instead;
 *   - an item of any type other than `databricks-sql-warehouse` (404), and an
 *     item id that matches more than one item (502 — never the first row).
 *
 * CONCURRENT LINKS. Two admins linking the same untagged warehouse to two items
 * can both pass the checks above. The read-back after the write is what decides:
 * the loser sees the winner's id and gets 409 `warehouse_already_linked` with
 * `linkedItemId`, never a false 200. Databricks has no compare-and-swap on tags,
 * so a writer that lands after the winner's read-back is not prevented; both
 * parties are tenant admins with write access on their item.
 *
 * WHY WAREHOUSES NEED THIS. Warehouses created before #3669 or outside Loom carry
 * no tag and no receipt, so the editor's self-heal (`healWarehouseLink`) cannot
 * link them, and only a tenant admin can target them from item-scoped routes
 * (`_lib/warehouse-item-binding.ts`). The SQL warehouse editor's AI functions
 * panel offers this as "Link to this item" to tenant admins.
 *
 * CLOUD BOUNDARIES. The route acts wherever Databricks is configured: it answers
 * 503 `not_configured` only when `databricksConfigGate()` reports
 * `LOOM_DATABRICKS_HOSTNAME` unset. That is NOT a Gov refusal —
 * `loomDatabricksEnabled = true` in `gcc-high.bicepparam` and `il5.bicepparam`,
 * so on those boundaries the route is reachable and stamps Databricks warehouses
 * like anywhere else. What differs in Gov is the item: there the SQL warehouse
 * item is backed by a Synapse dedicated pool, which carries no tag link, and the
 * AI-functions route checks `isGovCloud()` before it ever consults a tag (Gov
 * follow-up #4867).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  databricksConfigGate,
  getWarehouse,
  listWarehouses,
  type Warehouse,
} from '@/lib/azure/databricks-client';
import { LOOM_OWNER_KEY } from '@/app/api/items/_lib/databricks-resource-binding';
import {
  WAREHOUSE_ITEM_TYPE,
  isDeploymentSharedWarehouse,
  loadWarehouseItemRaw,
  stampWarehouseOwner,
  warehouseOwnerTag,
} from '@/app/api/items/_lib/warehouse-item-binding';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_NOT_FOUND = 'SQL warehouse item not found, or you have no write role in its workspace.';

function configGate(): NextResponse | null {
  const g = databricksConfigGate();
  if (!g) return null;
  return NextResponse.json(
    { ok: false, code: 'not_configured', error: `Databricks not configured. Set ${g.missing}.`, missing: g.missing },
    { status: 503 },
  );
}

function errStatus(e: unknown): number | undefined {
  return (e as { status?: number })?.status;
}

function alreadyLinked(linkedItemId: string): NextResponse {
  return NextResponse.json(
    { ok: false, code: 'warehouse_already_linked', error: 'The warehouse is already linked to a different item.', linkedItemId },
    { status: 409 },
  );
}

function tagConflict(): NextResponse {
  return NextResponse.json(
    { ok: false, code: 'warehouse_tag_conflict', error: `The warehouse carries more than one ${LOOM_OWNER_KEY} value; fix its tags in Databricks first.` },
    { status: 409 },
  );
}

export const GET = withTenantAdmin(async () => {
  const gate = configGate();
  if (gate) return gate;
  let list: Warehouse[];
  try {
    list = await listWarehouses();
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  const warehouses = list.map((w) => {
    const tag = warehouseOwnerTag(w);
    return {
      id: w.id,
      name: w.name,
      state: w.state,
      linkedItemId: tag.value ?? null,
      conflict: tag.conflict,
      deploymentShared: isDeploymentSharedWarehouse(w),
    };
  });
  return NextResponse.json({ ok: true, warehouses });
});

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  const gate = configGate();
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const warehouseId = typeof body.warehouseId === 'string' ? body.warehouseId.trim() : '';
  const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
  if (!warehouseId || !itemId) {
    return NextResponse.json({ ok: false, error: 'warehouseId and itemId are required' }, { status: 400 });
  }
  const dryRun = body.dryRun !== false;

  let item: WorkspaceItem | null;
  try {
    // Throws DuplicateWarehouseItemError when the id is ambiguous — FAIL CLOSED.
    item = await loadWarehouseItemRaw(itemId);
  } catch {
    return NextResponse.json(
      { ok: false, code: 'item_unverifiable', error: 'Could not resolve exactly one SQL warehouse item for that id; nothing was changed.' },
      { status: 502 },
    );
  }
  const workspaceId = typeof item?.workspaceId === 'string' ? item.workspaceId.trim() : '';
  // FAIL CLOSED before the ladder: it allows when handed no workspace.
  if (!item || !workspaceId) {
    return NextResponse.json({ ok: false, error: ITEM_NOT_FOUND }, { status: 404 });
  }
  const denied = await authorizeItemWorkspace(session, {
    workspaceId,
    itemId: item.id,
    itemType: WAREHOUSE_ITEM_TYPE,
    notFound: ITEM_NOT_FOUND,
  });
  if (denied) return denied;

  let wh: Warehouse;
  try {
    wh = await getWarehouse(warehouseId);
  } catch (e) {
    if (errStatus(e) === 404) {
      return NextResponse.json({ ok: false, error: 'SQL warehouse not found in the Databricks workspace.' }, { status: 404 });
    }
    return NextResponse.json(
      { ok: false, error: 'Could not read the SQL warehouse from Databricks; nothing was changed.' },
      { status: 502 },
    );
  }
  const tag = warehouseOwnerTag(wh);
  const summary = { warehouse: { id: wh.id, name: wh.name }, item: { id: item.id, workspaceId } };
  if (tag.conflict) return tagConflict();
  if (tag.value && tag.value !== item.id) return alreadyLinked(tag.value);
  if (tag.value === item.id) return NextResponse.json({ ok: true, dryRun, action: 'none', ...summary });
  if (isDeploymentSharedWarehouse(wh)) {
    return NextResponse.json(
      {
        ok: false,
        code: 'warehouse_deployment_shared',
        error: 'This is the deployment-shared SQL warehouse. It stays tenant-admin-only and is not linked to a single item; create a warehouse from this item instead.',
      },
      { status: 409 },
    );
  }
  if (dryRun) return NextResponse.json({ ok: true, dryRun: true, action: 'stamp', ...summary });

  // Report only what was read back, never what was sent.
  const stamped = await stampWarehouseOwner(wh, item.id);
  switch (stamped.kind) {
    case 'stamped':
      return NextResponse.json({ ok: true, dryRun: false, action: 'stamp', ...summary });
    case 'linked_elsewhere':
      return alreadyLinked(stamped.linkedItemId);
    case 'tag_conflict':
      return tagConflict();
    case 'edit_failed':
      return NextResponse.json({ ok: false, error: stamped.message }, { status: 502 });
    case 'unconfirmed':
    default:
      return NextResponse.json(
        { ok: false, code: 'stamp_unconfirmed', error: 'The edit was sent, but the tag could not be read back on the warehouse. Re-run the dry run to check.' },
        { status: 502 },
      );
  }
});
