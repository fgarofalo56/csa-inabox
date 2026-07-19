/**
 * Loom Apps — attachable RESOURCES (APPS-W2, Databricks-Apps "App resources"
 * parity). Each attachable kind resolves, from the DEPLOYMENT'S OWN env, the
 * (a) env vars to inject into the app container and (b) the RBAC grant the
 * shared apps UAMI needs so the injected coordinates actually work — one click
 * = grant + inject, exactly like adding a "resource" to a Databricks App
 * (sql-warehouse / secret / serving-endpoint / volume ...).
 *
 * Azure-native only (no-fabric-dependency): every kind targets the Azure
 * backend Loom itself runs on. Honest gates per kind: when the backing env
 * isn't configured the kind reports `available:false` with the exact env var,
 * and a grant that needs data-plane setup the ARM plane can't do (Synapse SQL
 * login) returns `pending-grants` with a copy-paste script pre-filled with
 * REAL values (scripts rule #70) — never a silent no-op.
 *
 * The GRANT PRINCIPAL is the shared apps UAMI (LOOM_APPS_UAMI_ID /
 * LOOM_MCP_UAMI_ID — the identity every deployed app container runs as, per
 * loom-apps-client), NOT the Console UAMI. Its principalId is resolved once
 * via an ARM GET on the UAMI resource and cached.
 */

import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { deterministicAssignmentGuid } from '@/lib/azure/role-grant-client';
import type { LoomAppEnvVar } from '@/lib/azure/loom-apps-runtime-templates';

const env = (k: string) => (process.env[k] || '').trim();

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type AppResourceKind =
  | 'lakehouse'
  | 'warehouse'
  | 'adx'
  | 'eventhubs'
  | 'keyvault'
  | 'ai-search'
  | 'aoai'
  | 'cosmos'
  | 'weave-ontology';

export type AppResourceGrantStatus = 'granted' | 'already-exists' | 'pending-grants' | 'skipped' | 'error';

/** One attached resource persisted on the item's state.appRuntime.resources. */
export interface AppResource {
  id: string;
  kind: AppResourceKind;
  label: string;
  /** Env var NAMES this resource injected (removed on detach). */
  envNames: string[];
  grant: {
    role: string;
    scope: string;
    status: AppResourceGrantStatus;
    detail: string;
    /** Copy-paste fix when status is pending-grants (pre-filled — rule #70). */
    grantScript?: string;
  };
  addedAt: string;
  addedBy?: string;
}

interface ResolvedKind {
  /** Env vars to inject (already resolved to this deployment's real values). */
  envVars: LoomAppEnvVar[];
  /** ARM scope to grant at ('' = no ARM grant for this kind). */
  grantScope: string;
  /** Role definition GUID ('' = no ARM grant). */
  roleGuid: string;
  roleName: string;
  /** Data-plane grant script when ARM can't do it (Synapse SQL login). */
  dataPlaneScript?: string;
}

export interface AppResourceKindInfo {
  kind: AppResourceKind;
  label: string;
  description: string;
  available: boolean;
  /** Exact env var(s) missing when unavailable (honest gate). */
  missing?: string;
}

// ---------------------------------------------------------------------------
// Kind registry — resolve real coordinates from the deployment's env
// ---------------------------------------------------------------------------

const armId = (sub: string, rg: string, provider: string, name: string) =>
  sub && rg && name ? `/subscriptions/${sub}/resourceGroups/${rg}/providers/${provider}/${name}` : '';

const SUB = () => env('LOOM_SUBSCRIPTION_ID');
const ADMIN_RG = () => env('LOOM_ADMIN_RG');
const DLZ_RG = () => env('LOOM_DLZ_RG') || env('LOOM_ADMIN_RG');

interface KindDef {
  label: string;
  description: string;
  /** null → kind unavailable, string = the missing env var name. */
  missing(): string | null;
  resolve(): ResolvedKind;
}

const KINDS: Record<AppResourceKind, KindDef> = {
  lakehouse: {
    label: 'Lakehouse (ADLS Gen2)',
    description: 'Read/write the medallion lake — injects the account + layer URLs, grants Storage Blob Data Contributor.',
    missing: () => (env('LOOM_ADLS_ACCOUNT') ? null : 'LOOM_ADLS_ACCOUNT'),
    resolve: () => ({
      envVars: [
        { name: 'LOOM_ADLS_ACCOUNT', value: env('LOOM_ADLS_ACCOUNT') },
        ...(['LOOM_LANDING_URL', 'LOOM_BRONZE_URL', 'LOOM_SILVER_URL', 'LOOM_GOLD_URL'] as const)
          .filter((k) => env(k))
          .map((k) => ({ name: k, value: env(k) })),
      ],
      grantScope: armId(env('LOOM_ADLS_SUB') || SUB(), DLZ_RG(), 'Microsoft.Storage/storageAccounts', env('LOOM_ADLS_ACCOUNT')),
      roleGuid: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
      roleName: 'Storage Blob Data Contributor',
    }),
  },
  warehouse: {
    label: 'Warehouse (Synapse SQL)',
    description: 'Query the dedicated SQL pool — injects the workspace + pool names; SQL login is a data-plane grant (script provided).',
    missing: () => (env('LOOM_SYNAPSE_WORKSPACE') ? null : 'LOOM_SYNAPSE_WORKSPACE'),
    resolve: () => {
      const ws = env('LOOM_SYNAPSE_WORKSPACE');
      const pool = env('LOOM_SYNAPSE_DEDICATED_POOL');
      const appUamiName = appsUamiName();
      return {
        envVars: [
          { name: 'LOOM_SYNAPSE_WORKSPACE', value: ws },
          ...(pool ? [{ name: 'LOOM_SYNAPSE_DEDICATED_POOL', value: pool }] : []),
        ],
        grantScope: '',
        roleGuid: '',
        roleName: 'SQL login (data-plane)',
        dataPlaneScript:
          `-- Run as an Entra admin on ${ws}${pool ? `/${pool}` : ''}:\n` +
          `CREATE USER [${appUamiName}] FROM EXTERNAL PROVIDER;\n` +
          `ALTER ROLE db_datareader ADD MEMBER [${appUamiName}];`,
      };
    },
  },
  adx: {
    label: 'Eventhouse (Azure Data Explorer)',
    description: 'Query KQL databases — injects the cluster URI + default database, grants a cluster viewer principal-assignment.',
    missing: () => (env('LOOM_KUSTO_CLUSTER_URI') ? null : 'LOOM_KUSTO_CLUSTER_URI'),
    resolve: () => {
      const clusterName = env('LOOM_KUSTO_CLUSTER_NAME')
        || (env('LOOM_KUSTO_CLUSTER_URI').match(/https:\/\/([^.]+)\./)?.[1] ?? '');
      return {
        envVars: [
          { name: 'LOOM_ADX_CLUSTER_URI', value: env('LOOM_KUSTO_CLUSTER_URI') },
          ...(env('LOOM_KUSTO_DEFAULT_DB') ? [{ name: 'LOOM_ADX_DEFAULT_DB', value: env('LOOM_KUSTO_DEFAULT_DB') }] : []),
        ],
        grantScope: armId(env('LOOM_KUSTO_SUB') || SUB(), env('LOOM_KUSTO_RG') || DLZ_RG(), 'Microsoft.Kusto/clusters', clusterName),
        // ADX uses principalAssignments, not classic role assignments — handled
        // by grantAdxViewer below; roleGuid stays '' so the generic path skips.
        roleGuid: '',
        roleName: 'AllDatabasesViewer (ADX principal-assignment)',
      };
    },
  },
  eventhubs: {
    label: 'Event Hubs (eventstream)',
    description: 'Send/receive events — injects the namespace, grants Azure Event Hubs Data Owner.',
    missing: () => (env('LOOM_EVENTHUB_NAMESPACE') ? null : 'LOOM_EVENTHUB_NAMESPACE'),
    resolve: () => ({
      envVars: [{ name: 'LOOM_EVENTHUB_NAMESPACE', value: env('LOOM_EVENTHUB_NAMESPACE') }],
      grantScope: armId(SUB(), DLZ_RG(), 'Microsoft.EventHub/namespaces', env('LOOM_EVENTHUB_NAMESPACE')),
      roleGuid: 'f526a384-b230-433a-b45c-95f59c4a2dec',
      roleName: 'Azure Event Hubs Data Owner',
    }),
  },
  keyvault: {
    label: 'Key Vault (secrets)',
    description: 'Read secrets at runtime — injects KEYVAULT_URI, grants Key Vault Secrets User.',
    missing: () => (env('LOOM_KEY_VAULT_URI') || env('LOOM_APPS_KEY_VAULT_URI') ? null : 'LOOM_KEY_VAULT_URI'),
    resolve: () => {
      const uri = env('LOOM_APPS_KEY_VAULT_URI') || env('LOOM_KEY_VAULT_URI');
      const vaultName = uri.match(/https:\/\/([^.]+)\./)?.[1] ?? '';
      return {
        envVars: [{ name: 'KEYVAULT_URI', value: uri }],
        grantScope: armId(SUB(), ADMIN_RG(), 'Microsoft.KeyVault/vaults', vaultName),
        roleGuid: '4633458b-17de-408a-b874-0445c86b69e6',
        roleName: 'Key Vault Secrets User',
      };
    },
  },
  'ai-search': {
    label: 'AI Search (RAG indexes)',
    description: 'Query search indexes — injects the service name, grants Search Index Data Reader.',
    missing: () => (env('LOOM_AI_SEARCH_SERVICE') ? null : 'LOOM_AI_SEARCH_SERVICE'),
    resolve: () => ({
      envVars: [{ name: 'LOOM_AI_SEARCH_SERVICE', value: env('LOOM_AI_SEARCH_SERVICE') }],
      grantScope: armId(env('LOOM_AI_SEARCH_SUB') || SUB(), env('LOOM_AI_SEARCH_RG') || ADMIN_RG(), 'Microsoft.Search/searchServices', env('LOOM_AI_SEARCH_SERVICE')),
      roleGuid: '1407120a-92aa-4202-b7e9-c0e197c71c8f',
      roleName: 'Search Index Data Reader',
    }),
  },
  aoai: {
    label: 'Azure OpenAI (models)',
    description: 'Call the shared AOAI/Foundry models — injects the endpoint + default deployment, grants Cognitive Services OpenAI User.',
    missing: () => (env('LOOM_AOAI_ENDPOINT') ? null : 'LOOM_AOAI_ENDPOINT'),
    resolve: () => ({
      envVars: [
        { name: 'LOOM_AOAI_ENDPOINT', value: env('LOOM_AOAI_ENDPOINT') },
        ...(env('LOOM_AOAI_DEPLOYMENT') ? [{ name: 'LOOM_AOAI_DEPLOYMENT', value: env('LOOM_AOAI_DEPLOYMENT') }] : []),
      ],
      grantScope: armId(env('LOOM_AOAI_SUB') || SUB(), env('LOOM_AOAI_RG') || ADMIN_RG(), 'Microsoft.CognitiveServices/accounts', env('LOOM_AOAI_ACCOUNT')),
      roleGuid: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd',
      roleName: 'Cognitive Services OpenAI User',
    }),
  },
  cosmos: {
    label: 'Cosmos DB (metadata store)',
    description: 'Read/write Cosmos containers — injects the endpoint; the data-plane role is assigned via the Cosmos SQL role API.',
    missing: () => (env('LOOM_COSMOS_ENDPOINT') ? null : 'LOOM_COSMOS_ENDPOINT'),
    resolve: () => {
      const account = env('LOOM_COSMOS_ACCOUNT') || (env('LOOM_COSMOS_ENDPOINT').match(/https:\/\/([^.]+)\./)?.[1] ?? '');
      return {
        envVars: [{ name: 'LOOM_COSMOS_ENDPOINT', value: env('LOOM_COSMOS_ENDPOINT') }],
        grantScope: armId(SUB(), DLZ_RG(), 'Microsoft.DocumentDB/databaseAccounts', account),
        // Cosmos data-plane RBAC uses sqlRoleAssignments — handled by
        // grantCosmosDataRole below; '' skips the generic role PUT.
        roleGuid: '',
        roleName: 'Cosmos DB Built-in Data Contributor',
      };
    },
  },
  'weave-ontology': {
    label: 'Weave ontology (semantic graph)',
    description: 'Query ontology objects/links + invoke actions over the Weave AGE graph — injects the PG host/db/graph; the PG principal is a data-plane grant (script provided).',
    missing: () => (env('LOOM_WEAVE_PG_FQDN') ? null : 'LOOM_WEAVE_PG_FQDN'),
    resolve: () => ({
      envVars: weavePgEnvVars(),
      grantScope: '',
      roleGuid: '',
      roleName: 'PG principal + AGE graph access (data-plane)',
      dataPlaneScript: weavePgGrantScript(),
    }),
  },
};

// ---------------------------------------------------------------------------
// Weave PG (AGE) coordinates + grant script — shared by the deployment-level
// kind and the per-item ontology attach
// ---------------------------------------------------------------------------

function weaveDb(): string { return env('LOOM_WEAVE_PG_DATABASE') || 'loom-weave'; }
function weaveGraph(): string { return env('LOOM_WEAVE_GRAPH') || 'loom_ontology'; }

function weavePgEnvVars(): LoomAppEnvVar[] {
  return [
    { name: 'LOOM_WEAVE_PG_FQDN', value: env('LOOM_WEAVE_PG_FQDN') },
    { name: 'LOOM_WEAVE_PG_DATABASE', value: weaveDb() },
    { name: 'LOOM_WEAVE_GRAPH', value: weaveGraph() },
    // The PG login the app must connect as (its own UAMI, token = password).
    { name: 'LOOM_WEAVE_PG_USER', value: appsUamiName() },
  ];
}

/**
 * The one-time data-plane grant: register the apps UAMI as a PG Entra
 * principal + grant it the same ag_catalog/graph-schema access the Console
 * principal gets in scripts/csa-loom/bootstrap-weave-pg.sh (mirrored SQL —
 * keep the two in sync). Pre-filled with REAL values per scripts rule #70.
 */
function weavePgGrantScript(): string {
  const fqdn = env('LOOM_WEAVE_PG_FQDN');
  const db = weaveDb();
  const graph = weaveGraph();
  const uami = appsUamiName();
  return (
    `-- Run once as the PG Entra admin on ${fqdn} (idempotent):\n` +
    `-- psql "host=${fqdn} port=5432 dbname=${db} user=<pg-entra-admin> sslmode=require"\n` +
    `-- (password = az account get-access-token --resource https://ossrdbms-aad.database.windows.net --query accessToken -o tsv)\n` +
    `SELECT * FROM pgaadauth_create_principal('${uami}', false, false);\n` +
    `GRANT CONNECT ON DATABASE "${db}" TO "${uami}";\n` +
    `GRANT USAGE ON SCHEMA ag_catalog TO "${uami}";\n` +
    `GRANT SELECT ON ALL TABLES IN SCHEMA ag_catalog TO "${uami}";\n` +
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ag_catalog TO "${uami}";\n` +
    `GRANT USAGE ON SCHEMA "${graph}" TO "${uami}";\n` +
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${graph}" TO "${uami}";\n` +
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${graph}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${uami}";`
  );
}

/** Catalog for the UI — every kind with an honest availability flag. */
export function listAppResourceKinds(): AppResourceKindInfo[] {
  return (Object.keys(KINDS) as AppResourceKind[]).map((kind) => {
    const def = KINDS[kind];
    const missing = def.missing();
    return { kind, label: def.label, description: def.description, available: !missing, missing: missing ?? undefined };
  });
}

// ---------------------------------------------------------------------------
// Apps-UAMI principal resolution (the grant target)
// ---------------------------------------------------------------------------

function appsUamiResourceId(): string {
  return env('LOOM_APPS_UAMI_ID') || env('LOOM_MCP_UAMI_ID');
}

/** UAMI resource NAME (= its Entra SP display name — what CREATE USER needs). */
export function appsUamiName(): string {
  return appsUamiResourceId().split('/').pop() || '<apps-uami-name>';
}

let cachedPrincipal: { rid: string; principalId: string } | null = null;

async function armFetch(url: string, init?: RequestInit): Promise<Response> {
  const tok = await uamiArmCredential().getToken(armScope());
  if (!tok?.token) throw new Error('Failed to acquire an ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: { ...(init?.headers || {}), authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    cache: 'no-store',
  });
}

/**
 * Resolve a resource's TRUE ARM id by (type, name) via Azure Resource Graph —
 * authoritative across every subscription the Console UAMI can read. The
 * env-derived scope guess can point at the WRONG subscription for DLZ-hosted
 * resources (live receipt 2026-07-18: the lake `saloomdefault…` lives in the
 * DLZ sub 363ef5d1 while LOOM_SUBSCRIPTION_ID is the admin sub, so the guessed
 * scope 404'd/failed the grant). Same Resource-Graph-by-name self-heal pattern
 * the dlz-attach console wiring uses. Returns '' when not found (caller keeps
 * the env guess).
 */
async function resolveArmIdByName(resourceType: string, name: string): Promise<string> {
  if (!name) return '';
  try {
    const res = await armFetch(
      `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      {
        method: 'POST',
        body: JSON.stringify({
          query: `resources | where type =~ '${resourceType}' and name =~ '${name.replace(/'/g, '')}' | project id | limit 1`,
        }),
      },
    );
    const j: any = await res.json().catch(() => ({}));
    return (res.ok && j?.data?.[0]?.id) ? String(j.data[0].id) : '';
  } catch {
    return '';
  }
}

/** ARM resource type per kind — used for the Resource-Graph authoritative lookup. */
const KIND_ARM_TYPE: Partial<Record<AppResourceKind, string>> = {
  lakehouse: 'microsoft.storage/storageaccounts',
  adx: 'microsoft.kusto/clusters',
  eventhubs: 'microsoft.eventhub/namespaces',
  keyvault: 'microsoft.keyvault/vaults',
  'ai-search': 'microsoft.search/searchservices',
  aoai: 'microsoft.cognitiveservices/accounts',
  cosmos: 'microsoft.documentdb/databaseaccounts',
};

/** principalId (objectId) of the shared apps UAMI — ARM GET, cached. */
export async function appsUamiPrincipalId(): Promise<string> {
  const rid = appsUamiResourceId();
  if (!rid) throw new Error('LOOM_APPS_UAMI_ID (or LOOM_MCP_UAMI_ID) is not set — deploy modules/admin-plane/mcp.bicep.');
  if (cachedPrincipal?.rid === rid) return cachedPrincipal.principalId;
  const res = await armFetch(`${armBase()}${rid}?api-version=2023-01-31`);
  const j: any = await res.json().catch(() => ({}));
  const principalId = j?.properties?.principalId || '';
  if (!res.ok || !principalId) throw new Error(`Could not resolve the apps UAMI principal (${res.status}): ${JSON.stringify(j).slice(0, 200)}`);
  cachedPrincipal = { rid, principalId };
  return principalId;
}

// ---------------------------------------------------------------------------
// Grant execution
// ---------------------------------------------------------------------------

const ROLE_API = '2022-04-01';

async function putRoleAssignment(scope: string, roleGuid: string, principalId: string): Promise<{ status: AppResourceGrantStatus; detail: string }> {
  const sub = scope.match(/\/subscriptions\/([^/]+)\//)?.[1] || '';
  const name = deterministicAssignmentGuid(scope, roleGuid, principalId);
  const res = await armFetch(
    `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments/${name}?api-version=${ROLE_API}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        properties: {
          roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`,
          principalId,
          principalType: 'ServicePrincipal',
        },
      }),
    },
  );
  if (res.ok) return { status: 'granted', detail: 'Role granted to the apps identity.' };
  const body: any = await res.json().catch(() => ({}));
  const code: string = body?.error?.code || '';
  const message: string = body?.error?.message || `HTTP ${res.status}`;
  if (res.status === 409 || /RoleAssignmentExists/i.test(code)) return { status: 'already-exists', detail: 'The apps identity already holds this role.' };
  if (res.status === 403 || /AuthorizationFailed/i.test(code)) {
    return { status: 'pending-grants', detail: `The Console UAMI cannot assign roles at this scope (needs Owner / User Access Administrator): ${message}` };
  }
  return { status: 'error', detail: message };
}

/** ADX viewer via cluster principalAssignments (ADX has its own RBAC plane). */
async function grantAdxViewer(clusterScope: string, principalId: string): Promise<{ status: AppResourceGrantStatus; detail: string }> {
  const tenant = env('LOOM_TENANT_ID') || env('AZURE_TENANT_ID');
  const res = await armFetch(
    `${armBase()}${clusterScope}/principalAssignments/loom-app-viewer-${principalId.slice(0, 8)}?api-version=2023-08-15`,
    {
      method: 'PUT',
      body: JSON.stringify({ properties: { principalId, principalType: 'App', role: 'AllDatabasesViewer', ...(tenant ? { tenantId: tenant } : {}) } }),
    },
  );
  if (res.ok) return { status: 'granted', detail: 'AllDatabasesViewer principal-assignment created on the ADX cluster.' };
  const body: any = await res.json().catch(() => ({}));
  const message: string = body?.error?.message || `HTTP ${res.status}`;
  if (/already exists|Conflict/i.test(message) || res.status === 409) return { status: 'already-exists', detail: 'The apps identity already has an ADX assignment.' };
  return { status: res.status === 403 ? 'pending-grants' : 'error', detail: message };
}

/** Cosmos data-plane role via sqlRoleAssignments (portal IAM does NOT cover this). */
async function grantCosmosDataRole(accountScope: string, principalId: string): Promise<{ status: AppResourceGrantStatus; detail: string }> {
  const stableName = deterministicAssignmentGuid(accountScope, '00000000-0000-0000-0000-000000000002', principalId);
  const res = await armFetch(
    `${armBase()}${accountScope}/sqlRoleAssignments/${stableName}?api-version=2024-05-15`,
    {
      method: 'PUT',
      body: JSON.stringify({
        properties: {
          roleDefinitionId: `${accountScope}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002`,
          principalId,
          scope: accountScope,
        },
      }),
    },
  );
  // Cosmos role-assignment PUT is async (202) — accepted counts as granted.
  if (res.ok || res.status === 202) return { status: 'granted', detail: 'Cosmos Built-in Data Contributor assigned to the apps identity.' };
  const body: any = await res.json().catch(() => ({}));
  const message: string = body?.error?.message || `HTTP ${res.status}`;
  if (res.status === 409 || /already exists/i.test(message)) return { status: 'already-exists', detail: 'The apps identity already holds the Cosmos data role.' };
  return { status: res.status === 403 ? 'pending-grants' : 'error', detail: message };
}

// ---------------------------------------------------------------------------
// attach — resolve + grant, returns the AppResource record + env vars to merge
// ---------------------------------------------------------------------------

export interface AttachResult {
  resource: AppResource;
  envVars: LoomAppEnvVar[];
}

/** APP_-prefixed (allowlisted) env-name slug from an item display name. */
function envSlug(name: string): string {
  return (name || 'ITEM').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'ITEM';
}

/**
 * Attach a SPECIFIC workspace kql-database ITEM (APPS-W2 slice 3). Resolves
 * the item's REAL ADX database (state.databaseName → provisioning.secondaryIds
 * — the same chain kusto-client.resolveDatabase uses), injects
 * APP_KQL_<SLUG>_CLUSTER_URI/_DB, and grants the apps UAMI **Viewer scoped to
 * that DATABASE only** (clusters/{c}/databases/{db}/principalAssignments) —
 * tighter than the cluster-wide AllDatabasesViewer the deployment-level
 * attach uses.
 */
export async function attachKqlItemResource(
  itemId: string,
  workspaceId: string,
  displayName: string,
  addedBy?: string,
): Promise<AttachResult> {
  const clusterUri = env('LOOM_KUSTO_CLUSTER_URI');
  if (!clusterUri) throw new Error('ADX is not configured in this deployment — set LOOM_KUSTO_CLUSTER_URI on the Console.');

  // The item's REAL database — same resolution chain as kusto-client.
  const { itemsContainer } = await import('@/lib/azure/cosmos-client');
  const items = await itemsContainer();
  const { resource: item } = await items.item(itemId, workspaceId).read<any>();
  if (!item || item.itemType !== 'kql-database') throw new Error('KQL database item not found.');
  const st = item.state || {};
  const prov = st.provisioning;
  const database: string =
    (typeof st.databaseName === 'string' && st.databaseName.trim())
      ? st.databaseName.trim()
      : (prov && (prov.status === 'created' || prov.status === 'exists') && typeof (prov.secondaryIds?.database || prov.resourceId) === 'string')
        ? String(prov.secondaryIds?.database || prov.resourceId).trim()
        : env('LOOM_KUSTO_DEFAULT_DB');
  if (!database) throw new Error(`Could not resolve the ADX database for "${displayName}" (set LOOM_KUSTO_DEFAULT_DB or provision the item).`);

  const clusterName = env('LOOM_KUSTO_CLUSTER_NAME') || (clusterUri.match(/https:\/\/([^.]+)\./)?.[1] ?? '');
  const clusterScope = (await resolveArmIdByName('microsoft.kusto/clusters', clusterName))
    || armId(env('LOOM_KUSTO_SUB') || SUB(), env('LOOM_KUSTO_RG') || DLZ_RG(), 'Microsoft.Kusto/clusters', clusterName);
  const principalId = await appsUamiPrincipalId();

  // DATABASE-scoped Viewer principal-assignment (ADX's own RBAC plane).
  const tenant = env('LOOM_TENANT_ID') || env('AZURE_TENANT_ID');
  let grantStatus: AppResourceGrantStatus; let grantDetail: string;
  try {
    const res = await armFetch(
      `${armBase()}${clusterScope}/databases/${encodeURIComponent(database)}/principalAssignments/loom-app-db-viewer-${principalId.slice(0, 8)}?api-version=2023-08-15`,
      {
        method: 'PUT',
        body: JSON.stringify({ properties: { principalId, principalType: 'App', role: 'Viewer', ...(tenant ? { tenantId: tenant } : {}) } }),
      },
    );
    if (res.ok) { grantStatus = 'granted'; grantDetail = `Viewer granted on ADX database '${database}'.`; }
    else {
      const body: any = await res.json().catch(() => ({}));
      const message: string = body?.error?.message || `HTTP ${res.status}`;
      if (res.status === 409 || /already exists|Conflict/i.test(message)) { grantStatus = 'already-exists'; grantDetail = 'The apps identity already has a Viewer assignment on this database.'; }
      else { grantStatus = res.status === 403 ? 'pending-grants' : 'error'; grantDetail = message; }
    }
  } catch (e: any) {
    grantStatus = 'error'; grantDetail = e?.message || String(e);
  }

  const slug = envSlug(displayName);
  const envVars: LoomAppEnvVar[] = [
    { name: `APP_KQL_${slug}_CLUSTER_URI`, value: clusterUri },
    { name: `APP_KQL_${slug}_DB`, value: database },
  ];
  return {
    resource: {
      id: `kql-item-${itemId.slice(0, 8)}`,
      kind: 'adx',
      label: `KQL database: ${displayName}`,
      envNames: envVars.map((e) => e.name),
      grant: { role: `Viewer (database '${database}')`, scope: `${clusterScope}/databases/${database}`, status: grantStatus, detail: grantDetail },
      addedAt: new Date().toISOString(),
      addedBy,
    },
    envVars,
  };
}

/**
 * Attach a SPECIFIC workspace lakehouse ITEM (APPS-W2 slice 2 — the
 * Databricks-Apps "pick the resource instance" flow). Resolves the item's REAL
 * abfss root via lakehouse-abfss (provisioned path or convention fallback),
 * injects APP_LH_<SLUG>_URL / _NAME / _CONTAINER, and grants the apps UAMI
 * Storage Blob Data Contributor on the item's ACTUAL storage account
 * (Resource-Graph-resolved, cross-sub-safe). Multiple lakehouse items can be
 * attached side-by-side — each carries its own env slug.
 */
export async function attachLakehouseItemResource(
  itemId: string,
  workspaceId: string,
  displayName: string,
  addedBy?: string,
): Promise<AttachResult> {
  const { resolveLakehouseAbfss } = await import('@/lib/azure/lakehouse-abfss');
  const resolved = await resolveLakehouseAbfss(itemId, workspaceId);
  if (!resolved) {
    throw new Error(
      `Could not resolve real storage for lakehouse "${displayName}" — the deployment has no configured ` +
      'ADLS containers (set LOOM_ADLS_ACCOUNT / the layer URLs), or the item was deleted.',
    );
  }
  const account = resolved.abfss.match(/@([^.]+)\./)?.[1] || '';
  const slug = envSlug(displayName);
  const envVars: LoomAppEnvVar[] = [
    { name: `APP_LH_${slug}_URL`, value: resolved.abfss },
    { name: `APP_LH_${slug}_NAME`, value: displayName },
    { name: `APP_LH_${slug}_CONTAINER`, value: resolved.container },
  ];

  const scope = (await resolveArmIdByName('microsoft.storage/storageaccounts', account))
    || armId(SUB(), DLZ_RG(), 'Microsoft.Storage/storageAccounts', account);
  const principalId = await appsUamiPrincipalId();
  const r = await putRoleAssignment(scope, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe', principalId);

  return {
    resource: {
      id: `lakehouse-item-${itemId.slice(0, 8)}`,
      kind: 'lakehouse',
      label: `Lakehouse: ${displayName}`,
      envNames: envVars.map((e) => e.name),
      grant: {
        role: 'Storage Blob Data Contributor', scope, status: r.status, detail: r.detail,
        ...(r.status === 'pending-grants'
          ? {
              grantScript:
                `az role assignment create --assignee-object-id ${principalId} --assignee-principal-type ServicePrincipal ` +
                `--role "Storage Blob Data Contributor" --scope "${scope}"`,
            }
          : {}),
      },
      addedAt: new Date().toISOString(),
      addedBy,
    },
    envVars,
  };
}

/**
 * Attach a SPECIFIC workspace ontology ITEM (APP-W3 slice A — Weave-native
 * apps). Resolves the item's declared object types from the structured
 * designer model (state.objectTypes[]), injects APP_ONT_<SLUG>_* coordinates
 * for the Weave AGE graph (host/db/graph/login + the ontology id + type
 * list), and reports the grant honestly: the PG principal is a DATA-PLANE
 * grant ARM cannot apply — but we CHECK pg_roles through the Console's own
 * PG connection first, so an already-bootstrapped apps principal shows
 * 'already-exists' instead of a stale pending-grants banner.
 */
export async function attachOntologyItemResource(
  itemId: string,
  workspaceId: string,
  displayName: string,
  addedBy?: string,
): Promise<AttachResult> {
  const fqdn = env('LOOM_WEAVE_PG_FQDN');
  if (!fqdn) throw new Error('The Weave ontology store is not configured in this deployment — set LOOM_WEAVE_PG_FQDN on the Console.');

  const { itemsContainer } = await import('@/lib/azure/cosmos-client');
  const items = await itemsContainer();
  const { resource: item } = await items.item(itemId, workspaceId).read<any>();
  if (!item || item.itemType !== 'ontology') throw new Error('Ontology item not found.');

  // Object type names from the structured designer model (post-#2128 the
  // canonical representation); legacy text-DSL-only items just omit _TYPES.
  const typeNames: string[] = Array.isArray(item.state?.objectTypes)
    ? item.state.objectTypes.map((t: any) => String(t?.name || '').trim()).filter(Boolean)
    : [];

  // Grant with SELF-HEAL (G2 zero-day-one-gates): the Console's own PG
  // principal is the server's Entra ADMIN (bicep registers it; live receipt
  // 2026-07-19: administrators list = ['loom-console'] only — the deploy SP
  // path can NEVER apply this grant here). So when pg_roles shows the apps
  // principal missing, the Console creates it + grants graph DML itself, and
  // only falls back to the pending-grants script if that fails (e.g. the
  // Console principal is not the admin in this deployment).
  const uami = appsUamiName();
  let grantStatus: AppResourceGrantStatus = 'pending-grants';
  let grantDetail =
    'The apps identity must be a PG Entra principal with AGE graph access — run the script below once as the PG admin (idempotent).';
  if (/^[A-Za-z0-9_-]{1,128}$/.test(uami)) {
    try {
      const { executePostgresQuery } = await import('@/lib/azure/postgres-flex-client');
      const probe = () => executePostgresQuery(
        fqdn, weaveDb(),
        `SELECT 1 FROM pg_roles WHERE rolname = '${uami}';`,
      );
      if ((await probe()).rowCount > 0) {
        grantStatus = 'already-exists';
        grantDetail = `'${uami}' is already a PG principal on ${fqdn} — no action needed.`;
      } else {
        // Same SQL as bootstrap-weave-pg.sh's EXTRA_PG_PRINCIPALS block
        // (DML, deliberately no CREATE). Idempotent.
        const graph = weaveGraph();
        await executePostgresQuery(
          fqdn, weaveDb(),
          `SELECT * FROM pgaadauth_create_principal('${uami}', false, false);`,
        ).catch(() => { /* may already exist under a race — the re-probe decides */ });
        await executePostgresQuery(
          fqdn, weaveDb(),
          `GRANT CONNECT ON DATABASE "${weaveDb()}" TO "${uami}"; ` +
          `GRANT USAGE ON SCHEMA ag_catalog TO "${uami}"; ` +
          `GRANT SELECT ON ALL TABLES IN SCHEMA ag_catalog TO "${uami}"; ` +
          `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ag_catalog TO "${uami}"; ` +
          `GRANT USAGE ON SCHEMA "${graph}" TO "${uami}"; ` +
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${graph}" TO "${uami}"; ` +
          `ALTER DEFAULT PRIVILEGES IN SCHEMA "${graph}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${uami}";`,
        );
        if ((await probe()).rowCount > 0) {
          grantStatus = 'granted';
          grantDetail = `'${uami}' registered as a PG principal with graph DML on '${graph}' (self-applied by the Console admin principal).`;
        }
      }
    } catch {
      /* self-heal unavailable (console principal not the PG admin) — keep pending-grants */
    }
  }

  const slug = envSlug(displayName);
  const envVars: LoomAppEnvVar[] = [
    { name: `APP_ONT_${slug}_ID`, value: itemId },
    { name: `APP_ONT_${slug}_PG_HOST`, value: fqdn },
    { name: `APP_ONT_${slug}_PG_DB`, value: weaveDb() },
    { name: `APP_ONT_${slug}_GRAPH`, value: weaveGraph() },
    { name: `APP_ONT_${slug}_PG_USER`, value: uami },
    ...(typeNames.length ? [{ name: `APP_ONT_${slug}_TYPES`, value: typeNames.join(',') }] : []),
  ];
  return {
    resource: {
      id: `ont-item-${itemId.slice(0, 8)}`,
      kind: 'weave-ontology',
      label: `Ontology: ${displayName}`,
      envNames: envVars.map((e) => e.name),
      grant: {
        role: 'PG principal + AGE graph access (data-plane)',
        scope: `${fqdn}/${weaveDb()} (graph '${weaveGraph()}')`,
        status: grantStatus,
        detail: grantDetail,
        ...(grantStatus === 'pending-grants' ? { grantScript: weavePgGrantScript() } : {}),
      },
      addedAt: new Date().toISOString(),
      addedBy,
    },
    envVars,
  };
}

export async function attachAppResource(kind: AppResourceKind, addedBy?: string): Promise<AttachResult> {
  const def = KINDS[kind];
  if (!def) throw new Error(`Unknown resource kind: ${kind}`);
  const missing = def.missing();
  if (missing) throw new Error(`${def.label} is not configured in this deployment — set ${missing} on the Console.`);

  const resolved = def.resolve();

  // Authoritative scope: Resource-Graph lookup by name (cross-sub-safe) —
  // the env-derived guess stays as fallback when ARG has no hit.
  const armType = KIND_ARM_TYPE[kind];
  if (armType && resolved.grantScope) {
    const name = resolved.grantScope.split('/').pop() || '';
    const trueId = await resolveArmIdByName(armType, name);
    if (trueId) resolved.grantScope = trueId;
  }

  let grant: AppResource['grant'];

  if (resolved.dataPlaneScript) {
    grant = {
      role: resolved.roleName, scope: resolved.grantScope || '(data plane)',
      status: 'pending-grants',
      detail: 'This backend uses a data-plane grant ARM cannot apply — run the script below once as an admin.',
      grantScript: resolved.dataPlaneScript,
    };
  } else if (!resolved.grantScope) {
    grant = { role: resolved.roleName, scope: '', status: 'skipped', detail: 'No grant scope could be resolved for this kind.' };
  } else {
    const principalId = await appsUamiPrincipalId();
    const r = kind === 'adx'
      ? await grantAdxViewer(resolved.grantScope, principalId)
      : kind === 'cosmos'
        ? await grantCosmosDataRole(resolved.grantScope, principalId)
        : await putRoleAssignment(resolved.grantScope, resolved.roleGuid, principalId);
    grant = {
      role: resolved.roleName, scope: resolved.grantScope, status: r.status, detail: r.detail,
      ...(r.status === 'pending-grants'
        ? {
            grantScript:
              `az role assignment create --assignee-object-id ${principalId} --assignee-principal-type ServicePrincipal ` +
              `--role "${resolved.roleName}" --scope "${resolved.grantScope}"`,
          }
        : {}),
    };
  }

  return {
    resource: {
      id: `${kind}-${Date.now().toString(36)}`,
      kind,
      label: def.label,
      envNames: resolved.envVars.map((e) => e.name),
      grant,
      addedAt: new Date().toISOString(),
      addedBy,
    },
    envVars: resolved.envVars,
  };
}
