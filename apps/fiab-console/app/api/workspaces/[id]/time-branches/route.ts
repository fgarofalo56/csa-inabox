/**
 * WS-10.3 Time-Machine — time-branches (branch = shadow workspace).
 *
 * GET  /api/workspaces/[id]/time-branches            → { ok, branches: [...] }
 * POST /api/workspaces/[id]/time-branches  { name, asOf, description? }
 *                                                    → { ok, branch }
 *
 * A time-branch is a named, pinned as-of snapshot over the workspace — a
 * zero-copy shadow workspace the user can query AS OF T via the global time-bar.
 * Persisted in the `time-branches` Cosmos container (real backend, no mocks).
 *
 * AUTHORIZATION: the caller is resolved against THIS workspace via
 * `resolveWorkspaceAccessByOid` (owner / ACL) — a signed-in session alone is not
 * enough (route-guards.mjs). Create requires write access; list requires read.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import {
  createTimeBranch, listTimeBranches, normalizeTimeBranchInput,
  MAX_TIME_BRANCHES_PER_WORKSPACE,
} from '@/lib/time-machine/time-branch-store';
import { TimeMachineError } from '@/lib/time-machine/time-machine';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id: workspaceId } = await ctx.params;

  const access = await resolveWorkspaceAccessByOid(s.claims.oid, workspaceId, {
    groups: s.claims.groups || [], callerTid: s.claims.tid, tenantAdmin: isTenantAdminTier(s),
  });
  if (!access) return apiError('workspace not found or access denied', 404, { code: 'not_found' });

  try {
    const branches = await listTimeBranches(workspaceId);
    return apiOk({ branches });
  } catch (e) {
    return apiServerError(e, 'failed to list time-branches', 'time_branch_list_failed');
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id: workspaceId } = await ctx.params;

  const access = await resolveWorkspaceAccessByOid(s.claims.oid, workspaceId, {
    groups: s.claims.groups || [], callerTid: s.claims.tid, tenantAdmin: isTenantAdminTier(s),
  });
  if (!access) return apiError('workspace not found or access denied', 404, { code: 'not_found' });
  if (!access.canWrite) return apiError('you need write access to create a time-branch', 403, { code: 'forbidden' });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  let input;
  try {
    input = normalizeTimeBranchInput(body);
  } catch (e) {
    if (e instanceof TimeMachineError) return apiError(e.message, 400, { code: 'bad_request' });
    throw e;
  }

  try {
    const existing = await listTimeBranches(workspaceId);
    if (existing.length >= MAX_TIME_BRANCHES_PER_WORKSPACE) {
      return apiError(
        `This workspace already has the maximum of ${MAX_TIME_BRANCHES_PER_WORKSPACE} time-branches. Delete one before creating another.`,
        409, { code: 'branch_cap' },
      );
    }
    const branch = await createTimeBranch(workspaceId, input, {
      oid: s.claims.oid, name: s.claims.name || s.claims.upn,
    });
    return apiOk({ branch });
  } catch (e) {
    return apiServerError(e, 'failed to create time-branch', 'time_branch_create_failed');
  }
}
