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

import { fetchWithTimeout, DEFAULT_SERVER_FETCH_TIMEOUT_MS } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import crypto from 'node:crypto';
import { armBase, armScope, graphBase, graphScope } from './cloud-endpoints';
import { workspaceRolesContainer } from './cosmos-client';
import { PagingBudget, PAGE_DEADLINE, defaultPagingBudgetMs } from './paging-budget';
import { logSafe, logSafeError } from '@/lib/util/log-safe';
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
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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
    `az role assignment create --role "Role Based Access Control Administrator" --assignee ${who} ` +
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
 * Wall-clock ceiling for the WHOLE group walk in {@link resolveEffectiveRole} —
 * not per probe. The default is the single-request ceiling, which is the
 * property worth being able to state: however many groups a workspace grants
 * to, resolving all of them can never out-live ONE Graph call. Override with
 * `LOOM_GRAPH_GROUP_WALK_BUDGET_MS`, read PER WALK (as `paging-budget` reads
 * its own knobs) so raising it takes effect on the next request rather than on
 * the next container restart.
 */
function graphGroupWalkBudgetMs(): number {
  const n = Number(process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SERVER_FETCH_TIMEOUT_MS;
}

/**
 * Resolve the HIGHEST effective workspace role for `userId`, considering both
 * direct assignments and (transitive / nested) group membership via Microsoft
 * Graph. Returns null when the user inherits no role.
 *
 * `userGroupIds` (when the caller already has the user's transitive group set,
 * e.g. from token claims) short-circuits the per-group Graph calls. Otherwise
 * each group assignment is checked with Graph `groups/{id}/transitiveMembers`,
 * under ONE walk-wide budget shared by every probe — see
 * {@link graphGroupWalkBudgetMs}.
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

  // #3834 §3 — BOUND THE WALK, NOT ONLY EACH PROBE. This loop used to have no
  // aggregate ceiling. Each probe IS bounded (a 30s point-read, then a 15s
  // PagingBudget on the paged fallback), so N group assignments cost N x ~45s —
  // and not one of the 13 admin-plane route files that reach here declares
  // `export const maxDuration`, so nothing above it caps that either. ONE budget
  // now spans the whole loop, and its remaining wall clock is handed down into
  // each probe so a single slow group cannot spend the walk's clock un-noticed.
  //
  // A GROUP WE NEVER VISITED CONTRIBUTES NOTHING — the same fail-closed posture
  // `unknown` already has. So a truncated walk can refuse a genuine member; that
  // is the correct direction for an authorization check, and `warnIfTruncated`
  // names the deadline so the refusal is diagnosable as a deadline rather than
  // read as "not a member" (#3381).
  //
  // maxPages is pinned to the assignment count so the WALL CLOCK is the only
  // ceiling here: the shared 50-page default would otherwise stop probing on a
  // workspace with more than 50 group grants even when every probe was fast.
  const walk = new PagingBudget(`graph group walk ${workspaceId}`, {
    maxPages: groupAssignments.length,
    budgetMs: graphGroupWalkBudgetMs(),
  });
  // REQUEST-SCOPED, and deliberately not a module-level cache: this is an
  // authorization path, where a cached positive outlives the membership that
  // justified it. Keyed on the PAIR, so two rows naming the same group cost one
  // probe while two different groups still cost two.
  const probed = new Map<string, GraphMembership>();
  for (const a of groupAssignments) {
    const key = `${userId}|${a.principalId}`;
    let membership = probed.get(key);
    if (membership === undefined) {
      // Claim the walk's next slot only when a real Graph call is needed — a
      // memo hit costs no wall clock and must not consume the ceiling.
      if (!walk.claimPage()) break;
      membership = await graphUserInGroup(token, a.principalId, userId, walk);
      probed.set(key, membership);
    }
    // 'unknown' (Graph unreachable) contributes nothing — same fail-closed
    // posture as before, when this read a bare `false`.
    if (membership === 'member') inherited.push(a.role);
  }
  walk.warnIfTruncated(probed.size);
  return pickHighestRole(inherited);
}

/**
 * The three genuinely-different answers a Graph membership check can produce.
 *
 * `unknown` exists because #3381's acceptance criteria call it out by name: a
 * fail-closed `false` returned because the endpoint could not be REACHED is
 * indistinguishable, to every caller and every log reader, from a `false` that
 * Graph actually measured. That ambiguity is what made the wrong-Graph-host bug
 * silent — an IL5 console asking `graph.microsoft.us` about an L5 tenant got a
 * non-answer and reported "not a member". Authorization still fails closed on
 * `unknown`; the difference is that it is now SAYABLE.
 */
export type GraphMembership = 'member' | 'not-member' | 'unknown';

/**
 * Transitive (nested-aware) group membership as a TRI-STATE. Prefer this over
 * `userIsTransitiveGroupMember` anywhere the caller can surface or log the
 * difference between a measured negative and an unreachable directory.
 */
export async function userTransitiveGroupMembership(
  userId: string,
  groupId: string,
): Promise<GraphMembership> {
  if (!userId || !groupId) return 'not-member';
  let token: string;
  try {
    token = await graphToken();
  } catch (e: unknown) {
    // COULD NOT ASK — no token. Callers fail closed, but the cause is named.
    // logSafeError, not raw interpolation: an Error's message reaches the log
    // verbatim and a newline in it forges a second record (js/log-injection).
    console.warn(
      `[graph-membership] UNKNOWN (not a measured negative): could not acquire a Graph token for ${logSafe(graphScope(), 120)} — ${logSafeError(e)}`,
    );
    return 'unknown';
  }
  return graphUserInGroup(token, groupId, userId);
}

/**
 * True when `userId` is a transitive (nested-aware) member of `groupId`,
 * acquiring its own Graph token. This is the standalone entry point used by the
 * domain-tier resolver (lib/auth/domain-role.ts) when the cached `groups` claim
 * is empty/truncated (the Entra >200-group overage case) and we must confirm
 * domain admin/contributor group membership against Graph directly.
 *
 * FAIL-CLOSED and unchanged: `unknown` collapses to `false`, so an unreachable
 * directory never grants a role. The collapse is deliberate and is the correct
 * posture for an authorization check — `userTransitiveGroupMembership()` is the
 * tri-state form for callers that need to tell the two apart.
 */
export async function userIsTransitiveGroupMember(userId: string, groupId: string): Promise<boolean> {
  return (await userTransitiveGroupMembership(userId, groupId)) === 'member';
}

/**
 * Read a JSON body without letting a NON-JSON one become an exception.
 *
 * #3834 — `await res.json()` on a body that is not JSON throws a `SyntaxError`
 * that propagates out of `graphUserInGroup`, past `resolveEffectiveRole`, past
 * `resolveWorkspaceAccessByOid` and out of the route as a 500. That is not
 * fail-closed, it is fail-LOUD-in-the-wrong-place: the caller cannot tell an
 * authorization refusal from a directory that answered in HTML. Returning the
 * sentinel lets the one place that knows what the body was FOR decide, and every
 * such decision here is `'unknown'`.
 *
 * The condition is not theoretical: it is the same proxy / WAF / captive-portal
 * / wrong-national-cloud shape as #3381, where something in front of Graph
 * answers 200 with a sign-in page.
 */
const NOT_JSON = Symbol('not-json');
async function readJsonBody(res: Response): Promise<any | typeof NOT_JSON> {
  try {
    return await res.json();
  } catch {
    return NOT_JSON;
  }
}

/**
 * Transitive membership against Graph. Returns `unknown` — never a bare
 * `false`, and never a bare `member` — whenever the directory could not answer,
 * so the caller's fail-closed decision is distinguishable from a measured "not a
 * member".
 *
 * #3834 — A BARE 2xx USED TO BE READ AS MEMBERSHIP. This opened with
 *
 *     if (res.ok) return 'member';
 *
 * without ever inspecting the body, so ANY 2xx from something sitting in front
 * of Graph — a proxy, a WAF, a captive portal, or the wrong national-cloud host
 * (#3381) — GRANTED the group's workspace role. That defeats the entire
 * `tenant_unconfirmed` refusal `resolveWorkspaceAccessByOid` exists to produce:
 * the ACL step (5) runs BEFORE the admin step (6), so a forged membership hands
 * back a real role and the tenant boundary below it is never reached.
 *
 * The endpoint is `groups/{id}/transitiveMembers/{userId}` — a directoryObject
 * point-read — so a genuine positive answers with THAT object. The check is
 * therefore the only one that means anything: does the returned object identify
 * the user we asked about? Anything else (not JSON, no `id`, a DIFFERENT `id`)
 * is a non-answer and resolves `unknown`, which contributes no role.
 *
 * `walk`, when supplied, is the WALK-WIDE budget shared by every group probe in
 * one {@link resolveEffectiveRole} call (#3834 §3). Its remaining wall clock
 * bounds both the point-read and the paged fallback, so N groups cost the walk's
 * ceiling in total rather than N times a per-probe one.
 */
async function graphUserInGroup(
  token: string,
  groupId: string,
  userId: string,
  walk?: PagingBudget,
): Promise<GraphMembership> {
  // Microsoft Graph: members/{id} existence check across the transitive closure.
  const url = `${graphBase()}/groups/${groupId}/transitiveMembers/${userId}?$select=id`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ConsistencyLevel: 'eventual' },
      cache: 'no-store',
    }, walk?.remainingMs());
    if (res.ok) {
      // 2xx IS NOT AN ANSWER ON ITS OWN — it must be the directory object for
      // the user we asked about. A body that is not JSON, carries no `id`, or
      // carries a different one, means we measured NOTHING.
      const body = await readJsonBody(res);
      const returnedId = body !== NOT_JSON && typeof body?.id === 'string' ? body.id : '';
      if (returnedId && returnedId.toLowerCase() === userId.toLowerCase()) return 'member';
      console.warn(
        '[graph-membership] UNKNOWN (not a measured negative): transitiveMembers point-read at ' +
          `${logSafe(graphBase(), 120)} answered HTTP ${Number(res.status)} with a body that does ` +
          `not identify the requested principal (${body === NOT_JSON ? 'body was not JSON' : returnedId ? 'a DIFFERENT id was returned' : 'no `id` field'}) — ` +
          'something in front of Graph may be answering instead of Graph',
      );
      // FALL THROUGH to the paged enumeration rather than answering here. An
      // ambiguous 2xx is not only the proxy/WAF case: a 204, or a `$select`
      // quirk that returns the object without `id`, is a GENUINE member, and
      // returning `unknown` immediately would deny them. The walk below settles
      // it — and for the WAF case it answers `unknown` too (that responder
      // returns the same non-JSON body to the enumeration), so the property this
      // check exists for is preserved either way.
    } else if (res.status === 404) {
      return 'not-member';
    } else if (res.status === 429) {
      // #3834 §3 — A THROTTLE IS A NON-ANSWER, AND FALLING THROUGH MADE IT
      // WORSE. Every non-404 used to drop into the paged enumeration, which
      // throttles too: measured `graphCalls=2` for one throttled probe, so these
      // routes AMPLIFIED a throttle instead of backing off, and no `Retry-After`
      // was honoured anywhere. Graph's `Retry-After` is the directory saying how
      // long it will keep answering this way, so a second ask inside the same
      // request cannot help. Answer `unknown` — it contributes no role — and put
      // the interval in the log so the back-off is diagnosable rather than
      // invisible. 429 ONLY: a 403/405 is the case the fallback exists for (the
      // point-read by id not permitted on the resource type), and aborting on
      // those would deny genuine members.
      const retryAfter = res.headers?.get?.('retry-after') ?? null;
      console.warn(
        '[graph-membership] UNKNOWN (not a measured negative): transitiveMembers point-read at ' +
          `${logSafe(graphBase(), 120)} was THROTTLED (HTTP 429` +
          `${retryAfter ? `, Retry-After: ${logSafe(String(retryAfter), 32)}` : ', no Retry-After header'})` +
          ' — NOT falling through to the paged enumeration, which would be throttled too',
      );
      return 'unknown';
    }
    // On 4xx/5xx other than 404 and 429, and on an ambiguous 2xx, fall back to
    // paged enumeration once.
  } catch (e: unknown) {
    // COULD NOT ASK — transport failure. Naming the host makes a
    // wrong-national-cloud call (the #3381 defect) diagnosable from one log
    // line instead of looking like an ordinary negative. The thrown error can
    // carry the request URL (and therefore a request-derived group id), so it
    // goes through logSafeError rather than into the template raw.
    console.warn(
      `[graph-membership] UNKNOWN (not a measured negative): transitiveMembers request to ${logSafe(graphBase(), 120)} failed — ${logSafeError(e)}`,
    );
    return 'unknown';
  }
  // Fallback: enumerate transitive members (covers tenants where the direct
  // membership-by-id check is not permitted on the resource type).
  //
  // BOUNDED by a PagingBudget (#2557/#2582): the old `guard < 50` capped pages
  // only, and 50 Graph pages x the 30s per-request ceiling is 25 minutes of
  // unbounded await on the authorization path. `runPage` hands each page the
  // walk's remaining wall clock and absorbs the resulting abort. When a
  // walk-wide budget is in play the enumeration takes the SMALLER of the two
  // ceilings, so the fallback for one group cannot spend the whole group walk's
  // clock (#3834 §3).
  //
  // TRUNCATION IS DELIBERATELY FAIL-CLOSED HERE, and that is the one place the
  // "truncate, keep the rows" reflex must not become "assume the answer". This
  // is an AUTHORIZATION check: returning true on a partial list would grant a
  // role from a membership we never actually saw. So a truncated walk answers
  // `unknown` — which `userIsTransitiveGroupMember` collapses to `false`,
  // exactly the previous behaviour — and `warnIfTruncated` logs the honest
  // cause so the deadline is diagnosable as a deadline, not read as "not a
  // member". The tri-state is what makes those two sayably different (#3381).
  const budget = new PagingBudget(
    `graph transitiveMembers ${groupId}`,
    walk ? { budgetMs: Math.min(defaultPagingBudgetMs(), walk.remainingMs()) } : {},
  );
  let next: string =
    `${graphBase()}/groups/${groupId}/transitiveMembers?$select=id&$top=999&$count=true`;
  let scanned = 0;
  // #3834 §2 residual — A TRANSPORT FAILURE HERE USED TO ESCAPE THE FUNCTION.
  // The point-read above has had a catch since #3381; this loop sat OUTSIDE it,
  // and `PagingBudget.runPage` rethrows everything that is not its own deadline
  // (`paging-budget.ts` 233-241). So an ECONNRESET / DNS failure / non-our-own
  // timeout on the FALLBACK propagated past `resolveEffectiveRole`, past
  // `resolveWorkspaceAccessByOid`, and out of `authorizeWorkspace` as an
  // uncaught throw into 99 route entry points. It denied by crashing, which is
  // safe-ish, but it is an opaque 500 rather than the membership answer this
  // function's contract promises — and `deploy-integrity.md` R6 wants a
  // classified outcome, not a stack trace. Same tri-state answer as every other
  // could-not-ask: `unknown`.
  try {
    while (budget.claimPage()) {
      const res = await budget.runPage((timeoutMs) => fetchWithTimeout(next, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ConsistencyLevel: 'eventual' },
        cache: 'no-store',
      }, timeoutMs));
      if (res === PAGE_DEADLINE) break; // wall clock spent mid-fetch
      if (!res.ok) {
        // Graph answered, but not with an enumeration — we measured NOTHING.
        console.warn(
          `[graph-membership] UNKNOWN (not a measured negative): transitiveMembers enumeration at ${logSafe(graphBase(), 120)} returned HTTP ${Number(res.status)}`,
        );
        return 'unknown';
      }
      const json: any = await readJsonBody(res);
      // #3834 — A MALFORMED PAGE IS A NON-ANSWER, NOT AN EXCEPTION. `res.json()`
      // used to be awaited raw here, so a 200 carrying HTML threw a `SyntaxError`
      // out of this function; and `json?.value` was iterated with `for…of`, so a
      // body whose `value` is not an array threw a `TypeError`. Both escaped past
      // every caller as a 500 rather than resolving the membership question, and
      // both are the SAME proxy / WAF / captive-portal condition as the point-read
      // above. Answer `unknown` — it contributes no role and it is sayable.
      const page = json !== NOT_JSON && Array.isArray(json?.value) ? (json.value as any[]) : null;
      if (page === null) {
        console.warn(
          '[graph-membership] UNKNOWN (not a measured negative): transitiveMembers enumeration at ' +
            `${logSafe(graphBase(), 120)} answered HTTP ${Number(res.status)} with ` +
            `${json === NOT_JSON ? 'a body that is not JSON' : 'no `value` array'} — ` +
            'something in front of Graph may be answering instead of Graph',
        );
        return 'unknown';
      }
      for (const m of page) {
        scanned += 1;
        if (typeof m?.id === 'string' && m.id.toLowerCase() === userId.toLowerCase()) return 'member';
      }
      if (!json?.['@odata.nextLink']) {
        // Finished cleanly with no match — this IS a measured negative.
        return 'not-member';
      }
      next = json['@odata.nextLink'];
    }
  } catch (e: unknown) {
    console.warn(
      `[graph-membership] UNKNOWN (not a measured negative): transitiveMembers enumeration at ${logSafe(graphBase(), 120)} failed — ${logSafeError(e)}`,
    );
    return 'unknown';
  }
  // Loop exited without finishing: either the page budget ran out or the wall
  // clock did. Either way we never saw the whole closure, so this is UNKNOWN.
  budget.warnIfTruncated(scanned);
  return budget.truncatedBy ? 'unknown' : 'not-member';
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
