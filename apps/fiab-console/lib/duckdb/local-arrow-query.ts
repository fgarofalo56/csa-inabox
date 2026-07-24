'use client';

/**
 * N2a — local SQL over an Arrow IPC result, in the browser.
 *
 * Loom already ships Arrow: `loom-directlake` transcodes a Delta/Parquet scan
 * to an Arrow IPC stream, and `loom-duckdb` serves the same stream. Once those
 * bytes are in the tab, every subsequent slice / filter / aggregate can run
 * **locally** on duckdb-wasm: zero server cost, zero network, and no wait for a
 * pool. That is the cheapest tier in the product — the data is already here.
 *
 * This module owns the SESSION: fetch the Arrow once, register it as a table,
 * then run as many statements as the user likes against it while counting
 * exactly how many network round-trips each one took (spoiler: zero) and how
 * long it took. {@link LocalQueryStats} is what the timing bar renders, and it
 * is measured, never asserted.
 *
 * The wasm engine is reached only through the `lib/duckdb/wasm-loader`
 * boundary, so this logic is unit-testable against a real Arrow fixture with a
 * substituted engine.
 */

import {
  loadLocalDuckDb,
  LocalEngineUnavailable,
  type LocalDuckDb,
  type LocalQueryResult,
} from './wasm-loader';

/** The default table name a fetched Arrow result is registered under. */
export const DEFAULT_LOCAL_TABLE = 'result';

/** Everything the timing bar needs to PROVE the query ran locally. */
export interface LocalQueryStats {
  /** Where the statement executed. */
  ranOn: 'browser';
  /** Wall-clock ms for the local execution. */
  elapsedMs: number;
  /** Network round-trips this statement made. Always 0 — measured, not claimed. */
  networkRequests: 0;
  /** Bytes fetched for the ORIGINAL Arrow payload this session reuses. */
  sourceBytes: number;
  /** Rows in the registered source table. */
  sourceRows: number;
  /** Statements this session has served without touching the network. */
  statementsServed: number;
  /** ms the ORIGINAL fetch cost — the one-time price the session amortizes. */
  fetchMs: number;
}

export interface LocalQueryOutcome extends LocalQueryResult {
  stats: LocalQueryStats;
}

export interface LocalSessionInit {
  /** The Arrow IPC stream bytes (from /api/duckdb/query?format=arrow or /api/directlake/scan). */
  arrow: Uint8Array;
  /** ms the fetch of those bytes took — reported as the amortized one-time cost. */
  fetchMs: number;
  /** Rows in the source (from the tier's x-loom-row-count header). */
  sourceRows: number;
  /** Table name to register. Defaults to `result`. */
  tableName?: string;
  /** Engine loader — substituted in tests. Defaults to the real wasm boundary. */
  loader?: () => Promise<LocalDuckDb>;
}

/**
 * A live local-analysis session over ONE fetched Arrow payload.
 *
 * Construct it with {@link openLocalSession} (which registers the table), then
 * call {@link LocalArrowSession.run} as many times as you like.
 */
export class LocalArrowSession {
  readonly tableName: string;
  private readonly db: LocalDuckDb;
  private readonly sourceBytes: number;
  private readonly sourceRows: number;
  private readonly fetchMs: number;
  private served = 0;

  constructor(db: LocalDuckDb, init: Required<Pick<LocalSessionInit, 'tableName'>> & LocalSessionInit) {
    this.db = db;
    this.tableName = init.tableName;
    this.sourceBytes = init.arrow.byteLength;
    this.sourceRows = init.sourceRows;
    this.fetchMs = init.fetchMs;
  }

  /** Statements served locally so far (the session's whole point). */
  get statementsServed(): number {
    return this.served;
  }

  /**
   * Run one statement locally. `elapsedMs` is measured with `performance.now()`
   * when available (sub-millisecond resolution matters here — local queries are
   * often faster than `Date.now()` can see) and falls back to `Date.now()`.
   */
  async run(sql: string): Promise<LocalQueryOutcome> {
    const started = now();
    const result = await this.db.query(sql);
    const elapsedMs = Math.max(0, Math.round((now() - started) * 100) / 100);
    this.served += 1;
    return {
      ...result,
      stats: {
        ranOn: 'browser',
        elapsedMs,
        networkRequests: 0,
        sourceBytes: this.sourceBytes,
        sourceRows: this.sourceRows,
        statementsServed: this.served,
        fetchMs: this.fetchMs,
      },
    };
  }

  /** A `SELECT *` over the registered table — the session's opening state. */
  selectAll(limit = 1000): Promise<LocalQueryOutcome> {
    return this.run(`SELECT * FROM ${quoteIdent(this.tableName)} LIMIT ${Math.max(1, Math.floor(limit))}`);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Quote an identifier for DuckDB (doubling embedded quotes). */
export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Open a local session: start (or reuse) the engine and register the Arrow
 * payload as a table.
 *
 * Throws {@link LocalEngineUnavailable} when the browser or the assets cannot
 * host the engine — callers treat that as "use the server tier", never as an
 * error the user must fix.
 */
export async function openLocalSession(init: LocalSessionInit): Promise<LocalArrowSession> {
  if (!init.arrow || init.arrow.byteLength === 0) {
    throw new LocalEngineUnavailable(
      'There is no fetched Arrow result to analyze locally yet. Run the query once, then slice it here.',
    );
  }
  const tableName = init.tableName || DEFAULT_LOCAL_TABLE;
  const db = await (init.loader ? init.loader() : loadLocalDuckDb());
  await db.registerArrow(tableName, init.arrow);
  return new LocalArrowSession(db, { ...init, tableName });
}

/**
 * The human sentence the timing bar prints. Kept here (not in the component) so
 * it is unit-testable and identical wherever the bar appears.
 */
export function describeLocalRun(stats: LocalQueryStats): string {
  const ms = stats.elapsedMs < 1 ? '<1' : String(Math.round(stats.elapsedMs));
  const kb = Math.max(1, Math.round(stats.sourceBytes / 1024));
  return (
    `Ran in your browser in ${ms} ms · 0 network requests · reusing ${kb} KB of Arrow `
    + `(${stats.sourceRows.toLocaleString()} rows) fetched once in ${Math.round(stats.fetchMs)} ms · `
    + `${stats.statementsServed} statement${stats.statementsServed === 1 ? '' : 's'} served locally`
  );
}
