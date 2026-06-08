/**
 * POST /api/items/databricks-sql-warehouse/[id]/delete
 *   body { warehouseId, force? }
 *   → { ok: true }  |  { ok: false, error, code? }
 *
 * Permanently deletes a SQL Warehouse, completing the lifecycle. Azure-native
 * DEFAULT — NO Fabric dependency:
 *
 *   - Commercial / GCC  → real Databricks REST DELETE /api/2.0/sql/warehouses/{id}
 *                         (databricks-client.deleteWarehouse). A RUNNING-state
 *                         guard returns 409 unless `force` is set — deleting a
 *                         live warehouse drops in-flight queries.
 *   - GCC-High / DoD    → real Synapse Dedicated SQL pool ARM DELETE
 *                         (synapse-dev-client.deleteDedicatedSqlPool). Dedicated
 *                         pools can be deleted regardless of Online/Paused state,
 *                         so no running-state guard is applied on that path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deleteWarehouse, getWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';
import { deleteDedicatedSqlPool } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const warehouseId =
    (typeof body?.warehouseId === 'string' && body.warehouseId) ||
    req.nextUrl.searchParams.get('warehouseId') ||
    '';
  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });
  const force = body?.force === true;

  // --- Gov boundary: delete the Synapse Dedicated SQL pool by name ---------
  if (isGovCloud()) {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: 'Synapse workspace not configured. Set LOOM_SYNAPSE_WORKSPACE.' },
        { status: 503 },
      );
    }
    try {
      await deleteDedicatedSqlPool(warehouseId);
      return NextResponse.json({ ok: true });
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

  // Running-state guard — a RUNNING warehouse has live compute and possibly
  // in-flight queries. Require an explicit force to delete it.
  if (!force) {
    try {
      const wh = await getWarehouse(warehouseId);
      if (wh.state === 'RUNNING' || wh.state === 'STARTING') {
        return NextResponse.json(
          {
            ok: false,
            code: 'warehouse_running',
            error: `Warehouse is ${wh.state}. Stop it first, or confirm a forced delete.`,
          },
          { status: 409 },
        );
      }
    } catch (e: any) {
      // If the state read itself fails, surface it rather than silently deleting.
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  try {
    await deleteWarehouse(warehouseId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
