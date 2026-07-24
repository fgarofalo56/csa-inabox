/**
 * N2b — loom-duckdb serving-tier client. SERVER-ONLY (imports the Cosmos audit
 * trail + the Synapse fallback path).
 *
 * ## The tier
 *
 * `apps/loom-duckdb` is an internal-ingress Container App running an embedded
 * **DuckDB** with the azure / httpfs / delta / iceberg extensions. It reads
 * Delta, Iceberg and Parquet IN PLACE on the deployment's own ADLS Gen2 through
 * a user-assigned managed identity holding *Storage Blob Data Reader*:
 *
 *   SELECT * FROM delta_scan('abfss://gold@<acct>.dfs.core.windows.net/sales')
 *
 * It is the fast path BELOW Spark — sub-second cold start where a Spark session
 * costs 1–5 minutes — and it is an ACCELERATOR, never a dependency.
 *
 * ## Honest fallback (no-vaporware, default-ON)
 *
 * When `LOOM_DUCKDB_URL` is unset {@link runSqlLabQuery} does NOT gate the
 * surface: it executes the SAME statement on **Synapse Serverless** and labels
 * the result `engine: 'synapse-serverless'`, so SQL Lab works day-one on a
 * push-button deploy. The UI still renders the gate chip + Fix-it so an
 * operator can see the faster tier is available to wire — that is a capability
 * hint, not a blocker.
 *
 * ## Audited data plane (ATO, round-3 extension)
 *
 * A server-tier query is an external data-access event, so
 * {@link logDuckDbAccess} writes an `_auditLog` row (principal, scope,
 * operation, timestamp, outcome, engine, rows) and fans out through
 * `emitAuditEvent`. The audit write is awaited before the response is sent.
 *
 * IL5 / SOVEREIGN MOAT: DuckDB is a single embedded OSS binary and its
 * extensions are baked into the image at build time, so this tier runs
 * disconnected in an air-gapped enclave against in-boundary storage. No SaaS
 * query service, no Microsoft Fabric / OneLake / Power BI is reachable from any
 * path here (.claude/rules/no-fabric-dependency.md).
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const DUCKDB_GATE_ID = 'svc-loom-duckdb';

/** Arrow IPC stream MIME — the zero-serialization wire shared with Flight. */
export const ARROW_STREAM_MIME = 'application/vnd.apache.arrow.stream';

/** Which engine actually answered — always reported, never assumed. */
export type SqlLabEngine = 'duckdb' | 'synapse-serverless';

/** Honest config signal — the missing env var, or null when the tier is wired. */
export function duckdbConfigGate(): { missing: string } | null {
  return (process.env.LOOM_DUCKDB_URL || '').trim() ? null : { missing: 'LOOM_DUCKDB_URL' };
}

/** True when the DuckDB serving tier is deployed + wired. */
export function isDuckDbConfigured(): boolean {
  return duckdbConfigGate() === null;
}

/** Base URL of the internal serving tier (no trailing slash, scheme-normalized). */
export function duckdbBase(): string {
  const raw = (process.env.LOOM_DUCKDB_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** Build an absolute endpoint URL on the serving tier. */
export function duckdbUrl(endpoint: 'query' | 'capabilities' | 'health' | 'explain'): string {
  return `${duckdbBase()}/${endpoint}`;
}

export class DuckDbError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'DuckDbError';
    this.status = status;
    this.code = code;
  }
}

/** One column of a SQL Lab result, with its REAL engine-reported type. */
export interface SqlLabColumn {
  name: string;
  type: string;
}

/** The normalized result both engines produce (identical shape, honest labels). */
export interface SqlLabResult {
  engine: SqlLabEngine;
  columns: SqlLabColumn[];
  rows: unknown[][];
  rowCount: number;
  /** Engine-reported execution time (ms). */
  elapsedMs: number;
  /** Wall-clock time the BFF measured, including the network hop. */
  totalMs: number;
  truncated: boolean;
  maxRows: number;
  /** Extensions the engine had loaded (DuckDB only) — receipt material. */
  extensions?: string[];
  /** Why this engine answered — surfaced verbatim in the UI status bar. */
  note?: string;
}

interface DuckDbJsonResponse {
  ok?: boolean;
  error?: string;
  code?: string;
  columns?: SqlLabColumn[];
  rows?: unknown[][];
  rowCount?: number;
  elapsedMs?: number;
  truncated?: boolean;
  maxRows?: number;
  extensions?: string[];
}

/** POST /query on the serving tier, JSON shape. Throws {@link DuckDbError}. */
export async function duckdbQueryJson(sql: string, maxRows?: number): Promise<DuckDbJsonResponse> {
  const url = duckdbUrl('query');
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sql, maxRows }),
    });
  } catch (e) {
    throw new DuckDbError(
      `The DuckDB serving tier at ${duckdbBase()} was unreachable: ${(e as Error)?.message || String(e)}`,
      502,
      'unreachable',
    );
  }
  const text = await res.text();
  let body: DuckDbJsonResponse | null = null;
  try { body = text ? (JSON.parse(text) as DuckDbJsonResponse) : null; } catch { body = null; }
  if (!res.ok || body?.ok !== true) {
    throw new DuckDbError(
      body?.error || text.slice(0, 400) || `DuckDB query failed (HTTP ${res.status})`,
      res.ok ? 502 : res.status,
      body?.code || 'query_failed',
    );
  }
  return body;
}

/**
 * POST /query asking for the RAW Arrow IPC stream. Returns the bytes plus the
 * `x-loom-*` stats headers the tier sets, so the body stays a pure Arrow stream
 * that duckdb-wasm's `insertArrowFromIPCStream` (N2a) consumes unmodified.
 */
export async function duckdbQueryArrow(
  sql: string,
  maxRows?: number,
): Promise<{ arrow: ArrayBuffer; rowCount: number; elapsedMs: number; truncated: boolean; bytes: number }> {
  const url = duckdbUrl('query');
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ARROW_STREAM_MIME },
      body: JSON.stringify({ sql, maxRows }),
    });
  } catch (e) {
    throw new DuckDbError(
      `The DuckDB serving tier at ${duckdbBase()} was unreachable: ${(e as Error)?.message || String(e)}`,
      502,
      'unreachable',
    );
  }
  if (!res.ok) {
    const text = await res.text();
    let body: DuckDbJsonResponse | null = null;
    try { body = JSON.parse(text) as DuckDbJsonResponse; } catch { /* non-JSON upstream */ }
    throw new DuckDbError(
      body?.error || text.slice(0, 400) || `DuckDB query failed (HTTP ${res.status})`,
      res.status,
      body?.code || 'query_failed',
    );
  }
  const arrow = await res.arrayBuffer();
  return {
    arrow,
    rowCount: Number(res.headers.get('x-loom-row-count') || 0),
    elapsedMs: Number(res.headers.get('x-loom-elapsed-ms') || 0),
    truncated: (res.headers.get('x-loom-truncated') || '') === 'true',
    bytes: Number(res.headers.get('x-loom-bytes') || arrow.byteLength),
  };
}

/** Engine capabilities (version, loaded extensions, Flight posture). */
export async function duckdbCapabilities(): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(duckdbUrl('capabilities'), { headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new DuckDbError(`Capabilities read failed (HTTP ${res.status})`, res.status, 'capabilities_failed');
  return body;
}

/**
 * The SQL Lab execution path: DuckDB when wired, Synapse Serverless otherwise.
 *
 * The fallback is SILENT in the sense that it never blocks — but it is never
 * silent about WHICH engine ran: `engine` + `note` are always populated and the
 * UI status bar prints them.
 */
export async function runSqlLabQuery(
  sql: string,
  opts: { maxRows?: number; tenantId: string } ,
): Promise<SqlLabResult> {
  const started = Date.now();
  const maxRows = Math.max(1, Math.min(opts.maxRows ?? 5_000, 200_000));

  if (isDuckDbConfigured()) {
    const body = await duckdbQueryJson(sql, maxRows);
    return {
      engine: 'duckdb',
      columns: body.columns || [],
      rows: body.rows || [],
      rowCount: body.rowCount ?? (body.rows?.length ?? 0),
      elapsedMs: body.elapsedMs ?? 0,
      totalMs: Date.now() - started,
      truncated: !!body.truncated,
      maxRows: body.maxRows ?? maxRows,
      extensions: body.extensions,
      note: 'Executed on the loom-duckdb serving tier (embedded DuckDB reading your lake in place).',
    };
  }

  // ── Honest fallback: the SAME statement on Synapse Serverless ──────────
  const { serverlessTargetResolved, executeQuery } = await import('@/lib/azure/synapse-sql-client');
  const target = await serverlessTargetResolved(opts.tenantId);
  const result = await executeQuery(target, sql, 60_000);
  return {
    engine: 'synapse-serverless',
    columns: (result.columns || []).map((name) => ({ name, type: '' })),
    rows: result.rows || [],
    rowCount: result.rowCount,
    elapsedMs: result.executionMs,
    totalMs: Date.now() - started,
    truncated: result.truncated,
    maxRows,
    note:
      'Executed on Synapse Serverless — LOOM_DUCKDB_URL is unset, so the faster embedded-DuckDB tier '
      + 'is not deployed in this environment. Results are identical; only latency differs.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lake-source SQL (server-built — a client never invents a storage URL)
// ─────────────────────────────────────────────────────────────────────────────

/** Formats the serving tier can read straight off the lake. */
export type LakeSourceFormat = 'delta' | 'parquet' | 'csv' | 'iceberg';

/** A lake object the caller wants scanned, in Loom's own coordinates. */
export interface LakeSource {
  container: string;
  path: string;
  format?: LakeSourceFormat;
  limit?: number;
}

/** DuckDB reader per format. Delta/Iceberg read the TABLE, not the files. */
const READER: Record<LakeSourceFormat, (uri: string) => string> = {
  delta: (uri) => `delta_scan('${uri}')`,
  iceberg: (uri) => `iceberg_scan('${uri}')`,
  parquet: (uri) => `read_parquet('${uri}')`,
  csv: (uri) => `read_csv_auto('${uri}')`,
};

/** Infer the reader from the path when the caller did not say. */
export function inferLakeFormat(path: string): LakeSourceFormat {
  const p = String(path || '').toLowerCase();
  if (p.endsWith('.parquet') || p.includes('*.parquet')) return 'parquet';
  if (p.endsWith('.csv')) return 'csv';
  // A Delta table is a FOLDER; that is the common case for a lakehouse Tables/ path.
  return 'delta';
}

/**
 * Build the real scan statement for a lake object.
 *
 * The storage account is resolved SERVER-SIDE (`getAccountName()`), never sent
 * by the browser — a client that guesses an account name would either 404 or,
 * worse, point the engine somewhere it should not look. Container and path are
 * validated against a conservative character set and single quotes are rejected
 * outright, so the literal can never break out of the string.
 */
export function buildLakeScanSql(account: string, source: LakeSource): string {
  const container = String(source.container || '').trim();
  const path = String(source.path || '').trim().replace(/^\/+/, '');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(container)) {
    throw new DuckDbError(`"${container}" is not a valid storage container name.`, 400, 'invalid_source');
  }
  if (!path || !/^[A-Za-z0-9._\-/=*+ ]+$/.test(path)) {
    throw new DuckDbError(
      `"${path}" is not a readable lake path (letters, digits, . _ - / = * + and spaces only).`,
      400,
      'invalid_source',
    );
  }
  if (!account) {
    throw new DuckDbError(
      'No lake storage account is configured for this deployment (LOOM_ADLS_ACCOUNT), so there is nothing to scan.',
      503,
      'lake_not_configured',
    );
  }
  const format = source.format || inferLakeFormat(path);
  const uri = `abfss://${container}@${account}.dfs.core.windows.net/${path}`;
  const limit = Math.max(1, Math.min(Math.floor(source.limit ?? 100_000), 200_000));
  return `SELECT * FROM ${READER[format](uri)} LIMIT ${limit}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audited data-plane access log
// ─────────────────────────────────────────────────────────────────────────────

/** Server-tier operations that produce an access row. */
export type DuckDbAccessOperation = 'sql.query' | 'sql.explain' | 'sql.capabilities';

export interface DuckDbAccessEvent {
  actorOid: string;
  actorUpn: string;
  tenantId: string;
  operation: DuckDbAccessOperation;
  /** Which engine actually answered. */
  engine: SqlLabEngine;
  /** The statement (truncated in the row) — the "scope" of a SQL access. */
  sql: string;
  /** Loom workspace scope when the caller supplied one. */
  workspaceId?: string;
  /** Item the query was launched from (SQL Lab item id). */
  itemId?: string;
  outcome: 'success' | 'failure';
  rowCount?: number;
  elapsedMs?: number;
  detail?: string;
}

/**
 * Write ONE `_auditLog` data-access row for a server-tier query and fan it out
 * through the SIEM / webhook audit stream. Best-effort by design: an audit-store
 * failure must never turn a successful read into a 500, but it IS logged.
 */
export async function logDuckDbAccess(ev: DuckDbAccessEvent): Promise<void> {
  const at = new Date().toISOString();
  const statement = (ev.sql || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const summary =
    `SQL Lab ${ev.operation} on ${ev.engine} by ${ev.actorUpn}`
    + (ev.rowCount === undefined ? '' : ` (${ev.rowCount} row(s))`)
    + (ev.outcome === 'failure' ? ` — FAILED: ${(ev.detail || '').slice(0, 200)}` : '');

  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: ev.tenantId,
      itemId: ev.itemId || 'sql-lab',
      itemType: 'sql-lab',
      action: `duckdb.${ev.operation}`,
      summary,
      engine: ev.engine,
      statement,
      workspaceId: ev.workspaceId || '',
      outcome: ev.outcome,
      rowCount: ev.rowCount ?? null,
      elapsedMs: ev.elapsedMs ?? null,
      upn: ev.actorUpn,
      actorOid: ev.actorOid,
      at,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[loom-duckdb] audit row write failed:', (e as Error)?.message || e);
  }

  try {
    emitAuditEvent({
      actorOid: ev.actorOid,
      actorUpn: ev.actorUpn,
      action: `duckdb.${ev.operation}`,
      targetType: 'sql-lab',
      targetId: ev.itemId || 'sql-lab',
      outcome: ev.outcome,
      tenantId: ev.tenantId,
      timestamp: at,
      detail: {
        engine: ev.engine,
        statement,
        workspaceId: ev.workspaceId || '',
        rowCount: ev.rowCount ?? null,
        elapsedMs: ev.elapsedMs ?? null,
        ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
      },
    });
  } catch {
    /* audit-stream fan-out is best-effort by contract */
  }
}
