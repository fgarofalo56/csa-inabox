/**
 * azure-connections-client (F16) — workspace-scoped ADLS Gen2 + Log Analytics
 * connection bindings.
 *
 * WHAT THIS IS
 * ------------
 * A workspace owner connects two Azure resources to a Loom workspace:
 *
 *   1. an ADLS Gen2 storage account → DATAFLOW STAGING. Once connected, the
 *      Dataflow Gen2 ADF run path writes its staged Parquet output to this
 *      account (see dataflow-run.ts), instead of only the global DLZ lake.
 *
 *   2. a Log Analytics workspace → QUERY-LOG EXPORT. Once connected, the
 *      workspace's query/run logs are queryable + exportable to this LAW (the
 *      Monitor surface and diagnostic-settings sweep target it).
 *
 * Both bindings are stored in the Cosmos `azure-connections` container
 * (PK /workspaceId) so every per-workspace connection list hits a single
 * physical partition. This is DISTINCT from the tenant-scoped `connections`
 * container (generic Key-Vault-backed data-source connections).
 *
 * REAL BACKENDS ONLY (per no-vaporware.md):
 *   - Resource discovery     → ARM Storage + OperationalInsights list REST.
 *   - Role verification       → ARM Authorization roleAssignments list, checking
 *                               the Console UAMI for the *Contributor* role the
 *                               binding actually requires.
 *   - ADLS connectivity probe → DataLakeFileSystemClient.exists()/create() of
 *                               the staging container.
 *   - LAW connectivity probe  → POST .../query (`print`) on the data plane.
 *
 * HONEST GATE (per no-vaporware.md + no-fabric-dependency.md): when the UAMI is
 * missing the required role the connection is still SAVED with status
 * 'role-missing' and a `roleGate` payload naming the exact role + the bicep
 * remediation, so the UI renders a Fluent MessageBar with a Retry. No Microsoft
 * Fabric / OneLake / Power BI is involved — both bindings are 100% Azure-native.
 *
 * Sovereign-cloud correctness comes entirely from cloud-endpoints.ts
 * (armBase / dfsUrl / getLogAnalyticsHost) — no hard-coded hosts here.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope, stripArmBase, getLogAnalyticsHost, dfsUrl } from '@/lib/azure/cloud-endpoints';
import { getServiceClientFor } from '@/lib/azure/adls-client';
import { listStorageAccounts, type StorageAccountSummary } from '@/lib/azure/storage-discovery';
import { azureConnectionsContainer } from '@/lib/azure/cosmos-client';

// ---------------------------------------------------------------------------
// Built-in role GUIDs (global across every Azure cloud).
// ---------------------------------------------------------------------------

/** Storage Blob Data Contributor — write Delta/Parquet staging to ADLS Gen2. */
export const STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
/** Log Analytics Contributor — configure data collection / export on a LAW. */
export const LOG_ANALYTICS_CONTRIBUTOR_ROLE_ID = '92aaf0da-9dab-42b6-94a3-d43ce8d16293';

const ARM_SCOPE = armScope();
const ROLE_ASSIGNMENTS_API = '2022-04-01';
const LAW_API = '2023-09-01';

// ---------------------------------------------------------------------------
// Credential — Console UAMI (chained with DefaultAzureCredential for local dev),
// matching every other Loom ARM client.
// ---------------------------------------------------------------------------

// MI-FIRST (per #218/#222 hardening): ManagedIdentityCredential is ALWAYS the
// first link in the chain on the container path — even when LOOM_UAMI_CLIENT_ID
// / AZURE_CLIENT_ID is unset (it then targets the system-assigned identity).
// A bare DefaultAzureCredential is NEVER used here, because on a Container App
// its inner chain can collapse to dev-only credentials (Environment / AzureCLI /
// VSCode / PowerShell / azd) and skip Managed Identity entirely — which is the
// "ChainedTokenCredential authentication failed" the operator hit on the
// connections / Log Analytics probes.
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = new ChainedTokenCredential(
  new AcaManagedIdentityCredential(),
  new ManagedIdentityCredential(uamiClientId ? { clientId: uamiClientId } : {}),
  new DefaultAzureCredential(),
);

/**
 * True when an error is an azure-identity token-acquisition failure (the
 * ChainedTokenCredential / Aggregate / CredentialUnavailable family). Used to
 * replace the raw dev-credential chain dump with an actionable UAMI message.
 */
function isCredentialError(e: any): boolean {
  const blob = `${e?.name || ''} ${e?.message || String(e || '')}`;
  return /ChainedTokenCredential|AggregateAuthenticationError|CredentialUnavailable|ManagedIdentityCredential|DefaultAzureCredential|authentication failed|failed to (?:get|retrieve|acquire).*token/i.test(blob);
}

/** Operator-actionable message for a managed-identity token failure on <resource>. */
function credentialErrorMessage(resource: string): string {
  return `The Console managed identity could not get a token for ${resource} — confirm the Console User-Assigned Managed Identity is assigned to this Container App and LOOM_UAMI_CLIENT_ID is set (wired by platform/fiab/bicep/modules/admin-plane/main.bicep), then click Retry.`;
}

export type AzureConnectionKind = 'adls-gen2' | 'log-analytics';
export type AzureConnectionStatus = 'connected' | 'role-missing' | 'probe-failed';

export interface RoleGate {
  /** Friendly role name + GUID, e.g. "Storage Blob Data Contributor (ba92f5b4…)". */
  missing: string;
  /** Exact remediation: grant the role or deploy the bicep module. */
  hint: string;
}

export interface AzureConnection {
  id: string;
  workspaceId: string; // partition key
  tenantId: string;    // caller oid — ownership gate in routes
  kind: AzureConnectionKind;
  name: string;
  // ADLS Gen2 only
  storageAccountId?: string; // ARM resource id
  storageAccountName?: string;
  containerName?: string;    // staging container (default 'dataflow-staging')
  dfsEndpoint?: string;      // https://<acct>.dfs.core.<suffix>
  subscriptionId?: string;
  resourceGroup?: string;
  // Log Analytics only
  lawResourceId?: string;    // ARM resource id
  lawWorkspaceId?: string;   // customerId GUID
  lawName?: string;
  // Status
  status: AzureConnectionStatus;
  statusDetail?: string;
  roleGate?: RoleGate;
  connectedAt?: string;
  connectedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LawSummary {
  id: string;          // ARM resource id
  name: string;
  location?: string;
  customerId?: string; // workspace GUID
  resourceGroup?: string;
  subscriptionId: string;
  provisioningState?: string;
}

export interface RoleProbeResult {
  hasRole: boolean;
  roleId: string;
  roleName: string;
  principalId?: string; // the UAMI principal id used for the check
  hint?: string;        // filled when hasRole=false
}

export class AzureConnectionError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'AzureConnectionError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// ARM helpers
// ---------------------------------------------------------------------------

async function armToken(): Promise<string> {
  let t;
  try {
    t = await credential.getToken(ARM_SCOPE);
  } catch (e: any) {
    throw new AzureConnectionError(credentialErrorMessage('Azure Resource Manager'), 401);
  }
  if (!t?.token) throw new AzureConnectionError(credentialErrorMessage('Azure Resource Manager'), 401);
  return t.token;
}

async function armGet<T = any>(pathOrUrl: string): Promise<T> {
  const token = await armToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${armBase()}${pathOrUrl}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `ARM GET ${url} failed (${res.status})`;
    throw new AzureConnectionError(msg, res.status);
  }
  return (json as T) ?? ({} as T);
}

async function armList<T = any>(firstPath: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = firstPath;
  let guard = 0;
  while (next && guard < 50) {
    guard += 1;
    const page: { value?: T[]; nextLink?: string } = await armGet(stripArmBase(next));
    if (Array.isArray(page.value)) out.push(...page.value);
    next = page.nextLink || null;
  }
  return out;
}

function subscriptionIds(): string[] {
  const single = process.env.LOOM_SUBSCRIPTION_ID;
  if (single && single.trim()) return [single.trim()];
  return [];
}

/**
 * Resolve the Console UAMI principal (object) id for the role-assignment check.
 * Prefers the bicep-wired LOOM_UAMI_PRINCIPAL_ID; otherwise decodes the `oid`
 * claim from a freshly-acquired ARM token (a UAMI token's `oid` IS the managed
 * identity's principal id). Returns null only when neither is available.
 */
let _cachedPrincipalId: string | null | undefined;
export async function resolveUamiPrincipalId(): Promise<string | null> {
  if (_cachedPrincipalId !== undefined) return _cachedPrincipalId;
  const explicit = (process.env.LOOM_UAMI_PRINCIPAL_ID || '').trim();
  if (explicit) {
    _cachedPrincipalId = explicit;
    return explicit;
  }
  try {
    const token = await armToken();
    const payload = token.split('.')[1];
    if (payload) {
      const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
      const oid = json?.oid || json?.sub;
      if (typeof oid === 'string' && oid) {
        _cachedPrincipalId = oid;
        return oid;
      }
    }
  } catch {
    /* fall through */
  }
  _cachedPrincipalId = null;
  return null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** ADLS Gen2 (HNS) + blob accounts the Console identity can read — HNS first. */
export async function listAdlsAccounts(): Promise<StorageAccountSummary[]> {
  return listStorageAccounts();
}

/** Log Analytics workspaces the Console identity can read across the target subs. */
export async function listLogAnalyticsWorkspaces(subscriptionId?: string): Promise<LawSummary[]> {
  const subs = subscriptionId ? [subscriptionId] : subscriptionIds();
  if (subs.length === 0) {
    throw new AzureConnectionError('LOOM_SUBSCRIPTION_ID is not configured — cannot list Log Analytics workspaces.', 400);
  }
  const out: LawSummary[] = [];
  for (const sub of subs) {
    try {
      const raws = await armList<any>(
        `/subscriptions/${sub}/providers/Microsoft.OperationalInsights/workspaces?api-version=${LAW_API}`,
      );
      for (const r of raws) {
        out.push({
          id: r.id,
          name: r.name,
          location: r.location,
          customerId: r.properties?.customerId,
          resourceGroup: /\/resourceGroups\/([^/]+)\//i.exec(r.id || '')?.[1],
          subscriptionId: sub,
          provisioningState: r.properties?.provisioningState,
        });
      }
    } catch {
      /* skip inaccessible sub */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Role verification — does the Console UAMI hold the required Contributor role?
//
// We list role assignments at the resource scope filtered to the UAMI principal
// (the OData principalId filter returns grants at the scope AND inherited from
// the RG/subscription, e.g. the azure-connections-rbac module), then check for
// the specific role GUID.
// ---------------------------------------------------------------------------

async function probeRole(resourceId: string, roleId: string, roleName: string, hint: string): Promise<RoleProbeResult> {
  const principalId = await resolveUamiPrincipalId();
  if (!principalId) {
    // Cannot verify — surface as missing so the operator wires LOOM_UAMI_PRINCIPAL_ID.
    return {
      hasRole: false, roleId, roleName, hint:
        'Could not resolve the Console UAMI principal id. Set LOOM_UAMI_PRINCIPAL_ID on the Console app (wired by admin-plane/main.bicep) and retry.',
    };
  }
  const filter = `principalId eq '${principalId}'`;
  const url =
    `${armBase()}${resourceId}/providers/Microsoft.Authorization/roleAssignments?api-version=${ROLE_ASSIGNMENTS_API}&$filter=${encodeURIComponent(filter)}`;
  const res = await armGet<{ value: any[] }>(url);
  const has = (res.value || []).some((a) => {
    const def: string = a?.properties?.roleDefinitionId || '';
    return def.split('/').pop() === roleId && (a?.properties?.principalId || '').toLowerCase() === principalId.toLowerCase();
  });
  return { hasRole: has, roleId, roleName, principalId, hint: has ? undefined : hint };
}

/** Probe the UAMI's Storage Blob Data Contributor role on a storage account. */
export async function probeAdlsRole(storageAccountId: string): Promise<RoleProbeResult> {
  return probeRole(
    storageAccountId,
    STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID,
    'Storage Blob Data Contributor',
    `Grant the Console UAMI "Storage Blob Data Contributor" (${STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID}) on this storage account, or deploy platform/fiab/bicep/modules/admin-plane/azure-connections-rbac.bicep, then click Retry.`,
  );
}

/** Probe the UAMI's Log Analytics Contributor role on a workspace. */
export async function probeLawRole(lawResourceId: string): Promise<RoleProbeResult> {
  return probeRole(
    lawResourceId,
    LOG_ANALYTICS_CONTRIBUTOR_ROLE_ID,
    'Log Analytics Contributor',
    `Grant the Console UAMI "Log Analytics Contributor" (${LOG_ANALYTICS_CONTRIBUTOR_ROLE_ID}) on this Log Analytics workspace, or deploy platform/fiab/bicep/modules/admin-plane/azure-connections-rbac.bicep, then click Retry.`,
  );
}

// ---------------------------------------------------------------------------
// Connectivity probes — real data-plane actions.
// ---------------------------------------------------------------------------

/** Ensure the dataflow-staging container exists on the account (creates it). */
async function probeAdlsStaging(accountName: string, container: string): Promise<void> {
  const svc = getServiceClientFor(accountName);
  const fs = svc.getFileSystemClient(container);
  const exists = await fs.exists();
  if (!exists) await fs.create();
}

/** Run a trivial KQL `print` against the LAW data plane to confirm reachability. */
async function probeLawQuery(customerId: string): Promise<void> {
  let t;
  try {
    t = await credential.getToken(`${getLogAnalyticsHost()}/.default`);
  } catch (e: any) {
    throw new AzureConnectionError(credentialErrorMessage('the Log Analytics query data plane'), 401);
  }
  if (!t?.token) throw new AzureConnectionError(credentialErrorMessage('the Log Analytics query data plane'), 401);
  const url = `${getLogAnalyticsHost()}/v1/workspaces/${customerId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query: "print loom_probe='ok'" }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const msg = json?.error?.message || text || `Log Analytics probe failed (${res.status})`;
    throw new AzureConnectionError(msg, res.status);
  }
}

// ---------------------------------------------------------------------------
// Cosmos CRUD
// ---------------------------------------------------------------------------

function connId(workspaceId: string, kind: AzureConnectionKind): string {
  // One binding per (workspace, kind) — a workspace stages dataflows to ONE
  // ADLS account and exports query logs to ONE LAW. A new connect replaces it.
  return `${kind}:${workspaceId}`;
}

export async function listAzureConnections(workspaceId: string): Promise<AzureConnection[]> {
  const c = await azureConnectionsContainer();
  const { resources } = await c.items.query<AzureConnection>({
    query: 'SELECT * FROM c WHERE c.workspaceId = @w',
    parameters: [{ name: '@w', value: workspaceId }],
  }, { partitionKey: workspaceId }).fetchAll();
  return resources;
}

export async function getAzureConnection(workspaceId: string, id: string): Promise<AzureConnection | null> {
  const c = await azureConnectionsContainer();
  try {
    const { resource } = await c.item(id, workspaceId).read<AzureConnection>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function disconnectAzureConnection(workspaceId: string, id: string): Promise<void> {
  const c = await azureConnectionsContainer();
  try {
    await c.item(id, workspaceId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

async function upsert(conn: AzureConnection): Promise<AzureConnection> {
  const c = await azureConnectionsContainer();
  const { resource } = await c.items.upsert<AzureConnection>(conn);
  return (resource as AzureConnection) ?? conn;
}

// ---------------------------------------------------------------------------
// Connect — ADLS Gen2 (dataflow staging)
// ---------------------------------------------------------------------------

export interface ConnectAdlsInput {
  storageAccountId: string;
  containerName?: string;
  name?: string;
  connectedBy?: string;
}

export async function connectAdls(
  workspaceId: string,
  tenantId: string,
  input: ConnectAdlsInput,
): Promise<AzureConnection> {
  if (!input.storageAccountId) throw new AzureConnectionError('storageAccountId is required', 400);
  // Resolve the account from ARM discovery so we have its name + sub/rg + dfs host.
  const accounts = await listStorageAccounts();
  const acct = accounts.find((a) => a.id.toLowerCase() === input.storageAccountId.toLowerCase());
  if (!acct) {
    throw new AzureConnectionError('Storage account not found, or the Console identity lacks Reader on it.', 404);
  }
  const container = (input.containerName || 'dataflow-staging').trim() || 'dataflow-staging';
  const now = new Date().toISOString();
  const existing = await getAzureConnection(workspaceId, connId(workspaceId, 'adls-gen2'));
  const base: AzureConnection = {
    id: connId(workspaceId, 'adls-gen2'),
    workspaceId,
    tenantId,
    kind: 'adls-gen2',
    name: input.name?.trim() || acct.name,
    storageAccountId: acct.id,
    storageAccountName: acct.name,
    containerName: container,
    dfsEndpoint: dfsUrl(acct.name),
    subscriptionId: acct.subscriptionId,
    resourceGroup: acct.resourceGroup,
    status: 'role-missing',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    connectedBy: input.connectedBy,
  };

  // 1) Verify the role the binding actually needs (write staging Parquet).
  const role = await probeAdlsRole(acct.id);
  if (!role.hasRole) {
    return upsert({
      ...base,
      status: 'role-missing',
      roleGate: { missing: `${role.roleName} (${role.roleId})`, hint: role.hint || '' },
    });
  }
  // 2) Real connectivity: ensure the staging container exists (create on miss).
  try {
    await probeAdlsStaging(acct.name, container);
  } catch (e: any) {
    if (isCredentialError(e)) {
      return upsert({ ...base, status: 'probe-failed', statusDetail: credentialErrorMessage(`the staging storage account "${acct.name}"`) });
    }
    const status = typeof e?.statusCode === 'number' ? e.statusCode : (typeof e?.status === 'number' ? e.status : 0);
    if (status === 403) {
      return upsert({
        ...base,
        status: 'role-missing',
        roleGate: {
          missing: 'Storage Blob Data Contributor (ba92f5b4-2d11-453d-a403-e96b0029c9fe)',
          hint: 'The data-plane staging probe was denied (403). Grant the Console UAMI Storage Blob Data Contributor on this account, then Retry.',
        },
      });
    }
    return upsert({ ...base, status: 'probe-failed', statusDetail: e?.message || String(e) });
  }
  return upsert({ ...base, status: 'connected', connectedAt: now });
}

// ---------------------------------------------------------------------------
// Connect — Log Analytics (query-log export)
// ---------------------------------------------------------------------------

export interface ConnectLawInput {
  lawResourceId: string;
  name?: string;
  connectedBy?: string;
}

export async function connectLogAnalytics(
  workspaceId: string,
  tenantId: string,
  input: ConnectLawInput,
): Promise<AzureConnection> {
  if (!input.lawResourceId) throw new AzureConnectionError('lawResourceId is required', 400);
  // Resolve the workspace (customerId GUID needed for the data-plane probe).
  let law: LawSummary;
  try {
    const raw = await armGet<any>(`${input.lawResourceId}?api-version=${LAW_API}`);
    law = {
      id: raw.id || input.lawResourceId,
      name: raw.name || input.lawResourceId.split('/').pop() || 'workspace',
      location: raw.location,
      customerId: raw.properties?.customerId,
      resourceGroup: /\/resourceGroups\/([^/]+)\//i.exec(input.lawResourceId)?.[1],
      subscriptionId: /\/subscriptions\/([^/]+)\//i.exec(input.lawResourceId)?.[1] || '',
      provisioningState: raw.properties?.provisioningState,
    };
  } catch (e: any) {
    throw new AzureConnectionError(e?.message || 'Log Analytics workspace not found', e?.status || 404);
  }
  const now = new Date().toISOString();
  const existing = await getAzureConnection(workspaceId, connId(workspaceId, 'log-analytics'));
  const base: AzureConnection = {
    id: connId(workspaceId, 'log-analytics'),
    workspaceId,
    tenantId,
    kind: 'log-analytics',
    name: input.name?.trim() || law.name,
    lawResourceId: law.id,
    lawWorkspaceId: law.customerId,
    lawName: law.name,
    subscriptionId: law.subscriptionId,
    resourceGroup: law.resourceGroup,
    status: 'role-missing',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    connectedBy: input.connectedBy,
  };

  // 1) Verify Log Analytics Contributor (needed to configure data export).
  const role = await probeLawRole(law.id);
  if (!role.hasRole) {
    return upsert({
      ...base,
      status: 'role-missing',
      roleGate: { missing: `${role.roleName} (${role.roleId})`, hint: role.hint || '' },
    });
  }
  // 2) Real connectivity: query the LAW data plane (confirms log streaming).
  if (!law.customerId) {
    return upsert({
      ...base,
      status: 'probe-failed',
      statusDetail: 'Workspace has no customerId (GUID) — cannot reach the query data plane.',
    });
  }
  try {
    await probeLawQuery(law.customerId);
  } catch (e: any) {
    const status = typeof e?.status === 'number' ? e.status : 0;
    if (status === 403) {
      return upsert({
        ...base,
        status: 'role-missing',
        roleGate: {
          missing: 'Log Analytics Contributor (92aaf0da-9dab-42b6-94a3-d43ce8d16293)',
          hint: 'The Log Analytics query data plane denied the probe (403). Grant the Console UAMI Log Analytics Contributor on this workspace, then Retry.',
        },
      });
    }
    return upsert({ ...base, status: 'probe-failed', statusDetail: e?.message || String(e) });
  }
  return upsert({ ...base, status: 'connected', connectedAt: now });
}

/**
 * Resolve the ADLS Gen2 account a workspace is bound to for dataflow staging,
 * or null when no connected binding exists. Used by dataflow-run.ts to prefer
 * the workspace-bound account over the global DLZ lake.
 */
export async function resolveBoundDataflowAdls(
  workspaceId: string,
): Promise<{ account: string; dfsBase: string; container: string } | null> {
  try {
    const conns = await listAzureConnections(workspaceId);
    const adls = conns.find((c) => c.kind === 'adls-gen2' && c.status === 'connected');
    if (adls?.storageAccountName && adls?.dfsEndpoint) {
      return {
        account: adls.storageAccountName,
        dfsBase: adls.dfsEndpoint,
        container: adls.containerName || 'dataflow-staging',
      };
    }
  } catch {
    /* fall back to env */
  }
  return null;
}
