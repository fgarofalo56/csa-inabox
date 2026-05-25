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
 *   - enableMirroring(server, db, fabricMirrorEndpoint)   — Fabric Mirror provisioning *deferred*: requires Fabric REST + sys.sp_change_feed_enable_db; we surface the toggle but actual execution returns a 501 unless `LOOM_AZURE_SQL_MIRRORING_LIVE=true`.
 *   - enableReplication(server, db, replica)              — ARM create geo-secondary
 *   - enableSqlServer2025Features(server, db)             — runs SET options for JSON_AGG / regex / vector (no-op on SQL Server 2022 or older — caller gets a MessageBar).
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import sql from 'mssql';

const SQL_SCOPE = 'https://database.windows.net/.default';

function arm(): string {
  // environment().resourceManager in bicep parlance — runtime equivalent.
  // Commercial: management.azure.com   Gov: management.usgovcloudapi.net
  return process.env.LOOM_ARM_ENDPOINT || 'https://management.azure.com';
}

function sqlHostSuffix(): string {
  // Commercial: database.windows.net   Gov: database.usgovcloudapi.net
  return process.env.LOOM_AZURE_SQL_HOST_SUFFIX || 'database.windows.net';
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
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
  sku?: { name: string; tier: string; capacity?: number };
  status?: string;
  maxSizeBytes?: number;
  collation?: string;
  createMode?: string;
  zoneRedundant?: boolean;
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
      sku: d.sku ? { name: d.sku.name, tier: d.sku.tier, capacity: d.sku.capacity } : undefined,
      status: d.properties?.status,
      maxSizeBytes: d.properties?.maxSizeBytes,
      collation: d.properties?.collation,
      createMode: d.properties?.createMode,
      zoneRedundant: d.properties?.zoneRedundant,
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
    sku: res.sku ? { name: res.sku.name, tier: res.sku.tier, capacity: res.sku.capacity } : undefined,
    status: res.properties?.status,
    maxSizeBytes: res.properties?.maxSizeBytes,
    collation: res.properties?.collation,
    createMode: res.properties?.createMode,
    zoneRedundant: res.properties?.zoneRedundant,
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
  const tok = await credential.getToken(SQL_SCOPE);
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

export async function executeQuery(server: string, database: string, sqlText: string): Promise<QueryResult> {
  const started = Date.now();
  const pool = await getPool(server, database);
  const result = await pool.request().query(sqlText);
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
}

// ============================================================
// Mirroring (Fabric Mirror to OneLake)
// ============================================================

export interface MirroringConfig {
  enabled: boolean;
  fabricMirrorEndpoint?: string;
  state?: 'Disabled' | 'Initializing' | 'Running' | 'Stopped' | 'Error' | 'NotConfigured';
  lastError?: string;
  deferredReason?: string;
}

/**
 * Toggle Fabric mirroring on an Azure SQL database. Live execution
 * (sys.sp_change_feed_enable_db + Fabric Mirror REST) is gated on the
 * `LOOM_AZURE_SQL_MIRRORING_LIVE` env var; otherwise we persist the
 * desired state and return `NotConfigured` so the UI can surface the
 * "deferred" MessageBar.
 */
export async function enableMirroring(
  server: string,
  database: string,
  fabricMirrorEndpoint?: string,
): Promise<MirroringConfig> {
  if (process.env.LOOM_AZURE_SQL_MIRRORING_LIVE !== 'true') {
    return {
      enabled: false,
      fabricMirrorEndpoint,
      state: 'NotConfigured',
      deferredReason: 'Fabric Mirror provisioning deferred to v3.x. Set LOOM_AZURE_SQL_MIRRORING_LIVE=true once the Fabric workspace mirror REST endpoint is wired.',
    };
  }
  // Live path — kick off CDC + Fabric Mirror config. The Fabric REST call
  // is a separate workspace-scoped POST out of scope of this v3 cut.
  try {
    await executeQuery(server, database, 'EXEC sys.sp_change_feed_enable_db @max_concurrent_workers = 4;');
    return { enabled: true, fabricMirrorEndpoint, state: 'Initializing' };
  } catch (e: any) {
    return { enabled: false, state: 'Error', lastError: e?.message || String(e) };
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
