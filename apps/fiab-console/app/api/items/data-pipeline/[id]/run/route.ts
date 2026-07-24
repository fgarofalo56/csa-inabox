/**
 * POST /api/items/data-pipeline/[id]/run?workspaceId=...
 *   body: { parameters?: Record<string, unknown> }
 *
 * v3.25: dispatches to the underlying ADF pipeline.
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { runPipeline, getPipeline, getDataset } from '@/lib/azure/adf-client';
import { prewarmShirForPipeline } from '@/lib/azure/shir-autoscale';
import { recordCostAttribution } from '@/lib/azure/cost-attribution';
// N6 — ODCS data contracts ENFORCED at ingestion (the pipeline-sink hook).
import { enforceSinkSchema } from '@/lib/ingest/contract-enforcement';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * N6 — resolve the pipeline's real SINK shape from Azure Data Factory.
 *
 * A pipeline's rows are moved server-side inside ADF, so Loom never holds them
 * in process. What it CAN enforce, with a real backend read, is the sink's
 * shape: read the live pipeline definition (`getPipeline` → ADF REST), find the
 * first Copy activity's output dataset reference, and read THAT dataset
 * (`getDataset` → ADF REST) for its declared column schema. Returns null when
 * the pipeline has no Copy sink or ADF is unreachable — enforcement then
 * silently no-ops (fail-open), never blocking a run because the guard could not
 * read its own inputs.
 */
async function resolveSinkShape(adfName: string): Promise<
  { dataset: string; columns: Array<{ name: string; type?: string }> } | null
> {
  const pipeline = await getPipeline(adfName);
  const activities = (pipeline.properties?.activities || []) as Array<Record<string, any>>;
  const copy = activities.find((a) => String(a?.type || '').toLowerCase() === 'copy');
  const sinkRef = (copy?.outputs || [])[0]?.referenceName;
  if (!sinkRef) return null;
  const ds = await getDataset(String(sinkRef));
  const raw = (Array.isArray(ds.properties?.schema) && ds.properties.schema.length
    ? ds.properties.schema
    : ds.properties?.structure) as Array<Record<string, unknown>> | undefined;
  const columns = (raw || [])
    .map((c) => ({ name: String(c?.name ?? ''), type: c?.type != null ? String(c.type) : undefined }))
    .filter((c) => !!c.name);
  if (!columns.length) return null;
  const tp = (ds.properties?.typeProperties || {}) as Record<string, unknown>;
  const dataset = String(
    tp.tableName ?? (tp.schema && tp.table ? `${tp.schema}.${tp.table}` : tp.table ?? ds.name),
  );
  return { dataset, columns };
}



export const POST = withSession(async (req, { session: s, params }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('pipeline not found', 404);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource } = await items.item(params.id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) {
      // Honest gate: bundle-installed pipeline whose activity graph opens
      // fully built-out from state.content, but which has not been deployed
      // to a live ADF factory yet (e.g. app install gated on "No bound
      // Fabric workspace"). Surface a structured, actionable gate instead of
      // a raw 500 so the editor can prompt the user to deploy/publish first.
      return NextResponse.json({
        ok: false,
        gate: {
          reason: 'This pipeline is not yet backed by a live Azure Data Factory pipeline.',
          remediation:
            'Open the pipeline in the editor and click Save/Publish to deploy its activities to ADF, then Run. ' +
            'If ADF is not configured in this deployment, set LOOM_ADF_FACTORY / LOOM_ADF_RESOURCE_GROUP and grant the console UAMI the Data Factory Contributor role.',
        },
        error: 'Pipeline has no ADF backing yet — publish it to ADF before running.',
      }, { status: 409 });
    }
    // ── N6 — ODCS data-contract pre-flight on the pipeline SINK ────────────
    // Default `warn-quarantine`: a shape mismatch alerts + records the failure
    // and the run STILL proceeds, so a newly authored contract can never drop a
    // production load. `hard-reject` (per-contract opt-in) blocks the dispatch
    // with a 409 before any data moves. Fail-open on any lookup/ADF error.
    let contractReceipt: Record<string, unknown> | undefined;
    try {
      const sink = await resolveSinkShape(adfName);
      if (sink) {
        const guard = await enforceSinkSchema({
          tenantId: s.claims.oid,
          targetItemId: resource.id,
          dataset: sink.dataset,
          sinkColumns: sink.columns,
        });
        if (guard.enforced) {
          contractReceipt = {
            itemId: guard.contractItemId, mode: guard.mode, note: guard.note,
            violations: guard.violations.slice(0, 20),
          };
          if (guard.blocked) {
            return NextResponse.json({
              ok: false,
              error: guard.note || 'The pipeline sink does not conform to its bound data contract (hard-reject mode).',
              contract: contractReceipt,
            }, { status: 409 });
          }
        }
      }
    } catch {
      /* fail-open: enforcement must never take down a real pipeline run */
    }

    const shir = await prewarmShirForPipeline(adfName);
    const runRes = await runPipeline(adfName, body?.parameters || {});

    // BR-COSTATTR — tag this pipeline run with who/where so it feeds the
    // per-workspace chargeback model's usage-weighted allocation (the same
    // ledger the notebook/KQL run paths write to). Best-effort — never throws,
    // must not fail the run.
    void recordCostAttribution({
      tenantId: tenantScopeId(s), userOid: s.claims.oid, userName: s.claims.upn,
      engine: 'pipeline', workspaceId, itemId: resource.id, itemType: 'data-pipeline',
      resourceId: adfName, domainId: (resource as any).domainId || (resource.state as any)?.domainId,
    });

    return NextResponse.json({
      ok: true,
      runId: runRes.runId,
      adfPipelineName: adfName,
      status: 'Queued',
      ...(shir || {}),
      ...(contractReceipt ? { contract: contractReceipt } : {}),
    });
  } catch (e: any) {
    return apiError(e?.message || String(e), e?.status || 502);
  }
});
