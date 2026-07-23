/**
 * workspace-grants — I2 (loom-next-level): the FULL per-backend scoped-grant
 * matrix for a workspace's managed identity (uami-ws-<workspaceId>).
 *
 * Phase A (shadow): these grants are provisioned but UNUSED — every call still
 * runs as the shared Console UAMI. They are the safety net that makes the I3
 * "would the workspace UAMI have had access?" check answerable from REAL RBAC,
 * and the thing the I6 enforce flip switches onto.
 *
 * Design (per the PRP's I2/I8 scale analysis):
 *  - ARM RBAC is used ONLY where the backend has no data-plane grant model
 *    (ADLS container, Event Hubs, Monitor, KV) — each costs one of the 4,000
 *    role assignments per subscription.
 *  - Data-plane grants are PREFERRED (Synapse external users, ADX database
 *    principals, Cosmos data-plane SQL role assignments) — they do NOT count
 *    against the 4,000-assignment ARM cap.
 *  - Every ARM write rides workspace-identity-client's serialized throttle
 *    queue (UAMI 2-req/s/sub creation throttle + the ~200-token ARM write
 *    bucket — Learn: request-limits-and-throttling), sharing ONE budget with
 *    the UAMI PUTs.
 *  - Idempotency: deterministic guid() assignment names (bicep contract) +
 *    409/`already exists` tolerated + `IF NOT EXISTS` T-SQL + ADX `.add` — a
 *    re-run records 'exists'/'granted' and never errors.
 *  - NEVER throws: every outcome (granted | exists | failed | skipped) is
 *    recorded per grant on the workspace doc (workspaceIdentity.grants).
 *
 * Runbook (per-backend grant + verify commands, scale ceilings):
 *   docs/fiab/runbooks/workspace-identity-grants.md
 * Bulk/IaC sibling: platform/fiab/bicep/modules/landing-zone/
 *   workspace-identity-grants.bicep (ARM-RBAC + Cosmos rows only; Synapse/ADX
 *   stay data-plane scripts per the runbook).
 */

import { armBase } from '@/lib/azure/cloud-endpoints';
import { discoverResourceCoordsByName } from '@/lib/azure/resource-graph-coords';
import {
  roleAssignmentGuid,
  workspaceIdentityArmConfig,
  workspaceIdentityArmRead,
  workspaceIdentityArmWrite,
  workspaceUamiName,
  type WorkspaceUami,
} from '@/lib/azure/workspace-identity-client';
import type { WorkspaceGrantStatus } from '@/lib/types/workspace';

// Stable GA api-versions.
const RA_API = '2022-04-01';
const COSMOS_RBAC_API = '2024-05-15';

// ── Built-in role GUIDs (cloud-invariant, all sovereign boundaries) ─────────
/** Storage Blob Data Contributor — the SAME role workspace-identity.bicep
 * grants, and the ONLY role family the Console UAMI's constrained
 * RBAC-Administrator (storage-rbac-admin.bicep ABAC condition) may delegate. */
export const STORAGE_BLOB_DATA_CONTRIBUTOR = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
/** Azure Event Hubs Data Receiver. */
export const EVENTHUBS_DATA_RECEIVER = 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde';
/** Azure Event Hubs Data Sender. */
export const EVENTHUBS_DATA_SENDER = '2b629674-e913-4c01-ae53-ef4638d8f975';
/** Monitoring Contributor (activator scheduled-query rules). */
export const MONITORING_CONTRIBUTOR = '749f88d5-cbae-40b8-bcfc-e573ddc772fa';
/** Key Vault Secrets User. */
export const KEY_VAULT_SECRETS_USER = '4633458b-17de-408a-b874-0445c86b69e6';
/** Cosmos DB Built-in Data Contributor — a DATA-PLANE role (sqlRoleAssignments),
 * NOT an ARM role assignment; does not count against the 4,000-assignment cap. */
export const COSMOS_DATA_CONTRIBUTOR = '00000000-0000-0000-0000-000000000002';

export type WorkspaceGrantKind = 'arm-rbac' | 'cosmos-data-rbac' | 'sql-data-plane' | 'kusto-data-plane';

/** Scope resolution per backend: a concrete scope, a named missing env var
 * (recorded as a failed grant — the backend IS configured but the grant scope
 * can't be built), or an honest not-applicable (recorded as skipped). */
export type WorkspaceGrantScope =
  | { scope: string }
  | { missing: string }
  | { notApplicable: string };

export interface WorkspaceGrantSpec {
  /** Stable backend key (surfaces on workspaceIdentity.grants + the I4 UI). */
  backend: string;
  kind: WorkspaceGrantKind;
  /** Built-in role GUID (ARM / Cosmos data-plane) or the symbolic data-plane
   * role set (Synapse / ADX). */
  roleDefinitionId: string;
  /** Tightest scope Azure allows, resolved from the deployment config. */
  resolveScope(ws: WorkspaceRef): WorkspaceGrantScope | Promise<WorkspaceGrantScope>;
}

export interface WorkspaceRef {
  id: string;
  storageAccountId?: string;
}

type GrantPrincipal = Pick<WorkspaceUami, 'principalId'> & Partial<Pick<WorkspaceUami, 'clientId' | 'name'>>;

/** Workspace ids embed into T-SQL / KQL principal names — enforce the shape
 * (UUID-ish) before any data-plane script interpolation. */
function safeWorkspaceId(id: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/.test(id) ? id : null;
}

function tenantId(): string {
  return process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || '';
}

// ── Scope resolvers ─────────────────────────────────────────────────────────

/**
 * ADLS lake scope for Storage Blob Data Contributor — tightest resolvable,
 * mirroring workspace-identity.bicep (ONE lake container):
 *   1. explicit per-workspace storage binding (ws.storageAccountId) → account;
 *   2. LOOM_BRONZE_URL / LOOM_LANDING_URL (https://<acct>.dfs…/<container>)
 *      → container scope on the DLZ lake account;
 *   3. LOOM_ADLS_ACCOUNT → account scope.
 */
export function workspaceLakeGrantScope(ws: { storageAccountId?: string }): { scope: string } | { missing: string } {
  if (ws.storageAccountId) return { scope: ws.storageAccountId };
  const { subscriptionId, resourceGroup } = workspaceIdentityArmConfig();
  const lakeUrl = process.env.LOOM_BRONZE_URL || process.env.LOOM_LANDING_URL || '';
  const m = lakeUrl.match(/^https:\/\/([^./]+)\.dfs\.[^/]+\/([^/?#]+)/i);
  const accountId = (name: string) =>
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${name}`;
  if (m) return { scope: `${accountId(m[1])}/blobServices/default/containers/${m[2]}` };
  const account = process.env.LOOM_ADLS_ACCOUNT || '';
  if (account) return { scope: accountId(account) };
  return { missing: 'LOOM_BRONZE_URL (or LOOM_LANDING_URL / LOOM_ADLS_ACCOUNT)' };
}

/** Event Hubs namespace ARM id from the eventhubs-client env family. Namespace
 * scope is the day-one resolvable scope (per-workspace hubs don't exist at
 * workspace create); the eventstream provisioner tightens to entity scope when
 * a workspace hub is born — runbook §event-hubs. */
function eventHubsNamespaceScope(): WorkspaceGrantScope {
  const namespace = process.env.LOOM_EVENTHUB_NAMESPACE || '';
  if (!namespace) return { notApplicable: 'Event Hubs is not configured in this deployment (LOOM_EVENTHUB_NAMESPACE unset).' };
  const subscriptionId = process.env.LOOM_EVENTHUB_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_EVENTHUB_RG || process.env.LOOM_DLZ_RG || '';
  if (!subscriptionId) return { missing: 'LOOM_EVENTHUB_SUB (or LOOM_SUBSCRIPTION_ID)' };
  if (!resourceGroup) return { missing: 'LOOM_EVENTHUB_RG (or LOOM_DLZ_RG)' };
  return { scope: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.EventHub/namespaces/${namespace}` };
}

/** Cosmos account ARM id — account name parsed from LOOM_COSMOS_ENDPOINT, real
 * coordinates self-healed via Azure Resource Graph (the PR #1445 pattern), so
 * no new env var is needed (I2: grants derive from already-registered vars). */
async function cosmosAccountScope(): Promise<WorkspaceGrantScope> {
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT || '';
  if (!endpoint) return { notApplicable: 'Cosmos DB is not configured in this deployment (LOOM_COSMOS_ENDPOINT unset).' };
  const m = endpoint.match(/^https:\/\/([^./]+)\./i);
  if (!m) return { missing: 'LOOM_COSMOS_ENDPOINT (unparseable account name)' };
  const coords = await discoverResourceCoordsByName({ resourceType: 'Microsoft.DocumentDB/databaseAccounts', name: m[1] });
  if (!coords) return { missing: `LOOM_COSMOS_ENDPOINT (Resource Graph could not locate account '${m[1]}' — grant the Console UAMI Reader on its subscription)` };
  return { scope: `/subscriptions/${coords.subscriptionId}/resourceGroups/${coords.resourceGroup}/providers/Microsoft.DocumentDB/databaseAccounts/${m[1]}` };
}

/** Synapse dedicated pool (warehouse backend) — data-plane T-SQL scope. */
function synapseSqlScope(): WorkspaceGrantScope {
  const ws = process.env.LOOM_SYNAPSE_WORKSPACE || '';
  const pool = process.env.LOOM_SYNAPSE_DEDICATED_POOL || '';
  if (!ws || !pool) {
    return { notApplicable: 'Synapse dedicated SQL (warehouse backend) is not configured (LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL unset).' };
  }
  return { scope: `synapse-dedicated:${ws}/${pool}` };
}

/** ADX default database — data-plane Kusto principal scope. */
function adxDatabaseScope(): WorkspaceGrantScope {
  const cluster = process.env.LOOM_KUSTO_CLUSTER_URI || '';
  if (!cluster) return { notApplicable: 'ADX / Eventhouse is not configured in this deployment (LOOM_KUSTO_CLUSTER_URI unset).' };
  const db = process.env.LOOM_KUSTO_DEFAULT_DB || 'loomdb-default';
  return { scope: `kusto:${cluster.replace(/\/+$/, '')}/${db}` };
}

/**
 * The declarative I2 grant matrix (PRP ws-identity-cloudmatrix §I2). Order is
 * the order grants are attempted AND the order statuses surface on the doc.
 * KV + Monitor are declared-but-not-applicable at workspace create by design:
 *  - key-vault: there is NO per-workspace Key Vault scope today; the shared
 *    platform vault holds platform secrets (MSAL client secret et al.) and is
 *    deliberately NEVER granted to workspace identities.
 *  - monitor: Monitoring Contributor is granted only when the workspace first
 *    owns an activator (scheduled-query alert) rule — runbook §monitor.
 */
export const WORKSPACE_GRANTS: WorkspaceGrantSpec[] = [
  { backend: 'adls-lake', kind: 'arm-rbac', roleDefinitionId: STORAGE_BLOB_DATA_CONTRIBUTOR, resolveScope: (ws) => workspaceLakeGrantScope(ws) },
  { backend: 'cosmos-data', kind: 'cosmos-data-rbac', roleDefinitionId: COSMOS_DATA_CONTRIBUTOR, resolveScope: () => cosmosAccountScope() },
  { backend: 'synapse-sql', kind: 'sql-data-plane', roleDefinitionId: 'db_datareader+db_datawriter', resolveScope: () => synapseSqlScope() },
  { backend: 'adx-database', kind: 'kusto-data-plane', roleDefinitionId: 'database-user', resolveScope: () => adxDatabaseScope() },
  { backend: 'eventhubs-receiver', kind: 'arm-rbac', roleDefinitionId: EVENTHUBS_DATA_RECEIVER, resolveScope: () => eventHubsNamespaceScope() },
  { backend: 'eventhubs-sender', kind: 'arm-rbac', roleDefinitionId: EVENTHUBS_DATA_SENDER, resolveScope: () => eventHubsNamespaceScope() },
  {
    backend: 'key-vault', kind: 'arm-rbac', roleDefinitionId: KEY_VAULT_SECRETS_USER,
    resolveScope: () => ({ notApplicable: 'No per-workspace Key Vault scope is bound; the shared platform vault is deliberately NOT granted to workspace identities (it holds platform secrets).' }),
  },
  {
    backend: 'monitor', kind: 'arm-rbac', roleDefinitionId: MONITORING_CONTRIBUTOR,
    resolveScope: () => ({ notApplicable: 'Granted when the workspace first owns an Azure Monitor activator rule (runbook §monitor) — not at workspace create.' }),
  },
];

// ── Grant executors (idempotent, never throw) ───────────────────────────────

async function putArmRoleAssignment(
  spec: WorkspaceGrantSpec, scope: string, principalId: string,
): Promise<WorkspaceGrantStatus> {
  const { backend, roleDefinitionId } = spec;
  const { subscriptionId } = workspaceIdentityArmConfig();
  const name = roleAssignmentGuid(scope, principalId, roleDefinitionId);
  const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments/${name}?api-version=${RA_API}`;
  const r = await workspaceIdentityArmWrite(url, {
    method: 'PUT',
    body: JSON.stringify({
      properties: {
        roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`,
        principalId,
        principalType: 'ServicePrincipal',
      },
    }),
  });
  if (r.ok) return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'granted' };
  const body = await r.text();
  if (r.status === 409 && /RoleAssignmentExists|already exists/i.test(body)) {
    return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'exists' };
  }
  return {
    backend, kind: spec.kind, roleDefinitionId, scope, status: 'failed',
    error: `ARM ${r.status}: ${body.slice(0, 300)}${r.status === 403 && backend === 'adls-lake'
      ? ' (the Console UAMI needs the constrained RBAC-Administrator grant from landing-zone/storage-rbac-admin.bicep on the lake account)'
      : ''}`,
  };
}

/** Cosmos DATA-PLANE SQL role assignment (account scope — Cosmos data-plane
 * RBAC has no container scope; partition isolation is logical, enforced in
 * query). Deterministic name → idempotent PUT; not an ARM role assignment, so
 * it does NOT count against the 4,000-assignment subscription cap. */
async function putCosmosDataRoleAssignment(
  spec: WorkspaceGrantSpec, accountId: string, principalId: string,
): Promise<WorkspaceGrantStatus> {
  const { backend, roleDefinitionId } = spec;
  const name = roleAssignmentGuid(accountId, principalId, roleDefinitionId);
  const url = `${armBase()}${accountId}/sqlRoleAssignments/${name}?api-version=${COSMOS_RBAC_API}`;
  const r = await workspaceIdentityArmWrite(url, {
    method: 'PUT',
    body: JSON.stringify({
      properties: {
        roleDefinitionId: `${accountId}/sqlRoleDefinitions/${roleDefinitionId}`,
        principalId,
        scope: accountId,
      },
    }),
  });
  // 200/201 sync, 202 async-accepted — all mean the assignment is in place(ing).
  if (r.ok || r.status === 202) return { backend, kind: spec.kind, roleDefinitionId, scope: accountId, status: 'granted' };
  const body = await r.text();
  if ((r.status === 409 || r.status === 400) && /already exists|conflict/i.test(body)) {
    return { backend, kind: spec.kind, roleDefinitionId, scope: accountId, status: 'exists' };
  }
  return { backend, kind: spec.kind, roleDefinitionId, scope: accountId, status: 'failed', error: `ARM ${r.status}: ${body.slice(0, 300)}` };
}

/** Synapse dedicated-pool data-plane grant: CREATE USER … FROM EXTERNAL
 * PROVIDER + db_datareader/db_datawriter, executed BY the Console UAMI
 * (Synapse SQL admin). Fully idempotent T-SQL (IF NOT EXISTS / IS_ROLEMEMBER
 * guards) → a re-run reports 'exists'. Counts against NO RBAC cap. */
async function applySynapseSqlGrant(
  spec: WorkspaceGrantSpec, scope: string, wsId: string,
): Promise<WorkspaceGrantStatus> {
  const { backend, roleDefinitionId } = spec;
  const id = safeWorkspaceId(wsId);
  if (!id) return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'failed', error: `Workspace id '${wsId}' fails the principal-name safety shape.` };
  const [{ executeQuery, dedicatedTarget }, { bracket, escapeSqlLiteral }] = await Promise.all([
    import('@/lib/azure/synapse-sql-client'),
    import('@/lib/sql/quoting'),
  ]);
  const user = workspaceUamiName(id);
  const ident = bracket(user);
  const lit = `N'${escapeSqlLiteral(user)}'`;
  const sql = [
    `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${lit})`,
    `  CREATE USER ${ident} FROM EXTERNAL PROVIDER;`,
    `IF IS_ROLEMEMBER(N'db_datareader', ${lit}) = 0 ALTER ROLE db_datareader ADD MEMBER ${ident};`,
    `IF IS_ROLEMEMBER(N'db_datawriter', ${lit}) = 0 ALTER ROLE db_datawriter ADD MEMBER ${ident};`,
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${lit}) THEN 1 ELSE 0 END AS created;`,
  ].join('\n');
  try {
    await executeQuery(dedicatedTarget(), sql, 60_000);
    return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'granted', detail: `external user ${user} in db_datareader + db_datawriter` };
  } catch (e: any) {
    return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'failed', error: e?.message || String(e) };
  }
}

/** ADX database data-plane grant: `.add database … users ('aadapp=<clientId>;
 * <tenant>')` via the Kusto mgmt endpoint (Console UAMI = cluster admin).
 * `.add` is additive — re-adding an existing principal is a no-op success. */
async function applyAdxGrant(
  spec: WorkspaceGrantSpec, scope: string, wsId: string, clientId: string | undefined,
): Promise<WorkspaceGrantStatus> {
  const { backend, roleDefinitionId } = spec;
  const id = safeWorkspaceId(wsId);
  if (!id) return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'failed', error: `Workspace id '${wsId}' fails the principal-name safety shape.` };
  if (!clientId || !/^[0-9a-fA-F-]{36}$/.test(clientId)) {
    return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'failed', error: 'The workspace UAMI clientId is unknown — cannot add the aadapp database principal.' };
  }
  const tid = tenantId();
  if (!tid) return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'failed', error: 'LOOM_TENANT_ID (or AZURE_TENANT_ID) is not set — the ADX aadapp principal needs the tenant.' };
  try {
    const { executeMgmtCommand, defaultDatabase } = await import('@/lib/azure/kusto-client');
    const db = defaultDatabase();
    const cmd = `.add database ['${db.replace(/[[\]'"\\]/g, '')}'] users ('aadapp=${clientId};${tid}') '${workspaceUamiName(id)}'`;
    await executeMgmtCommand(db, cmd);
    return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'granted', detail: `aadapp=${clientId} added as database user` };
  } catch (e: any) {
    return { backend, kind: spec.kind, roleDefinitionId, scope, status: 'failed', error: e?.message || String(e) };
  }
}

/**
 * I2 — idempotently apply the FULL per-backend grant matrix for a workspace
 * UAMI. Every backend present in the deployment gets its tightest-scope grant;
 * unconfigured / not-applicable backends record an honest 'skipped'. NEVER
 * throws — the caller (applyWorkspaceIdentity) persists the statuses verbatim
 * onto the workspace doc.
 */
export async function ensureWorkspaceGrants(
  ws: WorkspaceRef,
  uami: GrantPrincipal,
): Promise<WorkspaceGrantStatus[]> {
  const out: WorkspaceGrantStatus[] = [];
  for (const spec of WORKSPACE_GRANTS) {
    const { backend, roleDefinitionId } = spec;
    try {
      const resolved = await spec.resolveScope(ws);
      if ('notApplicable' in resolved) {
        out.push({ backend, kind: spec.kind, roleDefinitionId, scope: '', status: 'skipped', detail: resolved.notApplicable });
        continue;
      }
      if ('missing' in resolved) {
        out.push({ backend, kind: spec.kind, roleDefinitionId, scope: '', status: 'failed', error: `Cannot resolve the ${backend} grant scope — set ${resolved.missing}.` });
        continue;
      }
      const { scope } = resolved;
      if (spec.kind === 'arm-rbac') out.push(await putArmRoleAssignment(spec, scope, uami.principalId));
      else if (spec.kind === 'cosmos-data-rbac') out.push(await putCosmosDataRoleAssignment(spec, scope, uami.principalId));
      else if (spec.kind === 'sql-data-plane') out.push(await applySynapseSqlGrant(spec, scope, ws.id));
      else out.push(await applyAdxGrant(spec, scope, ws.id, uami.clientId));
    } catch (e: any) {
      out.push({ backend, kind: spec.kind, roleDefinitionId, scope: '', status: 'failed', error: e?.message || String(e) });
    }
  }
  return out;
}

// ── I3 hook — "would the workspace UAMI have had access?" (real, cached) ────

export interface WorkspaceGrantEvaluation {
  backend: string;
  /** true = the workspace UAMI holds the grant; false = it would be DENIED;
   * null = not applicable / unresolvable (recorded, never divergence-counted). */
  wouldAllow: boolean | null;
  reason: string;
  source: 'arm' | 'cosmos' | 'sql' | 'kusto' | 'not-applicable' | 'error';
  checkedAt: string;
}

// Per-process evaluation cache — the I3 shadow path must NOT do an ARM/SQL
// probe per data-plane call. Keyed strictly `${workspaceId}:${backend}`.
const EVAL_CACHE_TTL_MS = 5 * 60_000;
const evalCache = new Map<string, { at: number; value: WorkspaceGrantEvaluation }>();

/** Test-only: clear the evaluation cache. */
export function __clearWorkspaceGrantEvalCache(): void {
  evalCache.clear();
}

async function evaluateArmGrant(spec: WorkspaceGrantSpec, scope: string, principalId: string): Promise<{ wouldAllow: boolean; reason: string }> {
  const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=${RA_API}&$filter=principalId eq '${principalId}'`;
  const r = await workspaceIdentityArmRead(url);
  if (!r.ok) throw new Error(`ARM role-assignment list ${r.status}`);
  const rows: Array<{ properties?: { roleDefinitionId?: string; scope?: string } }> = (await r.json())?.value ?? [];
  const hit = rows.some((row) => {
    const rd = (row.properties?.roleDefinitionId || '').toLowerCase();
    const s = (row.properties?.scope || '').toLowerCase();
    return rd.endsWith(spec.roleDefinitionId) && (scope.toLowerCase().startsWith(s) || s === scope.toLowerCase());
  });
  return { wouldAllow: hit, reason: hit ? `role ${spec.roleDefinitionId} assigned at/above ${scope}` : `no ${spec.roleDefinitionId} assignment covering ${scope}` };
}

async function evaluateCosmosGrant(spec: WorkspaceGrantSpec, accountId: string, principalId: string): Promise<{ wouldAllow: boolean; reason: string }> {
  const r = await workspaceIdentityArmRead(`${armBase()}${accountId}/sqlRoleAssignments?api-version=${COSMOS_RBAC_API}`);
  if (!r.ok) throw new Error(`Cosmos sqlRoleAssignments list ${r.status}`);
  const rows: Array<{ properties?: { principalId?: string; roleDefinitionId?: string } }> = (await r.json())?.value ?? [];
  const hit = rows.some((row) => row.properties?.principalId === principalId && (row.properties?.roleDefinitionId || '').endsWith(spec.roleDefinitionId));
  return { wouldAllow: hit, reason: hit ? 'Cosmos data-plane role assignment present' : 'no Cosmos data-plane role assignment for the workspace principal' };
}

async function evaluateSynapseGrant(wsId: string): Promise<{ wouldAllow: boolean; reason: string }> {
  const [{ executeQuery, dedicatedTarget }, { escapeSqlLiteral }] = await Promise.all([
    import('@/lib/azure/synapse-sql-client'),
    import('@/lib/sql/quoting'),
  ]);
  const lit = `N'${escapeSqlLiteral(workspaceUamiName(wsId))}'`;
  const res = await executeQuery(
    dedicatedTarget(),
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${lit}) AND IS_ROLEMEMBER(N'db_datareader', ${lit}) = 1 THEN 1 ELSE 0 END AS ok;`,
    30_000,
  );
  const ok = String((res as any)?.rows?.[0]?.[0] ?? (res as any)?.rows?.[0]?.ok ?? '') === '1';
  return { wouldAllow: ok, reason: ok ? 'external user exists with db_datareader' : 'external user missing or not in db_datareader' };
}

async function evaluateAdxGrant(clientId: string | undefined): Promise<{ wouldAllow: boolean; reason: string }> {
  if (!clientId) return { wouldAllow: false, reason: 'workspace UAMI clientId unknown' };
  const { executeMgmtCommand, defaultDatabase } = await import('@/lib/azure/kusto-client');
  const db = defaultDatabase();
  const res = await executeMgmtCommand(db, `.show database ['${db.replace(/[[\]'"\\]/g, '')}'] principals`);
  const rows: unknown[][] = (res as any)?.rows ?? [];
  const hit = rows.some((row) => row.some((cell) => typeof cell === 'string' && cell.toLowerCase().includes(clientId.toLowerCase())));
  return { wouldAllow: hit, reason: hit ? 'aadapp principal present on the database' : 'aadapp principal absent from the database' };
}

/**
 * I3's real "would it have had access?" resolver: verifies the I2 grant
 * against the LIVE backend (ARM role-assignment list / Cosmos sqlRoleAssignments
 * / sys.database_principals / .show database principals), cached per
 * (workspaceId, backend) for 5 minutes so the shadow path stays cheap.
 * NEVER throws — errors resolve to wouldAllow:null with source:'error'.
 */
export async function evaluateWorkspaceGrant(
  ws: WorkspaceRef,
  uami: GrantPrincipal,
  backend: string,
): Promise<WorkspaceGrantEvaluation> {
  const key = `${ws.id}:${backend}`;
  const hit = evalCache.get(key);
  if (hit && Date.now() - hit.at < EVAL_CACHE_TTL_MS) return hit.value;

  const checkedAt = new Date().toISOString();
  const spec = WORKSPACE_GRANTS.find((s) => s.backend === backend);
  let value: WorkspaceGrantEvaluation;
  if (!spec) {
    value = { backend, wouldAllow: null, reason: `unknown backend '${backend}'`, source: 'not-applicable', checkedAt };
  } else {
    try {
      const resolved = await spec.resolveScope(ws);
      if ('notApplicable' in resolved) {
        value = { backend, wouldAllow: null, reason: resolved.notApplicable, source: 'not-applicable', checkedAt };
      } else if ('missing' in resolved) {
        value = { backend, wouldAllow: null, reason: `scope unresolvable — set ${resolved.missing}`, source: 'not-applicable', checkedAt };
      } else if (spec.kind === 'arm-rbac') {
        value = { backend, ...await evaluateArmGrant(spec, resolved.scope, uami.principalId), source: 'arm', checkedAt };
      } else if (spec.kind === 'cosmos-data-rbac') {
        value = { backend, ...await evaluateCosmosGrant(spec, resolved.scope, uami.principalId), source: 'cosmos', checkedAt };
      } else if (spec.kind === 'sql-data-plane') {
        value = { backend, ...await evaluateSynapseGrant(ws.id), source: 'sql', checkedAt };
      } else {
        value = { backend, ...await evaluateAdxGrant(uami.clientId), source: 'kusto', checkedAt };
      }
    } catch (e: any) {
      value = { backend, wouldAllow: null, reason: e?.message || String(e), source: 'error', checkedAt };
    }
  }
  evalCache.set(key, { at: Date.now(), value });
  return value;
}
