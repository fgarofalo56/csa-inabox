/**
 * POST /api/deployment-pipelines/loom/[id]/approvals/[requestId]
 *   body: { action: 'approve' | 'reject' | 'cancel', comment? }
 *
 * BR-APPROVAL — cast a decision on a pending promotion request. An eligible
 * approver (their oid or a group id matches the policy's approvers) may approve
 * or reject; the requester may cancel their own request but may NOT self-approve.
 * When the final required approval is cast, this route runs the SAME promotion
 * engine the deploy route uses (`runPromotion`) and marks the request `promoted`.
 *
 * Every decision emits an audit event to the LoomAudit_CL SIEM stream (BR-SIEM).
 *
 * NOTE (BR-WEBHOOK): the outbound webhook fan-out (`emitLoomEvent`) is not on
 * origin/main yet, so no webhook is emitted here — only the audit stream. When
 * BR-WEBHOOK lands, add a `void emitLoomEvent(...)` alongside each emitAuditEvent
 * below (same event names).
 */
import { NextRequest } from 'next/server';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { applyDecision, canPromote, summarizeApproval } from '@/lib/install/pipeline-approvals';
import type { LoomApprovalRequest } from '@/lib/types/loom-pipeline';
import {
  jok, jerr, loadPipeline, loadApprovalRequest, saveApprovalRequest, resolveCaller,
} from '../../../_lib/pipeline-store';
import { resolvePromotionStages, runPromotion } from '../../../_lib/promote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; requestId: string }> }) {
  const caller = resolveCaller(req);
  if (!caller) return jerr('unauthenticated', 401, 'unauthorized');
  const s = caller.session;
  const { id, requestId } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '').trim();
  const comment = typeof body?.comment === 'string' ? body.comment.slice(0, 1024) : undefined;
  if (!['approve', 'reject', 'cancel'].includes(action)) {
    return jerr("action must be 'approve', 'reject' or 'cancel'", 400, 'bad_request');
  }

  const auditBase = {
    actorOid: s.claims.oid,
    actorUpn: s.claims.upn || s.claims.email || s.claims.oid,
    targetType: 'deployment-pipeline',
    targetId: id,
    tenantId: s.claims.tid || caller.tenantId,
  };

  try {
    // The request is point-read by (pipelineId, requestId) — NOT owner-scoped —
    // because an approver is (deliberately) a DIFFERENT identity from the
    // pipeline owner. Authorization is the approvers list (eligibility) below;
    // the pipeline + promotion run under the OWNER tenant recorded on the
    // request so item-crud reaches the owner's stage workspaces.
    const request = await loadApprovalRequest(id, requestId);
    if (!request) return jerr('approval request not found', 404, 'not_found');
    const ownerTenant = request.tenantId;
    const pipeline = await loadPipeline(ownerTenant, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');
    if (request.status !== 'pending') return jerr(`request is already ${request.status}`, 409, 'conflict');

    // Cancel — only the requester may cancel their own pending request.
    if (action === 'cancel') {
      if (request.requestedByOid !== s.claims.oid) return jerr('only the requester can cancel this request', 403, 'forbidden');
      const cancelled: LoomApprovalRequest = { ...request, status: 'cancelled', updatedAt: new Date().toISOString() };
      await saveApprovalRequest(cancelled);
      emitAuditEvent({ ...auditBase, action: 'pipeline.promotion.cancelled', detail: { requestId } });
      return jok({ request: cancelled });
    }

    // Approve / reject — validated + applied by the pure state machine.
    const outcome = applyDecision(request, {
      decision: action as 'approve' | 'reject',
      approverOid: s.claims.oid,
      approverName: s.claims.upn || s.claims.email || s.claims.oid,
      comment,
      approverGroups: s.claims.groups || [],
    });
    if (!outcome.ok) {
      const map: Record<string, [string, number, string]> = {
        not_pending: [`request is already ${request.status}`, 409, 'conflict'],
        not_eligible: ['you are not a named approver for this stage', 403, 'forbidden'],
        self_approval: ['the requester of a promotion cannot approve it (separation of duties) — a different approver must approve, or you can reject/cancel it', 403, 'forbidden'],
        invalid_decision: ['invalid decision', 400, 'bad_request'],
      };
      const [msg, code, tag] = map[outcome.error];
      return jerr(msg, code, tag);
    }

    let next = outcome.request;

    emitAuditEvent({
      ...auditBase,
      action: action === 'approve' ? 'pipeline.promotion.approved' : 'pipeline.promotion.rejected',
      outcome: action === 'approve' ? 'success' : 'denied',
      detail: { requestId, status: next.status, summary: summarizeApproval(next) },
    });

    // Final approval reached — run the SAME promotion the deploy route runs.
    if (canPromote(next)) {
      const stages = resolvePromotionStages(pipeline, next.sourceStageId, next.targetStageId);
      if ('error' in stages) {
        next = { ...next, status: 'promotion-failed', updatedAt: new Date().toISOString() };
        await saveApprovalRequest(next);
        return jerr(stages.error, stages.status, stages.code);
      }
      try {
        // Run the promotion under a synthetic OWNER session so item-crud +
        // provisioners resolve the owner's stage workspaces (the approver is a
        // different identity). Provisioners are UAMI-backed, so no user OBO
        // token is needed — the session only carries the owner's tenant scope.
        const ownerSession = {
          claims: { oid: ownerTenant, name: 'Loom approval promotion', upn: request.requestedBy },
          exp: Math.floor(Date.now() / 1000) + 300,
        };
        const result = await runPromotion({
          tenantId: ownerTenant, session: ownerSession, actor: `${request.requestedBy} (approved by ${s.claims.upn || s.claims.email || s.claims.oid})`,
          pipeline, srcWs: stages.srcWs, tgtWs: stages.tgtWs,
          sourceStageId: next.sourceStageId, targetStageId: next.targetStageId, targetStage: stages.targetStage,
          chosen: next.items, note: next.note,
        });
        next = { ...next, status: 'promoted', promotionOperationId: result.operationId, updatedAt: new Date().toISOString() };
        await saveApprovalRequest(next);
        emitAuditEvent({ ...auditBase, action: 'pipeline.promotion.promoted', detail: { requestId, operationId: result.operationId, status: result.status } });
        return jok({ request: next, promotion: result });
      } catch (e) {
        next = { ...next, status: 'promotion-failed', updatedAt: new Date().toISOString() };
        await saveApprovalRequest(next);
        return jerr(`Approved, but the promotion failed: ${(e as Error).message}`);
      }
    }

    await saveApprovalRequest(next);
    return jok({ request: next });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to record decision');
  }
}
