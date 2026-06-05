/**
 * Access-policy enforcement — makes Governance → Policies "Access" rules REAL
 * instead of persist-only. A Loom-native, Azure-native data-access grant =
 * give a PRINCIPAL (Entra user/group/SP) a PERMISSION (read/write/admin) on a
 * data scope, enforced as a real Storage RBAC role assignment for ADLS Gen2
 * container scopes (the same data-plane grant the Lakehouse Permissions dialog
 * uses). No Microsoft Fabric / Purview-policy dependency (no-fabric-dependency.md).
 *
 * Scopes Loom can't yet bind to a runtime RBAC grant (warehouse / KQL /
 * collection) return status 'pending' with a precise reason — never a silent
 * no-op (no-vaporware.md).
 */
import { grantContainerRole, revokeContainerRoleAssignment } from './adls-client';

export type AccessPermission = 'read' | 'write' | 'admin';
export type AccessScopeType = 'adls-container' | 'workspace' | 'item' | 'collection';
export type PrincipalType = 'User' | 'Group' | 'ServicePrincipal';

/** Permission → Storage data-plane role for ADLS-container scopes. */
export const PERMISSION_ROLE: Record<AccessPermission, string> = {
  read: 'Storage Blob Data Reader',
  write: 'Storage Blob Data Contributor',
  admin: 'Storage Blob Data Owner',
};

export interface AccessGrantInput {
  principalId: string;
  principalType: PrincipalType;
  scopeType: AccessScopeType;
  /** For adls-container: the container name. */
  scopeRef: string;
  permission: AccessPermission;
}

export interface AccessGrantResult {
  status: 'active' | 'pending' | 'error';
  roleName?: string;
  roleAssignmentId?: string;
  detail?: string;
}

/** Enforce an access grant. Real RBAC for ADLS-container scopes; honest gate otherwise. */
export async function enforceAccessGrant(input: AccessGrantInput): Promise<AccessGrantResult> {
  if (input.scopeType !== 'adls-container') {
    return {
      status: 'pending',
      detail:
        `Enforcement for ${input.scopeType} scopes isn't wired to a runtime RBAC grant yet. ` +
        `The policy is recorded; apply the equivalent grant on the ${input.scopeType} backend, ` +
        `or scope this policy to an ADLS container (which Loom enforces automatically).`,
    };
  }
  const roleName = PERMISSION_ROLE[input.permission];
  try {
    const grant = await grantContainerRole(input.scopeRef, input.principalId, roleName, input.principalType);
    return { status: 'active', roleName: grant.roleName || roleName, roleAssignmentId: grant.id };
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 400);
    // 409 = grant already exists at scope → idempotent success.
    if (/\b409\b|already exists|RoleAssignmentExists/i.test(msg)) {
      return { status: 'active', roleName, detail: 'Role already assigned at this scope (idempotent).' };
    }
    return { status: 'error', detail: msg };
  }
}

/** Remove a previously-enforced grant (best-effort). */
export async function revokeAccessGrant(roleAssignmentId: string): Promise<void> {
  await revokeContainerRoleAssignment(roleAssignmentId).catch(() => { /* already gone */ });
}
