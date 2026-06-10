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

/**
 * ARM resource id for the configured Cosmos DB navigator account (no
 * api-version / trailing path). Used by the metrics route to build the Azure
 * Monitor `…/providers/microsoft.insights/metrics` URL without duplicating the
 * env-var resolution. Throws when LOOM_SUBSCRIPTION_ID / LOOM_COSMOS_ACCOUNT_RG
 * / LOOM_COSMOS_ACCOUNT are unset (callers gate with cosmosConfigGate first).
 */
export function cosmosAccountResourceId(): string {
  return accountBase();
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

// ---------------------------------------------------------------------------
// Indexing policy / unique-key policy shapes (form-driven; no raw JSON).
// Grounded in Microsoft.DocumentDB sqlContainers resource (api 2024-11-15):
//   properties.resource.indexingPolicy   { indexingMode, automatic,
//                                           includedPaths[], excludedPaths[],
//                                           compositeIndexes[][] }
//   properties.resource.uniqueKeyPolicy  { uniqueKeys[] { paths[] } }
// ---------------------------------------------------------------------------

export interface IndexingPath { path: string }
export interface CompositePath { path: string; order?: 'ascending' | 'descending' }
export interface CosmosIndexingPolicy {
  indexingMode: 'consistent' | 'lazy' | 'none';
  automatic: boolean;
  includedPaths: IndexingPath[];
  excludedPaths: IndexingPath[];
  /** Each inner array is one composite-index group (ordered paths). */
  compositeIndexes: CompositePath[][];
}
export interface CosmosUniqueKeyPolicy {
  uniqueKeys: { paths: string[] }[];
}

/** ARM ConflictResolutionPolicy shape (properties.resource.conflictResolutionPolicy).
 *  mode 'LastWriterWins' — uses conflictResolutionPath (defaults to "/_ts"; any
 *    numeric property path works; highest value wins).
 *  mode 'Custom' — uses conflictResolutionProcedure (stored-proc resource id;
 *    may be empty, in which case unresolved conflicts accumulate in the
 *    container's conflicts feed for the app to drain).
 *  Conflicts only actually occur when the account has
 *  enableMultipleWriteLocations:true; the policy is stored on every container
 *  regardless and can be read/edited on any account.
 *  Source: https://learn.microsoft.com/azure/cosmos-db/conflict-resolution-policies
 */
export interface CosmosConflictResolutionPolicy {
  mode: 'LastWriterWins' | 'Custom';
  /** LWW only. Path to a numeric property; highest value wins. Defaults to "/_ts". */
  conflictResolutionPath?: string;
  /** Custom mode only. Stored-procedure resource id (may be empty — means conflicts feed). */
  conflictResolutionProcedure?: string;
}

/** ContainerSummary + the policies the Settings panel edits. */
export interface ContainerDetail extends ContainerSummary {
  indexingPolicy?: CosmosIndexingPolicy;
  uniqueKeyPolicy?: CosmosUniqueKeyPolicy;
  conflictResolutionPolicy?: CosmosConflictResolutionPolicy;
}

function shapeIndexingPolicy(raw: any): CosmosIndexingPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const composite: CompositePath[][] = Array.isArray(raw.compositeIndexes)
    ? raw.compositeIndexes.map((group: any[]) =>
        (group || []).map((p: any) => ({
          path: p?.path,
          order: p?.order === 'descending' ? 'descending' : 'ascending',
        })),
      )
    : [];
  return {
    indexingMode: (raw.indexingMode || 'consistent').toString().toLowerCase() as CosmosIndexingPolicy['indexingMode'],
    automatic: raw.automatic !== false,
    includedPaths: Array.isArray(raw.includedPaths) ? raw.includedPaths.map((p: any) => ({ path: p?.path })).filter((p: IndexingPath) => p.path) : [],
    excludedPaths: Array.isArray(raw.excludedPaths) ? raw.excludedPaths.map((p: any) => ({ path: p?.path })).filter((p: IndexingPath) => p.path) : [],
    compositeIndexes: composite,
  };
}

function shapeUniqueKeyPolicy(raw: any): CosmosUniqueKeyPolicy | undefined {
  if (!raw || !Array.isArray(raw.uniqueKeys)) return undefined;
  return {
    uniqueKeys: raw.uniqueKeys.map((k: any) => ({ paths: Array.isArray(k?.paths) ? k.paths : [] })),
  };
}

function shapeConflictResolutionPolicy(raw: any): CosmosConflictResolutionPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const mode = raw.mode === 'Custom' ? 'Custom' : 'LastWriterWins';
  return {
    mode,
    conflictResolutionPath: raw.conflictResolutionPath || undefined,
    conflictResolutionProcedure: raw.conflictResolutionProcedure || undefined,
  };
}

/** Build the ARM `properties.resource.conflictResolutionPolicy` payload. */
function conflictResolutionPolicyToArm(p: CosmosConflictResolutionPolicy): any {
  if (p.mode === 'Custom') {
    return {
      mode: 'Custom',
      conflictResolutionProcedure: (p.conflictResolutionProcedure || '').trim(),
    };
  }
  return {
    mode: 'LastWriterWins',
    conflictResolutionPath: (p.conflictResolutionPath || '').trim() || '/_ts',
  };
}

/** Build the ARM `properties.resource.indexingPolicy` payload (no raw JSON). */
function indexingPolicyToArm(p: CosmosIndexingPolicy): any {
  const out: any = {
    indexingMode: p.indexingMode,
    automatic: p.automatic,
    includedPaths: (p.includedPaths || []).filter((x) => x.path?.trim()).map((x) => ({ path: x.path.trim() })),
    excludedPaths: (p.excludedPaths || []).filter((x) => x.path?.trim()).map((x) => ({ path: x.path.trim() })),
  };
  const composite = (p.compositeIndexes || [])
    .map((group) => (group || []).filter((x) => x.path?.trim()).map((x) => ({ path: x.path.trim(), order: x.order || 'ascending' })))
    .filter((group) => group.length > 0);
  if (composite.length) out.compositeIndexes = composite;
  return out;
}

/** Build the ARM `properties.resource.uniqueKeyPolicy` payload, or undefined. */
function uniqueKeyPolicyToArm(p?: CosmosUniqueKeyPolicy): any | undefined {
  if (!p) return undefined;
  const keys = (p.uniqueKeys || [])
    .map((k) => ({ paths: (k.paths || []).map((x) => (x?.trim().startsWith('/') ? x.trim() : `/${x?.trim()}`)).filter(Boolean) }))
    .filter((k) => k.paths.length > 0);
  if (!keys.length) return undefined;
  return { uniqueKeys: keys };
}

export interface CreateContainerInput {
  id: string;
  /** Partition key path, e.g. /id or /tenantId (required by Cosmos NoSQL). */
  partitionKey: string;
  /** Manual dedicated RU/s for the container. */
  throughput?: number;
  /** Autoscale max RU/s (mutually exclusive with throughput). */
  maxThroughput?: number;
  /** Default TTL: -1 = on (per-item only); positive = on with default seconds; omit = off. */
  defaultTtl?: number;
  /** Custom indexing policy (form-built; replaces the Cosmos default when present). */
  indexingPolicy?: CosmosIndexingPolicy;
  /** Unique-key constraints — set ONLY at creation time (immutable afterwards). */
  uniqueKeyPolicy?: CosmosUniqueKeyPolicy;
  /** Conflict-resolution policy (LWW path / Custom sproc). Editable post-create too. */
  conflictResolutionPolicy?: CosmosConflictResolutionPolicy;
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
  const resource: any = {
    id,
    partitionKey: { paths: [pk], kind: 'Hash', version: 2 },
  };
  if (typeof input.defaultTtl === 'number') resource.defaultTtl = input.defaultTtl;
  if (input.indexingPolicy) resource.indexingPolicy = indexingPolicyToArm(input.indexingPolicy);
  const uk = uniqueKeyPolicyToArm(input.uniqueKeyPolicy);
  if (uk) resource.uniqueKeyPolicy = uk;
  if (input.conflictResolutionPolicy) resource.conflictResolutionPolicy = conflictResolutionPolicyToArm(input.conflictResolutionPolicy);
  const body = { properties: { resource, options } };
  const path = `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(id)}`;
  const res = await armFetch(path, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok && res.status !== 202) {
    await readJson<unknown>(res);
  }
  await waitForProvisioned(path);
  return { id, name: id, partitionKey: pk, partitionKeyKind: 'Hash', defaultTtl: typeof input.defaultTtl === 'number' ? input.defaultTtl : null };
}

/**
 * Read a single container's full control-plane shape (the Settings "receipt"):
 * partition key, defaultTtl, indexing policy, unique-key policy, and live
 * throughput. Returns null when the container does not exist (404).
 */
export async function getContainer(db: string, container: string): Promise<ContainerDetail | null> {
  const path = `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}`;
  const res = await armFetch(path);
  const j = await readJson<any>(res);
  if (!j) return null;
  const r = j?.properties?.resource || {};
  const base = shapeContainer(j);
  const throughput = await readThroughput(path);
  return {
    ...base,
    throughput,
    indexingPolicy: shapeIndexingPolicy(r.indexingPolicy),
    uniqueKeyPolicy: shapeUniqueKeyPolicy(r.uniqueKeyPolicy),
    conflictResolutionPolicy: shapeConflictResolutionPolicy(r.conflictResolutionPolicy),
  };
}

export interface UpdateContainerSettingsInput {
  /** undefined = leave unchanged; null = TTL off; -1 = on/per-item; >0 = on/seconds. */
  defaultTtl?: number | null;
  /** New indexing policy (replaces the current one when present). */
  indexingPolicy?: CosmosIndexingPolicy;
  /** New conflict-resolution policy (replaces the current one when present). */
  conflictResolutionPolicy?: CosmosConflictResolutionPolicy;
}

/**
 * Update a container's TTL and/or indexing policy via a full-resource PUT.
 * Preserves id / partitionKey / uniqueKeyPolicy and any other resource fields
 * (uniqueKeyPolicy is immutable, so it is read back and re-sent verbatim).
 */
export async function updateContainerSettings(
  db: string,
  container: string,
  input: UpdateContainerSettingsInput,
): Promise<ContainerDetail> {
  const path = `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}`;
  const getRes = await armFetch(path);
  const current = await readJson<any>(getRes);
  if (!current) throw new CosmosArmError(404, null, `container ${db}/${container} not found`);
  // Start from the live resource, stripping the system (_-prefixed) fields ARM rejects on PUT.
  const resource: any = { ...(current?.properties?.resource || {}) };
  for (const k of Object.keys(resource)) { if (k.startsWith('_')) delete resource[k]; }
  if (input.indexingPolicy) resource.indexingPolicy = indexingPolicyToArm(input.indexingPolicy);
  if (input.conflictResolutionPolicy) resource.conflictResolutionPolicy = conflictResolutionPolicyToArm(input.conflictResolutionPolicy);
  if (input.defaultTtl === null) {
    delete resource.defaultTtl; // omitted body = TTL off
  } else if (typeof input.defaultTtl === 'number') {
    resource.defaultTtl = input.defaultTtl;
  }
  const body = { properties: { resource } };
  const res = await armFetch(path, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok && res.status !== 202) {
    await readJson<unknown>(res);
  }
  await waitForProvisioned(path);
  const detail = await getContainer(db, container);
  if (!detail) throw new CosmosArmError(500, null, 'container update succeeded but re-read returned nothing');
  return detail;
}

/** Read the container's live throughput (manual RU / autoscale max / serverless). */
export async function getContainerThroughput(db: string, container: string): Promise<ThroughputInfo> {
  return readThroughput(`/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}`);
}

/**
 * Change a container's provisioned throughput **within its current mode**.
 * Switching mode (manual↔autoscale) requires the migrate actions below — a
 * plain PUT cannot change the mode (ARM returns 400).
 */
export async function updateContainerThroughput(
  db: string,
  container: string,
  mode: 'manual' | 'autoscale',
  value: number,
): Promise<ThroughputInfo> {
  if (!(value > 0)) throw new CosmosArmError(400, null, 'throughput value must be a positive number');
  const tpPath = `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}/throughputSettings/default`;
  const resource = mode === 'autoscale'
    ? { autoscaleSettings: { maxThroughput: value } }
    : { throughput: value };
  const res = await armFetch(tpPath, { method: 'PUT', body: JSON.stringify({ properties: { resource } }) });
  if (!res.ok && res.status !== 202) {
    await readJson<unknown>(res);
  }
  await waitForProvisioned(tpPath);
  return getContainerThroughput(db, container);
}

/** Migrate a container's throughput from manual → autoscale (long-running 202). */
export async function migrateContainerToAutoscale(db: string, container: string): Promise<ThroughputInfo> {
  return migrateContainerThroughput(db, container, 'migrateToAutoscale');
}

/** Migrate a container's throughput from autoscale → manual (long-running 202). */
export async function migrateContainerToManual(db: string, container: string): Promise<ThroughputInfo> {
  return migrateContainerThroughput(db, container, 'migrateToManualThroughput');
}

async function migrateContainerThroughput(
  db: string,
  container: string,
  action: 'migrateToAutoscale' | 'migrateToManualThroughput',
): Promise<ThroughputInfo> {
  const base = `/sqlDatabases/${encodeURIComponent(db)}/containers/${encodeURIComponent(container)}/throughputSettings/default`;
  const res = await armFetch(`${base}/${action}`, { method: 'POST' });
  if (!res.ok && res.status !== 202) {
    await readJson<unknown>(res);
  }
  // The migrate action is async; poll the throughputSettings resource until settled.
  await waitForProvisioned(base);
  return getContainerThroughput(db, container);
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
// Server-side scripts — create / read-body / delete (authoring)
//
// Authoring runs on the SAME ARM control plane as the read-only list above
// (api-version 2024-11-15), grounded in Microsoft Learn:
//   …/storedProcedures/{name}        PUT { properties:{ resource:{ id, body }, options:{} } }
//   …/triggers/{name}               PUT { properties:{ resource:{ id, body,
//                                          triggerType, triggerOperation }, options:{} } }
//   …/userDefinedFunctions/{name}    PUT { properties:{ resource:{ id, body }, options:{} } }
//   GET on each leaf returns { properties:{ resource:{ id, body, … } } }
//   DELETE on each leaf removes it (same async 202 + waitForProvisioned path
//   as containers).
//
// ARM RBAC: the "DocumentDB Account Contributor" role (5bd9cd88-…) the
// navigator already requires covers `Microsoft.DocumentDB/databaseAccounts/*`,
// which includes the storedProcedures / triggers / userDefinedFunctions
// sub-resources — no extra role assignment is needed for authoring. (Executing
// a stored procedure is a DATA-plane call handled by cosmos-data-client.ts and
// needs the Cosmos data-plane RBAC role, same as the Items tab.)
// ---------------------------------------------------------------------------

export interface StoredProcedureDetail extends StoredProcedureSummary { body: string }
export interface TriggerDetail extends TriggerSummary { body: string }
export interface UdfDetail extends UdfSummary { body: string }

export interface CreateStoredProcedureInput { id: string; body: string }
export interface CreateTriggerInput {
  id: string;
  body: string;
  triggerType: 'Pre' | 'Post';
  triggerOperation: 'All' | 'Create' | 'Delete' | 'Replace' | 'Update';
}
export interface CreateUdfInput { id: string; body: string }

function scriptLeafPath(db: string, container: string, leaf: string, name: string): string {
  return (
    `/sqlDatabases/${encodeURIComponent(db)}` +
    `/containers/${encodeURIComponent(container)}` +
    `/${leaf}/${encodeURIComponent(name)}`
  );
}

// --- Stored procedures ---

export async function getStoredProcedure(db: string, container: string, name: string): Promise<StoredProcedureDetail | null> {
  const res = await armFetch(scriptLeafPath(db, container, 'storedProcedures', name));
  const j = await readJson<any>(res);
  if (!j) return null;
  const r = j?.properties?.resource || {};
  return { id: j?.id, name: j?.name ?? r.id, body: r.body ?? '' };
}

export async function upsertStoredProcedure(db: string, container: string, input: CreateStoredProcedureInput): Promise<StoredProcedureDetail> {
  const path = scriptLeafPath(db, container, 'storedProcedures', input.id);
  const res = await armFetch(path, {
    method: 'PUT',
    body: JSON.stringify({ properties: { resource: { id: input.id, body: input.body }, options: {} } }),
  });
  if (!res.ok && res.status !== 202) await readJson<unknown>(res);
  await waitForProvisioned(path);
  const detail = await getStoredProcedure(db, container, input.id);
  return detail ?? { id: input.id, name: input.id, body: input.body };
}

export async function deleteStoredProcedure(db: string, container: string, name: string): Promise<void> {
  await deleteScriptLeaf(scriptLeafPath(db, container, 'storedProcedures', name));
}

// --- Triggers ---

export async function getTrigger(db: string, container: string, name: string): Promise<TriggerDetail | null> {
  const res = await armFetch(scriptLeafPath(db, container, 'triggers', name));
  const j = await readJson<any>(res);
  if (!j) return null;
  const r = j?.properties?.resource || {};
  return {
    id: j?.id, name: j?.name ?? r.id, body: r.body ?? '',
    triggerType: r.triggerType, triggerOperation: r.triggerOperation,
  };
}

export async function upsertTrigger(db: string, container: string, input: CreateTriggerInput): Promise<TriggerDetail> {
  const path = scriptLeafPath(db, container, 'triggers', input.id);
  const res = await armFetch(path, {
    method: 'PUT',
    body: JSON.stringify({
      properties: {
        resource: {
          id: input.id,
          body: input.body,
          triggerType: input.triggerType,
          triggerOperation: input.triggerOperation,
        },
        options: {},
      },
    }),
  });
  if (!res.ok && res.status !== 202) await readJson<unknown>(res);
  await waitForProvisioned(path);
  const detail = await getTrigger(db, container, input.id);
  return detail ?? {
    id: input.id, name: input.id, body: input.body,
    triggerType: input.triggerType, triggerOperation: input.triggerOperation,
  };
}

export async function deleteTrigger(db: string, container: string, name: string): Promise<void> {
  await deleteScriptLeaf(scriptLeafPath(db, container, 'triggers', name));
}

// --- User-defined functions ---

export async function getUdf(db: string, container: string, name: string): Promise<UdfDetail | null> {
  const res = await armFetch(scriptLeafPath(db, container, 'userDefinedFunctions', name));
  const j = await readJson<any>(res);
  if (!j) return null;
  const r = j?.properties?.resource || {};
  return { id: j?.id, name: j?.name ?? r.id, body: r.body ?? '' };
}

export async function upsertUdf(db: string, container: string, input: CreateUdfInput): Promise<UdfDetail> {
  const path = scriptLeafPath(db, container, 'userDefinedFunctions', input.id);
  const res = await armFetch(path, {
    method: 'PUT',
    body: JSON.stringify({ properties: { resource: { id: input.id, body: input.body }, options: {} } }),
  });
  if (!res.ok && res.status !== 202) await readJson<unknown>(res);
  await waitForProvisioned(path);
  const detail = await getUdf(db, container, input.id);
  return detail ?? { id: input.id, name: input.id, body: input.body };
}

export async function deleteUdf(db: string, container: string, name: string): Promise<void> {
  await deleteScriptLeaf(scriptLeafPath(db, container, 'userDefinedFunctions', name));
}

/** Shared DELETE + async-poll for any script leaf (same shape as deleteContainer). */
async function deleteScriptLeaf(path: string): Promise<void> {
  const res = await armFetch(path, { method: 'DELETE' });
  if (res.status === 404 || res.ok || res.status === 204) {
    if (res.status === 202) await waitForProvisioned(path);
    return;
  }
  if (res.status === 202) { await waitForProvisioned(path); return; }
  await readJson<unknown>(res);
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
