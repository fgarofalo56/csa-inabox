/**
 * Resolve a user's effective role on a Loom workspace.
 *
 * Mirrors the model in app/api/workspaces/[id]/permissions/route.ts:
 *   • The workspace creator (`createdBy`) is the implicit `admin` (owner).
 *   • Otherwise the role comes from a row in the `workspace-permissions`
 *     container: admin | contributor | viewer.
 *   • No row + not the owner → null (no access).
 *
 * Used by the workspace data-agent config route so only OWNERS/CONTRIBUTORS
 * (admin or contributor) may change which Foundry agent/service the workspace's
 * data agents use.
 */
import { workspacesContainer, workspacePermissionsContainer } from '../azure/cosmos-client';

export type WorkspaceRole = 'admin' | 'contributor' | 'viewer';

export interface WorkspaceRoleResult {
  /** The workspace doc (null when not found / not in this tenant). */
  workspace: any | null;
  /** The caller's effective role, or null when they have no access. */
  role: WorkspaceRole | null;
}

/**
 * Resolve `role` for the given user identity (upn/email) on `workspaceId`,
 * scoped to `tenantId` (workspaces are partitioned by tenant).
 */
export async function resolveWorkspaceRole(
  workspaceId: string,
  tenantId: string,
  upn: string | undefined,
): Promise<WorkspaceRoleResult> {
  const ws = await workspacesContainer();
  let workspace: any | null = null;
  try {
    const { resource } = await ws.item(workspaceId, tenantId).read<any>();
    workspace = resource && resource.tenantId === tenantId ? resource : null;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  if (!workspace) return { workspace: null, role: null };

  const me = (upn || '').toLowerCase();
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
