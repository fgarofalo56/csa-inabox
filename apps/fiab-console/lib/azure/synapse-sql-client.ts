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
import sql from 'mssql';

/**
 * TDS AAD token scope — cloud-portable.
 *   Commercial / GCC : https://database.windows.net/.default
 *   GCC-High / IL5   : https://database.usgovcloudapi.net/.default
 * Set via `LOOM_SYNAPSE_SQL_TOKEN_SCOPE` (host without scheme / .default).
 */
function sqlScope(): string {
  return `https://${process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE || 'database.windows.net'}/.default`;
}
// Prefer explicit UAMI when LOOM_UAMI_CLIENT_ID is set (Container App
// runtime). Fall back to the default chain for local dev (az CLI).
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

let pools: Map<string, sql.ConnectionPool> = new Map();

export interface SynapseTarget {
  /** workspaceName.sql.azuresynapse.net (Dedicated) or workspaceName-ondemand.sql.azuresynapse.net (Serverless) */
  server: string;
  /** Pool name for Dedicated; 'master' for Serverless. */
  database: string;
  /** Connection-pool cache key. */
  cacheKey: string;
}

/**
 * Cloud-aware Synapse SQL endpoint domain suffix.
 *   - Commercial + GCC (AZURE_CLOUD=AzureCloud / unset): sql.azuresynapse.net
 *   - GCC-High + IL5 (AZURE_CLOUD=AzureUSGovernment):     sql.azuresynapse.usgovcloudapi.net
 *
 * AZURE_CLOUD is set per-boundary by admin-plane/main.bicep, mirroring the
 * privatelink DNS zone suffix that network.bicep provisions, so the serverless
 * FQDN resolves through the right private endpoint in every sovereign cloud.
 * Grounded in the Azure Government endpoint mapping:
 *   https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure
 */
export function getSynapseSqlSuffix(): string {
  // Explicit per-deployment override wins (single image can serve any cloud /
  // sovereign endpoint without an AZURE_CLOUD mapping change).
  if (process.env.LOOM_SYNAPSE_HOST_SUFFIX) return process.env.LOOM_SYNAPSE_HOST_SUFFIX;
  return process.env.AZURE_CLOUD === 'AzureUSGovernment'
    ? 'sql.azuresynapse.usgovcloudapi.net'
    : 'sql.azuresynapse.net';
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

export async function executeQuery(target: SynapseTarget, sqlText: string, timeoutMs = 60_000): Promise<QueryResult> {
  const started = Date.now();
  const pool = await getPool(target);
  const req = pool.request();

  // Capture TDS info/warning messages (PRINT, RAISERROR with severity ≤ 10).
  // These are how Synapse surfaces non-fatal diagnostics; the editor shows
  // them in the Messages tab alongside the result grid (SSMS/ADS parity).
  const messages: string[] = [];
  req.on('info', (info: any) => {
    const msg = info?.message ?? (typeof info === 'string' ? info : '');
    if (msg) messages.push(String(msg));
  });

  // Wrap query execution with an explicit timeout to catch cold-start latency.
  // Synapse serverless OPENROWSET on CSV files can take 30-60s on first run.
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
}
