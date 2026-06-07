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

const SQL_SCOPE = 'https://database.windows.net/.default';
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

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function getPool(target: SynapseTarget): Promise<sql.ConnectionPool> {
  const existing = pools.get(target.cacheKey);
  if (existing?.connected) return existing;

  const token = await credential.getToken(SQL_SCOPE);
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
}

const MAX_ROWS = 5_000;

export async function executeQuery(target: SynapseTarget, sqlText: string, timeoutMs = 60_000): Promise<QueryResult> {
  const started = Date.now();
  const pool = await getPool(target);
  const req = pool.request();
  
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
  return {
    columns,
    rows,
    rowCount: recordset.length,
    executionMs: Date.now() - started,
    truncated: recordset.length > MAX_ROWS,
  };
}
