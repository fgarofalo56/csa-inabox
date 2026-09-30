/**
 * GET /api/mdm/golden-records?modelId=&limit= — browse the golden-record table
 * a merge produced (real SELECT on the workspace Databricks SQL Warehouse).
 * Returns columns + rows for the stewardship grid (source lineage columns
 * source_systems / source_record_count are part of the table). Honest 503 when
 * Databricks isn't wired; honest error if the merge hasn't run yet.
 *
 * GET /api/mdm/golden-records (no modelId) → MDM run history.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getModel, listMdmRuns } from '@/lib/azure/mdm-store';
import { listGoldenRecords, mdmConfigGate } from '@/lib/azure/mdm-match-merge';
import { apiServerError } from '@/lib/api/respond';
import { WarehouseResolutionError, warehouseErrorBody, warehouseErrorStatus } from '@/lib/azure/databricks-sql-warehouse';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session: s }) => {
  const tenantId = s.claims.oid;
  const modelId = req.nextUrl.searchParams.get('modelId');

  if (!modelId) {
    try {
      const runs = await listMdmRuns(tenantId);
      return NextResponse.json({ ok: true, runs });
    } catch (e: any) {
      return apiServerError(e);
    }
  }

  const gate = mdmConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', missing: gate.missing,
        error: `MDM engine not configured — set ${gate.missing}.` },
      { status: 503 },
    );
  }

  const model = await getModel(tenantId, modelId);
  if (!model) return NextResponse.json({ ok: false, error: 'model not found' }, { status: 404 });
  const limit = Math.min(1000, Math.max(1, Number(req.nextUrl.searchParams.get('limit') || 200)));

  try {
    const page = await listGoldenRecords(model, limit);
    return NextResponse.json({ ok: true, goldenTable: model.goldenTable, ...page });
  } catch (e: any) {
    // listGoldenRecords resolves the warehouse first: a classified resolution
    // failure is NOT "the merge hasn't run" and must not carry that hint.
    if (e instanceof WarehouseResolutionError) {
      return NextResponse.json(warehouseErrorBody(e), { status: warehouseErrorStatus(e) });
    }
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: 'Run a merge first to create the golden-record table.' },
      { status: 500 },
    );
  }
});
