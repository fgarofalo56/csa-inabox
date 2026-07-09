/**
 * POST /api/deployment-pipelines/loom/[id]/deploy
 *   body: { sourceStageId, targetStageId, items?:[{sourceItemId, itemType}], note? }
 *
 * Selective (or full) deploy of content from one stage to the next. The heavy
 * lifting — Variable-Library rebind (FGC-24), stage-rule application, re-provision
 * through the real Azure-native provisioners, and the history receipt — lives in
 * the shared `_lib/promote.ts` engine so this route and the approval route run
 * one identical implementation.
 *
 * BR-APPROVAL: when the TARGET stage has an enabled required-reviewer policy, the
 * deploy does NOT execute here. Instead a pending approval request is created
 * (carrying a diff summary of what would promote) and the route returns
 * `{ status: 'pending-approval', requestId }`. Once the required approvals are
 * cast (POST .../approvals/[requestId]), that route runs the SAME promotion.
 *
 * Cosmos + the Azure-native provisioner backends only — no Fabric / Power BI.
 *
 * Shape: { ok, data: { operationId, status, diff, deployedItemIds, steps } }
 *   or   { ok, data: { status:'pending-approval', requestId, requiredApprovals } }
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { listAllOwnedItems } from '@/app/api/items/_lib/item-crud';
import { computePipelineDiff } from '@/lib/install/pipeline-compare';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { emitLoomEvent } from '@/lib/events/webhook-emitter';
import type { LoomApprovalRequest } from '@/lib/types/loom-pipeline';
import {
  jok, jerr, loadPipeline, resolveCaller, loadApprovalPolicy, createApprovalRequest,
} from '../../_lib/pipeline-store';
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

    // BR-APPROVAL — gate: an enabled policy with ≥1 required approval and ≥1
    // named approver defers the promotion to a pending approval request instead
    // of running it now.
    const policy = await loadApprovalPolicy(id, targetStageId);
    if (policy?.enabled && (policy.requiredApprovals || 0) > 0 && (policy.approvers?.length || 0) > 0) {
      const [source, before] = await Promise.all([
        listAllOwnedItems(tenantId, srcWs),
        listAllOwnedItems(tenantId, tgtWs),
      ]);
      const { summary } = computePipelineDiff(source, before);
      const diffSummary = `${summary.different} changed · ${summary.onlyInSource} new · ${summary.same} unchanged`;
      const now = new Date().toISOString();
      const request: LoomApprovalRequest = {
        id: `approval-request:${crypto.randomUUID()}`,
        docType: 'approval-request',
        pipelineId: id,
        tenantId,
        sourceStageId,
        targetStageId,
        requiredApprovals: policy.requiredApprovals,
        approvers: policy.approvers,
        items: chosen,
        note,
        diffSummary,
        status: 'pending',
        decisions: [],
        requestedBy: caller.actor,
        requestedByOid: tenantId,
        createdAt: now,
        updatedAt: now,
      };
      await createApprovalRequest(request);
      emitAuditEvent({
        actorOid: s.claims.oid,
        actorUpn: s.claims.upn || s.claims.email || s.claims.oid,
        action: 'pipeline.promotion.requested',
        targetType: 'deployment-pipeline',
        targetId: id,
        tenantId: s.claims.tid || tenantId,
        detail: { requestId: request.id, sourceStageId, targetStageId, requiredApprovals: policy.requiredApprovals, diffSummary },
      });
      return jok({
        status: 'pending-approval',
        requestId: request.id,
        requiredApprovals: policy.requiredApprovals,
        stageName: targetStage.displayName,
        diffSummary,
      });
    }

    // No gate — run the promotion now.
    const result = await runPromotion({
      tenantId, session: s, actor: caller.actor,
      pipeline, srcWs, tgtWs, sourceStageId, targetStageId, targetStage,
      chosen, note,
    });

    // BR-WEBHOOK — deployment-pipeline run reached a terminal receipt; fan the
    // outcome out to any subscribed outbound webhook (best-effort, non-blocking).
    emitLoomEvent({
      type: result.status === 'failed' ? 'pipeline.run.failed' : 'pipeline.run.completed',
      tenantId,
      subject: id,
      subjectName: pipeline.displayName,
      actor: { oid: s.claims.oid, upn: s.claims.upn || s.claims.email },
      data: {
        operationId: result.operationId,
        status: result.status,
        sourceStageId,
        targetStageId,
        deployedItemIds: result.deployedItemIds,
        summary: result.summary,
      },
    });

    return jok(result);
  } catch (e) {
    return jerr((e as Error).message || 'Deploy failed');
  }
}
