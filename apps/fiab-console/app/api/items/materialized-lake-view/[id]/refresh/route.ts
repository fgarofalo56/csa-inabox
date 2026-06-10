/**
 * POST /api/items/materialized-lake-view/[id]/refresh
 *
 * Runs a full refresh of a materialized lake view: regenerates the PySpark
 * driver, submits a Synapse Spark batch that (re)writes the managed Delta table
 * on the Azure-native DLZ lake, and re-records the MLV's cross-workspace
 * lineage edges in Cosmos. No Microsoft Fabric required.
 *
 * Body: { spec?: MlvSpec, trigger?: 'editor'|'adf-pipeline'|'schedule' }
 *   - spec is optional; when omitted the saved state.spec is used. When present
 *     it is persisted before the refresh so the freshest definition runs.
 *
 * Returns { ok, batch, deltaUrl, fqn, sparkPool, lineageEdges } on success, or
 * an honest structured gate (ok:false, gate, remediation) naming the exact
 * env var / role missing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { loadMlvItem, specFromItem } from '../../_lib/load';
import { refreshMaterializedLakeView } from '@/lib/azure/materialized-lake-view-engine';
import { setMlvLineage, type MlvLineageEdgeInput } from '@/lib/thread/mlv-lineage';
import { deriveSources, validateMlvSpec, type MlvSpec } from '@/lib/azure/materialized-lake-view-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  let item: WorkspaceItem | null;
  try {
    item = await loadMlvItem(id, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'lookup failed' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'MLV not found' }, { status: 404 });

  const incoming: MlvSpec | undefined = body?.spec && typeof body.spec === 'object' ? body.spec : undefined;
  const spec = incoming || specFromItem(item);
  if (!spec) {
    return NextResponse.json({ ok: false, error: 'No MLV definition to refresh. Author + save a definition first.' }, { status: 400 });
  }
  const problems = validateMlvSpec(spec);
  if (problems.length) {
    return NextResponse.json({ ok: false, error: `Invalid MLV definition: ${problems.join(' ')}` }, { status: 400 });
  }

  // Persist an incoming spec before refresh so the run + stored state agree.
  if (incoming) {
    try {
      const next: WorkspaceItem = {
        ...item,
        state: { ...(item.state || {}), spec },
        updatedAt: new Date().toISOString(),
      };
      const items = await itemsContainer();
      await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: `Failed to save definition: ${e?.message || String(e)}` }, { status: 500 });
    }
  }

  // Re-record lineage from the definition.
  const sources = deriveSources(spec);
  let lineageEdges = 0;
  if (sources.length) {
    const edges: MlvLineageEdgeInput[] = sources.map((s) => ({
      mlvItemId: item!.id,
      mlvName: item!.displayName,
      workspaceId: item!.workspaceId,
      source: s,
    }));
    const r = await setMlvLineage(session, { itemId: item.id, name: item.displayName, workspaceId: item.workspaceId }, edges);
    lineageEdges = r.written;
  }

  const trigger = (['adf-pipeline', 'schedule', 'editor'].includes(body?.trigger) ? body.trigger : 'editor') as
    'editor' | 'adf-pipeline' | 'schedule';
  const outcome = await refreshMaterializedLakeView(spec, { itemId: item.id, trigger });
  if (!outcome.ok) {
    if ('gate' in outcome && outcome.gate) {
      return NextResponse.json(
        { ok: false, gate: outcome.code, error: outcome.error, remediation: outcome.remediation, link: outcome.link },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: outcome.error }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    batch: { id: outcome.batch.id, state: outcome.batch.state, result: outcome.batch.result },
    deltaUrl: outcome.deltaUrl,
    driverPath: outcome.driverPath,
    container: outcome.container,
    sparkPool: outcome.sparkPool,
    fqn: outcome.fqn,
    lineageEdges,
    triggeredBy: session.claims.upn,
  });
}
