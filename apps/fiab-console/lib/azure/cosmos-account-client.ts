/**
 * Azure Cosmos DB account *navigator* control-plane client (parity wave 7).
 *
 * IMPORTANT: this is NOT `cosmos-client.ts`. That file is Loom's OWN internal
 * store (workspaces / items / copilot-sessions etc.). THIS client navigates a
 * USER-selected Cosmos DB account — the one named by LOOM_COSMOS_ACCOUNT — the
 * same way the ADF / Synapse / Databricks / APIM navigators target a user
 * resource. The two never share an account in production.
 *
 * Auth: Console UAMI via ChainedTokenCredential:
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — prod path
 *   2. DefaultAzureCredential — local dev / az login fallback
 *
 * Surface: the ARM control plane for the SQL (Core / NoSQL) API, api-version
 * 2024-11-15, grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts
 *
 * Endpoints under
 *   …/Microsoft.DocumentDB/databaseAccounts/{acct}
 *     /sqlDatabases                                  list / get / PUT / DELETE
 *     /sqlDatabases/{db}/containers                  list / get / PUT / DELETE
 *     /sqlDatabases/{db}/containers/{c}/storedProcedures        list (read-only)
 *     /sqlDatabases/{db}/containers/{c}/triggers                list (read-only)
 *     /sqlDatabases/{db}/containers/{c}/userDefinedFunctions    list (read-only)
 *     /sqlDatabases/{db}/throughputSettings/default             read (RU/s)
 *     /sqlDatabases/{db}/containers/{c}/throughputSettings/default  read (RU/s)
 *
 * Auth scope: the sovereign-cloud ARM `.default` scope (cloud-endpoints.armScope()).
 * UAMI role:  "DocumentDB Account Contributor" at the account scope (covers the
 *             control-plane CRUD on databases/containers AND the Connect panel's
 *             ARM listKeys / listConnectionStrings actions). NOTE: "Cosmos DB
 *             Operator" is NOT sufficient for the Connect panel — it explicitly
 *             excludes key access (Microsoft.DocumentDB/databaseAccounts/listKeys).
 *
 * Keys / connection strings (Connect panel): the control-plane key actions
 *   POST …/databaseAccounts/{acct}/listKeys                 → 4 master keys
 *   POST …/databaseAccounts/{acct}/listConnectionStrings    → per-API strings
 *   POST …/databaseAccounts/{acct}/regenerateKey            → rotate one key
 * The returned connection strings already embed the cloud-correct data-plane
 * suffix (getCosmosSuffix() — documents.azure.com / documents.azure.us); no
 * manual suffix assembly is needed. accountEndpointFallback() uses
 * getCosmosSuffix() only when ARM omits documentEndpoint.
 *
 * Config gate: cosmosConfigGate() returns the missing env var so the BFF can
 * emit an honest 503 instead of a fake list (per no-vaporware.md).
 *
 * 404 → null so callers branch cleanly. Other non-2xx throw CosmosArmError
 * carrying status + parsed body so the BFF surfaces ARM's own message.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { armBase, armScope, getCosmosSuffix } from './cloud-endpoints';

const ARM_SCOPE = armScope();
const COSMOS_ARM_API = '2024-11-15';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ---------------------------------------------------------------------------
// Config gate — the navigator account is distinct from Loom's internal store.
// ---------------------------------------------------------------------------

export interface CosmosConfigGate {
  /** The first missing env var (used in the honest 503 MessageBar). */
  missing: string;
  /** Human hint listing all required vars + role. */
  hint: string;
}

/**
 * Returns a gate object when the navigator account isn't configured, else null.
 * The BFF turns a non-null gate into a 503 { ok:false, code:'not_configured' }.
 */
export function cosmosConfigGate(): CosmosConfigGate | null {
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_COSMOS_ACCOUNT_RG;
  const acct = process.env.LOOM_COSMOS_ACCOUNT;
  const hint =
    'Set LOOM_COSMOS_ACCOUNT (the Cosmos DB account name to navigate — distinct ' +
    "from Loom's own LOOM_COSMOS_ENDPOINT store), LOOM_COSMOS_ACCOUNT_RG, and " +
    'LOOM_SUBSCRIPTION_ID on the Console Container App, then grant the Console ' +
    'UAMI the "DocumentDB Account Contributor" role (role ID ' +
    '5bd9cd88-fe45-4216-938b-f97437e15450) at the account scope. ' +
    '"DocumentDB Account Contributor" covers both the control-plane navigator ' +
    'AND the Connect panel (listKeys / listConnectionStrings); "Cosmos DB ' +
    'Operator" is NOT sufficient — it explicitly blocks key access.';
  if (!sub) return { missing: 'LOOM_SUBSCRIPTION_ID', hint };
  if (!acct) return { missing: 'LOOM_COSMOS_ACCOUNT', hint };
  if (!rg) return { missing: 'LOOM_COSMOS_ACCOUNT_RG', hint };
  return null;
}

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function accountBase(): string {
  const sub = required('LOOM_SUBSCRIPTION_ID');
  const rg = required('LOOM_COSMOS_ACCOUNT_RG');
  const acct = required('LOOM_COSMOS_ACCOUNT');
  return `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${acct}`;
}

export class CosmosArmError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Cosmos ARM call failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function armFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new CosmosArmError(401, null, 'Failed to acquire ARM token for Cosmos DB');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${accountBase()}${path}${sep}api-version=${COSMOS_ARM_API}`;
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

async function readJson<T>(res: Response): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' ? parsed : `Cosmos ARM ${res.status}`);
    throw new CosmosArmError(res.status, parsed, msg);
  }
  return (parsed as T) ?? ({} as T);
}

/**
 * ARM CRUD on databases/containers is async (202 + Azure-AsyncOperation
 * header). For navigator UX we poll the resource's own GET until the
 * provisioningState settles, with a short bounded budget.
 */
async function waitForProvisioned(path: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Small initial delay — ARM needs a beat before GET reflects the new state.
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() < deadline) {
    const res = await armFetch(path);
    if (res.status === 404) return; // delete completed
    const j = await readJson<any>(res);
    const state = j?.properties?.resource?._self !== undefined
      ? 'Succeeded' // resource body present implies it exists
      : j?.properties?.provisioningState;
    if (!state || state === 'Succeeded' || state === 'Canceled' || state === 'Failed') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------------------
// Throughput shape (shared by db + container)
// ---------------------------------------------------------------------------

export type ThroughputMode = 'manual' | 'autoscale' | 'serverless' | 'unknown';

export interface ThroughputInfo {
  mode: ThroughputMode;
  /** manual RU/s */
  ru?: number;
  /** autoscale max RU/s */
  maxRu?: number;
  /** ARM-reported minimum the resource can scale to */
  minRu?: number;
}

function shapeThroughput(raw: any): ThroughputInfo {
  const r = raw?.properties?.resource;
  if (!r) return { mode: 'unknown' };
  if (r.autoscaleSettings?.maxThroughput) {
    return {
      mode: 'autoscale',
      maxRu: r.autoscaleSettings.maxThroughput,
      minRu: r.minimumThroughput ? Number(r.minimumThroughput) : undefined,
    };
  }
  if (typeof r.throughput === 'number') {
    return {
      mode: 'manual',
      ru: r.throughput,
      minRu: r.minimumThroughput ? Number(r.minimumThroughput) : undefined,
    };
  }
  return { mode: 'unknown' };
}

/**
 * Read database- or container-scoped throughputSettings/default. Serverless
 * accounts (and fixed shared-throughput children) return 404 — we map that to
 * { mode:'serverless' } so the UI shows the honest state, never a fake RU.
 */
async function readThroughput(scopePath: string): Promise<ThroughputInfo> {
  try {
    const res = await armFetch(`${scopePath}/throughputSettings/default`);
    if (res.status === 404) return { mode: 'serverless' };
    const j = await readJson<any>(res);
    if (!j) return { mode: 'serverless' };
    return shapeThroughput(j);
  } catch (e) {
    if (e instanceof CosmosArmError && (e.status === 404 || e.status === 400)) {
      return { mode: 'serverless' };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// SQL databases
// ---------------------------------------------------------------------------

export interface SqlDatabaseSummary {
  id: string;
  name: string;
  /** Database-level shared throughput, when provisioned. */
  throughput?: ThroughputInfo;
}

function shapeDatabase(raw: any): SqlDatabaseSummary {
  return {
    id: raw?.id,
    name: raw?.name ?? raw?.properties?.resource?.id,
  };
}

export async function listSqlDatabases(opts: { withThroughput?: boolean } = {}): Promise<SqlDatabaseSummary[]> {
  const res = await armFetch('/sqlDatabases');
  const j = await readJson<{ value: any[] }>(res);
  const dbs = (j?.value || []).map(shapeDatabase);
  if (opts.withThroughput) {
    await Promise.all(
      dbs.map(async (d) => {
        d.throughput = await readThroughput(`/sqlDatabases/${encodeURIComponent(d.name)}`);
      }),
    );
  }
  return dbs;
}

export interface CreateSqlDatabaseInput {
  id: string;
  /** Optional database-level shared throughput. */
  throughput?: number;
  /** Optional autoscale max RU/s (mutually exclusive with throughput). */
  maxThroughput?: number;
}

export async function createSqlDatabase(input: CreateSqlDatabaseInput): Promise<SqlDatabaseSummary> {
  const id = input.id.trim();
  if (!id) throw new CosmosArmError(400, null, 'database id is required');
  const options: any = {};
  if (input.maxThroughput) options.autoscaleSettings = { maxThroughput: input.maxThroughput };
  else if (input.throughput) options.throughput = input.throughput;
  const body = { properties: { resource: { id }, options } };
  const res = await armFetch(`/sqlDatabases/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) {
    await readJson<unknown>(res); // throws CosmosArmError with ARM message
  }
  await waitForProvisioned(`/sqlDatabases/${encodeURIComponent(id)}`);
  return { id, name: id };
}

export async function deleteSqlDatabase(db: string): Promise<void> {
  const res = await armFetch(`/sqlDatabases/${encodeURIComponent(db)}`, { method: 'DELETE' });
  if (res.status === 404 || res.ok || res.status === 204) {
    if (res.status === 202) await waitForProvisioned(`/sqlDatabases/${encodeURIComponent(db)}`);
    return;
  }
  if (res.status === 202) { await waitForProvisioned(`/sqlDatabases/${encodeURIComponent(db)}`); return; }
  await readJson<unknown>(res);
}

// ---------------------------------------------------------------------------
// Containers (collections)
// ---------------------------------------------------------------------------

export interface ContainerSummary {
  id: string;
  name: string;
  partitionKey?: string;
  partitionKeyKind?: string;
  defaultTtl?: number | null;
  throughput?: ThroughputInfo;
}

function shapeContainer(raw: any): ContainerSummary {
  const r = raw?.properties?.resource || {};
  const pkPaths: string[] = r.partitionKey?.paths || [];
  return {
    id: raw?.id,
    name: raw?.name ?? r.id,
    partitionKey: pkPaths[0],
    partitionKeyKind: r.partitionKey?.kind,
    defaultTtl: typeof r.defaultTtl === 'number' ? r.defaultTtl : null,
  };
}

export async function listContainers(db: string, opts: { withThroughput?: boolean } = {}): Promise<ContainerSummary[]> {
  const res = await armFetch(`/sqlDatabases/${encodeURIComponent(db)}/containers`);
  const j = await readJson<{ value: any[] }>(res);
  const containers = (j?.value || []).map(shapeContainer);
  if (opts.withThroughput) {
    await Promise.all(
      containers.map(async (c) => {
        c.throughput = await readThroughput(
          `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(c.name)}`,
        );
      }),
    );
  }
  return containers;
}

export interface CreateContainerInput {
  id: string;
  /** Partition key path, e.g. /id or /tenantId (required by Cosmos NoSQL). */
  partitionKey: string;
  /** Manual dedicated RU/s for the container. */
  throughput?: number;
  /** Autoscale max RU/s (mutually exclusive with throughput). */
  maxThroughput?: number;
}

export async function createContainer(db: string, input: CreateContainerInput): Promise<ContainerSummary> {
  const id = input.id.trim();
  if (!id) throw new CosmosArmError(400, null, 'container id is required');
  let pk = (input.partitionKey || '').trim();
  if (!pk) throw new CosmosArmError(400, null, 'partition key is required');
  if (!pk.startsWith('/')) pk = `/${pk}`;
  const options: any = {};
  if (input.maxThroughput) options.autoscaleSettings = { maxThroughput: input.maxThroughput };
  else if (input.throughput) options.throughput = input.throughput;
  const body = {
    properties: {
      resource: {
        id,
        partitionKey: { paths: [pk], kind: 'Hash', version: 2 },
      },
      options,
    },
  };
  const path = `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(id)}`;
  const res = await armFetch(path, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok && res.status !== 202) {
    await readJson<unknown>(res);
  }
  await waitForProvisioned(path);
  return { id, name: id, partitionKey: pk, partitionKeyKind: 'Hash' };
}

export async function deleteContainer(db: string, container: string): Promise<void> {
  const path = `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}`;
  const res = await armFetch(path, { method: 'DELETE' });
  if (res.status === 404 || res.ok || res.status === 204) {
    if (res.status === 202) await waitForProvisioned(path);
    return;
  }
  if (res.status === 202) { await waitForProvisioned(path); return; }
  await readJson<unknown>(res);
}

// ---------------------------------------------------------------------------
// Server-side scripts — stored procedures / triggers / UDFs (read-only)
//
// Authoring/executing scripts is a rich JS editor surface (data-plane); the
// navigator lists them so the tree mirrors the portal's Data Explorer
// "Scripts" node. Create/edit is an honest "coming" row in the UI.
// ---------------------------------------------------------------------------

export interface StoredProcedureSummary { id: string; name: string }
export interface TriggerSummary { id: string; name: string; triggerType?: string; triggerOperation?: string }
export interface UdfSummary { id: string; name: string }

export async function listStoredProcedures(db: string, container: string): Promise<StoredProcedureSummary[]> {
  const res = await armFetch(
    `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}/storedProcedures`,
  );
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map((raw) => ({ id: raw?.id, name: raw?.name ?? raw?.properties?.resource?.id }));
}

export async function listTriggers(db: string, container: string): Promise<TriggerSummary[]> {
  const res = await armFetch(
    `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}/triggers`,
  );
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map((raw) => {
    const r = raw?.properties?.resource || {};
    return { id: raw?.id, name: raw?.name ?? r.id, triggerType: r.triggerType, triggerOperation: r.triggerOperation };
  });
}

export async function listUserDefinedFunctions(db: string, container: string): Promise<UdfSummary[]> {
  const res = await armFetch(
    `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}/userDefinedFunctions`,
  );
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map((raw) => ({ id: raw?.id, name: raw?.name ?? raw?.properties?.resource?.id }));
}

/** All three script collections for one container, in parallel. */
export async function listContainerScripts(db: string, container: string): Promise<{
  storedProcedures: StoredProcedureSummary[];
  triggers: TriggerSummary[];
  userDefinedFunctions: UdfSummary[];
}> {
  const [storedProcedures, triggers, userDefinedFunctions] = await Promise.all([
    listStoredProcedures(db, container),
    listTriggers(db, container),
    listUserDefinedFunctions(db, container),
  ]);
  return { storedProcedures, triggers, userDefinedFunctions };
}

// ---------------------------------------------------------------------------
// Account info (header chip + sanity probe)
// ---------------------------------------------------------------------------

export interface CosmosAccountInfo {
  name: string;
  location?: string;
  documentEndpoint?: string;
  /** Capabilities (e.g. EnableServerless, EnableGremlin) reported by ARM. */
  capabilities: string[];
  /** True when the account is serverless (no RU/s dials). */
  serverless: boolean;
  provisioningState?: string;
  enableFreeTier?: boolean;
  /**
   * True when the account disables key/connection-string (local) auth. ARM
   * still RETURNS the master keys via listKeys, but the data plane rejects them
   * — only AAD/RBAC tokens authenticate. The Connect panel discloses this so
   * operators don't try to use keys that will be refused at the data plane.
   */
  disableLocalAuth?: boolean;
}

export async function getAccountInfo(): Promise<CosmosAccountInfo | null> {
  const res = await armFetch('');
  const j = await readJson<any>(res);
  if (!j) return null;
  const caps: string[] = (j?.properties?.capabilities || []).map((c: any) => c?.name).filter(Boolean);
  return {
    name: j?.name,
    location: j?.location,
    documentEndpoint: j?.properties?.documentEndpoint,
    capabilities: caps,
    serverless: caps.includes('EnableServerless'),
    provisioningState: j?.properties?.provisioningState,
    enableFreeTier: j?.properties?.enableFreeTier,
    disableLocalAuth: j?.properties?.disableLocalAuth === true,
  };
}

// ---------------------------------------------------------------------------
// Keys & connection strings (Connect panel) — ARM control-plane key actions.
//
// listKeys / listConnectionStrings / regenerateKey are POST actions on the
// account. They require Microsoft.DocumentDB/databaseAccounts/listKeys/action
// (and …/listConnectionStrings/action), which "DocumentDB Account Contributor"
// (5bd9cd88-…) grants via the databaseAccounts/* wildcard. "Cosmos DB Operator"
// (230815da-…) does NOT — it explicitly excludes key access. A UAMI without the
// action gets ARM 403, surfaced by the BFF as an honest role gate.
// Learn: https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts
// ---------------------------------------------------------------------------

export interface CosmosAccountKeys {
  primaryMasterKey: string;
  secondaryMasterKey: string;
  primaryReadonlyMasterKey: string;
  secondaryReadonlyMasterKey: string;
}

export interface CosmosConnectionString {
  /** The full connection string (AccountEndpoint=…;AccountKey=…;). */
  connectionString: string;
  /** ARM-supplied label, e.g. "Primary SQL Connection String". */
  description: string;
  /** Mongo/Gremlin/Cassandra/Table strings carry the API kind on newer ARM. */
  keyKind?: string;
  type?: string;
}

export type CosmosKeyKind = 'primary' | 'secondary' | 'primaryReadonly' | 'secondaryReadonly';

/**
 * Account data-plane endpoint, preferring ARM's reported documentEndpoint and
 * falling back to the cloud-correct host built from getCosmosSuffix() (the
 * canonical sovereign suffix — documents.azure.com / documents.azure.us).
 */
export function accountEndpointFallback(documentEndpoint?: string): string {
  if (documentEndpoint) return documentEndpoint;
  const acct = required('LOOM_COSMOS_ACCOUNT');
  return `https://${acct}.${getCosmosSuffix()}:443/`;
}

/** POST …/listKeys — the four master keys (read-write + read-only pairs). */
export async function listAccountKeys(): Promise<CosmosAccountKeys> {
  const res = await armFetch('/listKeys', { method: 'POST' });
  const j = await readJson<any>(res);
  return {
    primaryMasterKey: j?.primaryMasterKey ?? '',
    secondaryMasterKey: j?.secondaryMasterKey ?? '',
    primaryReadonlyMasterKey: j?.primaryReadonlyMasterKey ?? '',
    secondaryReadonlyMasterKey: j?.secondaryReadonlyMasterKey ?? '',
  };
}

/**
 * POST …/listConnectionStrings — ARM returns every enabled API's connection
 * strings in one call (SQL/NoSQL always; Mongo when EnableMongo; Gremlin when
 * EnableGremlin; etc.), each labeled by `description`. The embedded endpoint is
 * already cloud-correct — no manual suffix assembly.
 */
export async function listConnectionStrings(): Promise<CosmosConnectionString[]> {
  const res = await armFetch('/listConnectionStrings', { method: 'POST' });
  const j = await readJson<{ connectionStrings?: any[] }>(res);
  return (j?.connectionStrings || []).map((c) => ({
    connectionString: c?.connectionString ?? '',
    description: c?.description ?? 'Connection String',
    keyKind: c?.keyKind,
    type: c?.type,
  }));
}

/**
 * POST …/regenerateKey — rotate one of the four keys. ARM runs this async
 * (202 + Azure-AsyncOperation); we don't block on completion (the new key is
 * fetched by the caller via a fresh listKeys). Throws CosmosArmError on a
 * non-2xx/202 (e.g. 403 when the UAMI lacks the action).
 */
export async function regenerateKey(keyKind: CosmosKeyKind): Promise<void> {
  const res = await armFetch('/regenerateKey', {
    method: 'POST',
    body: JSON.stringify({ keyKind }),
  });
  if (res.ok || res.status === 202) return;
  await readJson<unknown>(res); // throws CosmosArmError with ARM's message
}
