/**
 * Link existing Databricks SQL warehouses to Loom items (#3669).
 *
 *   GET  /api/admin/databricks-warehouses/adopt
 *        → { ok, warehouses: [{ id, name, state, linkedItemId, conflict }] }
 *        Dry-run listing: every warehouse and the `loom_item_id` tag it carries
 *        today. Changes nothing.
 *
 *   POST /api/admin/databricks-warehouses/adopt
 *        body { warehouseId, itemId, dryRun? }   (dryRun defaults to TRUE)
 *        → { ok, dryRun, action: 'stamp' | 'none', warehouse, item }
 *        Writes only when `dryRun === false`: re-sends the warehouse's current
 *        tags plus `loom_item_id = itemId` through `editWarehouse`, then re-reads
 *        the warehouse and reports success only if the tag is there.
 *
 * WHO. A tenant admin (`withTenantAdmin`), who must ALSO hold write access on the
 * target item's workspace through the canonical `authorizeItemWorkspace` ladder,
 * given the item's own `workspaceId` — so an admin cannot link a warehouse into a
 * workspace of another tenant the resolver would refuse them.
 *
 * WHAT IT REFUSES. A warehouse already linked to a DIFFERENT item (409
 * `warehouse_already_linked`) — moving a warehouse between items is not offered
 * here; a warehouse whose tag has more than one value (409); an item of any type
 * other than `databricks-sql-warehouse` (404).
 *
 * WHY WAREHOUSES NEED THIS. Warehouses created before #3669, created outside Loom,
 * or the deployment-shared `loom-default` carry no tag, so only a tenant admin
 * can target them from item-scoped routes (`_lib/warehouse-item-binding.ts`).
 * Linking one to an item opens it to every reader of that item's workspace.
 *
 * Databricks (Commercial / GCC) only. On GCC-High / IL5 / DoD the SQL warehouse
 * item is a Synapse dedicated pool, which has no tag link yet; this route answers
 * 503 `not_configured` there because `databricksConfigGate()` is unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  databricksConfigGate,
  editWarehouse,
  getWarehouse,
  listWarehouses,
  type Warehouse,
} from '@/lib/azure/databricks-client';
import { LOOM_OWNER_KEY } from '@/app/api/items/_lib/databricks-resource-binding';
import {
  WAREHOUSE_ITEM_TYPE,
  isOwnerTagKey,
  loadWarehouseItemRaw,
  warehouseOwnerTag,
} from '@/app/api/items/_lib/warehouse-item-binding';

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
    return { id: w.id, name: w.name, state: w.state, linkedItemId: tag.value ?? null, conflict: tag.conflict };
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

  const item = await loadWarehouseItemRaw(itemId);
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
  if (tag.conflict) {
    return NextResponse.json(
      { ok: false, code: 'warehouse_tag_conflict', error: `The warehouse carries more than one ${LOOM_OWNER_KEY} value; fix its tags in Databricks first.` },
      { status: 409 },
    );
  }
  if (tag.value && tag.value !== item.id) {
    return NextResponse.json(
      { ok: false, code: 'warehouse_already_linked', error: 'The warehouse is already linked to a different item.', linkedItemId: tag.value },
      { status: 409 },
    );
  }
  if (tag.value === item.id) return NextResponse.json({ ok: true, dryRun, action: 'none', ...summary });
  if (dryRun) return NextResponse.json({ ok: true, dryRun: true, action: 'stamp', ...summary });

  const kept = (wh.tags?.custom_tags || []).filter((t) => !isOwnerTagKey(t?.key));
  try {
    // Re-send the current scale settings so the edit changes only the tags.
    await editWarehouse(
      wh.id,
      {
        min_num_clusters: wh.min_num_clusters,
        max_num_clusters: wh.max_num_clusters,
        auto_stop_mins: wh.auto_stop_mins,
        enable_serverless_compute: wh.enable_serverless_compute,
      },
      [...kept, { key: LOOM_OWNER_KEY, value: item.id }],
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  // Report only what was read back, never what was sent.
  let after: Warehouse | null = null;
  try {
    after = await getWarehouse(wh.id);
  } catch {
    after = null;
  }
  if (warehouseOwnerTag(after).value !== item.id) {
    return NextResponse.json(
      { ok: false, code: 'stamp_unconfirmed', error: 'The edit was sent, but the tag could not be read back on the warehouse. Re-run the dry run to check.' },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, dryRun: false, action: 'stamp', ...summary });
});
