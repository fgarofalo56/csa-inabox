/**
 * Databricks REST client for SQL Warehouses + Statement execution.
 *
 * Auth: AAD token for resource `2ff814a6-3304-4ab8-85cb-cd0e6f879c1d`
 * (Azure Databricks). Container App MI must be a Workspace user/admin
 * (granted via SCIM bootstrap — see deployment notes). For ARM-level
 * operations (resource provider) we use management.azure.com scope.
 *
 * Hostname comes from env LOOM_DATABRICKS_HOSTNAME, e.g.
 *   adb-7405613013893759.19.azuredatabricks.net
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function host(): string {
  const h = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (!h) throw new Error('LOOM_DATABRICKS_HOSTNAME not configured');
  return h.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function dbxToken(): Promise<string> {
  const t = await credential.getToken(DBX_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire Databricks AAD token');
  return t.token;
}

async function dbxFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await dbxToken();
  return fetch(`https://${host()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
}

// ------------------------------------------------------------
// Warehouse management
// ------------------------------------------------------------

export interface Warehouse {
  id: string;
  name: string;
  state:
    | 'STARTING'
    | 'RUNNING'
    | 'STOPPING'
    | 'STOPPED'
    | 'DELETING'
    | 'DELETED'
    | string;
  cluster_size?: string;
  warehouse_type?: string;
  enable_serverless_compute?: boolean;
}

export async function listWarehouses(): Promise<Warehouse[]> {
  const res = await dbxFetch('/api/2.0/sql/warehouses');
  if (!res.ok) {
    throw new Error(`listWarehouses failed ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { warehouses?: Warehouse[] };
  return body.warehouses || [];
}

export async function getWarehouse(id: string): Promise<Warehouse> {
  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`getWarehouse failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Warehouse;
}

export async function startWarehouse(id: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`startWarehouse failed ${res.status}: ${await res.text()}`);
  }
}

export async function stopWarehouse(id: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`stopWarehouse failed ${res.status}: ${await res.text()}`);
  }
}

// ------------------------------------------------------------
// Statement execution
// ------------------------------------------------------------

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
}

interface StatementResponse {
  statement_id: string;
  status: { state: string; error?: { message?: string; error_code?: string } };
  manifest?: {
    schema?: { columns?: { name: string; type_name?: string; position?: number }[] };
    total_row_count?: number;
    truncated?: boolean;
  };
  result?: {
    data_array?: unknown[][];
    chunk_index?: number;
  };
}

const MAX_ROWS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 120_000;

export async function executeStatement(
  warehouseId: string,
  sql: string,
  catalog?: string,
  schema?: string,
): Promise<QueryResult> {
  const t0 = Date.now();
  const payload: Record<string, unknown> = {
    warehouse_id: warehouseId,
    statement: sql,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
    disposition: 'INLINE',
    format: 'JSON_ARRAY',
    row_limit: MAX_ROWS,
  };
  if (catalog) payload.catalog = catalog;
  if (schema) payload.schema = schema;

  const res = await dbxFetch('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`executeStatement submit failed ${res.status}: ${await res.text()}`);
  }
  let body = (await res.json()) as StatementResponse;

  // Poll until terminal (SUCCEEDED / FAILED / CANCELED / CLOSED).
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (
    (body.status?.state === 'PENDING' || body.status?.state === 'RUNNING') &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const r2 = await dbxFetch(`/api/2.0/sql/statements/${encodeURIComponent(body.statement_id)}`);
    if (!r2.ok) {
      throw new Error(`executeStatement poll failed ${r2.status}: ${await r2.text()}`);
    }
    body = (await r2.json()) as StatementResponse;
  }

  if (body.status?.state !== 'SUCCEEDED') {
    const msg =
      body.status?.error?.message ||
      `Statement ${body.status?.state || 'unknown'} (no error message)`;
    const err: Error & { code?: string } = new Error(msg);
    if (body.status?.error?.error_code) err.code = body.status.error.error_code;
    throw err;
  }

  const cols = (body.manifest?.schema?.columns || [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => c.name);
  const rows = body.result?.data_array || [];
  return {
    columns: cols,
    rows,
    rowCount: body.manifest?.total_row_count ?? rows.length,
    executionMs: Date.now() - t0,
    truncated: !!body.manifest?.truncated,
  };
}
