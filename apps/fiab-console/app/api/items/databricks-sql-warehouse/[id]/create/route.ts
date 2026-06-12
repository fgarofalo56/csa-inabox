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
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createWarehouse, databricksConfigGate, type WarehouseCreateSpec } from '@/lib/azure/databricks-client';
import { createDedicatedSqlPool } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { prepareItemCreate, isDeployTargetGate } from '@/lib/azure/topology';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  // Domain routing: the workspace that owns this item decides which DLZ
  // subscription + resource group the Synapse dedicated pool lands in.
  const workspaceId =
    req.nextUrl.searchParams.get('workspaceId') ||
    (typeof body?.workspace_id === 'string' ? body.workspace_id : '') ||
    '';

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
}
