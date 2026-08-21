/**
 * ONE renderer for a {@link WorkspaceAccessDenial} — the honest HTTP shape for
 * "the resolver REFUSED a grant it would otherwise have made".
 *
 * #3823 introduced the denial itself (`resolveWorkspaceAccessByOid`'s `diag`
 * out-channel) and rendered it inline in `app/api/workspaces/[id]/route.ts`.
 * #3825 routes the tenant-admin path of EVERY workspace guard through that same
 * resolver, so the same refusal now reaches ~117 more route files. Extracting
 * the renderer here — rather than copying those eight lines into the guard —
 * keeps ONE definition of what a refused tenant-admin grant looks like on the
 * wire. A second copy would drift, and the first thing to drift would be the
 * remediation string, which is the only part of the response a user can act on.
 *
 * WHY 409 AND NOT 404 OR 403. A 404 "workspace not found" would be false on
 * both counts: the workspace WAS read (that is how we know its `tid` is
 * absent), and the caller's tenant-admin rights are real. A 403 would assert
 * the caller lacks permission, which is also not what was established. Per
 * `deploy-integrity.md` R7 the response states only what the code proved — the
 * workspace's tenancy is UNCONFIRMED — and names the exact remediation. 409
 * (conflict) is the honest class: the blocker is a state of the DATA, not of
 * the caller.
 *
 * Returns null when `diag` records no denial, so call sites read as
 *   `return workspaceDenialResponse(diag) ?? <the route's own 404>`
 * and the ordinary "this caller simply holds no role here" case is untouched.
 */
import type { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import type { WorkspaceAccessDiagnostics } from '@/lib/auth/workspace-access';

export function workspaceDenialResponse(diag: WorkspaceAccessDiagnostics): NextResponse | null {
  const d = diag.denial;
  if (!d) return null;
  return apiError(d.reason, 409, {
    code: d.code,
    remediation: d.remediation,
    workspaceId: d.workspaceId,
  });
}
