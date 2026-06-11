/**
 * POST /api/mdm/match — run probabilistic + deterministic matching for a model,
 * returning scored candidate duplicate pairs for steward review. Real Spark SQL
 * on the workspace Databricks SQL Warehouse (levenshtein/soundex). Honest 503
 * when Databricks isn't wired. No Fabric / partner-SaaS dependency.
 *
 * body: { modelId, minScore? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getModel, appendMdmRun, type MdmRunRecord } from '@/lib/azure/mdm-store';
import { runMatch, mdmConfigGate } from '@/lib/azure/mdm-match-merge';

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
        error: `MDM match engine not configured — set ${gate.missing}.` },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const modelId = String(body?.modelId || '');
  const minScore = typeof body?.minScore === 'number' ? body.minScore : 80;
  const model = await getModel(tenantId, modelId);
  if (!model) return NextResponse.json({ ok: false, error: 'model not found' }, { status: 404 });

  try {
    const { sql, candidates } = await runMatch(model, minScore);
    const rec: MdmRunRecord = {
      id: `mdm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      modelId: model.id, modelName: model.name, kind: 'match',
      ranAt: new Date().toISOString(), ranBy: s.claims.upn || tenantId,
      count: candidates.length, detail: `${candidates.length} candidate pairs ≥ ${minScore}%`,
    };
    await appendMdmRun(tenantId, rec);
    return NextResponse.json({ ok: true, sql, candidates });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
