/**
 * POST /api/dq/run — execute the tenant's DQ rule set against a chosen engine.
 *
 * body: { backend: 'kusto'|'databricks'|'synapse', database?, warehouseId?,
 *         catalog?, schema?, synapsePool?, tableNames? }
 *
 * Runs every enabled rule (optionally filtered to tableNames) on the selected
 * Azure-native engine via {@link runDqRules} (real KQL / Spark SQL / T-SQL),
 * persists a run-history record to Cosmos (`dq-runs:<tenantId>`), and returns the
 * composite score + per-rule breakdown. Honest 503 with the missing env var when
 * the backend isn't wired. No Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runDqRules, dqRunConfigGate, type DqRunBackend } from '@/lib/azure/data-quality-client';
import { appendDqRun, type DqRunRecord } from '@/lib/azure/dq-run-store';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BACKENDS: DqRunBackend[] = ['kusto', 'databricks', 'synapse'];

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));

  const backend = (body?.backend || 'kusto') as DqRunBackend;
  if (!BACKENDS.includes(backend)) {
    return NextResponse.json({ ok: false, error: `backend must be one of: ${BACKENDS.join(', ')}` }, { status: 400 });
  }

  const gate = dqRunConfigGate(backend);
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', missing: gate.missing,
        error: `${backend} run backend not configured — set ${gate.missing}.` },
      { status: 503 },
    );
  }

  const tableNames = Array.isArray(body?.tableNames) ? body.tableNames.map((t: any) => String(t)).filter(Boolean) : undefined;

  try {
    const result = await runDqRules(tenantId, {
      backend,
      database: body?.database ? String(body.database) : undefined,
      warehouseId: body?.warehouseId ? String(body.warehouseId) : undefined,
      catalog: body?.catalog ? String(body.catalog) : undefined,
      schema: body?.schema ? String(body.schema) : undefined,
      synapsePool: body?.synapsePool === 'dedicated' ? 'dedicated' : 'serverless',
      tableNames,
    });

    const rec: DqRunRecord = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      backend: result.backend,
      target: result.target,
      score: result.score,
      ruleCount: result.ruleCount,
      passingRules: result.passingRules,
      breakdown: result.breakdown,
      ranAt: result.computedAt,
      ranBy: s.claims.upn || tenantId,
      tables: tableNames,
    };
    const history = await appendDqRun(tenantId, rec);
    return NextResponse.json({ ok: true, run: rec, history });
  } catch (e: any) {
    return apiServerError(e);
  }
}
