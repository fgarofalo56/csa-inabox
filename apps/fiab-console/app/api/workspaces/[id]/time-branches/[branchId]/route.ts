/**
 * WS-10.3 Time-Machine — delete a time-branch (shadow-workspace pin).
 *
 * DELETE /api/workspaces/[id]/time-branches/[branchId] → { ok }
 *
 * AUTHORIZATION: the caller is resolved against the workspace via
 * `resolveWorkspaceAccessByOid`; deleting requires write access.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import { deleteTimeBranch } from '@/lib/time-machine/time-branch-store';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; branchId: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id: workspaceId, branchId } = await ctx.params;

  const access = await resolveWorkspaceAccessByOid(s.claims.oid, workspaceId, {
    groups: s.claims.groups || [], callerTid: s.claims.tid, tenantAdmin: isTenantAdminTier(s),
  });
  if (!access) return apiError('workspace not found or access denied', 404, { code: 'not_found' });
  if (!access.canWrite) return apiError('you need write access to delete a time-branch', 403, { code: 'forbidden' });

  try {
    const removed = await deleteTimeBranch(workspaceId, branchId);
    if (!removed) return apiError('time-branch not found', 404, { code: 'not_found' });
    return apiOk({ deleted: branchId });
  } catch (e) {
    return apiServerError(e, 'failed to delete time-branch', 'time_branch_delete_failed');
  }
}
