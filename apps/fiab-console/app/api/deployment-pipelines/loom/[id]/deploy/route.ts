/**
 * POST /api/deployment-pipelines/loom/[id]/deploy
 *   body: { sourceStageId, targetStageId, items?:[{sourceItemId, itemType}], note? }
 *
 * Selective (or full) deploy of content from one stage to the next. For each
 * chosen source item, this:
 *   1. computes the patched ProvisionTarget by applying the TARGET stage's
 *      deployment rules (parameter / data-source overrides) to the env-resolved
 *      base target — the Azure-native parity for Fabric "deployment rules";
 *   2. promotes the item's definition (state.content) into the target stage's
 *      workspace — updating the paired item if one already exists, else creating
 *      a new one;
 *   3. re-runs the SAME real provisioner the install path uses against the
 *      patched target, so the model/report/etc. is materialized in Test/Prod
 *      bound to the Test/Prod data sources.
 *
 * The receipt (diff + deployed item ids) is returned and persisted to history.
 * Cosmos + the Azure-native provisioner backends only — no Fabric / Power BI.
 *
 * Shape: { ok, data: { operationId, status, diff, deployedItemIds, steps } }
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { listAllOwnedItems, createOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { PROVISIONERS, resolveTarget } from '@/lib/install/provisioning-engine';
import { applyStageRules } from '@/lib/install/pipeline-deploy';
import { computePipelineDiff, pairKey } from '@/lib/install/pipeline-compare';
import { pipelineHistoryContainer } from '@/lib/azure/cosmos-client';
import type { ProvisionResult } from '@/lib/install/provisioners/types';
import type { LoomPipelineHistoryRecord } from '@/lib/types/loom-pipeline';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { jok, jerr, loadPipeline, stageWorkspaceId, loadStageRules, resolveCaller } from '../../_lib/pipeline-store';

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

    const srcWs = stageWorkspaceId(pipeline, sourceStageId);
    const tgtWs = stageWorkspaceId(pipeline, targetStageId);
    if (!srcWs) return jerr('source stage not found in pipeline', 400, 'bad_request');
    if (!tgtWs) return jerr('target stage not found in pipeline', 400, 'bad_request');
    if (srcWs === tgtWs) {
      // Legacy pipelines created before the distinct-workspace guard could
      // bind two stages to the same workspace. Such a pipeline can never
      // promote (the deploy would modify its own source). Tell the operator
      // exactly how to fix it rather than surfacing a raw "promote error".
      const srcName = pipeline.stages.find((st) => st.id === sourceStageId)?.displayName || 'source';
      const tgtName = pipeline.stages.find((st) => st.id === targetStageId)?.displayName || 'target';
      return jerr(
        `Stages "${srcName}" and "${tgtName}" are bound to the same workspace, so content can't be promoted between them. Re-bind one stage to a distinct workspace, then deploy again.`,
        400,
        'duplicate_workspace',
      );
    }

    const [sourceItemsAll, targetItemsBefore, rules] = await Promise.all([
      listAllOwnedItems(tenantId, srcWs),
      listAllOwnedItems(tenantId, tgtWs),
      loadStageRules(id, targetStageId),
    ]);

    // The receipt diff is the source-vs-target comparison that motivated the deploy.
    const { pairs, summary } = computePipelineDiff(sourceItemsAll, targetItemsBefore);

    // Resolve the set of source items to deploy.
    let toDeploy = sourceItemsAll;
    if (chosen) {
      const wanted = new Set(chosen.map((c) => c.sourceItemId));
      toDeploy = sourceItemsAll.filter((it) => wanted.has(it.id));
      if (toDeploy.length === 0) return jerr('none of the chosen items exist in the source stage', 400, 'bad_request');
    }

    const targetByKey = new Map<string, WorkspaceItem>();
    for (const it of targetItemsBefore) targetByKey.set(pairKey(it), it);

    const baseTarget = resolveTarget('shared');
    const steps: string[] = [];
    const deployedItemIds: string[] = [];
    let anyCreated = false;
    let anyFailed = false;

    for (const src of toDeploy) {
      const content = (src.state as any)?.content ?? null;
      const { target: patched, applied } = applyStageRules(baseTarget, rules, src.itemType, src.displayName);
      if (applied.length) steps.push(`[${src.displayName}] ${applied.join('; ')}`);

      // Locate or create the paired item in the target workspace.
      const existing = targetByKey.get(pairKey(src));
      let targetItemId: string;
      if (existing) {
        targetItemId = existing.id;
      } else {
        const created = await createOwnedItem(s, src.itemType, {
          workspaceId: tgtWs,
          displayName: src.displayName,
          description: src.description,
          state: { ...(src.state || {}) },
        });
        if (!created.ok) {
          anyFailed = true;
          steps.push(`[${src.displayName}] target item create failed (${created.status}): ${created.error}`);
          continue;
        }
        targetItemId = created.item.id;
        steps.push(`[${src.displayName}] created target item ${targetItemId} in ${targetStageId}.`);
      }

      // Re-run the real provisioner against the patched (rule-applied) target.
      let result: ProvisionResult | undefined;
      const provisioner = PROVISIONERS[src.itemType];
      if (provisioner) {
        try {
          result = await provisioner({
            session: s,
            target: patched,
            cosmosItemId: targetItemId,
            workspaceId: tgtWs,
            displayName: src.displayName,
            content,
            appId: 'loom-pipeline-deploy',
          });
        } catch (e: any) {
          result = { status: 'failed', error: e?.message || String(e), steps: ['provisioner threw'] };
        }
        steps.push(`[${src.displayName}] provisioner(${src.itemType}) → ${result.status}.`);
        if (result.status === 'created' || result.status === 'exists') anyCreated = true;
        else if (result.status === 'failed' || result.status === 'remediation') anyFailed = true;
      } else {
        steps.push(`[${src.displayName}] ${src.itemType} is Cosmos-only — definition promoted, no backend re-provision.`);
        anyCreated = true;
      }

      // Persist the promoted definition + provision receipt onto the target item.
      await updateOwnedItem(targetItemId, src.itemType, tenantId, {
        state: {
          ...(src.state || {}),
          deployedFrom: src.id,
          deployedFromStage: sourceStageId,
          deployedAt: new Date().toISOString(),
          ...(result ? { provisionResult: result } : {}),
        },
      });
      deployedItemIds.push(targetItemId);
    }

    const status: LoomPipelineHistoryRecord['status'] =
      deployedItemIds.length === 0 ? 'failed' : anyFailed && anyCreated ? 'partial' : anyFailed ? 'failed' : 'succeeded';

    const now = new Date().toISOString();
    const record: LoomPipelineHistoryRecord = {
      id: crypto.randomUUID(),
      pipelineId: id,
      sourceStageId,
      targetStageId,
      status,
      note,
      diff: pairs,
      deployedItemIds,
      steps,
      startedAt: now,
      completedAt: now,
      startedBy: caller.actor,
    };
    try {
      const hist = await pipelineHistoryContainer();
      await hist.items.create(record);
    } catch (e) {
      steps.push(`History write failed (non-fatal): ${(e as Error).message}`);
    }

    return jok({ operationId: record.id, status, diff: pairs, summary, deployedItemIds, steps });
  } catch (e) {
    return jerr((e as Error).message || 'Deploy failed');
  }
}
