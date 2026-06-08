/**
 * Workspace role model (F5) — PURE, dependency-free role constants + helpers.
 *
 * Split out of workspace-roles-client.ts so the role priority / RBAC mapping /
 * highest-role resolution can be imported (and unit-tested) WITHOUT pulling in
 * the Azure SDK (@azure/identity) that the client needs for ARM/Graph calls.
 * The client re-exports everything here, so callers keep a single import site.
 */

export type WorkspaceRoleName = 'Admin' | 'Member' | 'Contributor' | 'Viewer';
export type PrincipalType = 'User' | 'Group' | 'ServicePrincipal';

export const WORKSPACE_ROLE_NAMES: WorkspaceRoleName[] = ['Admin', 'Member', 'Contributor', 'Viewer'];

/** Higher number wins when a user inherits a role via multiple paths. */
export const ROLE_PRIORITY: Record<WorkspaceRoleName, number> = {
  Admin: 4,
  Member: 3,
  Contributor: 2,
  Viewer: 1,
};

// Built-in Azure RBAC role definition GUIDs (global across every tenant/cloud).
export const RBAC_CONTRIBUTOR = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
export const RBAC_READER = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';

/**
 * Loom workspace role → Azure RBAC built-in role assigned on the workspace RG.
 * Admin & Member get write (Contributor); Contributor & Viewer get read
 * (Reader). The ABAC condition on the UAMI's grant only permits these two
 * role-definition GUIDs (see workspace-rbac.bicep).
 */
export const ROLE_TO_RBAC: Record<WorkspaceRoleName, { roleDefGuid: string; roleName: string }> = {
  Admin: { roleDefGuid: RBAC_CONTRIBUTOR, roleName: 'Contributor' },
  Member: { roleDefGuid: RBAC_CONTRIBUTOR, roleName: 'Contributor' },
  Contributor: { roleDefGuid: RBAC_READER, roleName: 'Reader' },
  Viewer: { roleDefGuid: RBAC_READER, roleName: 'Reader' },
};

export function isWorkspaceRoleName(v: unknown): v is WorkspaceRoleName {
  return typeof v === 'string' && (WORKSPACE_ROLE_NAMES as string[]).includes(v);
}

/**
 * Pick the highest-priority role from a set of inherited roles (direct +
 * transitive group membership). Pure + deterministic so it is unit-tested
 * directly; `resolveEffectiveRole` feeds it the roles a user inherits.
 * Returns null for an empty set.
 */
export function pickHighestRole(roles: Iterable<WorkspaceRoleName>): WorkspaceRoleName | null {
  let best: WorkspaceRoleName | null = null;
  for (const r of roles) {
    if (best === null || ROLE_PRIORITY[r] > ROLE_PRIORITY[best]) best = r;
  }
  return best;
}
