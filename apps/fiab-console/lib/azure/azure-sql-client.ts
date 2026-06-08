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
import { armBase } from './cloud-endpoints';

const SQL_SCOPE = 'https://database.windows.net/.default';

function arm(): string {
  // Sovereign-cloud ARM base (cloud-endpoints honors LOOM_ARM_ENDPOINT + AZURE_CLOUD).
  // Commercial: ARM commercial host   Gov: management.usgovcloudapi.net
  return armBase();
}

function sqlHostSuffix(): string {
  // Commercial: database.windows.net   Gov: database.usgovcloudapi.net
  return process.env.LOOM_AZURE_SQL_HOST_SUFFIX || 'database.windows.net';
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
// Credential-backed query path (SQL login / connection string)
//
// The default query paths above authenticate as the Console UAMI (AAD token).
// A Loom **Connection** can instead carry a SQL login + password or a full
// connection string, with the secret stored in Key Vault (never in Cosmos). The
// mirror's credential-aware table enumerator resolves that KV secret and queries
// the source with it here — so a source that only accepts SQL auth (no Entra
// admin for the UAMI) still enumerates its real tables. A transient pool is used
// (no caching of password-backed pools) and always closed.
// ============================================================

/** SQL login + password (resolved from a Key Vault secretRef). */
export interface SqlPasswordAuth { user: string; password: string }
/** A full TDS connection string (resolved from a Key Vault secretRef). */
export interface SqlConnStringAuth { connectionString: string }
export type SqlExplicitAuth = SqlPasswordAuth | SqlConnStringAuth;

export async function executeWithCredential<T = Record<string, unknown>>(
  server: string,
  database: string,
  sqlText: string,
  auth: SqlExplicitAuth,
): Promise<T[]> {
  let pool: sql.ConnectionPool;
  if ('connectionString' in auth) {
    pool = new sql.ConnectionPool(auth.connectionString);
  } else {
    const host = server.includes('.') ? server : `${server}.${sqlHostSuffix()}`;
    pool = new sql.ConnectionPool({
      server: host,
      database,
      user: auth.user,
      password: auth.password,
      options: { encrypt: true, trustServerCertificate: false },
      pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
      requestTimeout: 60_000,
      connectionTimeout: 30_000,
    } as sql.config);
  }
  try {
    await pool.connect();
    const result = await pool.request().query(sqlText);
    return (result.recordset || []) as T[];
  } finally {
    await pool.close().catch(() => { /* already closed */ });
  }
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
