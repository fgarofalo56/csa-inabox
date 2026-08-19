/**
 * Resolve a user's effective role on a Loom workspace.
 *
 * Mirrors the model in app/api/workspaces/[id]/permissions/route.ts:
 *   • The workspace creator (`createdBy`) is the implicit `admin` (owner).
 *   • Otherwise the role comes from a row in the `workspace-permissions`
 *     container: admin | contributor | viewer.
 *   • No row + not the owner → null (no access).
 *
 * Used by the workspace data-agent config route and by the admin-plane
 * "Workspace access" roster so only OWNERS/CONTRIBUTORS (admin or contributor)
 * — or, at the ROUTE level, a tenant admin / owning-domain admin — may act.
 *
 * ---------------------------------------------------------------------------
 * #3751 / #3753 — FINDING THE WORKSPACE IS NOT THE SAME AS AUTHORIZING ON IT
 * ---------------------------------------------------------------------------
 * This function used to take a `tenantId` parameter that every one of its call
 * sites filled with `session.claims.oid`, and point-read
 *
 *     workspacesContainer().item(workspaceId, tenantId)
 *
 * The `workspaces` container is partitioned on `/tenantId`, and
 * `Workspace.tenantId` stores the CREATOR's Entra oid (see
 * `lib/auth/workspace-access.ts`, and the note at `tenantScopeId()` in
 * `lib/auth/session.ts` which says outright that the tenant scope is NOT valid
 * for this container). So that read could only ever answer
 *
 *     "did THIS caller create this workspace?"
 *
 * and Cosmos 404s for everyone else — before the function reached its own
 * `resource.tenantId === tenantId` check. The routes then reported
 * "workspace not found", which is FALSE: the workspace exists and is listed
 * tenant-wide by `listAllWorkspacesAdmin()`. Reproduced 2/2 on a 108-workspace
 * tenant. This is the #2941/#2942/#2947 owner-only-point-read class, reached
 * through a shared helper rather than an inline read.
 *
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT. Only the LOOKUP is fixed: the
 * workspace is now resolved by its own id when the caller is not its creator.
 * Role resolution is byte-identical — `createdBy` still means owner/`admin`,
 * and every other role still comes from a `workspace-permissions` row. A
 * non-member therefore still resolves `role: null`; what changes is that the
 * caller now gets a real `workspace` object, so the ROUTE can apply the
 * authorization ladder it already has (workspace role → tenant admin → owning
 * domain admin) instead of dying on a false 404. No caller gains a role it did
 * not already hold.
 *
 * TENANT BOUNDARY (non-optional, by construction). The cross-partition lookup
 * can see workspaces belonging to OTHER Entra tenants, so it is followed by the
 * same boundary `resolveWorkspaceAccessByOid` applies: when the caller's `tid`
 * is known AND the workspace records its owning `tid`, they must match. This
 * function now takes the SESSION rather than a bare `oid`, so that boundary
 * cannot be switched off by a call site omitting an argument — the #2703
 * lesson, enforced by `tsc` rather than by review. Legacy workspace docs predate
 * the `tid` field; for those the owner check and the explicit permissions row
 * remain the boundary, exactly as they are for the pre-existing
 * `resolveWorkspaceAccessByOid` path.
 */
import { workspacePermissionsContainer } from '../azure/cosmos-client';
import { readWorkspaceById } from './workspace-access';
import type { SessionPayload } from './session';

export type WorkspaceRole = 'admin' | 'contributor' | 'viewer';

export interface WorkspaceRoleResult {
  /** The workspace doc (null when not found / outside the caller's tenant). */
  workspace: any | null;
  /** The caller's effective role, or null when they have no per-workspace role. */
  role: WorkspaceRole | null;
}

/**
 * Locate `workspaceId` for `session`: a bounded, single-id cross-partition
 * lookup, gated on the Entra tenant boundary.
 *
 * There is DELIBERATELY no owner point-read fast path here (#3753). Adding one
 * back would re-introduce `workspacesContainer().item(workspaceId, callerOid)`
 * — the exact shape `scripts/ci/check-owner-only-workspace-guard.mjs` ratchets,
 * and the shape that made this helper answer "did you CREATE it" instead of
 * "does it exist". `readWorkspaceById` resolves the doc in whichever partition
 * owns it, INCLUDING the caller's own, so the creator path is unchanged in
 * outcome. Ownership is then decided from the returned document, not from which
 * partition the read happened to hit.
 */
async function findWorkspace(workspaceId: string, session: SessionPayload): Promise<any | null> {
  const doc = await readWorkspaceById(workspaceId);
  if (!doc) return null;

  // Entra tenant boundary. Both sides must agree when both are known. Legacy
  // docs predate `tid`; for those, `createdBy` + the explicit permissions row
  // remain the boundary — identical to `resolveWorkspaceAccessByOid`.
  const callerTid = session.claims.tid;
  const docTid = (doc as { tid?: string }).tid;
  if (callerTid && docTid && docTid !== callerTid) return null;

  return doc;
}

/**
 * Resolve the caller's `role` on `workspaceId`. `session` supplies both the
 * identity the role is resolved for and the tenant boundary for the lookup.
 */
export async function resolveWorkspaceRole(
  workspaceId: string,
  session: SessionPayload,
): Promise<WorkspaceRoleResult> {
  const workspace = await findWorkspace(workspaceId, session);
  if (!workspace) return { workspace: null, role: null };

  const me = (session.claims.upn || session.claims.email || '').toLowerCase();
  if (me && (workspace.createdBy || '').toLowerCase() === me) {
    return { workspace, role: 'admin' };
  }

  const perms = await workspacePermissionsContainer();
  try {
    const { resource } = await perms.item(`${workspaceId}:${me}`, workspaceId).read<any>();
    if (resource?.role && ['admin', 'contributor', 'viewer'].includes(resource.role)) {
      return { workspace, role: resource.role as WorkspaceRole };
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return { workspace, role: null };
}

/** True when the role may EDIT workspace config (owner/contributor). */
export function canEditWorkspaceConfig(role: WorkspaceRole | null): boolean {
  return role === 'admin' || role === 'contributor';
}
