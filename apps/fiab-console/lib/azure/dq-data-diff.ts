/**
 * N7d — data-diff: the exact row + cell delta between two Delta versions (or two
 * environments / paths) of the same table, **computed through the N2 DuckDB
 * engine**. No Spark, no Fabric, no delta-extension version-pin feature: we
 * reconstruct each side's active data-file set from the `_delta_log`
 * ({@link activeFilesAtVersion}) and scan those exact parquet files with DuckDB
 * `read_parquet([...])`, join on the key column(s), and return added / removed
 * rows plus the precise changed cells.
 *
 * DuckDB does the heavy set work (the FULL OUTER JOIN + `IS DISTINCT FROM`
 * filter over the lake in place); the tiny per-cell extraction is a pure JS
 * function ({@link changedCells}) so it is fully unit-tested.
 *
 * IL5 / SOVEREIGN MOAT: DuckDB reads in-boundary ADLS through the deployment's
 * managed identity — the whole diff runs disconnected in an air-gapped enclave.
 *
 * Findings this produces feed N17's incident console (N17 OWNS the incident UX);
 * a diff regression is emitted as a `data-diff` {@link DqFindingDoc}.
 */

import { getAccountName } from './adls-client';
import { dfsSuffix } from './cloud-endpoints';
import { duckdbQueryJson, isDuckDbConfigured } from './duckdb-client';
import { activeFilesAtVersion, readCommitActions, maxVersion, replayActiveFiles } from './delta-version-files';

/** One side of a diff: a table at a container/path, optionally pinned to a version. */
export interface DiffSide {
  container: string;
  /** The table folder (the one that contains `_delta_log/`). */
  path: string;
  /** Delta version to reconstruct; omit for the current/latest state. */
  version?: number;
  /** Human label for the receipt ("v3", "prod", "dev"). */
  label?: string;
}

export interface DataDiffRequest {
  a: DiffSide;
  b: DiffSide;
  /** Key column(s) that identify a row across versions. */
  keyColumns: string[];
  /** Cap on returned changed/added/removed rows (per bucket). Default 200. */
  limit?: number;
}

export interface CellChange {
  column: string;
  before: unknown;
  after: unknown;
}

export interface ChangedRow {
  key: Record<string, unknown>;
  cells: CellChange[];
}

export interface DataDiffResult {
  /** Columns compared (from the parquet schema, minus the keys). */
  columns: string[];
  keyColumns: string[];
  changed: ChangedRow[];
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  counts: { changed: number; added: number; removed: number };
  truncated: boolean;
  /** Files scanned per side (receipt material). */
  scan: { a: { label: string; files: number; version?: number }; b: { label: string; files: number; version?: number } };
  engine: 'duckdb';
}

const IDENT_RE = /^[A-Za-z0-9_ .$-]+$/;
const CONTAINER_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const PATH_RE = /^[A-Za-z0-9._\-/=%*+ ]+$/;

function assertColumn(name: string): string {
  const s = String(name || '').trim();
  if (!s || !IDENT_RE.test(s)) throw new DataDiffError(`"${name}" is not a valid column name.`, 400);
  return s;
}

/** Double-quote a DuckDB identifier (injection-safe). */
export function dq(name: string): string {
  return `"${assertColumn(name).replace(/"/g, '""')}"`;
}

export class DataDiffError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'DataDiffError';
    this.status = status;
  }
}

/**
 * Build an `abfss://` URI for one table-relative data file. Account resolved
 * SERVER-SIDE (never client-supplied). Sovereign-cloud correct via dfsSuffix().
 */
export function fileUri(account: string, container: string, tablePath: string, relFile: string): string {
  if (!CONTAINER_RE.test(container)) throw new DataDiffError(`"${container}" is not a valid container name.`, 400);
  const path = `${tablePath.replace(/\/+$/, '')}/${relFile.replace(/^\/+/, '')}`;
  if (!PATH_RE.test(path)) throw new DataDiffError(`"${relFile}" is not a readable lake path.`, 400);
  // dfsSuffix(): Gov is .dfs.core.usgovcloudapi.net — a hardcoded Commercial host breaks Gov.
  return `abfss://${container}@${account}.${dfsSuffix()}/${path}`;
}

/** A `read_parquet([...])` list literal from a set of abfss URIs. */
export function readParquetList(uris: string[]): string {
  if (!uris.length) throw new DataDiffError('This version has no data files to scan (the table is empty at this version).', 422);
  const items = uris.map((u) => {
    if (u.includes("'")) throw new DataDiffError('Refusing a storage URI containing a single quote.', 400);
    return `'${u}'`;
  });
  return `read_parquet([${items.join(', ')}])`;
}

/**
 * Build the DuckDB diff query. Returns one row per differing key with every
 * column projected as `a_<col>` / `b_<col>`, plus a `_diff` discriminator
 * (added | removed | changed). PURE — the two `read_parquet(...)` scan snippets
 * come from {@link readParquetList}.
 */
export function buildDiffSql(
  aScan: string,
  bScan: string,
  keyColumns: string[],
  compareColumns: string[],
  limitPerBucket: number,
): string {
  const keys = keyColumns.map(assertColumn);
  if (!keys.length) throw new DataDiffError('A diff needs at least one key column.', 400);
  const allCols = Array.from(new Set([...keys, ...compareColumns.map(assertColumn)]));

  const proj = allCols
    .map((c) => `a.${dq(c)} AS ${dq(`a_${c}`)}, b.${dq(c)} AS ${dq(`b_${c}`)}`)
    .join(', ');
  const joinOn = keys.map((k) => `a.${dq(k)} = b.${dq(k)}`).join(' AND ');
  const keyPresentA = keys.map((k) => `a.${dq(k)} IS NOT NULL`).join(' AND ');
  const keyPresentB = keys.map((k) => `b.${dq(k)} IS NOT NULL`).join(' AND ');
  // A row is a diff when the key is missing on one side, or any non-key column differs.
  const nonKey = compareColumns.map(assertColumn).filter((c) => !keys.includes(c));
  const changedClause = nonKey.length
    ? nonKey.map((c) => `a.${dq(c)} IS DISTINCT FROM b.${dq(c)}`).join(' OR ')
    : 'FALSE';
  const diffCase =
    `CASE WHEN NOT (${keyPresentA}) THEN 'added' `
    + `WHEN NOT (${keyPresentB}) THEN 'removed' ELSE 'changed' END AS _diff`;

  const cap = Math.max(1, Math.min(Math.floor(limitPerBucket) * 3 + 3, 5000));
  return (
    `WITH a AS (SELECT * FROM ${aScan}), b AS (SELECT * FROM ${bScan}) `
    + `SELECT ${proj}, ${diffCase} `
    + `FROM a FULL OUTER JOIN b ON ${joinOn} `
    + `WHERE NOT (${keyPresentA}) OR NOT (${keyPresentB}) OR (${changedClause}) `
    + `LIMIT ${cap}`
  );
}

/** Values equal for cell-diff purposes (null-safe, number/string tolerant). */
function cellEqual(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (x === null || x === undefined) return y === null || y === undefined;
  if (y === null || y === undefined) return false;
  if (typeof x === 'number' && typeof y === 'number') return x === y;
  return String(x) === String(y);
}

/**
 * Extract the exact changed cells from one joined diff row. PURE. `row` has
 * `a_<col>` / `b_<col>` keys and `_diff`. For a 'changed' row we compare every
 * non-key column and return only the cells that actually differ.
 */
export function changedCells(
  row: Record<string, unknown>,
  keyColumns: string[],
  compareColumns: string[],
): CellChange[] {
  const keys = new Set(keyColumns);
  const cells: CellChange[] = [];
  for (const c of compareColumns) {
    if (keys.has(c)) continue;
    const before = row[`a_${c}`];
    const after = row[`b_${c}`];
    if (!cellEqual(before, after)) cells.push({ column: c, before, after });
  }
  return cells;
}

/** Pull the key object (from the present side) out of a joined diff row. */
function keyOf(row: Record<string, unknown>, keyColumns: string[], side: 'a' | 'b'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keyColumns) out[k] = row[`${side}_${k}`];
  return out;
}

/** Pull a single side's full row (bare column names) out of a joined diff row. */
function sideRow(row: Record<string, unknown>, columns: string[], side: 'a' | 'b'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[`${side}_${c}`];
  return out;
}

/** Discover the compare columns from a parquet scan (DuckDB schema, LIMIT 0). */
async function discoverColumns(scan: string): Promise<string[]> {
  const body = await duckdbQueryJson(`SELECT * FROM ${scan} LIMIT 0`, 0);
  return (body.columns || []).map((c) => c.name).filter(Boolean);
}

/**
 * Compute the data-diff between two sides. Requires the DuckDB serving tier
 * (LOOM_DUCKDB_URL) — this reads parquet files directly off the lake, which the
 * Synapse-Serverless fallback cannot do file-by-file, so the caller gates on
 * {@link isDuckDbConfigured} and surfaces an honest Fix-it when it is unset.
 */
export async function computeDataDiff(req: DataDiffRequest): Promise<DataDiffResult> {
  if (!isDuckDbConfigured()) {
    throw new DataDiffError(
      'The data-diff reads Delta files directly and needs the loom-duckdb serving tier. Set LOOM_DUCKDB_URL to enable it.',
      503,
    );
  }
  const account = getAccountName();
  if (!account) throw new DataDiffError('No lake storage account is configured (LOOM_ADLS_ACCOUNT).', 503);

  const keyColumns = (req.keyColumns || []).map(assertColumn);
  if (!keyColumns.length) throw new DataDiffError('Pick at least one key column so rows can be matched across versions.', 400);
  const limit = Math.max(1, Math.min(Math.floor(req.limit ?? 200), 1000));

  const aFiles = await resolveSide(req.a, account);
  const bFiles = await resolveSide(req.b, account);
  const aScan = readParquetList(aFiles.uris);
  const bScan = readParquetList(bFiles.uris);

  // Compare columns = the intersection of both sides' schemas.
  const aCols = await discoverColumns(aScan);
  const bCols = new Set(await discoverColumns(bScan));
  const compareColumns = aCols.filter((c) => bCols.has(c));
  for (const k of keyColumns) {
    if (!compareColumns.includes(k)) throw new DataDiffError(`Key column "${k}" is not present in both versions.`, 400);
  }

  const sql = buildDiffSql(aScan, bScan, keyColumns, compareColumns, limit);
  const body = await duckdbQueryJson(sql, limit * 3 + 3);
  const cols = (body.columns || []).map((c) => c.name);
  const rows = (body.rows || []).map((r) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((name, i) => { obj[name] = r[i]; });
    return obj;
  });

  const changed: ChangedRow[] = [];
  const added: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const kind = row._diff;
    if (kind === 'added') {
      if (added.length < limit) added.push(sideRow(row, compareColumns, 'b'));
    } else if (kind === 'removed') {
      if (removed.length < limit) removed.push(sideRow(row, compareColumns, 'a'));
    } else {
      const cells = changedCells(row, keyColumns, compareColumns);
      if (cells.length && changed.length < limit) {
        changed.push({ key: keyOf(row, keyColumns, 'a'), cells });
      }
    }
  }

  const truncated = rows.length >= limit * 3 + 3;
  return {
    columns: compareColumns.filter((c) => !keyColumns.includes(c)),
    keyColumns,
    changed,
    added,
    removed,
    counts: { changed: changed.length, added: added.length, removed: removed.length },
    truncated,
    scan: {
      a: { label: req.a.label || (req.a.version !== undefined ? `v${req.a.version}` : 'A'), files: aFiles.uris.length, version: aFiles.version },
      b: { label: req.b.label || (req.b.version !== undefined ? `v${req.b.version}` : 'B'), files: bFiles.uris.length, version: bFiles.version },
    },
    engine: 'duckdb',
  };
}

/** Resolve one side to its concrete abfss file URIs (version-pinned when asked). */
async function resolveSide(side: DiffSide, account: string): Promise<{ uris: string[]; version?: number }> {
  const container = String(side.container || '').trim();
  const path = String(side.path || '').trim().replace(/^\/+|\/+$/g, '');
  if (!CONTAINER_RE.test(container)) throw new DataDiffError(`"${container}" is not a valid container name.`, 400);
  if (!path || !PATH_RE.test(path)) throw new DataDiffError(`"${side.path}" is not a readable table path.`, 400);

  if (side.version === undefined) {
    // Latest state — read the commit chain once, replay to its newest version.
    const commits = await readCommitActions(container, path);
    if (commits.length === 0) {
      throw new DataDiffError(`No Delta commit log under ${container}/${path}/_delta_log (not a Delta table, or not materialized).`, 404);
    }
    const latestVersion = maxVersion(commits);
    const files = replayActiveFiles(commits, latestVersion);
    return { uris: files.map((f) => fileUri(account, container, path, f)), version: latestVersion };
  }
  const { files } = await activeFilesAtVersion(container, path, side.version);
  return { uris: files.map((f) => fileUri(account, container, path, f)), version: side.version };
}
