'use client';

/**
 * N2a — the duckdb-wasm boundary. The ONE module that touches the wasm engine.
 *
 * Everything above it (`local-arrow-query.ts`, the SQL Lab local mode, the
 * preview "analyze locally" panel) talks to the small {@link LocalDuckDb}
 * interface below, so:
 *   • the engine is loaded LAZILY — nothing is downloaded until a user actually
 *     runs a local query, so the wasm never costs a page load;
 *   • tests substitute a fake at this boundary and exercise the REAL wiring
 *     (register Arrow IPC → run SQL → shape the result) with no wasm; and
 *   • the asset origin is a single, auditable decision.
 *
 * SELF-HOSTED, NEVER A CDN. duckdb-wasm's `getJsDelivrBundles()` helper points
 * at jsdelivr; that is blocked by Loom's CSP and impossible in a disconnected
 * enclave. `scripts/copy-duckdb-assets.mjs` copies the wasm + worker out of the
 * npm package into `public/duckdb/` at build time (exactly how Monaco is
 * self-hosted), and this loader points the bundle at those same-origin paths.
 *
 * IL5 / SOVEREIGN MOAT: the engine is a static `.wasm` served from Loom's own
 * origin and executed in the browser. There is no query service, no network
 * call, and no telemetry — which is precisely why the fastest tier in the
 * product is also the one that works on an air-gapped network.
 */

/** A shaped local query result — engine-agnostic on purpose. */
export interface LocalQueryResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  rowCount: number;
}

/** The minimal engine surface the local-query layer depends on. */
export interface LocalDuckDb {
  /** Register an Arrow IPC stream as a queryable table. */
  registerArrow(name: string, ipc: Uint8Array): Promise<void>;
  /** Run SQL over the registered tables and shape the result. */
  query(sql: string): Promise<LocalQueryResult>;
  /** Release the worker + wasm instance. */
  close(): Promise<void>;
}

/** Where the self-hosted engine assets live (see copy-duckdb-assets.mjs). */
export const DUCKDB_ASSET_BASE = '/duckdb';

/** True in a browser that can host the engine at all. */
export function localEngineSupported(): boolean {
  return (
    typeof window !== 'undefined'
    && typeof Worker !== 'undefined'
    && typeof WebAssembly !== 'undefined'
  );
}

/** Thrown when the engine cannot be started — always with an actionable reason. */
export class LocalEngineUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalEngineUnavailable';
  }
}

/** Normalize a value the Arrow reader produced into something React can render. */
export function normalizeCell(value: unknown): unknown {
  if (typeof value === 'bigint') {
    // Beyond 2^53 a Number would silently lose precision, so keep the exact
    // decimal string instead of a wrong number.
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  return value;
}

/**
 * Shape an `apache-arrow` Table (whatever duckdb-wasm returned) into the plain
 * columns/rows form the grids consume. Exported so tests can pin the shaping
 * against a real Arrow-like object without a wasm engine.
 */
export function shapeArrowTable(table: {
  numRows: number;
  schema: { fields: { name: string; type: unknown }[] };
  toArray: () => unknown[];
}): LocalQueryResult {
  const columns = table.schema.fields.map((f) => ({ name: f.name, type: String(f.type) }));
  const rows = table.toArray().map((row) => {
    const record = row as Record<string, unknown>;
    return columns.map((c) => normalizeCell(record?.[c.name]));
  });
  return { columns, rows, rowCount: table.numRows ?? rows.length };
}

let cached: Promise<LocalDuckDb> | null = null;

/**
 * Start (or reuse) the in-browser engine.
 *
 * One instance per tab: the wasm module and its worker are expensive to create
 * and cheap to keep, and every local query registers its own uniquely-named
 * table, so sharing is safe.
 */
export function loadLocalDuckDb(): Promise<LocalDuckDb> {
  if (!localEngineSupported()) {
    return Promise.reject(
      new LocalEngineUnavailable(
        'This browser cannot run the in-browser query engine (WebAssembly or Web Workers are '
        + 'unavailable). Queries will run on the server tier instead — same results, one network hop.',
      ),
    );
  }
  if (!cached) cached = instantiate().catch((e) => { cached = null; throw e; });
  return cached;
}

/** Drop the cached instance (used when a page unmounts the local panel). */
export async function disposeLocalDuckDb(): Promise<void> {
  const pending = cached;
  cached = null;
  if (!pending) return;
  try {
    const db = await pending;
    await db.close();
  } catch {
    /* disposal is best-effort — a dead worker is already gone */
  }
}

async function instantiate(): Promise<LocalDuckDb> {
  let duckdb: typeof import('@duckdb/duckdb-wasm');
  try {
    duckdb = await import('@duckdb/duckdb-wasm');
  } catch (e) {
    throw new LocalEngineUnavailable(
      'The in-browser query engine bundle could not be loaded: '
      + `${(e as Error)?.message || String(e)}. Queries fall back to the server tier.`,
    );
  }

  // Self-hosted bundles only. `selectBundle` picks the exception-handling build
  // when the browser supports it and the MVP build otherwise.
  const bundle = await duckdb.selectBundle({
    mvp: {
      mainModule: `${DUCKDB_ASSET_BASE}/duckdb-mvp.wasm`,
      mainWorker: `${DUCKDB_ASSET_BASE}/duckdb-browser-mvp.worker.js`,
    },
    eh: {
      mainModule: `${DUCKDB_ASSET_BASE}/duckdb-eh.wasm`,
      mainWorker: `${DUCKDB_ASSET_BASE}/duckdb-browser-eh.worker.js`,
    },
  });

  if (!bundle.mainWorker) {
    throw new LocalEngineUnavailable(
      `The in-browser engine assets are missing from ${DUCKDB_ASSET_BASE}/. They are copied at build `
      + 'time by scripts/copy-duckdb-assets.mjs; re-run the build. Queries fall back to the server tier.',
    );
  }

  const worker = new Worker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const connection = await db.connect();

  return {
    async registerArrow(name: string, ipc: Uint8Array) {
      await connection.insertArrowFromIPCStream(ipc, { name, create: true });
    },
    async query(sql: string) {
      const table = await connection.query(sql);
      return shapeArrowTable(table as unknown as Parameters<typeof shapeArrowTable>[0]);
    },
    async close() {
      await connection.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
