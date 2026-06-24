/**
 * Databricks REST client for SQL Warehouses + Statement execution.
 *
 * Auth: AAD token for resource `2ff814a6-3304-4ab8-85cb-cd0e6f879c1d`
 * (Azure Databricks). Container App MI must be a Workspace user/admin
 * (granted via SCIM bootstrap — see deployment notes). For ARM-level
 * operations (resource provider) we use the sovereign-cloud ARM scope.
 *
 * Hostname comes from env LOOM_DATABRICKS_HOSTNAME, e.g.
 *   adb-7405613013893759.19.azuredatabricks.net
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function host(): string {
  const h = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (!h) throw new Error('LOOM_DATABRICKS_HOSTNAME not configured');
  return h.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Honest config gate for the workspace-level Databricks routes. Returns the
 * exact missing env var so each BFF route can 503 with a precise MessageBar
 * (`code: 'not_configured'`) instead of a generic 500. Returns null when the
 * workspace hostname is set. Mirrors synapseConfigGate / the ADF factory gate.
 */
export function databricksConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_DATABRICKS_HOSTNAME) return { missing: 'LOOM_DATABRICKS_HOSTNAME' };
  return null;
}

async function dbxToken(): Promise<string> {
  const t = await credential.getToken(DBX_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire Databricks AAD token');
  return t.token;
}

async function dbxFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await dbxToken();
  return fetchWithTimeout(`https://${host()}${path}`, {
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

/**
 * Connection endpoint details for a SQL Warehouse, returned verbatim by
 * `GET /api/2.0/sql/warehouses/{id}` in the `odbc_params` field. These are the
 * real, externally-routable JDBC/ODBC coordinates a BI tool or `databricks sql`
 * client uses to reach the warehouse — the Connection details panel surfaces
 * them so an analyst can copy a working JDBC URL.
 *   hostname : adb-7405613013893759.19.azuredatabricks.net (workspace FQDN)
 *   path     : /sql/1.0/warehouses/<warehouse-id> (the warehouse HTTP path)
 *   protocol : 'https'
 *   port     : 443
 */
export interface WarehouseOdbcParams {
  hostname: string;
  path: string;
  protocol?: string;
  port?: number;
}

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
  min_num_clusters?: number;
  max_num_clusters?: number;
  auto_stop_mins?: number;
  /**
   * ODBC/JDBC connection coordinates — present on a started warehouse. A
   * STOPPED warehouse may omit these until it has been provisioned at least
   * once; the connection route gates honestly when they are absent.
   */
  odbc_params?: WarehouseOdbcParams;
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

// ------------------------------------------------------------
// Warehouse events (running-clusters timeline for the Monitoring tab)
//
// GET /api/2.0/sql/warehouses/{id}/events returns lifecycle events for the
// warehouse — STARTING / RUNNING / SCALED_UP / SCALED_DOWN / STOPPING /
// STOPPED — each stamped with `timestamp` (epoch ms) and, where applicable,
// `cluster_count` (the number of clusters active at that instant). This is
// the real signal the Databricks SQL warehouse monitoring view plots for
// "Running clusters over time".
// Learn: https://learn.microsoft.com/azure/databricks/sql/api/sql-warehouses
// ------------------------------------------------------------
export interface WarehouseEvent {
  /** STARTING | RUNNING | STOPPING | STOPPED | SCALED_UP | SCALED_DOWN | … */
  event_type?: string;
  /** Epoch ms (UTC) the event was recorded. */
  timestamp?: number;
  /** Number of clusters running at this instant (present on RUNNING/SCALED_* events). */
  cluster_count?: number;
  /** Optional human-readable detail Databricks attaches to some events. */
  message?: string;
}

/**
 * List recent warehouse lifecycle events (most-recent first). The Databricks
 * endpoint paginates with `next_page_token`; we walk pages up to `limit`
 * total events so the last-hour window is complete even on a busy warehouse.
 */
export async function listWarehouseEvents(
  warehouseId: string,
  limit = 200,
): Promise<WarehouseEvent[]> {
  const out: WarehouseEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams();
    params.set('max_results', String(Math.min(1000, Math.max(1, limit))));
    if (pageToken) params.set('page_token', pageToken);
    const res = await dbxFetch(
      `/api/2.0/sql/warehouses/${encodeURIComponent(warehouseId)}/events?${params.toString()}`,
    );
    const body = await asJsonOrThrow<{ events?: WarehouseEvent[]; next_page_token?: string }>(
      res,
      'listWarehouseEvents',
    );
    out.push(...(body.events || []));
    pageToken = body.next_page_token;
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
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

export interface WarehouseCreateSpec {
  name: string;
  cluster_size?: string;          // '2X-Small' … '4X-Large'
  min_num_clusters?: number;
  max_num_clusters?: number;
  auto_stop_mins?: number;
  warehouse_type?: 'CLASSIC' | 'PRO';
  enable_serverless_compute?: boolean;
  // Advanced options (parity with the Databricks "Create SQL warehouse" dialog —
  // every field below is accepted by POST /api/2.0/sql/warehouses, verified
  // against Microsoft Learn `warehouses/create` + the createWarehouse audit
  // request_params list).
  enable_photon?: boolean;        // Photon vectorized engine (default on for serverless)
  channel?: { name: 'CHANNEL_NAME_CURRENT' | 'CHANNEL_NAME_PREVIEW' };
  tags?: { custom_tags?: Array<{ key: string; value: string }> };
  spot_instance_policy?: 'COST_OPTIMIZED' | 'RELIABILITY_OPTIMIZED' | 'POLICY_UNSPECIFIED';
}

/** Create a SQL Warehouse. POST /api/2.0/sql/warehouses → { id }. */
export async function createWarehouse(spec: WarehouseCreateSpec): Promise<{ id: string }> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    cluster_size: spec.cluster_size ?? 'X-Small',
    warehouse_type: spec.warehouse_type ?? 'PRO',
    min_num_clusters: spec.min_num_clusters ?? 1,
    max_num_clusters: spec.max_num_clusters ?? 1,
    auto_stop_mins: spec.auto_stop_mins ?? 10,
  };
  if (typeof spec.enable_serverless_compute === 'boolean') {
    payload.enable_serverless_compute = spec.enable_serverless_compute;
  }
  if (typeof spec.enable_photon === 'boolean') {
    payload.enable_photon = spec.enable_photon;
  }
  if (spec.channel?.name) {
    payload.channel = { name: spec.channel.name };
  }
  if (spec.tags?.custom_tags && spec.tags.custom_tags.length > 0) {
    payload.tags = { custom_tags: spec.tags.custom_tags };
  }
  if (spec.spot_instance_policy) {
    payload.spot_instance_policy = spec.spot_instance_policy;
  }
  const res = await dbxFetch('/api/2.0/sql/warehouses', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return asJsonOrThrow<{ id: string }>(res, 'createWarehouse');
}

/** Permanently delete a SQL Warehouse. DELETE /api/2.0/sql/warehouses/{id}. */
export async function deleteWarehouse(id: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await asJsonOrThrow<unknown>(res, 'deleteWarehouse');
}

export interface WarehouseScaleSpec {
  cluster_size?: string;          // '2X-Small' | 'X-Small' | 'Small' | 'Medium' | 'Large' | ... | '4X-Large'
  min_num_clusters?: number;      // 1-30
  max_num_clusters?: number;      // 1-30
  auto_stop_mins?: number;
  warehouse_type?: 'CLASSIC' | 'PRO';
  enable_serverless_compute?: boolean;
}

/**
 * Edit a SQL Warehouse via Databricks REST API. POST /api/2.0/sql/warehouses/{id}/edit
 * with the new cluster_size + scaling fields. Databricks requires the
 * warehouse to already exist (no upsert semantics) and will return 400
 * if cluster_size is outside the allowed enum.
 */
export async function editWarehouse(id: string, spec: WarehouseScaleSpec): Promise<void> {
  // Read existing to preserve required fields (name + warehouse_type) the
  // edit endpoint requires even when not changing them.
  const existing = await getWarehouse(id);
  const payload: Record<string, unknown> = {
    name: existing.name,
    warehouse_type: spec.warehouse_type ?? existing.warehouse_type ?? 'PRO',
    cluster_size: spec.cluster_size ?? existing.cluster_size,
  };
  if (typeof spec.min_num_clusters === 'number') payload.min_num_clusters = spec.min_num_clusters;
  if (typeof spec.max_num_clusters === 'number') payload.max_num_clusters = spec.max_num_clusters;
  if (typeof spec.auto_stop_mins === 'number') payload.auto_stop_mins = spec.auto_stop_mins;
  if (typeof spec.enable_serverless_compute === 'boolean') payload.enable_serverless_compute = spec.enable_serverless_compute;

  const res = await dbxFetch(`/api/2.0/sql/warehouses/${encodeURIComponent(id)}/edit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`editWarehouse failed ${res.status}: ${await res.text()}`);
  }
}

// ------------------------------------------------------------
// Query history (SQL warehouse statement history)
// ------------------------------------------------------------

export interface DbxQueryHistoryEntry {
  query_id: string;
  status: string;
  query_text?: string;
  query_start_time_ms?: number;
  query_end_time_ms?: number;
  duration?: number;       // ms
  warehouse_id?: string;
  user_name?: string;
  user_id?: number;
  executed_as_user_name?: string;
  rows_produced?: number;
  error_message?: string;
}

export async function listQueryHistory(
  opts: {
    warehouseId?: string;
    maxResults?: number;
    pageToken?: string;
    includeMetrics?: boolean;
  } = {},
): Promise<{ entries: DbxQueryHistoryEntry[]; nextPageToken?: string }> {
  const max = Math.max(1, Math.min(opts.maxResults ?? 50, 1000));
  const params = new URLSearchParams();
  params.set('max_results', String(max));
  if (opts.pageToken) params.set('page_token', opts.pageToken);
  if (opts.includeMetrics) params.set('include_metrics', 'true');
  if (opts.warehouseId) {
    params.set('filter_by.warehouse_ids', opts.warehouseId);
  }
  const res = await dbxFetch(`/api/2.0/sql/history/queries?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`listQueryHistory failed ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { res?: any[]; next_page_token?: string };
  const entries: DbxQueryHistoryEntry[] = (body.res || []).map((r) => ({
    query_id: r.query_id,
    status: r.status,
    query_text: r.query_text,
    query_start_time_ms: r.query_start_time_ms,
    query_end_time_ms: r.query_end_time_ms,
    duration: r.duration,
    warehouse_id: r.warehouse_id,
    user_name: r.user_name,
    user_id: r.user_id,
    executed_as_user_name: r.executed_as_user_name,
    rows_produced: r.rows_produced,
    error_message: r.error_message,
  }));
  return { entries, nextPageToken: body.next_page_token };
}

/**
 * Per-query execution metrics, returned by the Query History API when
 * `include_metrics=true`. Field set per the Databricks `QueryMetrics`
 * object (the same numbers the Databricks Query Profile UI renders).
 * https://docs.databricks.com/api/workspace/queryhistory/get
 */
export interface DbxQueryMetrics {
  compilation_time_ms?: number;
  execution_time_ms?: number;
  photon_total_time_ms?: number;
  total_time_ms?: number;
  read_bytes?: number;
  read_remote_bytes?: number;
  write_remote_bytes?: number;
  read_cache_bytes?: number;
  rows_read_count?: number;
  rows_produced_count?: number;
  result_fetch_time_ms?: number;
  read_files_count?: number;
  read_partitions_count?: number;
  pruned_files_count?: number;
  pruned_bytes?: number;
  network_sent_bytes?: number;
  spill_to_disk_bytes?: number;
  task_total_time_ms?: number;
  result_from_cache?: boolean;
}

/**
 * Single-query execution profile. The `metrics` object carries the IO/Photon
 * stats; `spark_ui_url` is the authoritative deep-link to the full physical
 * plan DAG in the Spark UI (the same data the Databricks Query Profile view
 * renders). `plans_state` reports whether the plan tree is available; when the
 * workspace returns the structured plan inline it lands on `plans` (opaque
 * JSON, passed straight through to the UI).
 */
export interface DbxQueryProfile {
  query_id: string;
  status: string;
  query_text?: string;
  query_start_time_ms?: number;
  query_end_time_ms?: number;
  duration?: number; // ms
  user_name?: string;
  warehouse_id?: string;
  rows_produced?: number;
  error_message?: string;
  spark_ui_url?: string;
  statement_type?: string;
  metrics?: DbxQueryMetrics;
  plans_state?: string;
  plans?: unknown;
}

/**
 * GET /api/2.0/sql/history/queries/{statement_id}?include_metrics=true
 *
 * Fetches a single query's execution profile (metrics + plan state + Spark UI
 * deep-link). The caller MI must own the query or hold CAN MONITOR on the
 * warehouse.
 */
export async function getQueryProfile(queryId: string): Promise<DbxQueryProfile> {
  const res = await dbxFetch(
    `/api/2.0/sql/history/queries/${encodeURIComponent(queryId)}?include_metrics=true`,
  );
  if (!res.ok) {
    throw new Error(`getQueryProfile failed ${res.status}: ${await res.text()}`);
  }
  // The single-query endpoint returns the QueryInfo object directly; some
  // workspace versions nest it under `res`. Accept either shape.
  const body = (await res.json()) as any;
  const q = body?.query_id ? body : body?.res || body;
  return {
    query_id: q.query_id,
    status: q.status,
    query_text: q.query_text,
    query_start_time_ms: q.query_start_time_ms,
    query_end_time_ms: q.query_end_time_ms,
    duration: q.duration,
    user_name: q.user_name,
    warehouse_id: q.warehouse_id,
    rows_produced: q.rows_produced,
    error_message: q.error_message,
    spark_ui_url: q.spark_ui_url,
    statement_type: q.statement_type,
    metrics: q.metrics,
    plans_state: q.plans_state,
    plans: q.plans,
  };
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

/**
 * A named parameter for the Statement Execution API. The SQL references the
 * marker as `:name` (colon-prefixed); the value here is bound SEPARATELY by
 * Databricks, never spliced into the SQL string — the canonical SQL-injection-
 * safe path. `type` is an optional SQL type hint (STRING/INT/DOUBLE/DATE/…).
 *
 * See: https://learn.microsoft.com/azure/databricks/sql/language-manual/sql-ref-parameter-marker
 */
export interface DbxQueryParam {
  name: string;
  value: string | null;
  type?: string;
}

export async function executeStatement(
  warehouseId: string,
  sql: string,
  catalog?: string,
  schema?: string,
  parameters?: DbxQueryParam[],
  onStatementId?: (id: string) => void,
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
  // Named parameter markers (`:name`) → the API `parameters` array. The value
  // is bound by Databricks, NOT concatenated into the statement, so this is
  // injection-safe regardless of what the user types.
  if (parameters?.length) {
    payload.parameters = parameters.map((p) => ({
      name: p.name,
      value: p.value,
      ...(p.type ? { type: p.type } : {}),
    }));
  }

  const res = await dbxFetch('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`executeStatement submit failed ${res.status}: ${await res.text()}`);
  }
  let body = (await res.json()) as StatementResponse;
  // Surface the server-assigned statement_id immediately so a caller (the BFF
  // query route) can register it for cancellation while we keep polling. The
  // Statement Execution API cancel endpoint keys off this id.
  if (body.statement_id) onStatementId?.(body.statement_id);

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

/**
 * Honest config gate for the SQL Statement Execution path. Returns the exact
 * missing env var when no warehouse is pinned (and none was passed) so a BFF
 * route can 503 with a precise MessageBar instead of a generic 500. Returns
 * null when a warehouse id is resolvable.
 */
export function warehouseConfigGate(explicit?: string | null): { missing: string } | null {
  const wid = (explicit || process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '').trim();
  if (!wid) return { missing: 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID' };
  return null;
}

/**
 * Typed not-configured error for the Databricks SQL warehouse path. Carries the
 * exact env var to set so the BFF can render an honest gate (no-vaporware.md)
 * rather than a generic 500.
 */
export class WarehouseNotConfiguredError extends Error {
  missing: string;
  constructor(missing = 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID') {
    super(
      `Databricks SQL warehouse not configured: set ${missing} on the Loom Console ` +
        `(the SQL warehouse used to query subscribed Delta Share catalogs).`,
    );
    this.name = 'WarehouseNotConfiguredError';
    this.missing = missing;
  }
}

/**
 * Run a SQL statement against the pinned Databricks SQL warehouse and return a
 * normalized {@link QueryResult}. This is the in-Loom "Explore / Query" path for
 * a subscribed Delta Share's mounted Unity Catalog catalog (and any other ad-hoc
 * read against the workspace's warehouse).
 *
 * The warehouse is resolved from `opts.warehouseId` → `LOOM_DATABRICKS_SQL_WAREHOUSE_ID`.
 * When neither is set we throw {@link WarehouseNotConfiguredError} so the caller
 * can surface the precise remediation (per no-vaporware.md) rather than failing
 * opaquely.
 *
 * Delegates to {@link executeStatement}, which POSTs to
 * `/api/2.0/sql/statements` with `disposition: INLINE`, `format: JSON_ARRAY`,
 * `wait_timeout: 30s`, then polls `GET /api/2.0/sql/statements/{id}` until the
 * statement is terminal (SUCCEEDED / FAILED / CANCELED). A FAILED statement
 * throws with the Databricks error message + error_code.
 *
 * The optional `catalog` / `schema` set the statement's default namespace so a
 * bare `SELECT * FROM tbl` resolves inside the subscribed catalog without
 * fully-qualifying every table.
 */
export async function runWarehouseStatement(
  sql: string,
  opts?: {
    warehouseId?: string;
    catalog?: string;
    schema?: string;
    parameters?: DbxQueryParam[];
    onStatementId?: (id: string) => void;
  },
): Promise<QueryResult> {
  const warehouseId = (opts?.warehouseId || process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '').trim();
  if (!warehouseId) throw new WarehouseNotConfiguredError();
  return executeStatement(
    warehouseId,
    sql,
    opts?.catalog,
    opts?.schema,
    opts?.parameters,
    opts?.onStatementId,
  );
}

// ============================================================
// Statement cancellation (SQL Statement Execution API 2.0)
// ============================================================

/**
 * In-process registry mapping a client-generated query id to the
 * server-assigned Databricks statement_id, so a separate /cancel request can
 * resolve the running statement without the client having to wait for the
 * (blocking) /query response to return the id first.
 *
 * Same-process only — sufficient for Loom's single-instance Container App.
 * On scale-out, a cancel may land on a different replica and find no entry;
 * the client then shows "Cancel sent" and the original query completes.
 */
const pendingStatements = new Map<string, string>(); // clientQueryId -> statement_id

export function registerPendingStatement(clientQueryId: string, statementId: string): void {
  if (clientQueryId && statementId) pendingStatements.set(clientQueryId, statementId);
}

export function clearPendingStatement(clientQueryId: string): void {
  if (clientQueryId) pendingStatements.delete(clientQueryId);
}

/**
 * Cancel a running statement.
 *   POST /api/2.0/sql/statements/{statement_id}/cancel
 * Grounded in the SQL Statement Execution API
 * (https://learn.microsoft.com/azure/databricks/api/workspace/statementexecution/cancelexecution).
 * Returns 200 with empty body when accepted; a 404 means the statement is
 * already terminal — both are treated as success.
 */
export async function cancelStatement(statementId: string): Promise<void> {
  const res = await dbxFetch(
    `/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`,
    { method: 'POST', body: '{}' },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`cancelStatement failed ${res.status}: ${await res.text()}`);
  }
}

/** Resolve a client query id to its statement_id and cancel it. */
export async function cancelByClientId(
  clientQueryId: string,
): Promise<{ canceled: boolean; statementId?: string }> {
  const statementId = pendingStatements.get(clientQueryId);
  if (!statementId) return { canceled: false };
  await cancelStatement(statementId);
  return { canceled: true, statementId };
}


async function asJsonOrThrow<T>(res: Response, op: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    const err: Error & { status?: number; body?: string } = new Error(
      `${op} failed ${res.status}: ${text || res.statusText}`,
    );
    err.status = res.status;
    err.body = text;
    throw err;
  }
  // Some endpoints (start/restart/delete) return empty body on success.
  const text = await res.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

// ============================================================
// Workspace / Notebooks  (api/2.0/workspace, api/2.1/jobs/runs)
// ============================================================
export interface WorkspaceObject {
  object_type: 'NOTEBOOK' | 'DIRECTORY' | 'LIBRARY' | 'FILE' | 'REPO' | string;
  path: string;
  language?: 'PYTHON' | 'SQL' | 'SCALA' | 'R' | string;
  object_id?: number;
  created_at?: number;
  modified_at?: number;
}

export async function listWorkspace(path = '/Workspace'): Promise<WorkspaceObject[]> {
  const res = await dbxFetch(
    `/api/2.0/workspace/list?path=${encodeURIComponent(path)}`,
  );
  // workspace/list returns 404 RESOURCE_DOES_NOT_EXIST on empty/missing path — bubble as []
  if (res.status === 404) return [];
  const body = await asJsonOrThrow<{ objects?: WorkspaceObject[] }>(res, 'listWorkspace');
  return body.objects || [];
}

export interface NotebookContent {
  path: string;
  language: string;
  content: string; // decoded source (UTF-8)
}

export async function getNotebook(path: string): Promise<NotebookContent> {
  const res = await dbxFetch(
    `/api/2.0/workspace/export?path=${encodeURIComponent(path)}&format=SOURCE&direct_download=false`,
  );
  const body = await asJsonOrThrow<{ content: string; file_type?: string }>(res, 'getNotebook');
  const buf = Buffer.from(body.content || '', 'base64');
  // Best-effort language detection from extension/header
  const lower = path.toLowerCase();
  const language = lower.endsWith('.py')
    ? 'PYTHON'
    : lower.endsWith('.sql')
      ? 'SQL'
      : lower.endsWith('.scala')
        ? 'SCALA'
        : lower.endsWith('.r')
          ? 'R'
          : (body.file_type || 'PYTHON').toUpperCase();
  return { path, language, content: buf.toString('utf-8') };
}

export async function importNotebook(
  path: string,
  language: 'PYTHON' | 'SQL' | 'SCALA' | 'R',
  source: string,
  overwrite = true,
): Promise<void> {
  const res = await dbxFetch('/api/2.0/workspace/import', {
    method: 'POST',
    body: JSON.stringify({
      path,
      format: 'SOURCE',
      language,
      content: Buffer.from(source, 'utf-8').toString('base64'),
      overwrite,
    }),
  });
  await asJsonOrThrow<unknown>(res, 'importNotebook');
}

/**
 * Import an arbitrary file (not a notebook) into a workspace folder using
 * `format: AUTO`. This is how a generated dbt project (dbt_project.yml,
 * profiles.yml, models/**.sql, schema.yml) lands in a workspace directory so a
 * Databricks Job dbt_task can run it with `source: WORKSPACE` +
 * `project_directory`. Workspace "files in workspace" hold arbitrary text.
 * Learn: /azure/databricks/files/workspace.
 */
export async function importWorkspaceFile(
  path: string,
  content: string,
  overwrite = true,
): Promise<void> {
  const res = await dbxFetch('/api/2.0/workspace/import', {
    method: 'POST',
    body: JSON.stringify({
      path,
      format: 'AUTO',
      content: Buffer.from(content, 'utf-8').toString('base64'),
      overwrite,
    }),
  });
  await asJsonOrThrow<unknown>(res, 'importWorkspaceFile');
}

export async function deleteWorkspaceObject(path: string, recursive = false): Promise<void> {
  const res = await dbxFetch('/api/2.0/workspace/delete', {
    method: 'POST',
    body: JSON.stringify({ path, recursive }),
  });
  await asJsonOrThrow<unknown>(res, 'deleteWorkspaceObject');
}

export async function mkdirsWorkspace(path: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/workspace/mkdirs', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  // mkdirs is idempotent on the server; a 400 "already exists" is fine.
  if (!res.ok && res.status !== 400) {
    throw new Error(`mkdirsWorkspace failed ${res.status}: ${await res.text()}`);
  }
}

export interface SubmittedRun {
  run_id: number;
  number_in_job?: number;
}

export async function runNotebook(
  path: string,
  clusterId: string,
  baseParameters?: Record<string, string>,
  runName?: string,
): Promise<SubmittedRun> {
  const payload: Record<string, unknown> = {
    run_name: runName || `loom-notebook-${Date.now()}`,
    tasks: [
      {
        task_key: 'notebook',
        existing_cluster_id: clusterId,
        notebook_task: {
          notebook_path: path,
          base_parameters: baseParameters || {},
        },
      },
    ],
  };
  const res = await dbxFetch('/api/2.1/jobs/runs/submit', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return asJsonOrThrow<SubmittedRun>(res, 'runNotebook');
}

export interface JobRun {
  run_id: number;
  job_id?: number;
  run_name?: string;
  state?: {
    life_cycle_state?: string;
    result_state?: string;
    state_message?: string;
  };
  start_time?: number;
  end_time?: number;
  setup_duration?: number;
  execution_duration?: number;
  cleanup_duration?: number;
  trigger?: string;
  creator_user_name?: string;
}

export async function listJobRuns(jobId?: number, limit = 25): Promise<JobRun[]> {
  const params = new URLSearchParams();
  if (jobId) params.set('job_id', String(jobId));
  params.set('limit', String(limit));
  params.set('expand_tasks', 'false');
  const res = await dbxFetch(`/api/2.1/jobs/runs/list?${params.toString()}`);
  const body = await asJsonOrThrow<{ runs?: JobRun[] }>(res, 'listJobRuns');
  return body.runs || [];
}

export async function getJobRun(runId: number): Promise<JobRun> {
  const res = await dbxFetch(`/api/2.1/jobs/runs/get?run_id=${runId}`);
  return asJsonOrThrow<JobRun>(res, 'getJobRun');
}

export interface RunOutput {
  notebook_output?: { result?: string; truncated?: boolean };
  logs?: string;
  logs_truncated?: boolean;
  error?: string;
  error_trace?: string;
  metadata?: JobRun;
}

export async function getRunOutput(runId: number): Promise<RunOutput> {
  const res = await dbxFetch(`/api/2.1/jobs/runs/get-output?run_id=${runId}`);
  return asJsonOrThrow<RunOutput>(res, 'getRunOutput');
}

// ============================================================
// Jobs  (api/2.1/jobs)
// ============================================================
export interface JobSpec {
  name?: string;
  tasks?: unknown[];
  schedule?: { quartz_cron_expression?: string; timezone_id?: string; pause_status?: string };
  max_concurrent_runs?: number;
  email_notifications?: unknown;
  [k: string]: unknown;
}

export interface Job {
  job_id: number;
  creator_user_name?: string;
  created_time?: number;
  settings?: JobSpec;
}

export async function listJobs(limit = 50): Promise<Job[]> {
  const res = await dbxFetch(
    `/api/2.1/jobs/list?limit=${limit}&expand_tasks=false`,
  );
  const body = await asJsonOrThrow<{ jobs?: Job[] }>(res, 'listJobs');
  return body.jobs || [];
}

export async function getJob(jobId: number): Promise<Job> {
  const res = await dbxFetch(`/api/2.1/jobs/get?job_id=${jobId}`);
  return asJsonOrThrow<Job>(res, 'getJob');
}

export async function createJob(spec: JobSpec): Promise<{ job_id: number }> {
  const res = await dbxFetch('/api/2.1/jobs/create', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return asJsonOrThrow<{ job_id: number }>(res, 'createJob');
}

export async function updateJob(jobId: number, newSettings: JobSpec): Promise<void> {
  const res = await dbxFetch('/api/2.1/jobs/reset', {
    method: 'POST',
    body: JSON.stringify({ job_id: jobId, new_settings: newSettings }),
  });
  await asJsonOrThrow<unknown>(res, 'updateJob');
}

export async function deleteJob(jobId: number): Promise<void> {
  const res = await dbxFetch('/api/2.1/jobs/delete', {
    method: 'POST',
    body: JSON.stringify({ job_id: jobId }),
  });
  await asJsonOrThrow<unknown>(res, 'deleteJob');
}

/**
 * Trigger an immediate run of a saved job (`POST /api/2.1/jobs/run-now`).
 *
 * Databricks accepts a different parameter shape per task type — all optional
 * and combinable for multi-task jobs (each task consumes the shape it knows):
 *   - notebook_params       Record<string,string>  (Notebook tasks)
 *   - python_params         string[]                (spark_python / Python script)
 *   - python_named_params   Record<string,string>  (Python wheel keyword args)
 *   - jar_params            string[]                (JAR / spark-submit)
 *   - spark_submit_params   string[]                (spark-submit)
 *   - sql_params            Record<string,string>  (SQL task query params)
 *   - dbt_commands          string[]                (dbt task)
 *   - job_parameters        Record<string,string>  (job-level parameters)
 *   - pipeline_params       { full_refresh?: boolean }
 *   - idempotency_token     string
 */
export interface RunNowParams {
  notebook_params?: Record<string, string>;
  python_params?: string[];
  python_named_params?: Record<string, string>;
  jar_params?: string[];
  spark_submit_params?: string[];
  sql_params?: Record<string, string>;
  dbt_commands?: string[];
  job_parameters?: Record<string, string>;
  pipeline_params?: { full_refresh?: boolean };
  idempotency_token?: string;
}

const RUN_NOW_SHAPES = new Set([
  'notebook_params', 'python_params', 'python_named_params', 'jar_params',
  'spark_submit_params', 'sql_params', 'dbt_commands', 'job_parameters',
  'pipeline_params', 'idempotency_token',
]);

export async function runJob(
  jobId: number,
  params?: RunNowParams | Record<string, string>,
): Promise<SubmittedRun> {
  const payload: Record<string, unknown> = { job_id: jobId };
  if (params && typeof params === 'object') {
    const keys = Object.keys(params);
    // Back-compat: a bare Record<string,string> = notebook_params.
    const isShaped = keys.length > 0 && keys.every((k) => RUN_NOW_SHAPES.has(k));
    if (isShaped) {
      for (const k of keys) {
        const v = (params as Record<string, unknown>)[k];
        if (v !== undefined && v !== null) payload[k] = v;
      }
    } else if (keys.length > 0) {
      payload.notebook_params = params;
    }
  }
  const res = await dbxFetch('/api/2.1/jobs/run-now', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return asJsonOrThrow<SubmittedRun>(res, 'runJob');
}

// ============================================================
// Clusters  (api/2.0/clusters)
// ============================================================
export interface Cluster {
  cluster_id: string;
  cluster_name?: string;
  state?: string;
  state_message?: string;
  spark_version?: string;
  node_type_id?: string;
  driver_node_type_id?: string;
  num_workers?: number;
  autoscale?: { min_workers?: number; max_workers?: number };
  autotermination_minutes?: number;
  creator_user_name?: string;
  start_time?: number;
  terminated_time?: number;
  custom_tags?: Record<string, string>;
  spark_conf?: Record<string, string>;
  data_security_mode?: string;
  /**
   * How the cluster was created. Only 'UI' / 'API' clusters are ALL-PURPOSE
   * (interactive) and accepted by `runs/submit` `existing_cluster_id`. 'JOB'
   * (and PIPELINE/MODELS/SQL) clusters are ephemeral/job clusters — passing one
   * to existing_cluster_id returns `INVALID_PARAMETER_VALUE … not an all-purpose
   * cluster`. clusters/list returns recently-run job clusters too, so callers
   * that need an interactive cluster MUST filter on this.
   */
  cluster_source?: string;
}

/** Is this an ALL-PURPOSE (interactive) cluster usable as existing_cluster_id?
 *  Accepts UI/API-sourced clusters; treats a missing cluster_source as
 *  all-purpose (older API shape) rather than over-filtering. */
export function isAllPurposeCluster(c: Cluster): boolean {
  return !c.cluster_source || c.cluster_source === 'UI' || c.cluster_source === 'API';
}

export interface ClusterSpec {
  cluster_name: string;
  spark_version: string;
  node_type_id: string;
  num_workers?: number;
  autoscale?: { min_workers: number; max_workers: number };
  autotermination_minutes?: number;
  data_security_mode?: string;
  spark_conf?: Record<string, string>;
  custom_tags?: Record<string, string>;
  driver_node_type_id?: string;
  /** Vectorized engine. 'PHOTON' enables Photon; 'STANDARD' (or omit) for OSS Spark. */
  runtime_engine?: 'PHOTON' | 'STANDARD';
  /** Azure VM availability — Spot for cost-optimized workers (driver stays on-demand). */
  azure_attributes?: {
    availability?: 'ON_DEMAND_AZURE' | 'SPOT_WITH_FALLBACK_AZURE' | 'SPOT_AZURE';
    first_on_demand?: number;
    spot_bid_max_price?: number;
  };
  /** Driver/worker/event-log delivery target so logs persist + can be ingested. */
  cluster_log_conf?: { dbfs?: { destination: string }; volumes?: { destination: string } };
}

export async function listClusters(): Promise<Cluster[]> {
  const res = await dbxFetch('/api/2.0/clusters/list');
  const body = await asJsonOrThrow<{ clusters?: Cluster[] }>(res, 'listClusters');
  return body.clusters || [];
}

export async function getCluster(clusterId: string): Promise<Cluster> {
  const res = await dbxFetch(
    `/api/2.0/clusters/get?cluster_id=${encodeURIComponent(clusterId)}`,
  );
  return asJsonOrThrow<Cluster>(res, 'getCluster');
}

export async function createCluster(spec: ClusterSpec): Promise<{ cluster_id: string }> {
  const res = await dbxFetch('/api/2.0/clusters/create', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return asJsonOrThrow<{ cluster_id: string }>(res, 'createCluster');
}

export async function editCluster(clusterId: string, spec: ClusterSpec): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/edit', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId, ...spec }),
  });
  await asJsonOrThrow<unknown>(res, 'editCluster');
}

export async function startCluster(clusterId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/start', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId }),
  });
  // Already-running returns 400 INVALID_STATE — ignore that case to make UI idempotent
  if (res.status === 400) {
    const text = await res.text();
    if (/already/i.test(text)) return;
    throw new Error(`startCluster failed 400: ${text}`);
  }
  await asJsonOrThrow<unknown>(res, 'startCluster');
}

export async function restartCluster(clusterId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/restart', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId }),
  });
  await asJsonOrThrow<unknown>(res, 'restartCluster');
}

export async function terminateCluster(clusterId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/delete', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId }),
  });
  await asJsonOrThrow<unknown>(res, 'terminateCluster');
}

export async function permanentDeleteCluster(clusterId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/clusters/permanent-delete', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId }),
  });
  await asJsonOrThrow<unknown>(res, 'permanentDeleteCluster');
}

export interface NodeType {
  node_type_id: string;
  memory_mb?: number;
  num_cores?: number;
  description?: string;
  category?: string;
  instance_type_id?: string;
}

export async function listNodeTypes(): Promise<NodeType[]> {
  const res = await dbxFetch('/api/2.0/clusters/list-node-types');
  const body = await asJsonOrThrow<{ node_types?: NodeType[] }>(res, 'listNodeTypes');
  return body.node_types || [];
}

export interface SparkVersion {
  key: string;
  name: string;
}

export async function listSparkVersions(): Promise<SparkVersion[]> {
  const res = await dbxFetch('/api/2.0/clusters/spark-versions');
  const body = await asJsonOrThrow<{ versions?: SparkVersion[] }>(res, 'listSparkVersions');
  return body.versions || [];
}

export interface ClusterEvent {
  cluster_id: string;
  timestamp?: number;
  type?: string;
  details?: Record<string, unknown>;
}

export async function listClusterEvents(
  clusterId: string,
  limit = 50,
): Promise<ClusterEvent[]> {
  const res = await dbxFetch('/api/2.0/clusters/events', {
    method: 'POST',
    body: JSON.stringify({
      cluster_id: clusterId,
      limit,
      order: 'DESC',
    }),
  });
  const body = await asJsonOrThrow<{ events?: ClusterEvent[] }>(res, 'listClusterEvents');
  return body.events || [];
}

// v3.4 — Libraries tab. Databricks /api/2.0/libraries/cluster-status returns
// install state for every library attached to the cluster (pypi, maven, jar,
// whl, etc.) plus per-status messages. The editor renders this read-only;
// install/uninstall lives in the Databricks UI for now since it touches
// per-library credentials (Azure DevOps PATs, private PyPI tokens, etc.).
export interface LibraryStatus {
  status?: string;
  is_library_for_all_clusters?: boolean;
  messages?: string[];
  library?: {
    pypi?: { package?: string; repo?: string };
    maven?: { coordinates?: string; repo?: string };
    cran?: { package?: string };
    jar?: string;
    egg?: string;
    whl?: string;
    requirements?: string;
  };
}

export async function listClusterLibraries(clusterId: string): Promise<LibraryStatus[]> {
  const res = await dbxFetch(
    `/api/2.0/libraries/cluster-status?cluster_id=${encodeURIComponent(clusterId)}`,
  );
  const body = await asJsonOrThrow<{ library_statuses?: LibraryStatus[] }>(res, 'listClusterLibraries');
  return body.library_statuses || [];
}

// ============================================================
// One-time notebook run — imports inline code as a notebook in
// /Shared/loom-runs/<ts>, then submits as a one-time job. Used
// by /api/items/notebook/[id]/run when compute is databricks.
// ============================================================

export async function runOneTimeNotebook(args: {
  clusterId: string;
  code: string;
  lang?: 'PYTHON' | 'SQL' | 'SCALA' | 'R';
  jobName?: string;
}): Promise<{ run_id: number; run_page_url?: string }> {
  const { clusterId, code, lang = 'PYTHON', jobName } = args;
  const ts = Date.now();
  const nbPath = `/Shared/loom-runs/${ts}-${jobName || 'notebook'}`;

  // 1) Ensure parent dir
  await dbxFetch('/api/2.0/workspace/mkdirs', {
    method: 'POST',
    body: JSON.stringify({ path: '/Shared/loom-runs' }),
  }).catch(() => { /* dir may exist */ });

  // 2) Import the notebook source
  await importNotebook(nbPath, lang, code, true);

  // 3) Submit as one-time run
  const submitRes = await dbxFetch('/api/2.1/jobs/runs/submit', {
    method: 'POST',
    body: JSON.stringify({
      run_name: jobName || `loom-${ts}`,
      existing_cluster_id: clusterId,
      notebook_task: { notebook_path: nbPath },
    }),
  });
  return asJsonOrThrow<{ run_id: number; run_page_url?: string }>(submitRes, 'runOneTimeNotebook');
}

// ============================================================
// Command Execution API (api/1.2) — per-cell notebook execution
//
// This is the REST surface that backs an interactive Databricks notebook:
// the UI creates an execution context bound to a cluster + language REPL,
// then runs each cell's source as a command against that context and polls
// for the command's result. Variables persist across commands in the same
// context (same REPL), exactly like a real notebook attached to a cluster.
//
// Flow:
//   1. POST /api/1.2/contexts/create   { clusterId, language }      -> { id }
//   2. POST /api/1.2/commands/execute  { clusterId, contextId,
//                                        language, command }        -> { id }
//   3. GET  /api/1.2/commands/status?clusterId&contextId&commandId -> result
//   4. POST /api/1.2/contexts/destroy  { clusterId, contextId }    (cleanup)
//
// Languages: 'python' | 'sql' | 'scala' | 'r'. Markdown cells are rendered
// client-side and never sent here.
// ============================================================

export type CommandLanguage = 'python' | 'sql' | 'scala' | 'r';

export interface ExecutionContext {
  id: string;
  status?: string; // Pending | Running | Error | Cancelling | Cancelled
}

/**
 * Create an execution context (a language REPL) bound to a cluster. The
 * returned context id is reused across cell executions so notebook state
 * (variables, imports, temp views) persists between cells.
 */
export async function createExecutionContext(
  clusterId: string,
  language: CommandLanguage,
): Promise<ExecutionContext> {
  const res = await dbxFetch('/api/1.2/contexts/create', {
    method: 'POST',
    body: JSON.stringify({ clusterId, language }),
  });
  return asJsonOrThrow<ExecutionContext>(res, 'createExecutionContext');
}

export interface ContextStatus {
  id: string;
  status?: 'Pending' | 'Running' | 'Error' | string;
}

export async function getExecutionContextStatus(
  clusterId: string,
  contextId: string,
): Promise<ContextStatus> {
  const params = new URLSearchParams({ clusterId, contextId });
  const res = await dbxFetch(`/api/1.2/contexts/status?${params.toString()}`);
  return asJsonOrThrow<ContextStatus>(res, 'getExecutionContextStatus');
}

export async function destroyExecutionContext(
  clusterId: string,
  contextId: string,
): Promise<void> {
  const res = await dbxFetch('/api/1.2/contexts/destroy', {
    method: 'POST',
    body: JSON.stringify({ clusterId, contextId }),
  });
  // destroy is best-effort — a stale context returns 404/400; don't throw.
  if (!res.ok && res.status !== 404 && res.status !== 400) {
    throw new Error(`destroyExecutionContext failed ${res.status}: ${await res.text()}`);
  }
}

export interface SubmittedCommand {
  id: string;
}

export async function runCommand(
  clusterId: string,
  contextId: string,
  language: CommandLanguage,
  command: string,
): Promise<SubmittedCommand> {
  const res = await dbxFetch('/api/1.2/commands/execute', {
    method: 'POST',
    body: JSON.stringify({ clusterId, contextId, language, command }),
  });
  return asJsonOrThrow<SubmittedCommand>(res, 'runCommand');
}

// Databricks command result shape (api/1.2). `resultType` is 'text' for
// stdout, 'table' for tabular results (with schema + data), 'image' for
// inline plots, and 'error' with summary/cause for failures.
export interface CommandResult {
  id: string;
  status?: 'Queued' | 'Running' | 'Cancelling' | 'Finished' | 'Cancelled' | 'Error' | string;
  results?: {
    resultType?: 'text' | 'table' | 'image' | 'error' | string;
    data?: unknown;
    schema?: Array<{ name?: string; type?: string }>;
    cause?: string;
    summary?: string;
    fileName?: string;
    truncated?: boolean;
  };
}

export async function getCommandStatus(
  clusterId: string,
  contextId: string,
  commandId: string,
): Promise<CommandResult> {
  const params = new URLSearchParams({ clusterId, contextId, commandId });
  const res = await dbxFetch(`/api/1.2/commands/status?${params.toString()}`);
  return asJsonOrThrow<CommandResult>(res, 'getCommandStatus');
}

export async function cancelCommand(
  clusterId: string,
  contextId: string,
  commandId: string,
): Promise<void> {
  const res = await dbxFetch('/api/1.2/commands/cancel', {
    method: 'POST',
    body: JSON.stringify({ clusterId, contextId, commandId }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`cancelCommand failed ${res.status}: ${await res.text()}`);
  }
}

const CMD_POLL_INTERVAL_MS = 1_000;
const CMD_POLL_TIMEOUT_MS = 600_000; // 10 min — long enough for Spark jobs.

/**
 * Execute a single cell end-to-end against an existing context and poll to
 * completion. Returns the terminal CommandResult. The caller owns the
 * context lifecycle (create once, reuse across cells, destroy on close).
 */
export async function executeCommand(
  clusterId: string,
  contextId: string,
  language: CommandLanguage,
  command: string,
): Promise<CommandResult> {
  const submitted = await runCommand(clusterId, contextId, language, command);
  const deadline = Date.now() + CMD_POLL_TIMEOUT_MS;
  let body = await getCommandStatus(clusterId, contextId, submitted.id);
  while (
    (body.status === 'Queued' || body.status === 'Running' || body.status === 'Cancelling') &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, CMD_POLL_INTERVAL_MS));
    body = await getCommandStatus(clusterId, contextId, submitted.id);
  }
  return body;
}

// ============================================================
// Unity Catalog — catalogs, schemas, tables
// Backs the MirroredDatabricksEditor (Fabric MirroredAzureDatabricksCatalog).
// Auth path is the same Bearer flow; UC API lives under /api/2.1/unity-catalog.
// ============================================================

export interface UcCatalog {
  name: string;
  comment?: string;
  owner?: string;
  metastore_id?: string;
  catalog_type?: string;
  created_at?: number;
  updated_at?: number;
}

export interface UcSchema {
  name: string;
  catalog_name: string;
  full_name?: string;
  comment?: string;
  owner?: string;
  created_at?: number;
  updated_at?: number;
}

export interface UcTable {
  name: string;
  catalog_name: string;
  schema_name: string;
  full_name?: string;
  table_type?: 'MANAGED' | 'EXTERNAL' | 'VIEW' | 'MATERIALIZED_VIEW' | string;
  data_source_format?: string;
  comment?: string;
  owner?: string;
  storage_location?: string;
  columns?: Array<{ name: string; type_name?: string; type_text?: string; nullable?: boolean; comment?: string }>;
  created_at?: number;
  updated_at?: number;
}

export async function listUcCatalogs(): Promise<UcCatalog[]> {
  const res = await dbxFetch('/api/2.1/unity-catalog/catalogs');
  const body = await asJsonOrThrow<{ catalogs?: UcCatalog[] }>(res, 'listUcCatalogs');
  return body.catalogs || [];
}

export async function listUcSchemas(catalogName: string): Promise<UcSchema[]> {
  const params = new URLSearchParams({ catalog_name: catalogName });
  const res = await dbxFetch(`/api/2.1/unity-catalog/schemas?${params.toString()}`);
  const body = await asJsonOrThrow<{ schemas?: UcSchema[] }>(res, `listUcSchemas(${catalogName})`);
  return body.schemas || [];
}

export async function listUcTables(catalogName: string, schemaName: string): Promise<UcTable[]> {
  const params = new URLSearchParams({ catalog_name: catalogName, schema_name: schemaName });
  const res = await dbxFetch(`/api/2.1/unity-catalog/tables?${params.toString()}`);
  const body = await asJsonOrThrow<{ tables?: UcTable[] }>(res, `listUcTables(${catalogName}.${schemaName})`);
  return body.tables || [];
}

export async function getUcTable(fullName: string): Promise<UcTable> {
  // GET /api/2.1/unity-catalog/tables/{full_name}  (catalog.schema.table)
  const res = await dbxFetch(`/api/2.1/unity-catalog/tables/${fullName.split('.').map(encodeURIComponent).join('.')}`);
  return asJsonOrThrow<UcTable>(res, `getUcTable(${fullName})`);
}

// ---- Volumes (managed/external storage volumes under a schema) ----
export interface UcVolume {
  name: string;
  catalog_name?: string;
  schema_name?: string;
  full_name?: string;
  volume_type?: 'MANAGED' | 'EXTERNAL' | string;
  storage_location?: string;
  comment?: string;
  owner?: string;
}

export async function listUcVolumes(catalogName: string, schemaName: string): Promise<UcVolume[]> {
  const params = new URLSearchParams({ catalog_name: catalogName, schema_name: schemaName });
  const res = await dbxFetch(`/api/2.1/unity-catalog/volumes?${params.toString()}`);
  const body = await asJsonOrThrow<{ volumes?: UcVolume[] }>(res, `listUcVolumes(${catalogName}.${schemaName})`);
  return body.volumes || [];
}

// ---- Functions (registered UDFs under a schema) ----
export interface UcFunction {
  name: string;
  catalog_name?: string;
  schema_name?: string;
  full_name?: string;
  data_type?: string;
  comment?: string;
  owner?: string;
}

export async function listUcFunctions(catalogName: string, schemaName: string): Promise<UcFunction[]> {
  const params = new URLSearchParams({ catalog_name: catalogName, schema_name: schemaName });
  const res = await dbxFetch(`/api/2.1/unity-catalog/functions?${params.toString()}`);
  const body = await asJsonOrThrow<{ functions?: UcFunction[] }>(res, `listUcFunctions(${catalogName}.${schemaName})`);
  return body.functions || [];
}

// ============================================================
// Unity Catalog — WRITE (create catalog / schema / table, grants)
// All on the real UC REST surface (api 2.1). The console UAMI must be a
// metastore-privileged principal (CREATE CATALOG on the metastore, or
// CREATE SCHEMA / CREATE TABLE on the parent) — Databricks 403s otherwise,
// surfaced verbatim through asJsonOrThrow.
// ============================================================

export interface UcCatalogCreateSpec {
  name: string;
  comment?: string;
  storage_root?: string;             // optional managed-storage root (abfss://…)
  properties?: Record<string, string>;
  // Catalog type — matches the Catalog Explorer "Type" selector. A standard
  // managed catalog is the default; a FOREIGN catalog wraps an external
  // database via a UC connection; a Delta-Sharing catalog mounts a share from
  // a provider. (Learn: catalogs/create-catalog, query-foreign, delta-sharing.)
  catalog_type?: 'MANAGED_CATALOG' | 'FOREIGN_CATALOG' | 'DELTASHARING_CATALOG';
  connection_name?: string;          // FOREIGN_CATALOG: the UC connection to wrap
  options?: Record<string, string>;  // FOREIGN_CATALOG: e.g. { database: 'sales' }
  provider_name?: string;            // DELTASHARING_CATALOG: share provider
  share_name?: string;               // DELTASHARING_CATALOG: share to mount
}

/** POST /api/2.1/unity-catalog/catalogs */
export async function createUcCatalog(spec: UcCatalogCreateSpec): Promise<UcCatalog> {
  const body: Record<string, unknown> = { name: spec.name };
  if (spec.comment) body.comment = spec.comment;
  if (spec.storage_root) body.storage_root = spec.storage_root;
  if (spec.properties && Object.keys(spec.properties).length) body.properties = spec.properties;
  // Foreign catalogs wrap a connection; Delta-Sharing catalogs mount a share.
  // Standard catalogs send no catalog_type (UC defaults to a managed catalog).
  if (spec.catalog_type === 'FOREIGN_CATALOG') {
    if (!spec.connection_name) throw new Error('createUcCatalog: FOREIGN catalog requires connection_name');
    body.connection_name = spec.connection_name;
    if (spec.options && Object.keys(spec.options).length) body.options = spec.options;
  } else if (spec.catalog_type === 'DELTASHARING_CATALOG') {
    if (!spec.provider_name || !spec.share_name) throw new Error('createUcCatalog: Delta-Sharing catalog requires provider_name and share_name');
    body.provider_name = spec.provider_name;
    body.share_name = spec.share_name;
  }
  const res = await dbxFetch('/api/2.1/unity-catalog/catalogs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return asJsonOrThrow<UcCatalog>(res, 'createUcCatalog');
}

/** DELETE /api/2.1/unity-catalog/catalogs/{name}?force= */
export async function deleteUcCatalog(name: string, force = false): Promise<void> {
  const qs = force ? '?force=true' : '';
  const res = await dbxFetch(`/api/2.1/unity-catalog/catalogs/${encodeURIComponent(name)}${qs}`, {
    method: 'DELETE',
  });
  await asJsonOrThrow<unknown>(res, 'deleteUcCatalog');
}

export interface UcSchemaCreateSpec {
  name: string;
  catalog_name: string;
  comment?: string;
  storage_root?: string;
  properties?: Record<string, string>;
}

/** POST /api/2.1/unity-catalog/schemas */
export async function createUcSchema(spec: UcSchemaCreateSpec): Promise<UcSchema> {
  const body: Record<string, unknown> = { name: spec.name, catalog_name: spec.catalog_name };
  if (spec.comment) body.comment = spec.comment;
  if (spec.storage_root) body.storage_root = spec.storage_root;
  if (spec.properties && Object.keys(spec.properties).length) body.properties = spec.properties;
  const res = await dbxFetch('/api/2.1/unity-catalog/schemas', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return asJsonOrThrow<UcSchema>(res, 'createUcSchema');
}

/** DELETE /api/2.1/unity-catalog/schemas/{full_name}  (catalog.schema) */
export async function deleteUcSchema(fullName: string, force = false): Promise<void> {
  const qs = force ? '?force=true' : '';
  const path = fullName.split('.').map(encodeURIComponent).join('.');
  const res = await dbxFetch(`/api/2.1/unity-catalog/schemas/${path}${qs}`, { method: 'DELETE' });
  await asJsonOrThrow<unknown>(res, 'deleteUcSchema');
}

export interface UcColumnSpec {
  name: string;
  type_name: string;                 // 'STRING' | 'INT' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP' | 'DATE' | …
  type_text?: string;                // defaults to lowercased type_name
  position: number;
  nullable?: boolean;
  comment?: string;
}

export interface UcTableCreateSpec {
  name: string;
  catalog_name: string;
  schema_name: string;
  columns: UcColumnSpec[];
  table_type?: 'MANAGED' | 'EXTERNAL';
  data_source_format?: 'DELTA' | 'PARQUET' | 'CSV' | 'JSON' | 'ORC' | 'AVRO' | 'TEXT' | string;
  storage_location?: string;         // required for EXTERNAL
  comment?: string;
}

/**
 * POST /api/2.1/unity-catalog/tables — create a UC table directly via REST.
 * For MANAGED Delta tables the storage_location is omitted (UC manages it).
 * EXTERNAL tables require storage_location. column_info type_json/type_name
 * follow the UC ColumnInfo schema.
 */
export async function createUcTable(spec: UcTableCreateSpec): Promise<UcTable> {
  const tableType = spec.table_type ?? 'MANAGED';
  const fmt = spec.data_source_format ?? 'DELTA';
  const columns = spec.columns.map((c) => ({
    name: c.name,
    type_name: c.type_name.toUpperCase(),
    type_text: c.type_text ?? c.type_name.toLowerCase(),
    type_json: JSON.stringify({
      name: c.name,
      type: c.type_name.toLowerCase(),
      nullable: c.nullable !== false,
      metadata: {},
    }),
    position: c.position,
    nullable: c.nullable !== false,
    ...(c.comment ? { comment: c.comment } : {}),
  }));
  const body: Record<string, unknown> = {
    name: spec.name,
    catalog_name: spec.catalog_name,
    schema_name: spec.schema_name,
    table_type: tableType,
    data_source_format: fmt,
    columns,
  };
  if (spec.comment) body.comment = spec.comment;
  if (tableType === 'EXTERNAL') {
    if (!spec.storage_location) {
      throw new Error('createUcTable: EXTERNAL tables require storage_location');
    }
    body.storage_location = spec.storage_location;
  } else if (spec.storage_location) {
    body.storage_location = spec.storage_location;
  }
  const res = await dbxFetch('/api/2.1/unity-catalog/tables', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return asJsonOrThrow<UcTable>(res, 'createUcTable');
}

// ------------------------------------------------------------
// Create table FROM a file (Catalog Explorer "Create table from file"
// — upload → infer schema → CREATE TABLE). Real Databricks flow, no mock:
//   1. PUT the uploaded bytes into a staging path on a UC Volume
//      (`/Volumes/<cat>/<schema>/<volume>/_loom_uploads/<file>`) via the
//      Files API (`writeUcVolumesFile`).
//   2. Run `CREATE TABLE … AS SELECT * FROM read_files('<vol path>', …)` on a
//      SQL Warehouse via the Statement Execution API. `read_files` (Auto
//      Loader's batch reader) infers the schema from the file, so the new
//      managed Delta table lands with inferred columns — exactly what the
//      portal's "Create table from file" dialog does.
//   3. Best-effort delete the staging file (the table is materialized Delta;
//      it no longer needs the raw upload).
// Learn:
//   https://learn.microsoft.com/azure/databricks/ingestion/file-upload/
//   https://learn.microsoft.com/azure/databricks/sql/language-manual/functions/read_files
// ------------------------------------------------------------

export interface UcTableFromFileSpec {
  catalog_name: string;
  schema_name: string;
  table_name: string;
  /** UC Volume (catalog.schema.volume) used to stage the upload. */
  volume: string;
  /** Original file name, e.g. `orders.csv`. */
  file_name: string;
  /** Raw text content of the uploaded file (CSV/JSON/etc). */
  content: string;
  /** read_files format — csv | json | parquet | orc | avro | text. */
  format: 'csv' | 'json' | 'parquet' | 'orc' | 'avro' | 'text';
  /** Warehouse to run the inference + CREATE TABLE statement on. */
  warehouse_id: string;
  /** CSV header row present (default true for csv). */
  header?: boolean;
}

export interface UcTableFromFileResult {
  full_name: string;
  row_count: number | null;
  columns: string[];
  staged_path: string;
}

export async function createUcTableFromFile(
  spec: UcTableFromFileSpec,
): Promise<UcTableFromFileResult> {
  const volParts = spec.volume.split('.');
  if (volParts.length !== 3) {
    throw new Error('createUcTableFromFile: volume must be catalog.schema.volume');
  }
  // Identifier hygiene — only allow safe identifier chars in names we splice
  // into the SQL statement. The file PATH is bound via a `read_files()` string
  // literal (single-quoted, with quotes escaped), so it cannot break out.
  const ident = (v: string) => {
    if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`Invalid identifier: ${v}`);
    return v;
  };
  const cat = ident(spec.catalog_name);
  const sch = ident(spec.schema_name);
  const tbl = ident(spec.table_name);
  const safeFile = spec.file_name.replace(/[^A-Za-z0-9._-]/g, '_');
  const stagedPath = `/Volumes/${volParts[0]}/${volParts[1]}/${volParts[2]}/_loom_uploads/${Date.now()}_${safeFile}`;

  // 1. Upload the bytes to the volume.
  await writeUcVolumesFile(stagedPath, spec.content);

  // 2. Build read_files options and run CREATE TABLE AS SELECT.
  const opts: string[] = [`format => '${spec.format}'`];
  if (spec.format === 'csv') {
    opts.push(`header => ${spec.header === false ? 'false' : 'true'}`);
    opts.push(`inferSchema => true`);
  }
  const literalPath = stagedPath.replace(/'/g, "''");
  const fqtn = `\`${cat}\`.\`${sch}\`.\`${tbl}\``;
  const createSql =
    `CREATE TABLE ${fqtn} AS SELECT * FROM read_files('${literalPath}', ${opts.join(', ')})`;

  try {
    await executeStatement(spec.warehouse_id, createSql, spec.catalog_name, spec.schema_name);
  } catch (e) {
    // Clean up the staged file on failure so a retry is not blocked by leftovers.
    await deleteUcVolumesFile(stagedPath).catch(() => {});
    throw e;
  }

  // 3. Read back the materialized table's columns + row count.
  let columns: string[] = [];
  let rowCount: number | null = null;
  try {
    const detail = await getUcTable(`${cat}.${sch}.${tbl}`);
    columns = (detail.columns || []).map((c) => c.name);
  } catch { /* table created but detail read failed — non-fatal */ }
  try {
    const cnt = await executeStatement(
      spec.warehouse_id, `SELECT COUNT(*) AS n FROM ${fqtn}`, spec.catalog_name, spec.schema_name,
    );
    const v = cnt.rows?.[0]?.[0];
    rowCount = v != null ? Number(v) : null;
  } catch { /* count is best-effort */ }

  // 4. Best-effort cleanup of the staging file (table is now materialized Delta).
  await deleteUcVolumesFile(stagedPath).catch(() => {});

  return { full_name: `${cat}.${sch}.${tbl}`, row_count: rowCount, columns, staged_path: stagedPath };
}

/** DELETE /api/2.1/unity-catalog/tables/{full_name}  (catalog.schema.table) */
export async function deleteUcTable(fullName: string): Promise<void> {
  const path = fullName.split('.').map(encodeURIComponent).join('.');
  const res = await dbxFetch(`/api/2.1/unity-catalog/tables/${path}`, { method: 'DELETE' });
  await asJsonOrThrow<unknown>(res, 'deleteUcTable');
}

// ---- Grants / permissions ----
// securable_type is one of CATALOG | SCHEMA | TABLE | VOLUME | FUNCTION | …
// full_name is the dot-qualified name of the securable.
export type UcSecurableType =
  | 'CATALOG' | 'SCHEMA' | 'TABLE' | 'VOLUME' | 'FUNCTION'
  | 'EXTERNAL_LOCATION' | 'STORAGE_CREDENTIAL' | 'METASTORE' | string;

export interface UcPrivilegeAssignment {
  principal: string;
  privileges: string[];
}

/**
 * GET /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 * Returns direct grants on the securable.
 */
export async function getUcPermissions(
  securableType: UcSecurableType,
  fullName: string,
): Promise<UcPrivilegeAssignment[]> {
  const path = fullName.split('.').map(encodeURIComponent).join('.');
  const res = await dbxFetch(`/api/2.1/unity-catalog/permissions/${encodeURIComponent(securableType)}/${path}`);
  const body = await asJsonOrThrow<{ privilege_assignments?: UcPrivilegeAssignment[] }>(res, 'getUcPermissions');
  return body.privilege_assignments || [];
}

/**
 * GET /api/2.1/unity-catalog/effective-permissions/{securable_type}/{full_name}
 * Returns inherited + direct grants.
 */
export async function getUcEffectivePermissions(
  securableType: UcSecurableType,
  fullName: string,
): Promise<Array<{ principal: string; privileges: Array<{ privilege: string; inherited_from_type?: string; inherited_from_name?: string }> }>> {
  const path = fullName.split('.').map(encodeURIComponent).join('.');
  const res = await dbxFetch(`/api/2.1/unity-catalog/effective-permissions/${encodeURIComponent(securableType)}/${path}`);
  const body = await asJsonOrThrow<{
    privilege_assignments?: Array<{ principal: string; privileges: Array<{ privilege: string; inherited_from_type?: string; inherited_from_name?: string }> }>;
  }>(res, 'getUcEffectivePermissions');
  return body.privilege_assignments || [];
}

export interface UcPermissionsChange {
  principal: string;
  add?: string[];
  remove?: string[];
}

/**
 * PATCH /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 * Body: { changes: [{ principal, add?: [...], remove?: [...] }] }
 * Returns the resulting direct grants.
 */
export async function updateUcPermissions(
  securableType: UcSecurableType,
  fullName: string,
  changes: UcPermissionsChange[],
): Promise<UcPrivilegeAssignment[]> {
  const path = fullName.split('.').map(encodeURIComponent).join('.');
  const res = await dbxFetch(`/api/2.1/unity-catalog/permissions/${encodeURIComponent(securableType)}/${path}`, {
    method: 'PATCH',
    body: JSON.stringify({ changes }),
  });
  const body = await asJsonOrThrow<{ privilege_assignments?: UcPrivilegeAssignment[] }>(res, 'updateUcPermissions');
  return body.privilege_assignments || [];
}

// ---- Ownership transfer / metadata update (ALTER … SET OWNER / SET … ) ----
// The Catalog Explorer "Owner" pencil and "Change owner" action map to a UC
// PATCH/UPDATE on the securable: `ALTER CATALOG c SET OWNER TO principal`,
// `ALTER SCHEMA c.s SET OWNER TO principal`, `ALTER TABLE c.s.t SET OWNER TO
// principal`. The REST equivalents are PATCH/UPDATE on the securable URL with
// `{ owner }` (and optionally `{ comment }`). Requires the caller to be the
// current owner, a metastore admin, or hold MANAGE on the object — a UC 403 is
// surfaced verbatim. (Learn: data-governance/unity-catalog/manage-privileges,
// catalogs/manage-catalog, schemas/manage-schema, tables/index.)
export interface UcMetadataPatch {
  owner?: string;
  comment?: string;
  new_name?: string;
}

function ucPatchBody(patch: UcMetadataPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.owner !== undefined) body.owner = patch.owner;
  if (patch.comment !== undefined) body.comment = patch.comment;
  if (patch.new_name !== undefined) body.new_name = patch.new_name;
  return body;
}

/** PATCH /api/2.1/unity-catalog/catalogs/{name} — change owner / comment. */
export async function patchUcCatalog(name: string, patch: UcMetadataPatch): Promise<UcCatalog> {
  const res = await dbxFetch(`/api/2.1/unity-catalog/catalogs/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify(ucPatchBody(patch)),
  });
  return asJsonOrThrow<UcCatalog>(res, `patchUcCatalog(${name})`);
}

/** PATCH /api/2.1/unity-catalog/schemas/{full_name} (catalog.schema). */
export async function patchUcSchema(fullName: string, patch: UcMetadataPatch): Promise<UcSchema> {
  const path = fullName.split('.').map(encodeURIComponent).join('.');
  const res = await dbxFetch(`/api/2.1/unity-catalog/schemas/${path}`, {
    method: 'PATCH',
    body: JSON.stringify(ucPatchBody(patch)),
  });
  return asJsonOrThrow<UcSchema>(res, `patchUcSchema(${fullName})`);
}

/** PATCH /api/2.1/unity-catalog/tables/{full_name} (catalog.schema.table). */
export async function patchUcTable(fullName: string, patch: UcMetadataPatch): Promise<UcTable> {
  const path = fullName.split('.').map(encodeURIComponent).join('.');
  const res = await dbxFetch(`/api/2.1/unity-catalog/tables/${path}`, {
    method: 'PATCH',
    body: JSON.stringify(ucPatchBody(patch)),
  });
  return asJsonOrThrow<UcTable>(res, `patchUcTable(${fullName})`);
}

// ============================================================
// Repos / Git folders  (api/2.0/repos)
//
// Databricks Git folders link a workspace path to a remote Git repo. The REST
// surface: list, create (must link a remote repo + provider), get, update
// (checkout branch/tag), delete. Mirrors `databricks repos` CLI group.
// ============================================================
export interface Repo {
  id: number;
  url?: string;
  provider?: string;
  path?: string;
  branch?: string;
  head_commit_id?: string;
}

export async function listRepos(pathPrefix?: string): Promise<Repo[]> {
  // /api/2.0/repos is paginated (next_page_token). Walk all pages so counts are real.
  const out: Repo[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams();
    if (pathPrefix) params.set('path_prefix', pathPrefix);
    if (token) params.set('next_page_token', token);
    const qs = params.toString();
    const res = await dbxFetch(`/api/2.0/repos${qs ? `?${qs}` : ''}`);
    const body = await asJsonOrThrow<{ repos?: Repo[]; next_page_token?: string }>(res, 'listRepos');
    out.push(...(body.repos || []));
    token = body.next_page_token;
  } while (token);
  return out;
}

export interface RepoCreateSpec {
  url: string;
  provider: string;   // gitHub | gitLab | azureDevOpsServices | bitbucketCloud | …
  path?: string;      // /Repos/<user>/<name> ; server derives one when omitted
}

export async function createRepo(spec: RepoCreateSpec): Promise<Repo> {
  const res = await dbxFetch('/api/2.0/repos', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return asJsonOrThrow<Repo>(res, 'createRepo');
}

export async function deleteRepo(repoId: number): Promise<void> {
  const res = await dbxFetch(`/api/2.0/repos/${repoId}`, { method: 'DELETE' });
  await asJsonOrThrow<unknown>(res, 'deleteRepo');
}

// ------------------------------------------------------------
// Unity Catalog Volumes — file I/O (Databricks Files API)
//
// Used by Delta Sharing Tables shortcuts: the open-sharing credential file
// (profile JSON) must live on a path the workspace can read so the
// `delta_sharing` Spark provider can authenticate against the share server.
// A UC Volume file at /Volumes/<cat>/<schema>/<volume>/<file> is the modern,
// UC-governed location for this (DBFS is legacy). API: PUT/DELETE /api/2.0/fs/files.
// Learn: https://learn.microsoft.com/azure/databricks/files/volumes
// ------------------------------------------------------------

/**
 * Write text content to a file in a UC Volume via the Databricks Files API
 * (`PUT /api/2.0/fs/files/<path>`). The path must be a UC Volume file path
 * (`/Volumes/<catalog>/<schema>/<volume>/<file>`). Uses a raw-body request
 * (not dbxFetch, which forces application/json) so the bytes land verbatim.
 */
export async function writeUcVolumesFile(volumePath: string, content: string): Promise<void> {
  const token = await dbxToken();
  const res = await fetchWithTimeout(
    `https://${host()}/api/2.0/fs/files${volumePath.startsWith('/') ? '' : '/'}${volumePath}?overwrite=true`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: content,
    },
  );
  if (!res.ok) {
    throw new Error(`writeUcVolumesFile failed for ${volumePath}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Delete a file from a UC Volume via the Databricks Files API
 * (`DELETE /api/2.0/fs/files/<path>`). Best-effort: a 404 (already gone) is not
 * an error. Used to clean up a Delta Sharing credential file when a shortcut is
 * deleted. Never touches the shared source data.
 */
export async function deleteUcVolumesFile(volumePath: string): Promise<void> {
  const token = await dbxToken();
  const res = await fetchWithTimeout(
    `https://${host()}/api/2.0/fs/files${volumePath.startsWith('/') ? '' : '/'}${volumePath}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteUcVolumesFile failed for ${volumePath}: HTTP ${res.status}`);
  }
}

// ============================================================
// Databricks SQL — Queries + Alerts (query-result alerting)
//
// The modern Databricks SQL alerting model (Learn:
// /azure/databricks/sql/user/alerts/) is a two-object pair:
//   1. a saved Query object — owns the SQL text + the warehouse it runs on
//      (POST /api/2.0/sql/queries)
//   2. an Alert object — references that query_id, evaluates a Condition
//      (op / value-column / threshold) on the result, and runs on a Schedule
//      (POST /api/2.0/sql/alerts)
// Both modern endpoints wrap the resource in a single-key envelope
// (`{ query: {...} }` / `{ alert: {...} }`) and return the created object with
// its server-assigned `id`. Condition shape is grounded in the documented CLI
// example:
//   { op:'GREATER_THAN', operand:{ column:{ name:'cpu' } },
//     threshold:{ value:{ double_value: 80 } } }
// Notification destinations are managed separately (workspace notification
// destinations); the alert links subscribers by id. This client creates the
// rule; the editor surfaces an honest note that subscribers are added in the
// Databricks portal / via the destinations API.
// ============================================================

/** A Databricks SQL saved query (the query an alert evaluates). */
export interface DbxSqlQuery {
  id: string;
  display_name?: string;
  query_text?: string;
  warehouse_id?: string;
}

/**
 * Create a saved SQL query that an alert can evaluate.
 *   POST /api/2.0/sql/queries  body { query: { display_name, query_text, warehouse_id } }
 * Returns the created query (incl. its server-assigned `id`).
 */
export async function createDbxQuery(
  displayName: string,
  queryText: string,
  warehouseId: string,
): Promise<DbxSqlQuery> {
  const res = await dbxFetch('/api/2.0/sql/queries', {
    method: 'POST',
    body: JSON.stringify({
      query: { display_name: displayName, query_text: queryText, warehouse_id: warehouseId },
    }),
  });
  const body = await asJsonOrThrow<DbxSqlQuery & { query?: DbxSqlQuery }>(res, 'createDbxQuery');
  // Tolerate either a bare object or a `{ query: {...} }` envelope on the response.
  return (body.id ? body : body.query) as DbxSqlQuery;
}

/** Move a saved SQL query to the trash. DELETE /api/2.0/sql/queries/{id}. */
export async function trashDbxQuery(queryId: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/sql/queries/${encodeURIComponent(queryId)}`, {
    method: 'DELETE',
  });
  await asJsonOrThrow<unknown>(res, 'trashDbxQuery');
}

export type DbxAlertOp =
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  | 'EQUAL'
  | 'NOT_EQUAL';

export interface DbxAlertCondition {
  op: DbxAlertOp;
  /** The value column of the query result to evaluate. */
  operand: { column: { name: string } };
  /** Numeric threshold the column value is compared against. */
  threshold: { value: { double_value: number } };
}

export interface DbxAlertSchedule {
  quartz_cron_schedule: { quartz_cron_expression: string; timezone_id: string };
}

export interface DbxAlert {
  id: string;
  display_name?: string;
  query_id?: string;
  condition?: DbxAlertCondition;
  schedule?: DbxAlertSchedule;
  /** OK | TRIGGERED | ERROR (modern alerts dropped the legacy UNKNOWN state). */
  state?: string;
  create_time?: string;
  update_time?: string;
  owner_user_name?: string;
}

/** List SQL alerts. GET /api/2.0/sql/alerts (paged: { results, next_page_token }). */
export async function listDbxAlerts(opts?: {
  page_size?: number;
  page_token?: string;
}): Promise<{ alerts: DbxAlert[]; next_page_token?: string }> {
  const qs = new URLSearchParams();
  if (opts?.page_size) qs.set('page_size', String(opts.page_size));
  if (opts?.page_token) qs.set('page_token', opts.page_token);
  const res = await dbxFetch(`/api/2.0/sql/alerts${qs.toString() ? `?${qs}` : ''}`);
  const body = await asJsonOrThrow<{ results?: DbxAlert[]; alerts?: DbxAlert[]; next_page_token?: string }>(
    res,
    'listDbxAlerts',
  );
  return { alerts: body.results || body.alerts || [], next_page_token: body.next_page_token };
}

/** Get a single SQL alert. GET /api/2.0/sql/alerts/{id}. */
export async function getDbxAlert(alertId: string): Promise<DbxAlert> {
  const res = await dbxFetch(`/api/2.0/sql/alerts/${encodeURIComponent(alertId)}`);
  const body = await asJsonOrThrow<DbxAlert & { alert?: DbxAlert }>(res, 'getDbxAlert');
  return (body.id ? body : body.alert) as DbxAlert;
}

export interface DbxAlertCreateSpec {
  display_name: string;
  query_id: string;
  condition: DbxAlertCondition;
  schedule?: DbxAlertSchedule;
}

/**
 * Create a SQL alert.
 *   POST /api/2.0/sql/alerts  body { alert: { display_name, query_id, condition, schedule? } }
 * Returns the created alert incl. its server-assigned `id`.
 */
export async function createDbxAlert(spec: DbxAlertCreateSpec): Promise<DbxAlert> {
  const res = await dbxFetch('/api/2.0/sql/alerts', {
    method: 'POST',
    body: JSON.stringify({
      alert: {
        display_name: spec.display_name,
        query_id: spec.query_id,
        condition: spec.condition,
        ...(spec.schedule ? { schedule: spec.schedule } : {}),
      },
    }),
  });
  const body = await asJsonOrThrow<DbxAlert & { alert?: DbxAlert }>(res, 'createDbxAlert');
  return (body.id ? body : body.alert) as DbxAlert;
}

/**
 * Partial-update a SQL alert (name / condition / schedule).
 *   PATCH /api/2.0/sql/alerts/{id}  body { alert: { …fields }, update_mask: 'a,b' }
 */
export async function updateDbxAlert(
  alertId: string,
  patch: { display_name?: string; condition?: DbxAlertCondition; schedule?: DbxAlertSchedule },
): Promise<DbxAlert> {
  const fields: string[] = [];
  const alert: Record<string, unknown> = {};
  if (patch.display_name !== undefined) { alert.display_name = patch.display_name; fields.push('display_name'); }
  if (patch.condition !== undefined) { alert.condition = patch.condition; fields.push('condition'); }
  if (patch.schedule !== undefined) { alert.schedule = patch.schedule; fields.push('schedule'); }
  const res = await dbxFetch(`/api/2.0/sql/alerts/${encodeURIComponent(alertId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ alert, update_mask: fields.join(',') }),
  });
  const body = await asJsonOrThrow<DbxAlert & { alert?: DbxAlert }>(res, 'updateDbxAlert');
  return (body.id ? body : body.alert) as DbxAlert;
}

/**
 * Move a SQL alert to the trash. DELETE /api/2.0/sql/alerts/{id}. Trashed alerts
 * stop triggering immediately and are permanently deleted after 30 days.
 */
export async function trashDbxAlert(alertId: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/sql/alerts/${encodeURIComponent(alertId)}`, {
    method: 'DELETE',
  });
  await asJsonOrThrow<unknown>(res, 'trashDbxAlert');
}

// ============================================================
// Unity Catalog — Volumes WRITE (managed/external storage volumes)
//
// Volumes are UC-governed storage locations under a schema. MANAGED volumes are
// backed by the catalog/metastore managed-storage root; EXTERNAL volumes point at
// an abfss:// location governed by an external location + storage credential.
// REST: POST/DELETE /api/2.1/unity-catalog/volumes
// Learn: https://learn.microsoft.com/azure/databricks/volumes/
// ============================================================

export interface UcVolumeCreateSpec {
  name: string;
  catalog_name: string;
  schema_name: string;
  volume_type: 'MANAGED' | 'EXTERNAL';
  storage_location?: string;   // required for EXTERNAL (abfss://…)
  comment?: string;
}

/** POST /api/2.1/unity-catalog/volumes — create a managed/external UC volume. */
export async function createUcVolume(spec: UcVolumeCreateSpec): Promise<UcVolume> {
  const body: Record<string, unknown> = {
    name: spec.name,
    catalog_name: spec.catalog_name,
    schema_name: spec.schema_name,
    volume_type: spec.volume_type,
  };
  if (spec.volume_type === 'EXTERNAL') {
    if (!spec.storage_location) throw new Error('createUcVolume: EXTERNAL volumes require storage_location');
    body.storage_location = spec.storage_location;
  }
  if (spec.comment) body.comment = spec.comment;
  const res = await dbxFetch('/api/2.1/unity-catalog/volumes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return asJsonOrThrow<UcVolume>(res, 'createUcVolume');
}

/** DELETE /api/2.1/unity-catalog/volumes/{full_name}  (catalog.schema.volume) */
export async function deleteUcVolume(fullName: string): Promise<void> {
  const path = fullName.split('.').map(encodeURIComponent).join('.');
  const res = await dbxFetch(`/api/2.1/unity-catalog/volumes/${path}`, { method: 'DELETE' });
  await asJsonOrThrow<unknown>(res, 'deleteUcVolume');
}

// ------------------------------------------------------------
// Principal directory (Catalog Explorer grant "principal" picker). The
// Permissions tab autocompletes over the workspace's users / groups / service
// principals; the same directory is exposed by the workspace SCIM 2.0 API:
//   GET /api/2.0/preview/scim/v2/Users
//   GET /api/2.0/preview/scim/v2/Groups
//   GET /api/2.0/preview/scim/v2/ServicePrincipals
// Filtered with the SCIM `filter` query (`userName co "q"` etc.) so the picker
// returns matches as the operator types — no `return []` placeholder.
// Learn: https://learn.microsoft.com/azure/databricks/admin/users-groups/scim/
// ------------------------------------------------------------

export interface UcPrincipal {
  /** Value passed to a UC grant (user email / group displayName / SP applicationId). */
  value: string;
  /** Human label for the picker. */
  label: string;
  kind: 'USER' | 'GROUP' | 'SERVICE_PRINCIPAL';
}

/** SCIM `co` (contains) filter, value-escaped so a quote in the query is safe. */
function scimContains(attr: string, q: string): string {
  return `${attr} co "${q.replace(/"/g, '\\"')}"`;
}

export async function listUcPrincipals(query: string): Promise<UcPrincipal[]> {
  const q = query.trim();
  const limit = 20;
  const out: UcPrincipal[] = [];

  const usersFilter = q ? `&filter=${encodeURIComponent(scimContains('userName', q))}` : '';
  const groupsFilter = q ? `&filter=${encodeURIComponent(scimContains('displayName', q))}` : '';
  const spsFilter = q ? `&filter=${encodeURIComponent(scimContains('displayName', q))}` : '';

  const [usersRes, groupsRes, spsRes] = await Promise.allSettled([
    dbxFetch(`/api/2.0/preview/scim/v2/Users?count=${limit}${usersFilter}`),
    dbxFetch(`/api/2.0/preview/scim/v2/Groups?count=${limit}${groupsFilter}`),
    dbxFetch(`/api/2.0/preview/scim/v2/ServicePrincipals?count=${limit}${spsFilter}`),
  ]);

  if (usersRes.status === 'fulfilled' && usersRes.value.ok) {
    const j = (await usersRes.value.json()) as { Resources?: Array<{ userName?: string; displayName?: string }> };
    for (const u of j.Resources || []) {
      if (u.userName) out.push({ value: u.userName, label: u.displayName ? `${u.displayName} (${u.userName})` : u.userName, kind: 'USER' });
    }
  }
  if (groupsRes.status === 'fulfilled' && groupsRes.value.ok) {
    const j = (await groupsRes.value.json()) as { Resources?: Array<{ displayName?: string }> };
    for (const g of j.Resources || []) {
      if (g.displayName) out.push({ value: g.displayName, label: `${g.displayName} (group)`, kind: 'GROUP' });
    }
  }
  if (spsRes.status === 'fulfilled' && spsRes.value.ok) {
    const j = (await spsRes.value.json()) as { Resources?: Array<{ applicationId?: string; displayName?: string }> };
    for (const sp of j.Resources || []) {
      if (sp.applicationId) out.push({ value: sp.applicationId, label: sp.displayName ? `${sp.displayName} (SP)` : `${sp.applicationId} (SP)`, kind: 'SERVICE_PRINCIPAL' });
    }
  }

  // If every SCIM call failed (e.g. missing scope), surface that honestly
  // instead of an empty list masquerading as "no principals".
  const allFailed =
    (usersRes.status !== 'fulfilled' || !usersRes.value.ok) &&
    (groupsRes.status !== 'fulfilled' || !groupsRes.value.ok) &&
    (spsRes.status !== 'fulfilled' || !spsRes.value.ok);
  if (allFailed) {
    const detail =
      usersRes.status === 'fulfilled'
        ? `HTTP ${usersRes.value.status}: ${(await usersRes.value.text()).slice(0, 200)}`
        : (usersRes.reason?.message || String(usersRes.reason));
    const err: Error & { status?: number } = new Error(`SCIM directory query failed — ${detail}`);
    if (usersRes.status === 'fulfilled') err.status = usersRes.value.status;
    throw err;
  }

  return out.slice(0, 30);
}

// ============================================================
// Delta Live Tables (Lakeflow Declarative Pipelines) — /api/2.0/pipelines
//
// DLT pipelines run a set of notebook/file libraries as a managed, dependency-
// aware ETL graph. REST surface: list, get, create, start an update, delete.
// Learn: https://learn.microsoft.com/azure/databricks/delta-live-tables/api-guide
// ============================================================

export interface DltPipeline {
  pipeline_id: string;
  name?: string;
  state?: string;           // IDLE | RUNNING | DEPLOYING | FAILED | …
  cluster_id?: string;
  creator_user_name?: string;
  catalog?: string;
  target?: string;
  latest_updates?: Array<{ update_id: string; state: string; creation_time?: string }>;
}

export interface DltPipelineLibrary {
  notebook?: { path: string };
  file?: { path: string };
}

export interface DltPipelineCreateSpec {
  name: string;
  libraries: DltPipelineLibrary[];
  continuous?: boolean;
  development?: boolean;
  catalog?: string;          // UC target catalog (publishes tables to UC)
  target?: string;           // target schema
  configuration?: Record<string, string>;
}

/** GET /api/2.0/pipelines — list DLT pipelines (paginated next_page_token). */
export async function listDltPipelines(): Promise<DltPipeline[]> {
  const out: DltPipeline[] = [];
  let token: string | undefined;
  do {
    const qs = token ? `?page_token=${encodeURIComponent(token)}` : '';
    const res = await dbxFetch(`/api/2.0/pipelines${qs}`);
    const body = await asJsonOrThrow<{ statuses?: DltPipeline[]; next_page_token?: string }>(res, 'listDltPipelines');
    out.push(...(body.statuses || []));
    token = body.next_page_token;
  } while (token);
  return out;
}

/** GET /api/2.0/pipelines/{id} — full pipeline spec + state. */
export async function getDltPipeline(pipelineId: string): Promise<DltPipeline & { spec?: unknown }> {
  const res = await dbxFetch(`/api/2.0/pipelines/${encodeURIComponent(pipelineId)}`);
  return asJsonOrThrow<DltPipeline & { spec?: unknown }>(res, 'getDltPipeline');
}

/** POST /api/2.0/pipelines — create a DLT pipeline. Returns { pipeline_id }. */
export async function createDltPipeline(spec: DltPipelineCreateSpec): Promise<{ pipeline_id: string }> {
  const body: Record<string, unknown> = {
    name: spec.name,
    libraries: spec.libraries,
    continuous: spec.continuous ?? false,
    development: spec.development ?? true,
  };
  if (spec.catalog) body.catalog = spec.catalog;
  if (spec.target) body.target = spec.target;
  if (spec.configuration && Object.keys(spec.configuration).length) body.configuration = spec.configuration;
  const res = await dbxFetch('/api/2.0/pipelines', { method: 'POST', body: JSON.stringify(body) });
  return asJsonOrThrow<{ pipeline_id: string }>(res, 'createDltPipeline');
}

/** POST /api/2.0/pipelines/{id}/updates — trigger a pipeline update (optionally full refresh). */
export async function startDltUpdate(pipelineId: string, fullRefresh = false): Promise<{ update_id: string }> {
  const res = await dbxFetch(`/api/2.0/pipelines/${encodeURIComponent(pipelineId)}/updates`, {
    method: 'POST',
    body: JSON.stringify({ full_refresh: fullRefresh }),
  });
  return asJsonOrThrow<{ update_id: string }>(res, 'startDltUpdate');
}

/** POST /api/2.0/pipelines/{id}/stop — request the active update to stop. */
export async function stopDltUpdate(pipelineId: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/pipelines/${encodeURIComponent(pipelineId)}/stop`, { method: 'POST' });
  await asJsonOrThrow<unknown>(res, 'stopDltUpdate');
}

/** DELETE /api/2.0/pipelines/{id} — delete a DLT pipeline. */
export async function deleteDltPipeline(pipelineId: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/pipelines/${encodeURIComponent(pipelineId)}`, { method: 'DELETE' });
  await asJsonOrThrow<unknown>(res, 'deleteDltPipeline');
}

// ============================================================
// MLflow — experiments + registered models  (/api/2.0/mlflow)
//
// Experiments group runs; registered models (UC-governed when a 3-level name is
// used) version trained models for serving. REST: experiments/search,
// experiments/create, registered-models/list, registered-models/create, delete.
// Learn: https://learn.microsoft.com/azure/databricks/mlflow/
// ============================================================

export interface MlflowExperiment {
  experiment_id: string;
  name: string;
  artifact_location?: string;
  lifecycle_stage?: string;
  last_update_time?: number;
}

/** POST /api/2.0/mlflow/experiments/search — list experiments (paginated). */
export async function listMlflowExperiments(maxResults = 200): Promise<MlflowExperiment[]> {
  const res = await dbxFetch('/api/2.0/mlflow/experiments/search', {
    method: 'POST',
    body: JSON.stringify({ max_results: maxResults }),
  });
  const body = await asJsonOrThrow<{ experiments?: MlflowExperiment[] }>(res, 'listMlflowExperiments');
  return body.experiments || [];
}

/** POST /api/2.0/mlflow/experiments/create — create an experiment. Returns { experiment_id }. */
export async function createMlflowExperiment(name: string, artifactLocation?: string): Promise<{ experiment_id: string }> {
  const body: Record<string, unknown> = { name };
  if (artifactLocation) body.artifact_location = artifactLocation;
  const res = await dbxFetch('/api/2.0/mlflow/experiments/create', { method: 'POST', body: JSON.stringify(body) });
  return asJsonOrThrow<{ experiment_id: string }>(res, 'createMlflowExperiment');
}

export interface MlflowRegisteredModel {
  name: string;
  user_id?: string;
  creation_timestamp?: number;
  last_updated_timestamp?: number;
  latest_versions?: Array<{ version: string; current_stage?: string; source?: string; status?: string }>;
}

/** GET /api/2.0/mlflow/registered-models/list — list registered models (paginated). */
export async function listRegisteredModels(maxResults = 200): Promise<MlflowRegisteredModel[]> {
  const out: MlflowRegisteredModel[] = [];
  let token: string | undefined;
  do {
    const qs = new URLSearchParams({ max_results: String(maxResults) });
    if (token) qs.set('page_token', token);
    const res = await dbxFetch(`/api/2.0/mlflow/registered-models/list?${qs.toString()}`);
    const body = await asJsonOrThrow<{ registered_models?: MlflowRegisteredModel[]; next_page_token?: string }>(res, 'listRegisteredModels');
    out.push(...(body.registered_models || []));
    token = body.next_page_token;
  } while (token);
  return out;
}

/** POST /api/2.0/mlflow/registered-models/create — register a new model. */
export async function createRegisteredModel(name: string, tags?: Record<string, string>): Promise<MlflowRegisteredModel> {
  const body: Record<string, unknown> = { name };
  if (tags && Object.keys(tags).length) body.tags = Object.entries(tags).map(([key, value]) => ({ key, value }));
  const res = await dbxFetch('/api/2.0/mlflow/registered-models/create', { method: 'POST', body: JSON.stringify(body) });
  const out = await asJsonOrThrow<{ registered_model?: MlflowRegisteredModel } & MlflowRegisteredModel>(res, 'createRegisteredModel');
  return (out.registered_model || out) as MlflowRegisteredModel;
}

/** DELETE /api/2.0/mlflow/registered-models/delete — delete a registered model. */
export async function deleteRegisteredModel(name: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/mlflow/registered-models/delete', {
    method: 'DELETE',
    body: JSON.stringify({ name }),
  });
  await asJsonOrThrow<unknown>(res, 'deleteRegisteredModel');
}

// ============================================================
// Model Serving — real-time endpoints  (/api/2.0/serving-endpoints)
//
// A serving endpoint hosts one or more model versions behind an HTTPS route with
// scale-to-zero + workload sizing. REST: list, create, delete.
// Learn: https://learn.microsoft.com/azure/databricks/machine-learning/model-serving/
// ============================================================

export interface ServingEndpoint {
  name: string;
  state?: { ready?: string; config_update?: string };
  config?: { served_entities?: Array<{ name?: string; entity_name?: string; entity_version?: string }> };
  creator?: string;
}

export interface ServingEndpointCreateSpec {
  name: string;
  /** A served model version (UC model name + version). */
  model_name: string;
  model_version: string;
  workload_size?: 'Small' | 'Medium' | 'Large';
  scale_to_zero_enabled?: boolean;
}

/** GET /api/2.0/serving-endpoints — list serving endpoints. */
export async function listServingEndpoints(): Promise<ServingEndpoint[]> {
  const res = await dbxFetch('/api/2.0/serving-endpoints');
  const body = await asJsonOrThrow<{ endpoints?: ServingEndpoint[] }>(res, 'listServingEndpoints');
  return body.endpoints || [];
}

/** POST /api/2.0/serving-endpoints — create a serving endpoint with one served model. */
export async function createServingEndpoint(spec: ServingEndpointCreateSpec): Promise<ServingEndpoint> {
  const body = {
    name: spec.name,
    config: {
      served_entities: [
        {
          entity_name: spec.model_name,
          entity_version: spec.model_version,
          workload_size: spec.workload_size ?? 'Small',
          scale_to_zero_enabled: spec.scale_to_zero_enabled ?? true,
        },
      ],
    },
  };
  const res = await dbxFetch('/api/2.0/serving-endpoints', { method: 'POST', body: JSON.stringify(body) });
  return asJsonOrThrow<ServingEndpoint>(res, 'createServingEndpoint');
}

/** DELETE /api/2.0/serving-endpoints/{name} — delete a serving endpoint. */
export async function deleteServingEndpoint(name: string): Promise<void> {
  const res = await dbxFetch(`/api/2.0/serving-endpoints/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await asJsonOrThrow<unknown>(res, 'deleteServingEndpoint');
}

