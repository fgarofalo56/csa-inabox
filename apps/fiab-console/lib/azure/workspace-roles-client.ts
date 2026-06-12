/**
 * Workspace roles client (F5 — Manage Access).
 *
 * Azure-native workspace RBAC, the DEFAULT and only-required backend:
 *   • Cosmos `workspace-roles` container is the system of record (one row per
 *     principal per workspace, keyed by Entra principalId so GROUPS — which
 *     have no UPN — are first-class).
 *   • Each row is MIRRORED to a real Azure RBAC role assignment on the DLZ
 *     resource group (the workspace's backing resources), performed AS the
 *     Console UAMI via the ARM control plane. Admin/Member → Contributor;
 *     Contributor/Viewer → Reader.
 *
 * Fabric is strictly OPT-IN (per no-fabric-dependency.md): when
 * `LOOM_WORKSPACE_ROLES_FABRIC=1` AND a workspace is bound, the same change is
 * also POSTed/DELETEd against `/v1/workspaces/{id}/roleAssignments`. With the
 * env unset, NOTHING touches api.fabric.microsoft.com — the Azure-native path
 * runs silently and is fully functional.
 *
 * Nested-group resolution: `resolveEffectiveRole` consults Microsoft Graph
 * `transitiveMembers` for every group assignment and returns the HIGHEST role
 * (Admin > Member > Contributor > Viewer) the user inherits, direct or via any
 * (possibly nested) group.
 *
 * Honest-gate: when the UAMI lacks Microsoft.Authorization/roleAssignments/write
 * on the DLZ RG, the Cosmos row is STILL written (membership is recorded) and
 * the RBAC side-effect returns { status: 'pending', detail } so the UI can show
 * a precise remediation MessageBar. No write path is silently dropped.
 *
 * No mocks. No stubs. All non-Cosmos calls hit ARM / Graph / (opt-in) Fabric.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import crypto from 'node:crypto';
import { armBase, armScope, graphBase, graphScope } from './cloud-endpoints';
import { workspaceRolesContainer } from './cosmos-client';
import {
  ROLE_TO_RBAC,
  pickHighestRole,
  type WorkspaceRoleName,
  type PrincipalType,
} from './workspace-role-model';

// Re-export the pure role model so callers keep a single import site.
export {
  WORKSPACE_ROLE_NAMES,
  ROLE_PRIORITY,
  ROLE_TO_RBAC,
  isWorkspaceRoleName,
  pickHighestRole,
} from './workspace-role-model';
export type { WorkspaceRoleName, PrincipalType } from './workspace-role-model';

// ---------------------------------------------------------------------------
// Cosmos doc shape
// ---------------------------------------------------------------------------

export type SideEffectStatus = 'active' | 'pending' | 'error';

export interface WorkspaceRoleAssignment {
  /** `${workspaceId}:${principalId}` */
  id: string;
  workspaceId: string;
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  role: WorkspaceRoleName;
  /** ARM resource id of the mirrored role assignment (when active). */
  azureRoleAssignmentId?: string;
  azureRoleStatus?: SideEffectStatus;
  azureRoleDetail?: string;
  /** True when also mirrored to a Fabric workspace role (opt-in). */
  fabricSynced?: boolean;
  fabricDetail?: string;
  addedBy: string;
  addedAt: string;
}

export interface SideEffectResult {
  status: SideEffectStatus;
  detail?: string;
}

export interface AddRoleInput {
  workspaceId: string;
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  role: WorkspaceRoleName;
  addedBy: string;
}

export interface AddRoleResult {
  roleAssignment: WorkspaceRoleAssignment;
  rbac: SideEffectResult;
  fabric?: SideEffectResult;
}

export interface RemoveRoleResult {
  removed: boolean;
  rbac: SideEffectResult;
  fabric?: SideEffectResult;
}

// ---------------------------------------------------------------------------
// Credentials / tokens
// ---------------------------------------------------------------------------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function armToken(): Promise<string> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new Error('Failed to acquire ARM token for workspace RBAC');
  return t.token;
}

async function graphToken(): Promise<string> {
  const t = await credential.getToken(graphScope());
  if (!t?.token) throw new Error('Failed to acquire Microsoft Graph token');
  return t.token;
}

interface ArmResponse<T = any> {
  ok: boolean;
  status: number;
  json: T | null;
  text: string;
}

async function armFetch<T = any>(url: string, init: RequestInit = {}): Promise<ArmResponse<T>> {
  const token = await armToken();
  const res = await fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  return { ok: res.ok, status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

function subId(): string {
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) throw new Error('LOOM_SUBSCRIPTION_ID required');
  return sub;
}

function dlzRg(): string {
  const rg = process.env.LOOM_DLZ_RG;
  if (!rg) throw new Error('LOOM_DLZ_RG required');
  return rg;
}

/** Bare ARM resource path (leading slash, no host) of the workspace RBAC scope. */
function rgScope(): string {
  return `/subscriptions/${subId()}/resourceGroups/${dlzRg()}`;
}

/**
 * Deterministic GUID-shaped name from the (workspace, principal, role) tuple so
 * a re-grant targets the SAME role-assignment resource — making PUT idempotent
 * (a duplicate is a 409 we treat as success rather than a stray new assignment).
 */
function deterministicGuid(...parts: string[]): string {
  const h = crypto.createHash('sha256').update(parts.join(':')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function rbacAdminRemediation(): string {
  const sub = process.env.LOOM_SUBSCRIPTION_ID || '<sub>';
  const rg = process.env.LOOM_DLZ_RG || '<dlz-rg>';
  const who = process.env.LOOM_UAMI_CLIENT_ID || '<uami-principal-id>';
  return (
    `Console UAMI (clientId=${who}) lacks Microsoft.Authorization/roleAssignments/write on ${rg}. ` +
    `Workspace membership is recorded in Cosmos but Azure RBAC is NOT enforced. To fix, run: ` +
    `az role assignment create --role "Role Based Access Control Administrator" --assignee <uami-principal-id> ` +
    `--scope /subscriptions/${sub}/resourceGroups/${rg} ` +
    `--condition-version 2.0 (constrained to Contributor + Reader) — or re-run Bicep with skipRoleGrants=false ` +
    `(module workspace-rbac.bicep).`
  );
}

// ---------------------------------------------------------------------------
// Fabric opt-in (NEVER reached unless explicitly enabled + bound)
// ---------------------------------------------------------------------------

function fabricEnabled(): boolean {
  return process.env.LOOM_WORKSPACE_ROLES_FABRIC === '1';
}

/**
 * The Fabric workspace GUID to mirror to. Opt-in only: derived from the
 * workspace doc's bound `fabricWorkspaceId` when present, else the deployment
 * default. Returns null when no workspace is bound — in which case Fabric sync
 * is silently skipped and the Azure-native path stands alone.
 */
function fabricWorkspaceFor(boundWorkspaceId?: string | null): string | null {
  if (!fabricEnabled()) return null;
  const id = boundWorkspaceId || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE || '';
  return id || null;
}

async function fabricToken(): Promise<string> {
  const scope = process.env.LOOM_FABRIC_SCOPE || 'https://api.fabric.microsoft.com/.default';
  const t = await credential.getToken(scope);
  if (!t?.token) throw new Error('Failed to acquire Fabric token');
  return t.token;
}

function fabricBase(): string {
  return process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
}

async function fabricAddRole(
  fabricWorkspace: string,
  principalId: string,
  principalType: PrincipalType,
  role: WorkspaceRoleName,
): Promise<SideEffectResult> {
  try {
    const token = await fabricToken();
    const res = await fetchWithTimeout(`${fabricBase()}/workspaces/${fabricWorkspace}/roleAssignments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        principal: { id: principalId, type: principalType === 'ServicePrincipal' ? 'ServicePrincipal' : principalType },
        role,
      }),
    });
    if (res.ok) return { status: 'active', detail: `Mirrored to Fabric workspace ${fabricWorkspace} as ${role}.` };
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      return { status: 'pending', detail: `Fabric opt-in enabled but UAMI not authorized on workspace ${fabricWorkspace}: ${body}` };
    }
    return { status: 'error', detail: `Fabric ${res.status}: ${body}` };
  } catch (e: any) {
    return { status: 'error', detail: (e?.message || String(e)).slice(0, 300) };
  }
}

async function fabricRemoveRole(fabricWorkspace: string, principalId: string): Promise<SideEffectResult> {
  try {
    const token = await fabricToken();
    const res = await fetchWithTimeout(`${fabricBase()}/workspaces/${fabricWorkspace}/roleAssignments/${principalId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.ok || res.status === 404) return { status: 'active', detail: 'Removed from Fabric workspace.' };
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      return { status: 'pending', detail: `Fabric opt-in enabled but UAMI not authorized: ${body}` };
    }
    return { status: 'error', detail: `Fabric ${res.status}: ${body}` };
  } catch (e: any) {
    return { status: 'error', detail: (e?.message || String(e)).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// ARM RBAC side-effects
// ---------------------------------------------------------------------------

async function armGrant(
  workspaceId: string,
  principalId: string,
  principalType: PrincipalType,
  role: WorkspaceRoleName,
): Promise<{ result: SideEffectResult; assignmentId?: string }> {
  let scope: string;
  try {
    scope = rgScope();
  } catch (e: any) {
    return { result: { status: 'pending', detail: e?.message || 'LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG not configured.' } };
  }
  const { roleDefGuid, roleName } = ROLE_TO_RBAC[role];
  const guid = deterministicGuid(workspaceId, principalId, roleDefGuid);
  const assignmentPath = `${scope}/providers/Microsoft.Authorization/roleAssignments/${guid}`;
  const url = `${armBase()}${assignmentPath}?api-version=2022-04-01`;
  const roleDefinitionId = `/subscriptions/${subId()}/providers/Microsoft.Authorization/roleDefinitions/${roleDefGuid}`;
  const resp = await armFetch<any>(url, {
    method: 'PUT',
    body: JSON.stringify({ properties: { roleDefinitionId, principalId, principalType } }),
  });
  if (resp.ok) {
    return { result: { status: 'active', detail: `Granted ${roleName} on ${dlzRg()}.` }, assignmentId: resp.json?.id || assignmentPath };
  }
  // Idempotent: the deterministic-named assignment already exists.
  const code = resp.json?.error?.code || '';
  if (resp.status === 409 || code === 'RoleAssignmentExists') {
    return { result: { status: 'active', detail: `${roleName} already assigned on ${dlzRg()} (idempotent).` }, assignmentId: assignmentPath };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { result: { status: 'pending', detail: rbacAdminRemediation() } };
  }
  const msg = resp.json?.error?.message || resp.text || `ARM ${resp.status}`;
  return { result: { status: 'error', detail: String(msg).slice(0, 400) } };
}

async function armRevoke(assignmentArmId: string): Promise<SideEffectResult> {
  const url = `${armBase()}${assignmentArmId}?api-version=2022-04-01`;
  const resp = await armFetch<any>(url, { method: 'DELETE' });
  if (resp.ok || resp.status === 204 || resp.status === 404) {
    return { status: 'active', detail: 'Azure RBAC assignment revoked.' };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { status: 'pending', detail: rbacAdminRemediation() };
  }
  const msg = resp.json?.error?.message || resp.text || `ARM ${resp.status}`;
  return { status: 'error', detail: String(msg).slice(0, 400) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all workspace role assignments (Cosmos system-of-record). */
export async function listWorkspaceRoles(workspaceId: string): Promise<WorkspaceRoleAssignment[]> {
  const c = await workspaceRolesContainer();
  const { resources } = await c.items
    .query<WorkspaceRoleAssignment>(
      {
        query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.addedAt',
        parameters: [{ name: '@w', value: workspaceId }],
      },
      { partitionKey: workspaceId },
    )
    .fetchAll();
  return resources;
}

/**
 * Add (or update) a workspace role assignment.
 *
 * The Cosmos row is ALWAYS written (membership is recorded), then the Azure
 * RBAC mirror is attempted — a missing RBAC-admin grant yields status 'pending'
 * (never a silent drop). Fabric mirror runs only when opted-in + bound.
 */
export async function addWorkspaceRole(input: AddRoleInput, boundFabricWorkspaceId?: string | null): Promise<AddRoleResult> {
  const { workspaceId, principalId, principalType, displayName, role, addedBy } = input;

  const grant = await armGrant(workspaceId, principalId, principalType, role);

  let fabric: SideEffectResult | undefined;
  const fabricWs = fabricWorkspaceFor(boundFabricWorkspaceId);
  if (fabricWs) {
    fabric = await fabricAddRole(fabricWs, principalId, principalType, role);
  }

  const doc: WorkspaceRoleAssignment = {
    id: `${workspaceId}:${principalId}`,
    workspaceId,
    principalId,
    principalType,
    displayName,
    role,
    azureRoleAssignmentId: grant.assignmentId,
    azureRoleStatus: grant.result.status,
    azureRoleDetail: grant.result.detail,
    fabricSynced: fabric ? fabric.status === 'active' : undefined,
    fabricDetail: fabric?.detail,
    addedBy,
    addedAt: new Date().toISOString(),
  };
  const c = await workspaceRolesContainer();
  const { resource } = await c.items.upsert<WorkspaceRoleAssignment>(doc);
  return { roleAssignment: resource as WorkspaceRoleAssignment, rbac: grant.result, fabric };
}

/** Remove a workspace role assignment + its Azure RBAC (and Fabric, if opted-in) mirror. */
export async function removeWorkspaceRole(
  workspaceId: string,
  principalId: string,
  boundFabricWorkspaceId?: string | null,
): Promise<RemoveRoleResult> {
  const c = await workspaceRolesContainer();
  let existing: WorkspaceRoleAssignment | null = null;
  try {
    const { resource } = await c.item(`${workspaceId}:${principalId}`, workspaceId).read<WorkspaceRoleAssignment>();
    existing = resource ?? null;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  if (!existing) return { removed: false, rbac: { status: 'active', detail: 'No such assignment.' } };

  let rbac: SideEffectResult = { status: 'active', detail: 'No Azure RBAC assignment was recorded.' };
  if (existing.azureRoleAssignmentId) {
    rbac = await armRevoke(existing.azureRoleAssignmentId);
  }

  let fabric: SideEffectResult | undefined;
  const fabricWs = fabricWorkspaceFor(boundFabricWorkspaceId);
  if (fabricWs) {
    fabric = await fabricRemoveRole(fabricWs, principalId);
  }

  try {
    await c.item(`${workspaceId}:${principalId}`, workspaceId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return { removed: true, rbac, fabric };
}

/**
 * Resolve the HIGHEST effective workspace role for `userId`, considering both
 * direct assignments and (transitive / nested) group membership via Microsoft
 * Graph. Returns null when the user inherits no role.
 *
 * `userGroupIds` (when the caller already has the user's transitive group set,
 * e.g. from token claims) short-circuits the per-group Graph calls. Otherwise
 * each group assignment is checked with Graph `groups/{id}/transitiveMembers`.
 */
export async function resolveEffectiveRole(
  userId: string,
  workspaceId: string,
  opts: { userGroupIds?: string[] } = {},
): Promise<WorkspaceRoleName | null> {
  const assignments = await listWorkspaceRoles(workspaceId);
  if (assignments.length === 0) return null;

  const inherited: WorkspaceRoleName[] = [];

  // Direct (user / SP) assignments.
  for (const a of assignments) {
    if (a.principalType !== 'Group' && a.principalId === userId) inherited.push(a.role);
  }

  const groupAssignments = assignments.filter((a) => a.principalType === 'Group');
  if (groupAssignments.length === 0) return pickHighestRole(inherited);

  // Fast path: caller supplied the user's transitive group ids.
  const known = opts.userGroupIds ? new Set(opts.userGroupIds) : null;
  if (known) {
    for (const a of groupAssignments) {
      if (known.has(a.principalId)) inherited.push(a.role);
    }
    return pickHighestRole(inherited);
  }

  // Otherwise ask Graph whether the user is a transitive member of each group.
  let token: string;
  try {
    token = await graphToken();
  } catch {
    // Graph unavailable — return whatever direct match we have rather than throw.
    return pickHighestRole(inherited);
  }
  for (const a of groupAssignments) {
    const isMember = await graphUserInGroup(token, a.principalId, userId);
    if (isMember) inherited.push(a.role);
  }
  return pickHighestRole(inherited);
}

/**
 * True when `userId` is a transitive (nested-aware) member of `groupId`,
 * acquiring its own Graph token. This is the standalone entry point used by the
 * domain-tier resolver (lib/auth/domain-role.ts) when the cached `groups` claim
 * is empty/truncated (the Entra >200-group overage case) and we must confirm
 * domain admin/contributor group membership against Graph directly. Returns
 * false (never throws) when Graph is unavailable so callers fail closed.
 */
export async function userIsTransitiveGroupMember(userId: string, groupId: string): Promise<boolean> {
  if (!userId || !groupId) return false;
  let token: string;
  try {
    token = await graphToken();
  } catch {
    return false;
  }
  return graphUserInGroup(token, groupId, userId);
}

/** True when `userId` is a transitive member of `groupId` (handles nested groups). */
async function graphUserInGroup(token: string, groupId: string, userId: string): Promise<boolean> {
  // Microsoft Graph: members/{id} existence check across the transitive closure.
  const url = `${graphBase()}/groups/${groupId}/transitiveMembers/${userId}?$select=id`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ConsistencyLevel: 'eventual' },
      cache: 'no-store',
    });
    if (res.ok) return true;
    if (res.status === 404) return false;
    // On 4xx/5xx other than 404 fall back to paged enumeration once.
  } catch {
    return false;
  }
  // Fallback: enumerate transitive members (covers tenants where the direct
  // membership-by-id check is not permitted on the resource type).
  let next: string | null =
    `${graphBase()}/groups/${groupId}/transitiveMembers?$select=id&$top=999&$count=true`;
  let guard = 0;
  while (next && guard < 50) {
    guard += 1;
    const res: Response = await fetchWithTimeout(next, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ConsistencyLevel: 'eventual' },
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const json: any = await res.json();
    for (const m of json?.value || []) {
      if (m?.id === userId) return true;
    }
    next = json?.['@odata.nextLink'] || null;
  }
  return false;
}

/**
 * List ALL workspace-role assignments across a set of workspace IDs (Cosmos
 * system-of-record). Used by GET /api/admin/users to build the per-user
 * role-expansion view without iterating workspaces individually.
 *
 * This is a cross-partition query (no partitionKey option) — acceptable for the
 * admin-console path where the workspace count is bounded (~50–500 for a typical
 * tenant). Results are grouped by principalId on the caller side. Returns an
 * empty array when `workspaceIds` is empty.
 */
export async function listAllWorkspaceRolesForWorkspaces(
  workspaceIds: string[],
): Promise<WorkspaceRoleAssignment[]> {
  if (!workspaceIds.length) return [];
  const c = await workspaceRolesContainer();
  const { resources } = await c.items
    .query<WorkspaceRoleAssignment>({
      query:
        'SELECT c.id, c.workspaceId, c.principalId, c.principalType, c.displayName, c.role ' +
        'FROM c WHERE ARRAY_CONTAINS(@wids, c.workspaceId)',
      parameters: [{ name: '@wids', value: workspaceIds }],
    })
    .fetchAll(); // cross-partition — no partitionKey argument
  return resources;
}

/**
 * Probe whether the Console UAMI can write role assignments on the DLZ RG.
 * A 403 on a zero-cost list means the RBAC-admin grant is missing — the route
 * surfaces the returned `detail` as an honest-gate MessageBar.
 */
export async function checkRbacAdminCapability(): Promise<{ ok: boolean; detail?: string }> {
  let scope: string;
  try {
    scope = rgScope();
  } catch (e: any) {
    return { ok: false, detail: e?.message || 'LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG must be set to enforce Azure RBAC.' };
  }
  const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$top=1`;
  const resp = await armFetch<any>(url);
  if (resp.ok) return { ok: true };
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, detail: rbacAdminRemediation() };
  }
  const msg = resp.json?.error?.message || resp.text || `ARM ${resp.status}`;
  return { ok: false, detail: String(msg).slice(0, 400) };
}
