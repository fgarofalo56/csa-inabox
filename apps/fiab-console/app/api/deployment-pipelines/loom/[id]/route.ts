/**
 * GET    /api/deployment-pipelines/loom/[id]  — read one pipeline (with refreshed
 *                                               stage workspace names)
 * DELETE /api/deployment-pipelines/loom/[id]  — delete a pipeline + its stage-rule
 *                                               docs (best-effort)
 *
 * Cosmos-only; tenant-scoped. No Fabric / Power BI dependency.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loomPipelinesContainer, pipelineStageRulesContainer } from '@/lib/azure/cosmos-client';
import { jok, jerr, loadPipeline } from '../_lib/pipeline-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return jerr('unauthenticated', 401, 'unauthorized');
  const { id } = await ctx.params;
  try {
    const pipeline = await loadPipeline(s.claims.oid, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');
    return jok({ pipeline });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to read pipeline');
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return jerr('unauthenticated', 401, 'unauthorized');
  const { id } = await ctx.params;
  try {
    const pipeline = await loadPipeline(s.claims.oid, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');

    // Best-effort: delete each stage's rules doc (PK = pipelineId).
    const rules = await pipelineStageRulesContainer();
    for (const st of pipeline.stages) {
      try {
        await rules.item(`rules:${id}:${st.id}`, id).delete();
      } catch (e: any) {
        if (e?.code !== 404) throw e;
      }
    }
    const c = await loomPipelinesContainer();
    await c.item(id, s.claims.oid).delete();
    return jok({ deleted: true });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to delete pipeline');
  }
}
