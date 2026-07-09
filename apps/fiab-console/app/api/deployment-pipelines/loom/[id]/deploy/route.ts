/**
 * POST /api/deployment-pipelines/loom/[id]/deploy
 *   body: { sourceStageId, targetStageId, items?:[{sourceItemId, itemType}], note? }
 *
 * Selective (or full) deploy of content from one stage to the next. The heavy
 * lifting — Variable-Library rebind (FGC-24), stage-rule application, re-provision
 * through the real Azure-native provisioners, and the history receipt — lives in
 * the shared `_lib/promote.ts` engine so this route stays thin.
 *
 * Cosmos + the Azure-native provisioner backends only — no Fabric / Power BI.
 *
 * Shape: { ok, data: { operationId, status, diff, deployedItemIds, steps } }
 */
import { NextRequest } from 'next/server';
import { listAllOwnedItems } from '@/app/api/items/_lib/item-crud';
import { jok, jerr, loadPipeline, resolveCaller } from '../../_lib/pipeline-store';
import { resolvePromotionStages, runPromotion } from '../../_lib/promote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = resolveCaller(req);
  if (!caller) return jerr('unauthenticated', 401, 'unauthorized');
  const s = caller.session;
  const tenantId = caller.tenantId;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const sourceStageId = String(body?.sourceStageId || '').trim();
  const targetStageId = String(body?.targetStageId || '').trim();
  const note = typeof body?.note === 'string' ? body.note.slice(0, 1024) : undefined;
  if (!sourceStageId) return jerr('sourceStageId required', 400, 'bad_request');
  if (!targetStageId) return jerr('targetStageId required', 400, 'bad_request');

  const chosen: Array<{ sourceItemId: string; itemType: string }> | undefined =
    Array.isArray(body?.items) && body.items.length
      ? body.items
          .filter((i: any) => i?.sourceItemId)
          .map((i: any) => ({ sourceItemId: String(i.sourceItemId), itemType: String(i.itemType || '') }))
      : undefined;

  try {
    const pipeline = await loadPipeline(tenantId, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');

    const stages = resolvePromotionStages(pipeline, sourceStageId, targetStageId);
    if ('error' in stages) return jerr(stages.error, stages.status, stages.code);
    const { srcWs, tgtWs, targetStage } = stages;

    // Selective deploy that names only non-existent items is a client error.
    if (chosen) {
      const sourceItems = await listAllOwnedItems(tenantId, srcWs);
      const ids = new Set(sourceItems.map((it) => it.id));
      if (!chosen.some((c) => ids.has(c.sourceItemId))) {
        return jerr('none of the chosen items exist in the source stage', 400, 'bad_request');
      }
    }

    const result = await runPromotion({
      tenantId, session: s, actor: caller.actor,
      pipeline, srcWs, tgtWs, sourceStageId, targetStageId, targetStage,
      chosen, note,
    });
    return jok(result);
  } catch (e) {
    return jerr((e as Error).message || 'Deploy failed');
  }
}
