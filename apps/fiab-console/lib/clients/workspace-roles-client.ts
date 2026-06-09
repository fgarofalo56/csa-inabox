/**
 * Workspace roles — browser-safe BFF client (F9 Manage Access).
 *
 * Fetch-only wrapper over the workspace role-assignment BFF routes. No
 * `@azure/identity`, no Cosmos, no server-only imports — safe to import from a
 * `'use client'` component (the server-side system of record lives in
 * lib/azure/workspace-roles-client.ts and is reached over HTTP here).
 *
 *   GET    /api/workspaces/{id}/role-assignments
 *   POST   /api/workspaces/{id}/role-assignments
 *   DELETE /api/workspaces/{id}/role-assignments/{principalId}
 *
 * Each non-ok response throws an Error carrying the BFF's `json.error` so the
 * caller can surface an honest MessageBar (per no-vaporware.md). The Azure RBAC
 * + (opt-in) Fabric side-effects are returned verbatim so the UI can show
 * 'active' / 'pending' / 'error' enforcement state.
 */

export type WorkspaceRoleName = 'Admin' | 'Member' | 'Contributor' | 'Viewer';
export type PrincipalType = 'User' | 'Group' | 'ServicePrincipal';
export type SideEffectStatus = 'active' | 'pending' | 'error';

export interface WorkspaceRoleAssignment {
  /** `${workspaceId}:${principalId}` */
  id: string;
  workspaceId: string;
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  role: WorkspaceRoleName;
  azureRoleAssignmentId?: string;
  azureRoleStatus?: SideEffectStatus;
  azureRoleDetail?: string;
  fabricSynced?: boolean;
  fabricDetail?: string;
  addedBy: string;
  addedAt: string;
}

export interface SideEffectResult {
  status: SideEffectStatus;
  detail?: string;
}

export interface ListRolesResponse {
  ok: boolean;
  roleAssignments: WorkspaceRoleAssignment[];
  /** Honest-gate text when the Console UAMI lacks RBAC-admin on the DLZ RG. */
  rbacAdminGate?: string;
  fabricMode: 'azure-native' | 'fabric+azure';
  callerRole: 'admin' | 'contributor' | 'viewer';
}

export interface AddRoleBody {
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  role: WorkspaceRoleName;
}

export interface AddRoleResponse {
  ok: boolean;
  roleAssignment: WorkspaceRoleAssignment;
  rbac: SideEffectResult;
  fabric?: SideEffectResult;
}

export interface RemoveRoleResponse {
  ok: boolean;
  removed: boolean;
  rbac: SideEffectResult;
  fabric?: SideEffectResult;
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** List a workspace's role assignments + RBAC-admin gate + Fabric mode. */
export async function listRoleAssignments(workspaceId: string): Promise<ListRolesResponse> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/role-assignments`, {
    cache: 'no-store',
  });
  const json = await readJson(res);
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json as ListRolesResponse;
}

/**
 * Add (or upsert/edit) a workspace role assignment. POSTing the same
 * `principalId` with a new `role` updates the existing assignment (the server
 * upserts the Cosmos row and re-PUTs the deterministic Azure RBAC assignment).
 */
export async function addRoleAssignment(
  workspaceId: string,
  body: AddRoleBody,
): Promise<AddRoleResponse> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/role-assignments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await readJson(res);
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json as AddRoleResponse;
}

/** Remove a workspace role assignment — deletes the Cosmos row AND revokes the Azure RBAC mirror. */
export async function deleteRoleAssignment(
  workspaceId: string,
  principalId: string,
): Promise<RemoveRoleResponse> {
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/role-assignments/${encodeURIComponent(principalId)}`,
    { method: 'DELETE' },
  );
  const json = await readJson(res);
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json as RemoveRoleResponse;
}

/** Workspace-role badge accent (matches the Fabric role taxonomy). */
export function roleBadgeColor(role: WorkspaceRoleName): 'brand' | 'success' | 'informative' | 'subtle' {
  switch (role) {
    case 'Admin': return 'brand';
    case 'Member': return 'success';
    case 'Contributor': return 'informative';
    default: return 'subtle';
  }
}

/** Azure RBAC side-effect → Fluent Badge color + label. */
export function rbacBadge(status?: SideEffectStatus): {
  color: 'success' | 'warning' | 'danger' | 'subtle';
  label: string;
} {
  switch (status) {
    case 'active': return { color: 'success', label: 'Active' };
    case 'pending': return { color: 'warning', label: 'Pending' };
    case 'error': return { color: 'danger', label: 'Error' };
    default: return { color: 'subtle', label: '—' };
  }
}

export const WORKSPACE_ROLE_NAMES: WorkspaceRoleName[] = ['Admin', 'Member', 'Contributor', 'Viewer'];

export const ROLE_DESCRIPTIONS: Record<WorkspaceRoleName, string> = {
  Admin: 'Full workspace control, including membership and settings (→ Azure Contributor on the RG)',
  Member: 'Create, publish, and share items (→ Azure Contributor on the RG)',
  Contributor: 'Create and modify items (→ Azure Reader on the RG)',
  Viewer: 'Read-only access to items (→ Azure Reader on the RG)',
};
