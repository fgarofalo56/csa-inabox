/**
 * GET  /api/items/semantic-model/[id]/refresh-policy?workspaceId=...&tableName=...
 * PUT  /api/items/semantic-model/[id]/refresh-policy?workspaceId=...
 *
 * Incremental-refresh policy + hybrid-table (current-period DirectQuery) editor
 * backend. Opt-in Azure Analysis Services path — the semantic-model default
 * backend stays loom-native (no Microsoft Fabric / Power BI workspace required
 * per no-fabric-dependency.md). This route is only active when the operator sets
 * LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_XMLA_ENDPOINT; otherwise it
 * returns an honest 503 gate naming the exact env var to set (no fabricated data
 * per no-vaporware.md).
 *
 * GET: lists the current partition schema (TMSCHEMA_PARTITIONS).
 * PUT: applies a new incremental refresh policy:
 *   1. setIncrementalRefreshPolicy(tableName, policy)  — TMSL Alter
 *   2. applyRefreshPolicy(tableName, { effectiveDate }) — TMSL Refresh
 *      (creates historical Import partitions + a live DirectQuery partition when
 *       mode=Hybrid). Skipped when skipApply=true (set-policy-only).
 *   3. returns listPartitions(tableName) as the receipt.
 *
 * Docs: https://learn.microsoft.com/power-bi/connect-data/incremental-refresh-xmla
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  aasConfigGate,
  setIncrementalRefreshPolicy,
  applyRefreshPolicy,
  listPartitions,
  AasError,
  type AasRefreshPolicy,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_GRANULARITIES = new Set(['day', 'month', 'quarter', 'year']);

/**
 * Backend + AAS config gate. Returns a 503 NextResponse with precise remediation
 * when the AAS incremental-refresh path is not selected/configured, else null.
 */
function backendGate(): NextResponse | null {
  const backend = process.env.LOOM_SEMANTIC_BACKEND || 'loom-native';
  if (backend !== 'analysis-services') {
    return NextResponse.json(
      {
        ok: false,
        error:
          `Incremental refresh policy requires LOOM_SEMANTIC_BACKEND=analysis-services ` +
          `(current: ${backend}). Set it plus LOOM_AAS_XMLA_ENDPOINT and LOOM_AAS_DATABASE ` +
          `in the deployment (admin-plane/main.bicep loomSemanticBackend / loomAasXmlaEndpoint).`,
      },
      { status: 503 },
    );
  }
  const gate = aasConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Azure Analysis Services not configured: set ${gate.missing}.` },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = backendGate();
  if (gate) return gate;
  const tableName = req.nextUrl.searchParams.get('tableName') || undefined;
  try {
    const partitions = await listPartitions(tableName);
    return NextResponse.json({ ok: true, partitions });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = backendGate();
  if (gate) return gate;

  const body = (await req.json().catch(() => ({}))) as {
    tableName?: string;
    policy?: AasRefreshPolicy;
    effectiveDate?: string;
    /** true = set policy only, do not fire the initial apply refresh. */
    skipApply?: boolean;
  };

  if (!body.tableName) return NextResponse.json({ ok: false, error: 'tableName required' }, { status: 400 });
  if (!body.policy) return NextResponse.json({ ok: false, error: 'policy required' }, { status: 400 });
  const p = body.policy;
  if (!VALID_GRANULARITIES.has(p.rollingWindowGranularity)) {
    return NextResponse.json({ ok: false, error: `invalid rollingWindowGranularity: ${p.rollingWindowGranularity}` }, { status: 400 });
  }
  if (!VALID_GRANULARITIES.has(p.incrementalGranularity)) {
    return NextResponse.json({ ok: false, error: `invalid incrementalGranularity: ${p.incrementalGranularity}` }, { status: 400 });
  }
  if (!Number.isInteger(p.rollingWindowPeriods) || p.rollingWindowPeriods < 1) {
    return NextResponse.json({ ok: false, error: 'rollingWindowPeriods must be a positive integer' }, { status: 400 });
  }
  if (!Number.isInteger(p.incrementalPeriods) || p.incrementalPeriods < 1) {
    return NextResponse.json({ ok: false, error: 'incrementalPeriods must be a positive integer' }, { status: 400 });
  }
  if (p.mode && p.mode !== 'Import' && p.mode !== 'Hybrid') {
    return NextResponse.json({ ok: false, error: 'mode must be "Import" or "Hybrid"' }, { status: 400 });
  }

  try {
    // 1. TMSL Alter — write the refreshPolicy to the table.
    await setIncrementalRefreshPolicy(body.tableName, p);
    // 2. TMSL Refresh (applyRefreshPolicy:true) — create the partition structure:
    //    historical Import partitions + a live DirectQuery partition when Hybrid.
    if (!body.skipApply) {
      await applyRefreshPolicy(body.tableName, { effectiveDate: body.effectiveDate });
    }
    // 3. Receipt — the resulting partition list.
    const partitions = await listPartitions(body.tableName);
    return NextResponse.json({ ok: true, partitions, appliedAt: new Date().toISOString() });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
