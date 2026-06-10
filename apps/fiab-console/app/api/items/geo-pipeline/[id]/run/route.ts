/**
 * POST /api/items/geo-pipeline/[id]/run — trigger the target ADF pipeline with
 * the geo-enrichment flags materialized as pipeline parameters.
 *
 * `[id]` is the Loom geo-pipeline item GUID. The geo-enrichment flags live in
 * the item's Cosmos state:
 *   state.adfPipelineName  — the ADF pipeline NAME to invoke
 *   state.enrichH3         — Bool  → @pipeline().parameters.enrichH3
 *   state.reverseGeocode   — Bool  → @pipeline().parameters.reverseGeocode
 *   state.bufferMeters     — Int   → @pipeline().parameters.bufferMeters
 *
 * Flow:
 *   1. Load the geo-pipeline item (tenant-scoped, same RBAC as cosmos-items).
 *   2. Read the target pipeline name + flags from item state.
 *   3. getPipelineParameters() to see which of the three params the pipeline
 *      actually declares — pass only declared ones (ADF ignores unknown params,
 *      but we surface a precise list so a misconfigured pipeline is obvious).
 *   4. runPipeline(name, paramMap) — real ADF createRun ARM REST.
 *
 * Honest gates:
 *   401 unauthenticated · 404 item not found · 412 no target pipeline set ·
 *   503 ADF env vars unset (LOOM_ADF_NAME / LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runPipeline, getPipelineParameters, adfConfigGate } from '@/lib/azure/adf-client';
import { loadPipelineItem } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GEO_PARAM_KEYS = ['enrichH3', 'reverseGeocode', 'bufferMeters'] as const;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  // Honest config gate before touching Cosmos — the editor renders a precise
  // MessageBar with the exact missing env var.
  const gate = adfConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', notDeployed: true, error: `ADF is not configured in this deployment. Set ${gate.missing} on the Console Container App.`, missing: gate.missing },
      { status: 503 },
    );
  }

  const item = await loadPipelineItem(id, 'geo-pipeline', session.claims.oid).catch(() => null);
  if (!item) return NextResponse.json({ ok: false, code: 'not_found', error: `geo-pipeline ${id} not found in this tenant.` }, { status: 404 });

  const st = (item.state || {}) as Record<string, unknown>;
  const adfPipelineName = typeof st.adfPipelineName === 'string' ? st.adfPipelineName.trim() : '';
  if (!adfPipelineName) {
    return NextResponse.json(
      { ok: false, code: 'unbound', error: 'No target ADF pipeline is set on this geo-pipeline. Pick a pipeline in the editor and Save first.' },
      { status: 412 },
    );
  }

  // The fully-typed flag values from item state (with safe defaults).
  const flagValues: Record<(typeof GEO_PARAM_KEYS)[number], unknown> = {
    enrichH3: st.enrichH3 === true,
    reverseGeocode: st.reverseGeocode === true,
    bufferMeters: Number.isFinite(Number(st.bufferMeters)) ? Number(st.bufferMeters) : 0,
  };

  try {
    // Inspect the pipeline's declared parameters; only pass the ones it declares
    // so the createRun body matches the pipeline contract. ADF would silently
    // ignore unknown params, but we want an honest receipt of what actually
    // mapped vs. what was skipped.
    const declared = await getPipelineParameters(adfPipelineName);
    const declaredNames = new Set(Object.keys(declared));
    const parametersUsed: string[] = [];
    const parametersSkipped: string[] = [];
    const paramMap: Record<string, unknown> = {};
    for (const k of GEO_PARAM_KEYS) {
      if (declaredNames.has(k)) { paramMap[k] = flagValues[k]; parametersUsed.push(k); }
      else parametersSkipped.push(k);
    }

    const res = await runPipeline(adfPipelineName, paramMap);
    return NextResponse.json({
      ok: true,
      runId: res.runId,
      pipelineName: adfPipelineName,
      parametersUsed,
      parametersSkipped,
      parameters: paramMap,
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    // A 404 from getPipeline means the named ADF pipeline doesn't exist.
    const notFound = /getPipeline.*failed 404|NotFound|not found/i.test(msg);
    return NextResponse.json(
      { ok: false, error: notFound ? `ADF pipeline "${adfPipelineName}" was not found in the factory. Create it (with enrichH3/reverseGeocode/bufferMeters parameters) or pick another.` : msg },
      { status: notFound ? 404 : 502 },
    );
  }
}
