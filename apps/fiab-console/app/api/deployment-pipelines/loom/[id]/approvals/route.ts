/**
 * GET /api/deployment-pipelines/loom/[id]/approvals?status=pending
 *   → { ok, data: { requests: LoomApprovalRequest[], viewer: { oid, canApprove } } }
 *
 * BR-APPROVAL — lists a pipeline's promotion approval requests (newest first),
 * optionally filtered by status. The approver UI uses this to show pending
 * requests + each one's diff summary of what would promote. Cosmos-only.
 */
import { NextRequest } from 'next/server';
import type { LoomApprovalRequest } from '@/lib/types/loom-pipeline';
import { isEligibleApprover } from '@/lib/install/pipeline-approvals';
import { jok, jerr, loadPipeline, listApprovalRequests, resolveCaller } from '../../_lib/pipeline-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = new Set(['pending', 'approved', 'rejected', 'cancelled', 'promoted', 'promotion-failed']);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = resolveCaller(req);
  if (!caller) return jerr('unauthenticated', 401, 'unauthorized');
  const { id } = await ctx.params;
  const statusParam = (req.nextUrl.searchParams.get('status') || '').trim();
  const status = STATUSES.has(statusParam) ? (statusParam as LoomApprovalRequest['status']) : undefined;

  try {
    const pipeline = await loadPipeline(caller.tenantId, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');
    const requests = await listApprovalRequests(id, status ? { status } : {});
    const groups = caller.session.claims.groups || [];
    // Annotate each request with whether THIS viewer may act on it (eligible
    // approver, and not the requester for an approve).
    const viewerOid = caller.session.claims.oid;
    const annotated = requests.map((r) => ({
      ...r,
      viewerCanApprove:
        r.status === 'pending' &&
        r.requestedByOid !== viewerOid &&
        isEligibleApprover(r.approvers, { oid: viewerOid, groups }),
      viewerIsRequester: r.requestedByOid === viewerOid,
    }));
    return jok({ requests: annotated, viewer: { oid: viewerOid } });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to list approval requests');
  }
}
