/**
 * M2 `loom-query` exfiltration controls — the enforcement half of PRP §5.3.
 *
 * These run inside the tool, before (read-only parse) and after (row/byte cap)
 * the SDK call, so the caps are *enforced in the tool, not requested by the
 * caller* (§5.3.2): a caller may lower a limit, never raise it past the hard cap.
 *
 *   • {@link assertReadOnlySql} / {@link assertReadOnlyKql} — read-only by
 *     construction (§5.3.4): DDL/DML (SQL) and control commands (KQL) are
 *     rejected *at parse*, naming the offending statement class — never a silent
 *     no-op, never reaching the engine.
 *   • {@link clampLimit} — the per-query row cap (§5.3.2), bounded to a hard max.
 *   • {@link capResult} — the belt-and-braces post-fetch row + byte cap, applied
 *     to whatever the backend returned regardless of its own truncation.
 *
 * The core scrub still runs on the capped result (secrets in a data cell are the
 * point of §5.2); these guards are additive, not a replacement for it.
 */
import { LoomApiError } from '@csa-loom/sdk';
import type { QueryResult } from '@csa-loom/sdk';

/** Default rows returned when the caller does not ask for fewer. */
export const DEFAULT_ROWS = 500;
/** Absolute row ceiling — a caller may lower `limit`, never exceed this. */
export const MAX_ROWS_HARD = 5000;
/** Absolute serialized-byte ceiling for a single result (§5.3.2). */
export const MAX_BYTES_HARD = 512 * 1024;

/** Clamp a requested row limit into `[1, MAX_ROWS_HARD]` (default when unset). */
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
 * Reject any non-read T-SQL BEFORE it reaches the engine (§5.3.4). Allow-listed
 * (not deny-listed): only SELECT/WITH/EXPLAIN/SHOW/DESCRIBE lead a statement,
 * and `SELECT … INTO <table>` (materialization) is refused. Throws a coded
 * {@link LoomApiError} naming the rejected class.
 */
export function assertReadOnlySql(sql: string): void {
  const cleaned = stripSqlComments(sql);
  const statements = cleaned.split(';').map((s) => s.trim()).filter(Boolean);
  if (statements.length === 0) {
    throw new LoomApiError('empty SQL statement', 400, 'query_empty');
  }
  for (const stmt of statements) {
    const m = /^([a-zA-Z_]+)/.exec(stmt);
    const leader = (m?.[1] ?? '').toLowerCase();
    if (!SQL_READ_LEADERS.has(leader)) {
      throw new LoomApiError(
        `read-only query tool: statement class "${(leader || stmt.slice(0, 12)).toUpperCase()}" is not allowed — only SELECT / WITH / EXPLAIN / SHOW / DESCRIBE may run.`,
        400,
        'query_not_read_only',
      );
    }
    // T-SQL `SELECT … INTO <table>` writes a table even though it leads with SELECT.
    if (leader === 'select' && /\binto\b\s+[#@\w[]/i.test(stmt)) {
      throw new LoomApiError(
        'read-only query tool: `SELECT … INTO` materializes a table and is not allowed.',
        400,
        'query_not_read_only',
      );
    }
  }
}

/**
 * Reject a KQL control/management command (§5.3.4). A leading `.` is a control
 * command (`.create`, `.drop`, `.ingest`, `.set`, `.append`, …); the query MCP
 * runs read queries only. Throws a coded {@link LoomApiError}.
 */
export function assertReadOnlyKql(kql: string): void {
  const trimmed = kql.trim();
  if (!trimmed) {
    throw new LoomApiError('empty KQL statement', 400, 'query_empty');
  }
  if (trimmed.startsWith('.')) {
    throw new LoomApiError(
      'read-only query tool: KQL control/management commands (leading `.`) are not allowed — run a read query.',
      400,
      'query_not_read_only',
    );
  }
}

/**
 * Belt-and-braces post-fetch cap (§5.3.2). Truncates `result.rows` to `maxRows`,
 * then drops further rows until the serialized result is under `MAX_BYTES_HARD`.
 * Returns the capped result plus the reported row `count`. Non-array `rows`
 * (e.g. a metadata-only preview) pass through with a `count` of `undefined`.
 */
export function capResult(result: QueryResult, maxRows: number): { data: QueryResult; count: number | undefined } {
  if (!result || !Array.isArray(result.rows)) {
    return { data: result, count: undefined };
  }
  const originalLen = result.rows.length;
  let rows = result.rows.slice(0, maxRows);
  let cappedByRows = rows.length < originalLen;

  // Byte cap: shrink until the serialized payload fits, halving on each overflow.
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

  const capped = rows.length < result.rows.length || cappedByRows || cappedByBytes;
  const data: QueryResult = {
    ...result,
    rows,
    rowCount: rows.length,
    // Preserve any engine-side truncation flag; OR-in ours so the caller sees both.
    truncated: Boolean(result.truncated) || capped,
    truncatedByCap: capped,
    ...(cappedByBytes ? { cappedBy: 'bytes' } : capped ? { cappedBy: 'rows' } : {}),
  };
  return { data, count: rows.length };
}
