/**
 * Synapse SQL client — shared TDS path for both Dedicated and Serverless pools.
 *
 * Auth: BFF service identity (DefaultAzureCredential).
 *   - In Container Apps: user-assigned MI `uami-loom-console-eastus2`
 *   - Locally: az CLI / VS Code login
 * Reaches Synapse via private endpoints on the spoke VNet (peered to hub).
 * AAD admin on the Synapse workspace is the same UAMI, so the token has SQL admin.
 *
 * Phase 1 wires Serverless (OPENROWSET over ADLS) and Dedicated (T-SQL on the pool).
 * Both use the same TDS connection shape — only the FQDN and database differ.
 */

import { DefaultAzureCredential, ManagedIdentityCredential, ChainedTokenCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import sql from 'mssql';
import { getSqlSuffix, synapseSqlSuffix } from './cloud-endpoints';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

/**
 * TDS AAD token scope — cloud-portable. The SQL audience host differs per
 * sovereign boundary and is resolved by `cloud-endpoints.getSqlSuffix()`
 * (Commercial/GCC vs Gov). Override the host via `LOOM_SYNAPSE_SQL_TOKEN_SCOPE`
 * (host without scheme / `.default`).
 */
function sqlScope(): string {
  return `https://${process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE || getSqlSuffix()}/.default`;
}
// Prefer explicit UAMI when LOOM_UAMI_CLIENT_ID is set (Container App
// runtime). Fall back to the default chain for local dev (az CLI).
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

let pools: Map<string, sql.ConnectionPool> = new Map();

/**
 * Per-user connection pools for "user's identity" data-access mode (F10).
 * NEVER shared across users: a TDS connection carries the AAD identity of the
 * token it was opened with, so reusing one caller's pool for another would be a
 * privilege escalation. Keyed by `${target.cacheKey}:user:${oid}`.
 */
const userPools: Map<string, sql.ConnectionPool> = new Map();

export interface SynapseTarget {
  /** workspaceName.sql.azuresynapse.net (Dedicated) or workspaceName-ondemand.sql.azuresynapse.net (Serverless) */
  server: string;
  /** Pool name for Dedicated; 'master' for Serverless. */
  database: string;
  /** Connection-pool cache key. */
  cacheKey: string;
}

/**
 * Cloud-aware Synapse SQL endpoint domain suffix. The Commercial/GCC vs Gov
 * suffix is resolved by `cloud-endpoints.synapseSqlSuffix()` (the single source
 * of truth), mirroring the privatelink DNS zone suffix that network.bicep
 * provisions so the serverless FQDN resolves through the right private endpoint
 * in every sovereign cloud. `LOOM_SYNAPSE_HOST_SUFFIX` overrides outright.
 * Grounded in the Azure Government endpoint mapping:
 *   https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure
 */
export function getSynapseSqlSuffix(): string {
  // Explicit per-deployment override wins (single image can serve any cloud /
  // sovereign endpoint without a boundary mapping change).
  if (process.env.LOOM_SYNAPSE_HOST_SUFFIX) return process.env.LOOM_SYNAPSE_HOST_SUFFIX;
  return synapseSqlSuffix();
}

export function dedicatedTarget(): SynapseTarget {
  const ws = required('LOOM_SYNAPSE_WORKSPACE');
  const pool = required('LOOM_SYNAPSE_DEDICATED_POOL');
  const suffix = getSynapseSqlSuffix();
  return {
    server: `${ws}.${suffix}`,
    database: pool,
    cacheKey: `dedicated:${ws}:${pool}`,
  };
}

export function serverlessTarget(database = 'master'): SynapseTarget {
  const ws = required('LOOM_SYNAPSE_WORKSPACE');
  const suffix = getSynapseSqlSuffix();
  return {
    server: `${ws}-ondemand.${suffix}`,
    database,
    cacheKey: `serverless:${ws}:${database}`,
  };
}

/** Public Serverless endpoint FQDN for the env-bound workspace (UI badges / receipts). */
export function serverlessEndpoint(): string {
  return `${required('LOOM_SYNAPSE_WORKSPACE')}-ondemand.${getSynapseSqlSuffix()}`;
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function getPool(target: SynapseTarget): Promise<sql.ConnectionPool> {
  const existing = pools.get(target.cacheKey);
  if (existing?.connected) return existing;

  const token = await credential.getToken(sqlScope());
  if (!token?.token) throw new Error('Failed to acquire AAD token for Synapse SQL');

  const pool = new sql.ConnectionPool({
    server: target.server,
    database: target.database,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: token.token },
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 60_000 },
    requestTimeout: 60_000,
    connectionTimeout: 30_000,
  } as sql.config);

  await pool.connect();
  pools.set(target.cacheKey, pool);
  pool.on('error', () => pools.delete(target.cacheKey));
  return pool;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
  /** TDS PRINT / RAISERROR (severity ≤ 10) info messages — surfaced in the Messages pane. */
  messages: string[];
  /** Rows affected by the last statement (non-SELECT DDL/DML returns this; SELECT returns 0). */
  recordsAffected: number;
}

const MAX_ROWS = 5_000;

/**
/**
 * In-process registry of in-flight TDS requests, keyed by a caller-supplied
 * queryId. A separate /cancel route looks the request up and calls
 * `Request.cancel()`, which sends the TDS ATTENTION packet (tedious) to abort
 * the batch on the server. Same-process only — sufficient for Loom's
 * single-instance Container App. On scale-out a cancel may land on a different
 * replica (no entry → found:false); the client shows "Cancel sent" and the
 * original query completes on its own replica.
 */
const activeRequests = new Map<string, sql.Request>();

/**
 * Cancel an in-flight query by its caller-supplied queryId. Sends a TDS
 * ATTENTION packet via mssql `Request.cancel()`. Returns true if a matching
 * in-flight request was found on this process, false otherwise.
 */
export function cancelActiveQuery(queryId: string): boolean {
  const req = activeRequests.get(queryId);
  if (!req) return false;
  try {
    req.cancel();
  } finally {
    activeRequests.delete(queryId);
  }
  return true;
}

/**
 * A named query parameter for the TDS path. The SQL references the marker as
 * `@name`; the value is bound via `req.input(name, type, value)` (which mssql
 * issues as `sp_executesql @stmt, @params, …`), so the value is NEVER spliced
 * into the SQL string — the canonical SQL-injection-safe T-SQL parameterization
 * for both Synapse Dedicated and Serverless pools.
 */
export interface SynapseQueryParam {
  name: string;
  value: string | null;
}

/** Bind named parameters onto a TDS request as NVARCHAR(MAX). T-SQL implicitly
 * converts to the target column type at execution, so a single bind type covers
 * string/number/date filters. The value is bound, not concatenated. */
function bindParams(req: sql.Request, parameters?: SynapseQueryParam[]): void {
  if (!parameters?.length) return;
  for (const p of parameters) {
    req.input(p.name, sql.NVarChar(sql.MAX), p.value ?? null);
  }
}

export async function executeQuery(target: SynapseTarget, sqlText: string, timeoutMs = 60_000, parameters?: SynapseQueryParam[], queryId?: string): Promise<QueryResult> {
  const started = Date.now();
  const pool = await getPool(target);
  const req = pool.request();
  if (queryId) activeRequests.set(queryId, req);

  // Capture TDS info/warning messages (PRINT, RAISERROR with severity ≤ 10).
  // These are how Synapse surfaces non-fatal diagnostics; the editor shows
  // them in the Messages tab alongside the result grid (SSMS/ADS parity).
  const messages: string[] = [];
  req.on('info', (info: any) => {
    const msg = info?.message ?? (typeof info === 'string' ? info : '');
    if (msg) messages.push(String(msg));
  });

  // Bind named parameters (`@name`) before executing — injection-safe.
  bindParams(req, parameters);

  // Wrap query execution with an explicit timeout to catch cold-start latency.
  // Synapse serverless OPENROWSET on CSV files can take 30-60s on first run.
  try {
    const queryPromise = req.query(sqlText);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms — Synapse serverless pool may be cold. Retry in a moment.`)), timeoutMs)
    );

    const result = await Promise.race([queryPromise, timeoutPromise]);
    const recordset = result.recordset || [];
    const columns = recordset.length
      ? Object.keys(recordset[0])
      : Object.keys((result as any).recordsets?.[0]?.columns || {});
    const rows = recordset.slice(0, MAX_ROWS).map((r: any) => columns.map((c) => r[c]));
    // mssql sums rowsAffected per statement; report the last/total for DDL receipts.
    const affected = Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((a: number, b: number) => a + b, 0)
      : 0;
    return {
      columns,
      rows,
      rowCount: recordset.length,
      executionMs: Date.now() - started,
      truncated: recordset.length > MAX_ROWS,
      messages,
      recordsAffected: affected,
    };
  } finally {
    if (queryId) activeRequests.delete(queryId);
  }
}

/**
 * Run `EXPLAIN [WITH_RECOMMENDATIONS] <sqlText>` on a Synapse Dedicated SQL pool
 * and return the raw distributed-query-plan XML from the first result-set cell.
 *
 * EXPLAIN compiles (but does NOT execute) the statement and returns the MPP
 * plan as XML — operation types such as BroadcastMoveOperation /
 * ShuffleMoveOperation reveal the data-movement steps a query incurs. The
 * WITH_RECOMMENDATIONS form additionally surfaces engine optimization hints
 * (missing statistics, alternative distributions). This is the real backend
 * the Warehouse Copilot "optimize" mode grounds its suggestions in.
 *
 * Only supported on Dedicated pools (not Serverless / Databricks) — the caller
 * must gate. Requires SHOWPLAN, held by any SQL admin (the Console UAMI
 * qualifies); no extra GRANT is needed.
 *
 * Reference: https://learn.microsoft.com/sql/t-sql/queries/explain-transact-sql?view=azure-sqldw-latest
 */
export async function explainQuery(
  target: SynapseTarget,
  sqlText: string,
  withRecommendations = true,
  timeoutMs = 30_000,
): Promise<string> {
  const keyword = withRecommendations ? 'EXPLAIN WITH_RECOMMENDATIONS' : 'EXPLAIN';
  const res = await executeQuery(target, `${keyword}\n${sqlText}`, timeoutMs);
  if (!res.rows.length) return '';
  const cell = res.rows[0]?.[0];
  return cell == null ? '' : String(cell);
}

/**
 * Get (or open) a per-user TDS pool authenticated with the caller's own Azure
 * SQL access token. Pools are isolated by user oid and never shared, because
 * the connection carries the token's AAD identity (sharing would leak one
 * user's access to another). Capped small (max 2, 5-min idle) since a pool
 * exists per active user rather than one shared service pool.
 */
async function getUserPool(
  target: SynapseTarget,
  userSqlToken: string,
  userOid: string,
): Promise<sql.ConnectionPool> {
  const cacheKey = `${target.cacheKey}:user:${userOid}`;
  const existing = userPools.get(cacheKey);
  if (existing?.connected) return existing;

  const pool = new sql.ConnectionPool({
    server: target.server,
    database: target.database,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: userSqlToken },
    },
    pool: { max: 2, min: 0, idleTimeoutMillis: 300_000 },
    requestTimeout: 60_000,
    connectionTimeout: 30_000,
  } as sql.config);

  await pool.connect();
  userPools.set(cacheKey, pool);
  pool.on('error', () => userPools.delete(cacheKey));
  return pool;
}

/**
 * Execute T-SQL on behalf of the signed-in user ("user's identity" data-access
 * mode, F10). Identical result shape to executeQuery, but the TDS connection is
 * opened with the CALLER's Azure SQL access token instead of the Loom service
 * identity (UAMI/SP) — so row-level security, SUSER_NAME()/USER_NAME(), and the
 * SQL audit log all reflect the real user.
 *
 * @param userSqlToken a valid Entra access token for the SQL audience
 *   (https://database.windows.net/.default, or .usgovcloudapi.net in gov).
 * @param userOid the caller's Entra object id — used as the pool isolation key.
 *
 * The user must be provisioned as a contained database user (Dedicated) or hold
 * the appropriate Storage RBAC (Serverless OPENROWSET); otherwise the TDS layer
 * returns a login/authorization error (e.g. 18456 / 15247) that surfaces
 * verbatim to the caller for an honest gate.
 */
export async function executeQueryAsUser(
  target: SynapseTarget,
  sqlText: string,
  userSqlToken: string,
  userOid: string,
  timeoutMs = 60_000,
  parameters?: SynapseQueryParam[],
  queryId?: string,
): Promise<QueryResult> {
  const started = Date.now();
  const pool = await getUserPool(target, userSqlToken, userOid);
  const req = pool.request();
  if (queryId) activeRequests.set(queryId, req);

  const messages: string[] = [];
  req.on('info', (info: any) => {
    const msg = info?.message ?? (typeof info === 'string' ? info : '');
    if (msg) messages.push(String(msg));
  });

  // Bind named parameters (`@name`) before executing — injection-safe.
  bindParams(req, parameters);

  try {
    const queryPromise = req.query(sqlText);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms — Synapse serverless pool may be cold. Retry in a moment.`)), timeoutMs)
    );

    const result = await Promise.race([queryPromise, timeoutPromise]);
    const recordset = result.recordset || [];
    const columns = recordset.length
      ? Object.keys(recordset[0])
      : Object.keys((result as any).recordsets?.[0]?.columns || {});
    const rows = recordset.slice(0, MAX_ROWS).map((r: any) => columns.map((c) => r[c]));
    const affected = Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((a: number, b: number) => a + b, 0)
      : 0;
    return {
      columns,
      rows,
      rowCount: recordset.length,
      executionMs: Date.now() - started,
      truncated: recordset.length > MAX_ROWS,
      messages,
      recordsAffected: affected,
    };
  } finally {
    if (queryId) activeRequests.delete(queryId);
  }
}

/**
 * Build a T-SQL OPENROWSET query for a Delta Lake root folder on ADLS Gen2.
 * Synapse Serverless' DELTA reader auto-discovers partitions from `_delta_log`
 * and returns the latest committed version, so the BULK path must point at the
 * Delta ROOT (the folder containing `_delta_log/`) — never a partition subdir
 * or a wildcard. This is the Azure-native analog of Fabric "Direct Lake on SQL"
 * DirectQuery fallback (which reads the same Delta files via the Lakehouse SQL
 * analytics endpoint when the in-memory VertiPaq cache can't serve a query).
 * Grounded in: https://learn.microsoft.com/azure/synapse-analytics/sql/query-delta-lake-format
 */
export function buildDeltaOpenRowsetSql(deltaBulkUrl: string, maxRows = 5_000): string {
  const safeMax = Math.min(Math.max(1, Math.floor(maxRows) || 1), MAX_ROWS);
  // Single-quotes in the URL would break out of the BULK string literal; double
  // them per T-SQL escaping. URLs never legitimately contain a quote, so this is
  // purely defensive against a malformed table name reaching here.
  const safeUrl = escapeSqlLiteral(deltaBulkUrl);
  return `SELECT TOP ${safeMax} *\nFROM OPENROWSET(\n  BULK '${safeUrl}',\n  FORMAT = 'DELTA'\n) AS r;`;
}

/**
 * Build the full https:// DFS URL for a Gold Delta table, for use as a Synapse
 * Serverless OPENROWSET BULK target. Reads `LOOM_GOLD_URL` (the landing-zone
 * Bicep wires it as `https://{account}.dfs.core.{suffix}/gold`, the same env
 * var `adls-client` uses for the gold medallion container) and appends the
 * conventional `Tables/<name>` Delta layout.
 *
 * Sovereign-cloud portability: `LOOM_GOLD_URL` already carries the correct DFS
 * suffix per cloud (stamped at deploy time), so no extra cloud detection is
 * needed here. Throws an honest, var-named error when it is not configured.
 */
export function goldDeltaBulkUrl(tableName: string): string {
  const goldUrl = process.env.LOOM_GOLD_URL;
  if (!goldUrl) {
    throw new Error(
      'LOOM_GOLD_URL is not configured — set it to the Gold container DFS URL ' +
      '(https://{account}.dfs.core.{suffix}/gold). ' +
      'Required for Direct Lake Serverless fallback.',
    );
  }
  const safeTable = encodeURIComponent(tableName.replace(/[^A-Za-z0-9._-]/g, ''));
  return `${goldUrl.replace(/\/+$/, '')}/Tables/${safeTable}`;
}
