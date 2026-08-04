/**
 * Bounded read-only query caps — the extension-host half of the SAME
 * exfiltration controls the M2 `loom-query` MCP server enforces
 * (`apps/loom-mcp/src/servers/loom-query/guards.ts`). Phase 3's data explorer /
 * query grid runs against the very same per-item query/preview routes the M2
 * server + SDK `query` resource use, so it carries the very same guarantees:
 *
 *   • {@link assertReadOnlySql} / {@link assertReadOnlyKql} — read-only by
 *     construction: DDL/DML (SQL) and control commands (KQL) are rejected AT
 *     PARSE, before the request leaves the client, naming the offending class.
 *   • {@link clampLimit} — the per-query row cap. A caller may only LOWER it;
 *     the hard ceiling {@link MAX_ROWS_HARD} can NOT be raised.
 *   • {@link capResult} — belt-and-braces post-fetch row + byte cap over
 *     whatever the backend returned, regardless of the engine's own truncation.
 *
 * These are the values the M2 guards use (default 500 rows, hard 5000, 512 KiB),
 * kept in lock-step on purpose so the VS Code surface is neither looser nor
 * tighter than the MCP one. Pure (no `vscode`, no SDK import) so it is unit
 * tested — including the mutation-proof "a caller can only lower the cap".
 */

/** A coded, honest cap/parse rejection surfaced to the user verbatim. */
export class QueryCapError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'QueryCapError';
  }
}

/** Default rows returned when the caller does not ask for fewer. */
export const DEFAULT_ROWS = 500;
/** Absolute row ceiling — a caller may lower `limit`, never exceed this. */
export const MAX_ROWS_HARD = 5000;
/** Absolute serialized-byte ceiling for a single result. */
export const MAX_BYTES_HARD = 512 * 1024;
/** Client-side statement time cap (ms) — belt over the route's own 60s server cap. */
export const QUERY_TIMEOUT_MS = 65_000;

/**
 * Clamp a requested row limit into `[1, MAX_ROWS_HARD]` (default when unset).
 * The one-way property that matters: a request ABOVE the hard cap comes back AT
 * the hard cap — never above. Reverting that guard is the caps mutation-proof.
 */
export function clampLimit(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) return DEFAULT_ROWS;
  const n = Math.floor(requested);
  if (n < 1) return 1;
  if (n > MAX_ROWS_HARD) return MAX_ROWS_HARD;
  return n;
}

/** Strip SQL comments so the leading-keyword check sees real statement text. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n\r]*/g, ' '); // line comments
}

/** Statement classes that read data (allow-list — everything else is refused). */
const SQL_READ_LEADERS = new Set(['select', 'with', 'explain', 'show', 'describe', 'desc']);

/**
 * Reject any non-read T-SQL BEFORE it reaches the engine. Allow-listed (not
 * deny-listed): only SELECT/WITH/EXPLAIN/SHOW/DESCRIBE lead a statement, and
 * `SELECT … INTO <table>` (materialization) is refused. Throws a coded
 * {@link QueryCapError} naming the rejected class.
 */
export function assertReadOnlySql(sql: string): void {
  const cleaned = stripSqlComments(sql);
  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw new QueryCapError('Empty SQL statement.', 'query_empty');
  }
  for (const stmt of statements) {
    const m = /^([a-zA-Z_]+)/.exec(stmt);
    const leader = (m?.[1] ?? '').toLowerCase();
    if (!SQL_READ_LEADERS.has(leader)) {
      throw new QueryCapError(
        `Read-only query: statement class "${(leader || stmt.slice(0, 12)).toUpperCase()}" is not allowed — only SELECT / WITH / EXPLAIN / SHOW / DESCRIBE may run.`,
        'query_not_read_only',
      );
    }
    // T-SQL `SELECT … INTO <table>` writes a table even though it leads with SELECT.
    if (leader === 'select' && /\binto\b\s+[#@\w[]/i.test(stmt)) {
      throw new QueryCapError(
        'Read-only query: `SELECT … INTO` materializes a table and is not allowed.',
        'query_not_read_only',
      );
    }
  }
}

/**
 * Reject a KQL control/management command. A leading `.` is a control command
 * (`.create`, `.drop`, `.ingest`, `.set`, `.append`, …); this surface runs read
 * queries only. Throws a coded {@link QueryCapError}.
 */
export function assertReadOnlyKql(kql: string): void {
  const trimmed = kql.trim();
  if (!trimmed) {
    throw new QueryCapError('Empty KQL statement.', 'query_empty');
  }
  if (trimmed.startsWith('.')) {
    throw new QueryCapError(
      'Read-only query: KQL control/management commands (leading `.`) are not allowed — run a read query.',
      'query_not_read_only',
    );
  }
}

/** The shape `capResult` operates on — any query/preview envelope with `rows`. */
export interface CappableResult {
  rows?: unknown[];
  truncated?: boolean;
  [k: string]: unknown;
}

/** The outcome of {@link capResult}: the bounded envelope + how it was capped. */
export interface CapOutcome {
  data: CappableResult;
  count: number | undefined;
  cappedBy?: 'rows' | 'bytes';
}

/**
 * Belt-and-braces post-fetch cap. Truncates `rows` to `maxRows`, then drops
 * further rows until the serialized result is under {@link MAX_BYTES_HARD}.
 * Non-array `rows` (a metadata-only preview) pass through with `count`
 * undefined. The `truncated`/`truncatedByCap` flags let the grid show a badge.
 */
export function capResult(result: CappableResult, maxRows: number): CapOutcome {
  if (!result || !Array.isArray(result.rows)) {
    return { data: result, count: undefined };
  }
  const originalLen = result.rows.length;
  let rows = result.rows.slice(0, maxRows);
  const cappedByRows = rows.length < originalLen;

  let cappedByBytes = false;
  while (rows.length > 0) {
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(rows), 'utf8');
    } catch {
      size = Number.POSITIVE_INFINITY; // unserializable → force a trim
    }
    if (size <= MAX_BYTES_HARD) break;
    cappedByBytes = true;
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
    if (rows.length === 1) break; // a single oversized row: keep it, flag the cap
  }

  const capped = cappedByRows || cappedByBytes;
  const data: CappableResult = {
    ...result,
    rows,
    rowCount: rows.length,
    truncated: Boolean(result.truncated) || capped,
    truncatedByCap: capped,
  };
  return {
    data,
    count: rows.length,
    ...(cappedByBytes ? { cappedBy: 'bytes' } : cappedByRows ? { cappedBy: 'rows' } : {}),
  };
}
