/**
 * Azure SQL Database family client — TDS query against
 * <server>.database.windows.net (Commercial) or .database.usgovcloudapi.net
 * (Gov), plus ARM REST for server/database/MI listing, mirroring, and
 * geo-replication wiring.
 *
 * Auth: console UAMI via ChainedTokenCredential (same pattern as
 * synapse-sql-client). The UAMI must be granted as an AAD-only admin on
 * each Azure SQL server it queries, and Reader at the subscription level
 * for the listing calls.
 *
 * v3.0 scope:
 *   - listServers / listDatabases / getDatabase           — ARM REST
 *   - listManagedInstances                                — ARM REST (list-only)
 *   - executeQuery(server, database, sql)                 — TDS + AAD token
 *   - enableMirroring(server, db)                         — Azure-native change replication: runs the REAL `sys.sp_change_feed_enable_db` DDL (the CDC primitive Fabric mirroring consumes, but it is an Azure SQL feature). NO Microsoft Fabric workspace and NO `LOOM_*_LIVE` flag is required — the Azure-native path is the default. Captured changes are landed to ADLS Bronze by the Loom mirroring engine (lib/azure/mirror-engine.ts).
 *   - enableReplication(server, db, replica)              — ARM create geo-secondary
 *   - enableSqlServer2025Features(server, db)             — runs SET options for JSON_AGG / regex / vector (no-op on SQL Server 2022 or older — caller gets a MessageBar).
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import sql from 'mssql';
import { armBase, getSqlSuffix } from './cloud-endpoints';

function arm(): string {
  // Sovereign-cloud ARM base (cloud-endpoints honors LOOM_ARM_ENDPOINT + AZURE_CLOUD).
  // Commercial: ARM commercial host   Gov: management.usgovcloudapi.net
  return armBase();
}

function sqlHostSuffix(): string {
  // LOOM_AZURE_SQL_HOST_SUFFIX: explicit per-instance override (rare edge cases).
  // Default: cloud-aware from LOOM_CLOUD / AZURE_CLOUD via getSqlSuffix().
  //   Commercial / GCC      → database.windows.net
  //   GCC-High / IL5 / DoD  → database.usgovcloudapi.net
  return process.env.LOOM_AZURE_SQL_HOST_SUFFIX || getSqlSuffix();
}

/** TDS AAD token scope, cloud-correct (https://<sql-suffix>/.default). */
function sqlScope(): string {
  return `https://${sqlHostSuffix()}/.default`;
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class AzureSqlError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AzureSqlError';
    this.status = status;
    this.body = body;
  }
}

async function armToken(): Promise<string> {
  const t = await credential.getToken(`${arm()}/.default`);
  if (!t?.token) throw new AzureSqlError('Failed to acquire AAD token for ARM', 401);
  return t.token;
}

async function armRequest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await armToken();
  const url = `${arm()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || 'ARM call failed').toString();
    throw new AzureSqlError(msg, res.status, json || text);
  }
  return json as T;
}

// ============================================================
// Listing (ARM)
// ============================================================

export interface AzureSqlServer {
  id: string;
  name: string;
  location: string;
  fqdn: string;
  state?: string;
  administratorLogin?: string;
  publicNetworkAccess?: 'Enabled' | 'Disabled';
  version?: string;
}

export async function listServers(subscriptionId?: string): Promise<AzureSqlServer[]> {
  const sub = subscriptionId || process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) throw new AzureSqlError('LOOM_SUBSCRIPTION_ID not set', 400);
  const res = await armRequest<{ value: any[] }>(
    `/subscriptions/${sub}/providers/Microsoft.Sql/servers?api-version=2023-08-01-preview`,
  );
  return (res.value || []).map((s) => ({
    id: s.id,
    name: s.name,
    location: s.location,
    fqdn: s.properties?.fullyQualifiedDomainName || `${s.name}.${sqlHostSuffix()}`,
    state: s.properties?.state,
    administratorLogin: s.properties?.administratorLogin,
    publicNetworkAccess: s.properties?.publicNetworkAccess,
    version: s.properties?.version,
  }));
}

export interface AzureSqlDatabase {
  id: string;
  name: string;
  location: string;
  sku?: { name: string; tier: string; family?: string; capacity?: number };
  status?: string;
  maxSizeBytes?: number;
  collation?: string;
  createMode?: string;
  zoneRedundant?: boolean;
  /** Serverless auto-pause delay in minutes (-1 = never pause). GP serverless only. */
  autoPauseDelay?: number;
  /** Serverless minimum vCores. GP serverless only. */
  minCapacity?: number;
}

export async function listDatabases(serverIdOrName: string): Promise<AzureSqlDatabase[]> {
  const path = serverIdOrName.startsWith('/')
    ? `${serverIdOrName}/databases?api-version=2023-08-01-preview`
    : await defaultServerScopePath(serverIdOrName, 'databases');
  const res = await armRequest<{ value: any[] }>(path);
  return (res.value || [])
    .filter((d) => d.name !== 'master')
    .map((d) => ({
      id: d.id,
      name: d.name,
      location: d.location,
      sku: d.sku ? { name: d.sku.name, tier: d.sku.tier, family: d.sku.family, capacity: d.sku.capacity } : undefined,
      status: d.properties?.status,
      maxSizeBytes: d.properties?.maxSizeBytes,
      collation: d.properties?.collation,
      createMode: d.properties?.createMode,
      zoneRedundant: d.properties?.zoneRedundant,
      autoPauseDelay: d.properties?.autoPauseDelay,
      minCapacity: d.properties?.minCapacity,
    }));
}

export async function getDatabase(serverIdOrName: string, dbName: string): Promise<AzureSqlDatabase> {
  const base = serverIdOrName.startsWith('/')
    ? serverIdOrName
    : await defaultServerScope(serverIdOrName);
  const res = await armRequest<any>(`${base}/databases/${encodeURIComponent(dbName)}?api-version=2023-08-01-preview`);
  return {
    id: res.id,
    name: res.name,
    location: res.location,
    sku: res.sku ? { name: res.sku.name, tier: res.sku.tier, family: res.sku.family, capacity: res.sku.capacity } : undefined,
    status: res.properties?.status,
    maxSizeBytes: res.properties?.maxSizeBytes,
    collation: res.properties?.collation,
    createMode: res.properties?.createMode,
    zoneRedundant: res.properties?.zoneRedundant,
    autoPauseDelay: res.properties?.autoPauseDelay,
    minCapacity: res.properties?.minCapacity,
  };
}

export interface ManagedInstance {
  id: string;
  name: string;
  location: string;
  state?: string;
  fqdn?: string;
  sku?: { name: string; tier: string };
}

export async function listManagedInstances(subscriptionId?: string): Promise<ManagedInstance[]> {
  const sub = subscriptionId || process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) throw new AzureSqlError('LOOM_SUBSCRIPTION_ID not set', 400);
  const res = await armRequest<{ value: any[] }>(
    `/subscriptions/${sub}/providers/Microsoft.Sql/managedInstances?api-version=2023-08-01-preview`,
  );
  return (res.value || []).map((m) => ({
    id: m.id,
    name: m.name,
    location: m.location,
    state: m.properties?.state,
    fqdn: m.properties?.fullyQualifiedDomainName,
    sku: m.sku ? { name: m.sku.name, tier: m.sku.tier } : undefined,
  }));
}

// ============================================================
// Database provisioning (ARM PUT — Microsoft.Sql/servers/databases)
// ============================================================

export interface CreateDatabaseSpec {
  /** Existing logical server name or ARM id to create the DB on. */
  server: string;
  /** New database name. */
  name: string;
  /** Region — defaults to the server's region when omitted. */
  location?: string;
  /** Service objective / SKU name (e.g. GP_S_Gen5_2, S0, Basic). */
  skuName?: string;
  /** Tier (Basic | Standard | Premium | GeneralPurpose | BusinessCritical | Hyperscale). */
  tier?: string;
  /** Sample schema to seed (AdventureWorksLT). */
  sampleName?: string;
  /** Zone redundancy. */
  zoneRedundant?: boolean;
  maxSizeBytes?: number;
  /** Database collation. Default applied by ARM: SQL_Latin1_General_CP1_CI_AS.
   *  Set at create time only; immutable after the database exists. */
  collation?: string;
  /** Backup storage redundancy. ARM validates against region/tier availability. */
  requestedBackupStorageRedundancy?: 'Geo' | 'GeoZone' | 'Local' | 'Zone';
  /** Full ARM resource ID of a public maintenance configuration (SQLDB scope).
   *  Use listDbMaintenanceConfigs() to discover valid IDs for the server's
   *  region. Only honored on vCore tiers (GP, BC, HS). */
  maintenanceConfigurationId?: string;
}

export interface MaintenanceConfig {
  /** Full ARM resource ID — pass as CreateDatabaseSpec.maintenanceConfigurationId. */
  id: string;
  /** Configuration name, e.g. SQL_EastUS2_DB_1. */
  name: string;
  /** Human-friendly window description for the UI dropdown. */
  displayName: string;
}

/**
 * Lists available public maintenance configurations for a given Azure region,
 * scope=SQLDB. Use a returned `id` as `maintenanceConfigurationId` in
 * CreateDatabaseSpec. An empty array means the region publishes no SQLDB
 * windows (the database then uses the System default policy) — that is an
 * honest gate, not an error. Resolves to the sovereign ARM host automatically
 * via armBase() (Commercial / Gov / DoD) with no per-cloud branching here.
 */
export async function listDbMaintenanceConfigs(location: string): Promise<MaintenanceConfig[]> {
  if (!location) return [];
  try {
    const filter = encodeURIComponent(`location eq '${location}' and maintenanceScope eq 'SQLDB'`);
    const res = await armRequest<{ value: any[] }>(
      `/providers/Microsoft.Maintenance/publicMaintenanceConfigurations?api-version=2023-09-01&$filter=${filter}`,
    );
    return (res.value || []).map((c) => {
      const name: string = c.name || '';
      const displayName = name.endsWith('_DB_1')
        ? 'Weekday window (Mon–Thu 10 PM – 6 AM local)'
        : name.endsWith('_DB_2')
          ? 'Weekend window (Fri–Sun 10 PM – 6 AM local)'
          : name;
      return { id: c.id, name, displayName };
    });
  } catch {
    // Maintenance API may be unavailable in a region or boundary; fall back to
    // System default rather than blocking the create flow.
    return [];
  }
}

export async function createDatabase(
  spec: CreateDatabaseSpec,
): Promise<{ ok: true; id: string; status?: string } | { ok: false; error: string; status: number }> {
  if (!spec.server || !spec.name) {
    return { ok: false, error: 'server and name are required', status: 400 };
  }
  try {
    const scope = spec.server.startsWith('/') ? spec.server : await defaultServerScope(spec.server);
    // Resolve the server's region if the caller did not provide one.
    let location = spec.location;
    if (!location) {
      const servers = await listServers();
      location = servers.find((s) => s.id === scope || s.name === spec.server)?.location;
    }
    if (!location) return { ok: false, error: 'location could not be resolved for the target server', status: 400 };
    const path = `${scope}/databases/${encodeURIComponent(spec.name)}?api-version=${SQL_API_VERSION}`;
    const body: any = {
      location,
      properties: {
        ...(spec.sampleName ? { sampleName: spec.sampleName } : {}),
        ...(typeof spec.zoneRedundant === 'boolean' ? { zoneRedundant: spec.zoneRedundant } : {}),
        ...(spec.maxSizeBytes ? { maxSizeBytes: spec.maxSizeBytes } : {}),
        ...(spec.collation ? { collation: spec.collation } : {}),
        ...(spec.requestedBackupStorageRedundancy
          ? { requestedBackupStorageRedundancy: spec.requestedBackupStorageRedundancy }
          : {}),
        ...(spec.maintenanceConfigurationId
          ? { maintenanceConfigurationId: spec.maintenanceConfigurationId }
          : {}),
      },
      ...(spec.skuName ? { sku: { name: spec.skuName, ...(spec.tier ? { tier: spec.tier } : {}) } } : {}),
    };
    const res = await armRequest<any>(path, { method: 'PUT', body: JSON.stringify(body) });
    return { ok: true, id: res?.id || path, status: res?.properties?.status };
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return { ok: false, error: e?.message || String(e), status };
  }
}

async function defaultServerScope(serverName: string): Promise<string> {
  // Resolve a bare server name to a full ARM scope via a subscription-level
  // list. Cached per process for the session lifetime.
  const cache = (defaultServerScope as any)._c as Map<string, string> | undefined;
  const c = cache || new Map<string, string>();
  if (!cache) (defaultServerScope as any)._c = c;
  if (c.has(serverName)) return c.get(serverName)!;
  const servers = await listServers();
  const hit = servers.find((s) => s.name === serverName);
  if (!hit) throw new AzureSqlError(`Server '${serverName}' not found in subscription`, 404);
  c.set(serverName, hit.id);
  return hit.id;
}

async function defaultServerScopePath(serverName: string, suffix: string): Promise<string> {
  const base = await defaultServerScope(serverName);
  return `${base}/${suffix}?api-version=2023-08-01-preview`;
}

// ============================================================
// TDS query path (TDS + AAD)
// ============================================================

const pools: Map<string, sql.ConnectionPool> = new Map();

/**
 * Registry of live mssql `Request` objects, keyed by a caller-supplied request
 * id. The cancel route (`/query/cancel`) looks the request up and calls
 * `.cancel()`, which makes tedious send a TDS ATTENTION packet on the same
 * connection — SQL Server acknowledges (error 3617 / SYS_ATTN) and the in-flight
 * `.query()` promise rejects with `RequestError('Canceled.', 'ECANCEL')`.
 *
 * This is in-process Node.js state scoped to ONE Container App replica. For a
 * scaled-out console the cancel POST must reach the SAME replica that started
 * the query — enable ingress sticky sessions
 * (`ingress.stickySessions.affinity: 'sticky'`) or run a single replica. There
 * is no cross-replica cancel because the mssql connection itself is per-replica.
 *
 * Entries are removed on completion, error, or explicit cancel (in the `finally`
 * of `executeQuery` and in the cancel route after `.cancel()`).
 */
export const liveRequests: Map<string, sql.Request> = new Map();

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
}

const MAX_ROWS = 5_000;

async function getPool(server: string, database: string): Promise<sql.ConnectionPool> {
  const key = `${server}/${database}`;
  const existing = pools.get(key);
  if (existing?.connected) return existing;
  const tok = await credential.getToken(sqlScope());
  if (!tok?.token) throw new AzureSqlError('Failed to acquire AAD token for Azure SQL', 401);
  const host = server.includes('.') ? server : `${server}.${sqlHostSuffix()}`;
  const pool = new sql.ConnectionPool({
    server: host,
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: tok.token },
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 60_000 },
    requestTimeout: 60_000,
    connectionTimeout: 30_000,
  } as sql.config);
  await pool.connect();
  pools.set(key, pool);
  pool.on('error', () => pools.delete(key));
  return pool;
}

export async function executeQuery(
  server: string,
  database: string,
  sqlText: string,
  opts?: { requestId?: string },
): Promise<QueryResult> {
  const started = Date.now();
  const pool = await getPool(server, database);
  const request = pool.request();
  // Register the live Request so the cancel route can send a TDS ATTENTION
  // packet for this exact in-flight query. Registered BEFORE .query() so a
  // cancel that races the start still lands on the right Request.
  if (opts?.requestId) liveRequests.set(opts.requestId, request);
  try {
    const result = await request.query(sqlText);
    const recordset = result.recordset || [];
    const columns = recordset.length ? Object.keys(recordset[0]) : [];
    const rows = recordset.slice(0, MAX_ROWS).map((r: any) => columns.map((c) => r[c]));
    return {
      columns,
      rows,
      rowCount: recordset.length,
      executionMs: Date.now() - started,
      truncated: recordset.length > MAX_ROWS,
    };
  } finally {
    if (opts?.requestId) liveRequests.delete(opts.requestId);
  }
}

// ============================================================
// Batch query (multi-result-set + in-band messages)
// ============================================================

/** Server-side row cap for batch queries — honest "showing first N" in the UI. */
export const MAX_ROWS_BATCH = 10_000;

/** An in-band SQL message (PRINT / RAISERROR severity ≤ 10 / done-with-counts). */
export interface InfoMessage {
  message: string;
  number: number;
  /** SQL severity class: 0 = PRINT/info, 1–10 = warning, > 10 = error. */
  severity: number;
  lineNumber: number;
  serverName: string;
  procName: string;
}

/** One result set from a batch, already capped + flattened to a row matrix. */
export interface RecordsetSlice {
  columns: string[];
  rows: unknown[][];
  /** Total rows the statement produced before the 10k cap. */
  rowCount: number;
  truncated: boolean;
}

export interface BatchQueryResult {
  recordsets: RecordsetSlice[];
  messages: InfoMessage[];
  /** One count per statement, from mssql result.rowsAffected[]. */
  rowsAffected: number[];
  executionMs: number;
}

/**
 * Batch-aware TDS query: captures ALL result sets from a multi-statement batch
 * (`result.recordsets[]`) AND every in-band SQL message (PRINT / RAISERROR with
 * severity ≤ 10 / statement done-with-count messages). The 10k row cap applies
 * per result set with an honest truncation flag — parity with the SSMS / Azure
 * Data Studio / Fabric SQL editor results pane (multiple grids + Messages tab).
 *
 * Cloud behavior: identical across Commercial, GCC, GCC-High, and DoD — TDS is
 * the on-wire protocol; the only cloud variable is the host suffix
 * (database.windows.net vs database.usgovcloudapi.net), already resolved by
 * sqlHostSuffix() + LOOM_AZURE_SQL_HOST_SUFFIX. No Microsoft Fabric dependency.
 */
export async function executeQueryBatch(
  server: string,
  database: string,
  sqlText: string,
  opts?: { requestId?: string },
): Promise<BatchQueryResult> {
  const started = Date.now();
  const pool = await getPool(server, database);
  const request = pool.request();
  // Register the live Request so the cancel route can send a TDS ATTENTION
  // packet for this exact in-flight query. Registered BEFORE .query() so a
  // cancel that races the start still lands on the right Request.
  if (opts?.requestId) liveRequests.set(opts.requestId, request);
  const messages: InfoMessage[] = [];
  // Attach the info listener BEFORE .query() — tedious emits 'info' events
  // during result-set processing, before the Promise resolves.
  request.on('info', (msg: any) => {
    messages.push({
      message: msg?.message || '',
      number: msg?.number || 0,
      severity: msg?.class ?? 0,
      lineNumber: msg?.lineNumber || 0,
      serverName: msg?.serverName || '',
      procName: msg?.procName || '',
    });
  });
  let result: sql.IResult<any>;
  try {
    result = await request.query(sqlText);
  } finally {
    if (opts?.requestId) liveRequests.delete(opts.requestId);
  }
  // result.recordsets is an array of arrays: one element per SELECT in the batch.
  const rawSets: any[][] = Array.isArray(result.recordsets) && result.recordsets.length
    ? (result.recordsets as any[][])
    : (result.recordset ? [result.recordset] : []);
  const recordsets: RecordsetSlice[] = rawSets.map((rs) => {
    const cols = rs.length ? Object.keys(rs[0]) : [];
    const rows = rs.slice(0, MAX_ROWS_BATCH).map((r: any) =>
      cols.map((c) => (r[c] !== undefined ? r[c] : null)),
    );
    return { columns: cols, rows, rowCount: rs.length, truncated: rs.length > MAX_ROWS_BATCH };
  });
  return {
    recordsets,
    messages,
    rowsAffected: Array.isArray(result.rowsAffected) ? result.rowsAffected : [],
    executionMs: Date.now() - started,
  };
}

/**
 * Parameterized query — returns the raw recordset (array of row objects) so
 * the object navigator can read named catalog columns. Inputs are bound as
 * `@p0`, `@p1`, … so no string-injection path exists for the catalog reads.
 * Used only by the sql-objects navigator (`sys.*` catalog queries).
 */
export async function executeParameterized<T = Record<string, unknown>>(
  server: string,
  database: string,
  sqlText: string,
  params: Array<string | number | boolean> = [],
): Promise<T[]> {
  const pool = await getPool(server, database);
  const request = pool.request();
  params.forEach((v, i) => request.input(`p${i}`, v));
  const result = await request.query(sqlText);
  return (result.recordset || []) as T[];
}

// ============================================================
// Mirroring (Fabric Mirror to OneLake)
// ============================================================

export interface MirroringConfig {
  enabled: boolean;
  /** Azure-native by default; legacy optional field kept for back-compat. */
  fabricMirrorEndpoint?: string;
  backend?: 'azure-native-cdc';
  state?: 'Disabled' | 'Initializing' | 'Running' | 'Stopped' | 'Error' | 'NotConfigured';
  lastError?: string;
  /** Honest disclosure of the downstream Azure-native sink (no Fabric). */
  note?: string;
  deferredReason?: string;
}

/**
 * Enable Azure-native change replication ("mirroring") on an Azure SQL database.
 *
 * Per .claude/rules/no-fabric-dependency.md this is **Azure-native, no Microsoft
 * Fabric**: it turns on the database **change feed** via the real
 * `sys.sp_change_feed_enable_db` primitive (the same CDC engine Fabric mirroring
 * consumes under the hood, but it is an Azure SQL feature). The captured changes
 * are streamed to ADLS **Bronze Delta** by an ADF CDC / Synapse Link copy or the
 * Loom mirroring engine — wired by the mirrored-database item, not Fabric.
 *
 * This runs REAL DDL (the toggle is an explicit user action). The console
 * identity must be `db_owner` (or have `ALTER DATABASE`) on the target DB; a
 * permission/feature failure surfaces verbatim as `state:'Error'` (no fake
 * success, no Fabric gate) per no-vaporware.md.
 */
export async function enableMirroring(
  server: string,
  database: string,
  _legacyFabricMirrorEndpoint?: string,
): Promise<MirroringConfig> {
  const note =
    'Change feed enabled (Azure-native CDC). Stream the captured changes to ADLS ' +
    'Bronze Delta via an ADF CDC pipeline / Synapse Link copy or the Loom mirroring ' +
    'engine — no Microsoft Fabric workspace required.';
  try {
    await executeQuery(server, database, 'EXEC sys.sp_change_feed_enable_db @max_concurrent_workers = 4;');
    return { enabled: true, backend: 'azure-native-cdc', state: 'Initializing', note };
  } catch (e: any) {
    const msg = (e?.message || String(e));
    // Idempotent: already enabled is success.
    if (/already enabled|already exists/i.test(msg)) {
      return { enabled: true, backend: 'azure-native-cdc', state: 'Running', note };
    }
    return {
      enabled: false,
      backend: 'azure-native-cdc',
      state: 'Error',
      lastError: msg,
      note: 'Enabling the change feed needs the console identity to be db_owner (or have ALTER DATABASE) on this database, and the change feed must be supported on this SQL tier.',
    };
  }
}

// ============================================================
// Geo-replication
// ============================================================

export interface ReplicaSpec {
  /** Replica server FQDN or ARM id */
  replicaServer: string;
  /** Replica database name (defaults to the primary db name) */
  replicaDatabaseName?: string;
  /** Replica region */
  location: string;
  /** SKU name (e.g., GP_Gen5_4) — defaults to primary */
  skuName?: string;
}

export async function enableReplication(
  server: string,
  database: string,
  replica: ReplicaSpec,
): Promise<{ ok: true; operationStatusLink?: string } | { ok: false; error: string }> {
  try {
    const primaryScope = server.startsWith('/') ? server : await defaultServerScope(server);
    const replicaScope = replica.replicaServer.startsWith('/')
      ? replica.replicaServer
      : await defaultServerScope(replica.replicaServer);
    const dbName = replica.replicaDatabaseName || database;
    const path = `${replicaScope}/databases/${encodeURIComponent(dbName)}?api-version=2023-08-01-preview`;
    const body = {
      location: replica.location,
      properties: {
        createMode: 'Secondary',
        sourceDatabaseId: `${primaryScope}/databases/${encodeURIComponent(database)}`,
      },
      ...(replica.skuName ? { sku: { name: replica.skuName } } : {}),
    };
    await armRequest(path, { method: 'PUT', body: JSON.stringify(body) });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ============================================================
// Firewall rules (ARM REST — Microsoft.Sql/servers/firewallRules)
// ============================================================

export interface FirewallRule {
  name: string;
  startIpAddress: string;
  endIpAddress: string;
}

const SQL_API_VERSION = '2023-08-01-preview';

// ============================================================
// Compute & Storage scaling (ARM PATCH — Microsoft.Sql/servers/databases)
// ============================================================

export interface ScaleDatabaseSpec {
  /** Full ARM scope of the server (/subscriptions/.../servers/<name>) OR a bare server name. */
  serverId: string;
  /** Database name to scale. */
  database: string;
  /** DTU name (S0, S1, P1…), vCore name (GP_Gen5_4), or serverless name (GP_S_Gen5_2). */
  skuName: string;
  /** Basic | Standard | Premium | GeneralPurpose | BusinessCritical | Hyperscale */
  tier: string;
  /** Gen5 (vCore / serverless). Omit for DTU SKUs. */
  family?: string;
  /** DTU count or vCore count. */
  capacity?: number;
  /** Max storage in bytes; must be a multiple of 1,073,741,824 (1 GiB). */
  maxSizeBytes?: number;
  /** Serverless GP only. Auto-pause delay in minutes. -1 = disabled. */
  autoPauseDelay?: number;
  /** Serverless GP only. Minimum vCores (0.5 | 0.75 | 1 | …). */
  minCapacity?: number;
}

export interface ScaledSku {
  name?: string;
  tier?: string;
  family?: string;
  capacity?: number;
}

export interface ScaleDatabaseResult {
  ok: true;
  beforeSku: ScaledSku;
  afterSku: ScaledSku;
  /** Before/after serverless settings (present when the DB is GP serverless). */
  beforeAutoPauseDelay?: number;
  afterAutoPauseDelay?: number;
  beforeMinCapacity?: number;
  afterMinCapacity?: number;
  beforeMaxSizeBytes?: number;
  afterMaxSizeBytes?: number;
  /** Provisioning/operational state of the database after the LRO settled. */
  provisioningState: string;
  /** Async-operation outcome reported by ARM (Succeeded / Failed / …), if observed. */
  lroStatus?: string;
}

/**
 * Poll an ARM Long-Running-Operation (Azure-AsyncOperation / Location) URL to a
 * terminal state. Honours Retry-After (capped at 30s). Returns the final status
 * string ('Succeeded' | 'Failed' | 'Canceled') or undefined if there was no URL
 * / the poll could not be read (caller then re-GETs the resource for truth).
 */
async function pollScaleLro(url: string | null, token: string, timeoutMs = 600_000): Promise<string | undefined> {
  if (!url) return undefined;
  const deadline = Date.now() + timeoutMs;
  // Give ARM an initial beat before the first poll.
  await new Promise((r) => setTimeout(r, 2_000));
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    } catch {
      return undefined; // transient — caller re-GETs the resource for the real state
    }
    if (!res.ok) return undefined;
    const j: any = await res.json().catch(() => null);
    const status: string | undefined = j?.status;
    if (!status || status === 'Succeeded' || status === 'Failed' || status === 'Canceled') return status;
    const retryAfter = Math.min(Number(res.headers.get('retry-after') || '5') || 5, 30) * 1_000;
    await new Promise((r) => setTimeout(r, retryAfter));
  }
  return undefined;
}

/**
 * Scale an Azure SQL database's compute + storage via ARM PATCH on
 * Microsoft.Sql/servers/databases — change SKU (DTU ↔ vCore ↔ serverless),
 * vCore/DTU capacity, max storage, and serverless auto-pause / min-vCore.
 *
 * This is a REAL control-plane mutation: it GETs the before-SKU, PATCHes the
 * new SKU/properties, polls the Azure-AsyncOperation LRO to completion, then
 * GETs the after-SKU so the caller has an honest before/after receipt.
 *
 * The console UAMI must hold "SQL DB Contributor" (9b7fa17d-e63e-47b0-bb0a-15c516ac86ec)
 * — or Contributor — on the server's resource group; otherwise ARM returns 403,
 * which propagates as an AzureSqlError so the editor can render an honest gate
 * naming the missing role (per no-vaporware.md).
 */
export async function scaleDatabase(spec: ScaleDatabaseSpec): Promise<ScaleDatabaseResult> {
  if (!spec.serverId) throw new AzureSqlError('serverId is required', 400);
  if (!spec.database) throw new AzureSqlError('database is required', 400);
  if (!spec.skuName) throw new AzureSqlError('skuName is required', 400);
  if (!spec.tier) throw new AzureSqlError('tier is required', 400);
  if (typeof spec.maxSizeBytes === 'number' && spec.maxSizeBytes % 1_073_741_824 !== 0) {
    throw new AzureSqlError('maxSizeBytes must be a multiple of 1,073,741,824 (1 GiB)', 400);
  }

  const scope = spec.serverId.startsWith('/') ? spec.serverId : await defaultServerScope(spec.serverId);
  const dbPath = `${scope}/databases/${encodeURIComponent(spec.database)}?api-version=${SQL_API_VERSION}`;

  // 1. before-state
  const beforeDb = await armRequest<any>(dbPath);
  const beforeSku: ScaledSku = beforeDb?.sku
    ? { name: beforeDb.sku.name, tier: beforeDb.sku.tier, family: beforeDb.sku.family, capacity: beforeDb.sku.capacity }
    : {};

  // 2. PATCH body — only include fields the caller set.
  const sku: any = { name: spec.skuName, tier: spec.tier };
  if (spec.family) sku.family = spec.family;
  if (typeof spec.capacity === 'number') sku.capacity = spec.capacity;
  const properties: any = {};
  if (typeof spec.maxSizeBytes === 'number') properties.maxSizeBytes = spec.maxSizeBytes;
  if (typeof spec.autoPauseDelay === 'number') properties.autoPauseDelay = spec.autoPauseDelay;
  if (typeof spec.minCapacity === 'number') properties.minCapacity = spec.minCapacity;
  const patchBody: any = { sku };
  if (Object.keys(properties).length > 0) patchBody.properties = properties;

  // 3. PATCH via raw fetch so we can read the LRO headers (armRequest discards them).
  const token = await armToken();
  const patchRes = await fetch(`${arm()}${dbPath}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(patchBody),
    cache: 'no-store',
  });
  if (!patchRes.ok && patchRes.status !== 202) {
    const errText = await patchRes.text();
    let errJson: any = null;
    try { errJson = errText ? JSON.parse(errText) : null; } catch { /* leave as text */ }
    const msg = (errJson?.error?.message || errText || `Scale PATCH failed (HTTP ${patchRes.status})`).toString();
    throw new AzureSqlError(msg, patchRes.status, errJson || errText);
  }

  // 4. poll the LRO to a terminal state (202 path); a 200 means it was synchronous.
  const asyncOpUrl = patchRes.headers.get('azure-asyncoperation') || patchRes.headers.get('location') || null;
  const lroStatus = await pollScaleLro(asyncOpUrl, token);
  if (lroStatus === 'Failed' || lroStatus === 'Canceled') {
    throw new AzureSqlError(`Scale operation ${lroStatus.toLowerCase()} on ${spec.database}`, 502, { lroStatus });
  }

  // 5. after-state (source of truth — confirms ARM applied the SKU).
  const afterDb = await armRequest<any>(dbPath);
  const afterSku: ScaledSku = afterDb?.sku
    ? { name: afterDb.sku.name, tier: afterDb.sku.tier, family: afterDb.sku.family, capacity: afterDb.sku.capacity }
    : {};

  return {
    ok: true,
    beforeSku,
    afterSku,
    beforeAutoPauseDelay: beforeDb?.properties?.autoPauseDelay,
    afterAutoPauseDelay: afterDb?.properties?.autoPauseDelay,
    beforeMinCapacity: beforeDb?.properties?.minCapacity,
    afterMinCapacity: afterDb?.properties?.minCapacity,
    beforeMaxSizeBytes: beforeDb?.properties?.maxSizeBytes,
    afterMaxSizeBytes: afterDb?.properties?.maxSizeBytes,
    provisioningState: afterDb?.properties?.status || 'Online',
    lroStatus,
  };
}

export async function listFirewallRules(serverName: string): Promise<FirewallRule[]> {
  const scope = serverName.startsWith('/') ? serverName : await defaultServerScope(serverName);
  const res = await armRequest<{ value: any[] }>(`${scope}/firewallRules?api-version=${SQL_API_VERSION}`);
  return (res.value || []).map((r) => ({
    name: r.name,
    startIpAddress: r.properties?.startIpAddress,
    endIpAddress: r.properties?.endIpAddress,
  }));
}

export async function upsertFirewallRule(
  serverName: string,
  rule: FirewallRule,
): Promise<FirewallRule> {
  if (!rule.name || !rule.startIpAddress || !rule.endIpAddress) {
    throw new AzureSqlError('name, startIpAddress, endIpAddress are required', 400);
  }
  const scope = serverName.startsWith('/') ? serverName : await defaultServerScope(serverName);
  const path = `${scope}/firewallRules/${encodeURIComponent(rule.name)}?api-version=${SQL_API_VERSION}`;
  const res = await armRequest<any>(path, {
    method: 'PUT',
    body: JSON.stringify({
      properties: {
        startIpAddress: rule.startIpAddress,
        endIpAddress: rule.endIpAddress,
      },
    }),
  });
  return {
    name: res.name,
    startIpAddress: res.properties?.startIpAddress,
    endIpAddress: res.properties?.endIpAddress,
  };
}

export async function deleteFirewallRule(serverName: string, ruleName: string): Promise<void> {
  const scope = serverName.startsWith('/') ? serverName : await defaultServerScope(serverName);
  await armRequest<void>(
    `${scope}/firewallRules/${encodeURIComponent(ruleName)}?api-version=${SQL_API_VERSION}`,
    { method: 'DELETE' },
  );
}

// ============================================================
// AAD admin (ARM REST — Microsoft.Sql/servers/administrators)
// ============================================================

export interface AadAdmin {
  login: string;
  sid: string;       // Entra object id of the principal
  tenantId?: string;
  azureADOnlyAuthentication?: boolean;
}

export async function getAadAdmin(serverName: string): Promise<AadAdmin | null> {
  const scope = serverName.startsWith('/') ? serverName : await defaultServerScope(serverName);
  try {
    const res = await armRequest<any>(
      `${scope}/administrators/ActiveDirectory?api-version=${SQL_API_VERSION}`,
    );
    return {
      login: res.properties?.login,
      sid: res.properties?.sid,
      tenantId: res.properties?.tenantId,
      azureADOnlyAuthentication: res.properties?.azureADOnlyAuthentication,
    };
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

export async function setAadAdmin(
  serverName: string,
  admin: AadAdmin,
): Promise<AadAdmin> {
  if (!admin.login || !admin.sid) {
    throw new AzureSqlError('login (UPN/group name) and sid (object id) are required', 400);
  }
  const scope = serverName.startsWith('/') ? serverName : await defaultServerScope(serverName);
  const res = await armRequest<any>(
    `${scope}/administrators/ActiveDirectory?api-version=${SQL_API_VERSION}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        properties: {
          administratorType: 'ActiveDirectory',
          login: admin.login,
          sid: admin.sid,
          tenantId: admin.tenantId,
        },
      }),
    },
  );
  return {
    login: res.properties?.login,
    sid: res.properties?.sid,
    tenantId: res.properties?.tenantId,
    azureADOnlyAuthentication: res.properties?.azureADOnlyAuthentication,
  };
}

// ============================================================
// SQL Server 2025 features
// ============================================================

export async function enableSqlServer2025Features(
  server: string,
  database: string,
): Promise<{ ok: boolean; engineEdition?: number; productVersion?: string; note?: string }> {
  try {
    const r = await executeQuery(
      server,
      database,
      "SELECT SERVERPROPERTY('EngineEdition') AS ee, SERVERPROPERTY('ProductVersion') AS pv;",
    );
    const ee = Number(r.rows?.[0]?.[0]);
    const pv = String(r.rows?.[0]?.[1] || '');
    const major = Number(pv.split('.')[0] || 0);
    if (major < 17) {
      return {
        ok: false,
        engineEdition: ee,
        productVersion: pv,
        note: 'SQL Server 2025 (major ≥17) required for native vector + JSON_AGG + regex. Current engine is older — features deferred.',
      };
    }
    // No-op DDL — features are surface-level T-SQL, no enablement step today.
    return { ok: true, engineEdition: ee, productVersion: pv };
  } catch (e: any) {
    return { ok: false, note: e?.message || String(e) };
  }
}

// ============================================================
// Database-scope ARM role assignments (item-level Share dialog)
//
// Per .claude/rules/ui-parity.md this mirrors the Azure portal "Access control
// (IAM) → Add role assignment" blade scoped to a single Azure SQL database
// (Microsoft.Sql/servers/databases/{db} ARM scope). The Console UAMI must hold
// "Role Based Access Control Administrator" (constrained via ABAC to the three
// roles below) on the SQL server's resource group — granted by
// platform/fiab/bicep/modules/admin-plane/sql-database-share-rbac.bicep. If
// that grant is absent ARM returns 403 verbatim and the route surfaces it
// honestly (no fake success, per no-vaporware.md).
// ============================================================

/** Built-in role definition GUIDs (identical across every Azure cloud). */
export const SQL_DATABASE_ROLES: Record<string, string> = {
  'Reader':             'acdd72a7-3385-48ef-bd42-f606fba81ae7',
  'Contributor':        'b24988ac-6180-42a0-ab88-20f7382dd24c',
  'SQL DB Contributor': '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec',
};

export interface DbRoleAssignment {
  /** Full ARM id of the role assignment (the receipt). */
  id: string;
  principalId: string;
  principalType?: string;
  roleDefinitionId: string;
  /** Friendly role name when the GUID is one of SQL_DATABASE_ROLES. */
  roleName?: string;
  createdOn?: string;
}

function dbScopeFrom(serverScope: string, databaseName: string): string {
  return `${serverScope}/databases/${encodeURIComponent(databaseName)}`;
}

/** List the role assignments declared AT the database scope (atScope filter). */
export async function listDatabaseRoleAssignments(
  serverName: string,
  databaseName: string,
): Promise<DbRoleAssignment[]> {
  const serverScope = serverName.startsWith('/') ? serverName : await defaultServerScope(serverName);
  const dbScope = dbScopeFrom(serverScope, databaseName);
  const res = await armRequest<{ value: any[] }>(
    `${dbScope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`,
  );
  return (res.value || []).map((r) => {
    const roleDef = r.properties?.roleDefinitionId || '';
    const roleGuid = roleDef.split('/').pop() || '';
    const known = Object.entries(SQL_DATABASE_ROLES).find(([, gid]) => gid === roleGuid);
    return {
      id: r.id,
      principalId: r.properties?.principalId,
      principalType: r.properties?.principalType,
      roleDefinitionId: roleDef,
      roleName: known ? known[0] : undefined,
      createdOn: r.properties?.createdOn,
    } as DbRoleAssignment;
  });
}

/**
 * Grant a role at the database scope via ARM PUT. `roleNameOrGuid` accepts a
 * friendly name from SQL_DATABASE_ROLES or a raw role-definition GUID. Returns
 * the new assignment including its ARM id (the receipt the UI shows).
 */
export async function grantDatabaseRole(
  serverName: string,
  databaseName: string,
  principalId: string,
  roleNameOrGuid: string,
  principalType: 'User' | 'Group' | 'ServicePrincipal' = 'User',
): Promise<DbRoleAssignment> {
  if (!principalId || !roleNameOrGuid) {
    throw new AzureSqlError('principalId and roleNameOrGuid are required', 400);
  }
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) throw new AzureSqlError('LOOM_SUBSCRIPTION_ID not set', 400);
  const serverScope = serverName.startsWith('/') ? serverName : await defaultServerScope(serverName);
  const dbScope = dbScopeFrom(serverScope, databaseName);
  const roleGuid = SQL_DATABASE_ROLES[roleNameOrGuid] || roleNameOrGuid;
  const roleDefinitionId = `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`;
  // ARM role-assignment names are random GUIDs; a duplicate principal+role pair
  // at the same scope 409s, which surfaces honestly to the caller.
  const assignmentGuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  const res = await armRequest<any>(
    `${dbScope}/providers/Microsoft.Authorization/roleAssignments/${assignmentGuid}?api-version=2022-04-01`,
    {
      method: 'PUT',
      body: JSON.stringify({ properties: { roleDefinitionId, principalId, principalType } }),
    },
  );
  return {
    id: res.id,
    principalId,
    principalType,
    roleDefinitionId,
    roleName: Object.entries(SQL_DATABASE_ROLES).find(([, gid]) => gid === roleGuid)?.[0],
    createdOn: res.properties?.createdOn,
  };
}

/** Revoke one role assignment by its full ARM id (ARM DELETE). */
export async function revokeDatabaseRoleAssignment(roleAssignmentArmId: string): Promise<void> {
  if (!roleAssignmentArmId) throw new AzureSqlError('roleAssignmentArmId is required', 400);
  await armRequest<void>(`${roleAssignmentArmId}?api-version=2022-04-01`, { method: 'DELETE' });
}
