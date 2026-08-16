/**
 * GET  /api/items/semantic-model/[id]/refresh-policy?tableName=...
 * PUT  /api/items/semantic-model/[id]/refresh-policy
 *
 * NOTE (#2649): this route takes NO workspace. The AAS server + database come
 * from LOOM_AAS_XMLA_ENDPOINT / LOOM_AAS_DATABASE, and `[id]` is the model. A
 * `?workspaceId=` was accepted-and-ignored here for a while and the editor sent
 * its Power BI groupId in it — a Power BI id inside a Loom item URL. Callers no
 * longer send one; nothing reads one.
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
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. `withSession` resolved a session and
 * authorized nobody against `[id]` — which the header above even says out loud
 * ("`[id]` is the model") while nothing read it. The AAS server AND database are
 * env-pinned (`LOOM_AAS_XMLA_ENDPOINT` / `LOOM_AAS_DATABASE`), so EVERY
 * semantic-model item in every workspace shares ONE tabular database, and
 * `tableName` came straight from the body into a TMSL **Alter** followed by a
 * TMSL **Refresh** with `applyRefreshPolicy`. That is not a read: applying a
 * refresh policy REBUILDS the table's partition structure, and a rolling window
 * shorter than the data's history DROPS the partitions outside it. Any signed-in
 * user could rewrite another tenant's incremental-refresh policy and destroy
 * their historical partitions in one PUT.
 *
 * Layer 1 (`guardSynapseItemRequest`) now authorizes the caller against the
 * semantic-model item — write-scoped on PUT, read-scoped on the GET partition
 * list. The guard is backend-agnostic (session → `authorizeItemWorkspace` →
 * fail-closed item load); its Synapse-specific `database` field is unused here.
 *
 * NOT closed: `tableName` remains caller-supplied inside the one shared AAS
 * database, because no item→table binding exists for the tabular layer. A
 * caller authorized for their own model can still name another model's table.
 * FLOOR, not BOUND — see the PR ledger. The correct fix is to resolve the
 * table set from the item's own model definition, which is its own change.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  aasConfigGate,
  setIncrementalRefreshPolicy,
  applyRefreshPolicy,
  listPartitions,
  AasError,
  type AasRefreshPolicy,
} from '@/lib/azure/aas-incremental-refresh';
import { guardSynapseItemRequest } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODEL_NOT_FOUND = 'semantic model not found';

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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'semantic-model',
    notFound: MODEL_NOT_FOUND,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

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

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // TMSL Alter + Refresh REBUILD partitions — a write. No allowReadRoles.
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'semantic-model',
    notFound: MODEL_NOT_FOUND,
  });
  if (guard.res) return guard.res;

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
