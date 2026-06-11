/**
 * POST /api/mdm/merge — run the survivorship merge for a model, writing GOLDEN
 * RECORDS (with source lineage) to the model's Delta table on the workspace
 * Databricks SQL Warehouse (CREATE OR REPLACE TABLE … real Spark SQL). Records
 * the run to Cosmos (mdm-runs:<tenantId>). Honest 503 when Databricks isn't
 * wired. No Fabric / partner-SaaS dependency.
 *
 * body: { modelId }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getModel, appendMdmRun, type MdmRunRecord } from '@/lib/azure/mdm-store';
import { runMerge, mdmConfigGate } from '@/lib/azure/mdm-match-merge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;

  const gate = mdmConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', missing: gate.missing,
        error: `MDM merge engine not configured — set ${gate.missing}.` },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const model = await getModel(tenantId, String(body?.modelId || ''));
  if (!model) return NextResponse.json({ ok: false, error: 'model not found' }, { status: 404 });

  try {
    const result = await runMerge(model);
    const rec: MdmRunRecord = {
      id: `mdm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      modelId: model.id, modelName: model.name, kind: 'merge',
      ranAt: new Date().toISOString(), ranBy: s.claims.upn || tenantId,
      count: result.goldenRecordCount, sourceRecordCount: result.sourceRecordCount,
      goldenTable: result.goldenTable,
      detail: `${result.goldenRecordCount ?? '?'} golden records from ${result.sourceRecordCount ?? '?'} source rows`,
    };
    await appendMdmRun(tenantId, rec);
    return NextResponse.json({ ok: true, result, run: rec });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
