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
  | 'cosmos';

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
};

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

export async function attachAppResource(kind: AppResourceKind, addedBy?: string): Promise<AttachResult> {
  const def = KINDS[kind];
  if (!def) throw new Error(`Unknown resource kind: ${kind}`);
  const missing = def.missing();
  if (missing) throw new Error(`${def.label} is not configured in this deployment — set ${missing} on the Console.`);

  const resolved = def.resolve();
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
