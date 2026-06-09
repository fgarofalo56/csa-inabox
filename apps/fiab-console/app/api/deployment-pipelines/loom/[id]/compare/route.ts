/**
 * GET /api/deployment-pipelines/loom/[id]/compare?source=<stageId>&target=<stageId>
 *
 * Content-level stage compare — the capability Fabric REST has no endpoint for.
 * Reads every item in the source stage's workspace and the target stage's
 * workspace (Cosmos), pairs them by (itemType, name), and diffs their serialized
 * definitions (TMSL for semantic models, stable JSON for report/scorecard/etc.).
 *
 * Shape: { ok, data: { sourceStageId, targetStageId, pairs, summary } }
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listAllOwnedItems } from '@/app/api/items/_lib/item-crud';
import { computePipelineDiff } from '@/lib/install/pipeline-compare';
import { jok, jerr, loadPipeline, stageWorkspaceId } from '../../_lib/pipeline-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return jerr('unauthenticated', 401, 'unauthorized');
  const tenantId = s.claims.oid;
  const { id } = await ctx.params;

  const source = (req.nextUrl.searchParams.get('source') || '').trim();
  const target = (req.nextUrl.searchParams.get('target') || '').trim();
  if (!source || !target) return jerr('source and target stage ids required', 400, 'bad_request');

  try {
    const pipeline = await loadPipeline(tenantId, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');

    const srcWs = stageWorkspaceId(pipeline, source);
    const tgtWs = stageWorkspaceId(pipeline, target);
    if (!srcWs) return jerr('source stage not found in pipeline', 400, 'bad_request');
    if (!tgtWs) return jerr('target stage not found in pipeline', 400, 'bad_request');

    const [sourceItems, targetItems] = await Promise.all([
      listAllOwnedItems(tenantId, srcWs),
      listAllOwnedItems(tenantId, tgtWs),
    ]);

    const { pairs, summary } = computePipelineDiff(sourceItems, targetItems);
    return jok({ sourceStageId: source, targetStageId: target, pairs, summary });
  } catch (e) {
    return jerr((e as Error).message || 'Compare failed');
  }
}
