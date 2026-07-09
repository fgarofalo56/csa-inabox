/**
 * GET /api/deployment-pipelines/loom/[id]/stages/[stageId]/approvals
 *   → { ok, data: { policy: {enabled, requiredApprovals, approvers} } }
 * PUT /api/deployment-pipelines/loom/[id]/stages/[stageId]/approvals
 *   body: { enabled, requiredApprovals, approvers:[{id,type,displayName}] }
 *
 * BR-APPROVAL — the required-reviewer promotion gate for a stage. This is
 * governance-AS-the-feature: an admin CONFIGURES how many approvals from which
 * named users/groups are required before a promotion INTO this stage runs. The
 * policy is Cosmos-backed (shared `pipeline-stage-rules` container) and real —
 * the deploy route enforces it. Default is opt-out (disabled = promotes freely).
 */
import { NextRequest } from 'next/server';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import type { LoomApprover } from '@/lib/types/loom-pipeline';
import {
  jok, jerr, loadPipeline, stageWorkspaceId, loadApprovalPolicy, saveApprovalPolicy, resolveCaller,
} from '../../../../_lib/pipeline-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_APPROVALS = 10;
const MAX_APPROVERS = 50;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; stageId: string }> }) {
  const caller = resolveCaller(req);
  if (!caller) return jerr('unauthenticated', 401, 'unauthorized');
  const { id, stageId } = await ctx.params;
  try {
    const pipeline = await loadPipeline(caller.tenantId, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');
    if (!stageWorkspaceId(pipeline, stageId)) return jerr('stage not found in pipeline', 404, 'not_found');
    const doc = await loadApprovalPolicy(id, stageId);
    const policy = doc
      ? { enabled: doc.enabled, requiredApprovals: doc.requiredApprovals, approvers: doc.approvers }
      : { enabled: false, requiredApprovals: 1, approvers: [] as LoomApprover[] };
    return jok({ policy });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to load approval policy');
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string; stageId: string }> }) {
  const caller = resolveCaller(req);
  if (!caller) return jerr('unauthenticated', 401, 'unauthorized');
  const { id, stageId } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const enabled = body?.enabled === true;
  const requiredApprovals = Math.floor(Number(body?.requiredApprovals));
  if (!Number.isFinite(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > MAX_APPROVALS) {
    return jerr(`requiredApprovals must be between 1 and ${MAX_APPROVALS}`, 400, 'bad_request');
  }
  const rawApprovers = Array.isArray(body?.approvers) ? body.approvers : [];
  if (rawApprovers.length > MAX_APPROVERS) return jerr(`at most ${MAX_APPROVERS} approvers`, 400, 'bad_request');

  const approvers: LoomApprover[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawApprovers.length; i++) {
    const a = rawApprovers[i] || {};
    const idv = String(a.id || '').trim();
    const type = a.type === 'group' ? 'group' : 'user';
    const displayName = String(a.displayName || '').trim() || idv;
    if (!idv) return jerr(`Approver ${i + 1}: id (user oid or group id) required`, 400, 'bad_request');
    if (seen.has(idv)) continue; // de-dupe repeated ids
    seen.add(idv);
    approvers.push({ id: idv, type, displayName });
  }
  // An enabled gate with no approvers can never be satisfied — reject it so the
  // stage isn't silently un-promotable.
  if (enabled && approvers.length === 0) {
    return jerr('An enabled approval gate needs at least one approver (user or group).', 400, 'bad_request');
  }
  if (enabled && requiredApprovals > approvers.length) {
    return jerr(`requiredApprovals (${requiredApprovals}) can't exceed the number of approvers (${approvers.length}).`, 400, 'bad_request');
  }

  try {
    const pipeline = await loadPipeline(caller.tenantId, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');
    if (!stageWorkspaceId(pipeline, stageId)) return jerr('stage not found in pipeline', 404, 'not_found');
    const doc = await saveApprovalPolicy(id, stageId, { enabled, requiredApprovals, approvers }, caller.actor);
    emitAuditEvent({
      actorOid: caller.session.claims.oid,
      actorUpn: caller.session.claims.upn || caller.session.claims.email || caller.session.claims.oid,
      action: 'pipeline.approval-policy.upsert',
      targetType: 'deployment-pipeline',
      targetId: id,
      tenantId: caller.session.claims.tid || caller.tenantId,
      detail: { stageId, enabled, requiredApprovals, approvers: approvers.map((a) => a.id) },
    });
    return jok({ policy: { enabled: doc.enabled, requiredApprovals: doc.requiredApprovals, approvers: doc.approvers } });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to save approval policy');
  }
}
