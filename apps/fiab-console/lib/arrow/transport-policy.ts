/**
 * N3 — result-transport policy: when does a grid stop shipping JSON and start
 * streaming Arrow?
 *
 * JSON is fine for a 200-row preview and terrible for a 200,000-row export: the
 * server stringifies every cell, the browser re-parses every cell, and the wire
 * carries repeated key names. Arrow IPC carries the columnar buffers the engine
 * already produced — the SAME batches an ADBC/Flight client would receive — so
 * past a size threshold Loom's own grids switch to it.
 *
 * This module is PURE (no fetch, no React, no Node built-ins) so both the BFF
 * and the browser evaluate the identical rule, and so the measurement is
 * unit-testable. It carries no engine coupling: `loom-directlake` and
 * `loom-duckdb` both emit the same Arrow IPC stream.
 *
 * The BFF proxies the Arrow stream from the serving tier over the AUDITED
 * route; external clients take the same batches over Flight SQL. Both paths are
 * the "Arrow transport" as far as this policy is concerned — the difference is
 * who is calling, not what is on the wire.
 */

/** The wire a result is delivered on. */
export type ResultTransport = 'json' | 'arrow';

/** Row count past which Arrow wins decisively (measured, not guessed — see the doc). */
export const DEFAULT_ARROW_ROW_THRESHOLD = 5_000;

/** Cell count (rows × columns) past which Arrow wins even for narrow row counts. */
export const DEFAULT_ARROW_CELL_THRESHOLD = 50_000;

/** Parse an env-provided override, falling back to the code default. */
export function arrowRowThreshold(raw?: string | number | null): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ARROW_ROW_THRESHOLD;
}

export interface TransportDecision {
  transport: ResultTransport;
  /** Operator-readable reason, printed in the results status bar. */
  reason: string;
  rowThreshold: number;
  cellThreshold: number;
}

/**
 * Choose the transport for a result of the given shape.
 *
 * `estimatedRows` is what the caller expects (a LIMIT, a prior row count, or a
 * planner estimate). When it is unknown, JSON is chosen — an unknown result is
 * usually a small ad-hoc query, and the Arrow path costs a decode.
 */
export function chooseTransport(shape: {
  estimatedRows?: number | null;
  columns?: number | null;
  rowThreshold?: number;
  cellThreshold?: number;
  /** Force a transport (the UI's explicit toggle). */
  force?: ResultTransport;
}): TransportDecision {
  const rowThreshold = shape.rowThreshold ?? DEFAULT_ARROW_ROW_THRESHOLD;
  const cellThreshold = shape.cellThreshold ?? DEFAULT_ARROW_CELL_THRESHOLD;

  if (shape.force) {
    return {
      transport: shape.force,
      reason: `Transport forced to ${shape.force} by the caller.`,
      rowThreshold,
      cellThreshold,
    };
  }

  const rows = Number.isFinite(shape.estimatedRows as number) ? Number(shape.estimatedRows) : null;
  const cols = Number.isFinite(shape.columns as number) ? Number(shape.columns) : null;

  if (rows === null) {
    return {
      transport: 'json',
      reason: 'Result size unknown — starting on JSON; the next run uses the measured row count.',
      rowThreshold,
      cellThreshold,
    };
  }
  if (rows >= rowThreshold) {
    return {
      transport: 'arrow',
      reason: `${rows.toLocaleString()} rows ≥ the ${rowThreshold.toLocaleString()}-row Arrow threshold — streaming Arrow IPC (no per-cell JSON encode).`,
      rowThreshold,
      cellThreshold,
    };
  }
  const cells = cols ? rows * cols : 0;
  if (cells >= cellThreshold) {
    return {
      transport: 'arrow',
      reason: `${cells.toLocaleString()} cells ≥ the ${cellThreshold.toLocaleString()}-cell Arrow threshold — streaming Arrow IPC.`,
      rowThreshold,
      cellThreshold,
    };
  }
  return {
    transport: 'json',
    reason: `${rows.toLocaleString()} rows is below the ${rowThreshold.toLocaleString()}-row Arrow threshold — JSON is cheaper end-to-end at this size.`,
    rowThreshold,
    cellThreshold,
  };
}

/** One measured leg of a fetch, for the before/after receipt. */
export interface TransportMeasurement {
  transport: ResultTransport;
  /** Wall-clock ms from request start to a usable in-memory result. */
  totalMs: number;
  /** Engine-reported execution ms (excluded from the transport comparison). */
  engineMs: number;
  /** Bytes on the wire. */
  bytes: number;
  rows: number;
}

/**
 * Transport-only latency: the wall clock minus the engine's own execution time.
 * This is the number the Arrow switch is supposed to move, so it is the number
 * the receipt prints — comparing raw totals would flatter or punish Arrow
 * depending on how long the query itself took.
 */
export function transportMs(m: TransportMeasurement): number {
  return Math.max(0, m.totalMs - m.engineMs);
}

export interface TransportComparison {
  baseline: TransportMeasurement;
  candidate: TransportMeasurement;
  /** Positive = the candidate transport was faster by this many ms. */
  savedMs: number;
  /** Positive = the candidate transport moved this many fewer bytes. */
  savedBytes: number;
  /** e.g. "2.4× faster transport, 61% fewer bytes" — rendered in the status bar. */
  summary: string;
}

/**
 * Compare two measured legs of the SAME query. Used by the SQL Lab "measure
 * transports" action so the receipt carries a real before/after instead of a
 * claim: it runs the statement once per transport and prints both.
 */
export function compareTransports(
  baseline: TransportMeasurement,
  candidate: TransportMeasurement,
): TransportComparison {
  const base = transportMs(baseline);
  const cand = transportMs(candidate);
  const savedMs = base - cand;
  const savedBytes = baseline.bytes - candidate.bytes;
  const speedup = cand > 0 ? base / cand : 0;
  const bytesPct = baseline.bytes > 0 ? Math.round((savedBytes / baseline.bytes) * 100) : 0;

  const speedText = speedup >= 1.05
    ? `${speedup.toFixed(1)}× faster transport`
    : speedup > 0 && speedup < 0.95
      ? `${(1 / speedup).toFixed(1)}× slower transport`
      : 'comparable transport time';
  const bytesText = savedBytes === 0
    ? 'same bytes on the wire'
    : `${Math.abs(bytesPct)}% ${savedBytes > 0 ? 'fewer' : 'more'} bytes`;

  return {
    baseline,
    candidate,
    savedMs,
    savedBytes,
    summary: `${candidate.transport} vs ${baseline.transport} over ${candidate.rows.toLocaleString()} rows: ${speedText}, ${bytesText}.`,
  };
}
