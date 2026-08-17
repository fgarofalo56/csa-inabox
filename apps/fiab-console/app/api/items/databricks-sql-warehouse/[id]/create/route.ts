/**
 * POST /api/items/databricks-sql-warehouse/[id]/create
 *   body {
 *     name, cluster_size?, warehouse_type?, enable_serverless_compute?,
 *     enable_photon?, channel?, auto_stop_mins?, min_num_clusters?,
 *     max_num_clusters?, tags?, spot_instance_policy?,   // Databricks (Comm/GCC)
 *     gov_sku?                                           // Synapse Dedicated pool (Gov)
 *   }
 *   → { ok: true, id, name }  |  { ok: false, error, code? }
 *
 * Completes the SQL Warehouse lifecycle (edit/scale already exist). This is the
 * Azure-native DEFAULT create — NO Fabric/Power BI dependency (per
 * `.claude/rules/no-fabric-dependency.md`):
 *
 *   - Commercial / GCC  → real Databricks REST POST /api/2.0/sql/warehouses
 *                         (databricks-client.createWarehouse).
 *   - GCC-High / DoD    → real Synapse Dedicated SQL pool via ARM PUT
 *                         (synapse-dev-client.createDedicatedSqlPool). Databricks
 *                         SQL Warehouses aren't a Gov-boundary offering, so the
 *                         dedicated pool is the parity backend there.
 *
 * Errors from the live backend are surfaced verbatim (no mocks, no fakes).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `POST(req: NextRequest)` took NO `ctx`, so `[id]` was never read. `getSession()`
 * was the entire authorization on a route that PROVISIONS AZURE INFRASTRUCTURE:
 *
 *   Commercial/GCC → `createWarehouse(spec)`          — new billed compute
 *   GCC-High/DoD   → `createDedicatedSqlPool(...)`    — an ARM PUT of a
 *                    dedicated SQL pool, i.e. a new DATABASE, at a DWU SKU the
 *                    caller names
 *
 * IT IS NOT THE SAME SHAPE AS ITS SIBLINGS — it takes a CREATION SPEC, not a
 * `warehouseId` — so it is treated on its own evidence rather than by family
 * analogy. The exposure is different in kind too: the others act on an existing
 * resource, this one MANUFACTURES resources. Any authenticated session, owning
 * nothing, could stand up warehouses or `DW30000c` pools in the deployment and
 * bill them to the operator. That is an unbounded spend primitive, and on the
 * Gov branch it also creates persistent data-bearing infrastructure.
 *
 * BOTH BOUNDARIES WERE AFFECTED — recorded explicitly because most of this
 * family is Databricks-only, so "Commercial-only finding" is the natural and
 * WRONG assumption here (`cloud-parity.md`).
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via `withSession`, ABOVE the `id === 'new'` gate
 *   (ordering defect MEASURED on #3655; no `middleware.ts` here, verified).
 *
 * LAYER 1 — OWN THE ROUTE ITEM, WRITE-SCOPED (no `allowReadRoles`), and placed
 *   ABOVE the `isGovCloud()` branch so ONE check covers both boundaries rather
 *   than two that can drift — the same placement decision #3665 made on
 *   `[id]/delete`, and for the same reason: the Gov path is the more
 *   consequential one and a Commercial-only receipt would never exercise it.
 *   Every config gate (`databricksConfigGate`, `LOOM_SYNAPSE_WORKSPACE`, the
 *   `prepareItemCreate` RBAC preflight) now sits BELOW it.
 *
 * LAYER 2 — THE DEPLOY TARGET IS NOW RESOLVED FROM THE AUTHORIZED ITEM.
 *   `workspaceId` used to come from `?workspaceId=` or `body.workspace_id`, and
 *   it decides which DLZ subscription and resource group the Gov pool lands in.
 *   A caller-supplied deploy target on an unauthenticated provisioning route is
 *   the same class of defect as a caller-supplied database name, so it is read
 *   from `guard.ctx.item.workspaceId` instead. NOTHING REGRESSES: the editor's
 *   `createWarehouse` payload (`sql-warehouse-editor.tsx:529`) carries no
 *   `workspace_id` and the URL carries no `workspaceId`, so the previous value
 *   on the shipped path was the empty string.
 *
 * LAYER 3 — the created resource is still NOT bound back to the item. Creating
 *   a warehouse here does not stamp it with `loom_item_id`, so the next call to
 *   a sibling route still cannot resolve it — that is the same missing binding
 *   the rest of this family records, tracked in #3669. FLOOR, NOT BOUND:
 *   `createOwnedItem` (`_lib/item-crud.ts:423`) is self-service, so this moves
 *   the reachable population from "any authenticated session" to "any
 *   authenticated session, plus one POST".
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { createWarehouse, databricksConfigGate, type WarehouseCreateSpec } from '@/lib/azure/databricks-client';
import { createDedicatedSqlPool } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { prepareItemCreate, isDeployTargetGate } from '@/lib/azure/topology';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'databricks-sql-warehouse';

/** 404 body naming BOTH causes and asserting neither (`deploy-integrity.md` R7). */
const ITEM_UNREACHABLE =
  'This SQL warehouse item is not available to you. Either it does not exist, or you have no ' +
  'role in its workspace. Ask a workspace owner to share it with you.';

/**
 * The unsaved-item honest gate — after authentication, before the guard.
 *
 * REACHABLE, and this is the call site where the WORDING carries the most
 * weight, because the natural reading of "create" is that it should work on a
 * new item. It cannot: this route provisions Azure infrastructure in the name of
 * a Loom item, and an unsaved item has no owner and no workspace to route the
 * deploy target from (see Layer 2 above — the target is read from
 * `guard.ctx.item.workspaceId`). `submitCreate`
 * (`sql-warehouse-editor.tsx:529`) renders `j.error` verbatim as the Create
 * dialog's error text, so the message below is written to be the actionable next
 * step rather than a refusal.
 *
 * DISCLOSED DELIBERATELY: the stronger fix is for the editor to disable the
 * Create action on an unsaved item, the shape #3655 applied to
 * `warehouse-alerts.tsx`. `lib/editors/databricks/sql-warehouse-editor.tsx` is
 * OUTSIDE this change's file ownership (another lane owns `lib/editors/**`), so
 * it is named as follow-up rather than edited here.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first, then create the warehouse — provisioning runs in the ' +
      'name of the saved item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. WRITE-SCOPED, and ABOVE the cloud branch so Commercial and Gov are
  // covered by ONE check. This route provisions billed Azure infrastructure.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  // LAYER 2. Domain routing from the AUTHORIZED ITEM, never from the request.
  // This decides which DLZ subscription + resource group the Gov pool lands in.
  const workspaceId = guard.ctx.item.workspaceId;

  // --- Gov boundary: Azure-native Synapse Dedicated SQL pool ---------------
  if (isGovCloud()) {
    const govSku = typeof body?.gov_sku === 'string' ? body.gov_sku.trim() : '';
    if (!/^DW\d+c$/i.test(govSku)) {
      return NextResponse.json(
        { ok: false, error: 'gov_sku is required for the Gov dedicated-pool backend (e.g. DW100c)' },
        { status: 400 },
      );
    }
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: 'Synapse workspace not configured. Set LOOM_SYNAPSE_WORKSPACE (and LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID).' },
        { status: 503 },
      );
    }
    // Resolve the owning domain's deploy target + preflight UAMI reach. A
    // cross-sub permission gap is surfaced as an honest, named remediation
    // (409) instead of an opaque ARM 403 on the pool PUT.
    const target = await prepareItemCreate(workspaceId, 'databricks-sql-warehouse');
    if (isDeployTargetGate(target)) {
      return NextResponse.json(
        { ok: false, code: 'rbac_gate', error: target.reason, missingGrant: target.missingGrant, fixScript: target.fixScript, redeploy: true },
        { status: 409 },
      );
    }
    const location = process.env.LOOM_LOCATION || process.env.LOOM_ASA_LOCATION || 'eastus';
    try {
      const pool = await createDedicatedSqlPool(name, govSku, location, undefined, {
        subscriptionId: target.subscriptionId,
        resourceGroup: target.resourceGroup,
      });
      // Synapse dedicated pools are addressed by name — that IS the warehouse id.
      return NextResponse.json({ ok: true, id: pool?.name || name, name, deployTier: target.tier, domainId: target.domainId });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // --- Commercial / GCC: Databricks SQL Warehouse --------------------------
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks not configured. Set ${gate.missing}.` },
      { status: 503 },
    );
  }

  const spec: WarehouseCreateSpec = { name };
  if (typeof body?.cluster_size === 'string') spec.cluster_size = body.cluster_size;
  if (body?.warehouse_type === 'CLASSIC' || body?.warehouse_type === 'PRO') spec.warehouse_type = body.warehouse_type;
  if (typeof body?.enable_serverless_compute === 'boolean') spec.enable_serverless_compute = body.enable_serverless_compute;
  if (typeof body?.enable_photon === 'boolean') spec.enable_photon = body.enable_photon;
  if (body?.channel === 'CHANNEL_NAME_CURRENT' || body?.channel === 'CHANNEL_NAME_PREVIEW') {
    spec.channel = { name: body.channel };
  }
  if (typeof body?.auto_stop_mins === 'number') spec.auto_stop_mins = body.auto_stop_mins;
  if (typeof body?.min_num_clusters === 'number') spec.min_num_clusters = body.min_num_clusters;
  if (typeof body?.max_num_clusters === 'number') spec.max_num_clusters = body.max_num_clusters;
  if (body?.spot_instance_policy === 'COST_OPTIMIZED' || body?.spot_instance_policy === 'RELIABILITY_OPTIMIZED' || body?.spot_instance_policy === 'POLICY_UNSPECIFIED') {
    spec.spot_instance_policy = body.spot_instance_policy;
  }
  // Tags arrive from the UI as a { key: value } object; the REST API wants
  // { custom_tags: [{ key, value }] }.
  if (body?.tags && typeof body.tags === 'object' && !Array.isArray(body.tags)) {
    const custom_tags = Object.entries(body.tags as Record<string, unknown>)
      .filter(([k, v]) => k && typeof v === 'string' && v.length > 0)
      .map(([key, value]) => ({ key, value: String(value) }));
    if (custom_tags.length > 0) spec.tags = { custom_tags };
  }

  try {
    const result = await createWarehouse(spec);
    return NextResponse.json({ ok: true, id: result.id, name });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
