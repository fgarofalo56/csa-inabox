/**
 * Grid model — PURE (no `vscode`) shaping of a raw query/preview envelope into a
 * type-badged column + row grid, plus the credential-free webview payload. Unit
 * tested; a mutation to the shaping (e.g. dropping the engine column-type
 * preference) turns a test RED.
 *
 * The Console query/preview routes are non-uniform (see the SDK `QueryResult`
 * note): Synapse SQL / dataset-preview return `columns: string[]` + positional
 * `rows: unknown[][]`; ADX/KQL returns `columns: string[]` + a parallel
 * `columnTypes: string[]` + positional `rows`. Some routes instead return
 * keyed `rows: Record<string, unknown>[]`. {@link shapeGrid} normalizes all of
 * them to `{ columns: {name,type}[], rows: string[][] }` where the type is the
 * engine's declared type when present, else INFERRED from the actual returned
 * cells (honest — derived from real data, never fabricated).
 */

/** A rendered grid ready for the webview, or an honest message (DDL / empty / error). */
export type GridModel =
  | {
      kind: 'grid';
      columns: GridColumn[];
      rows: string[][];
      rowCount: number;
      truncated: boolean;
      cappedBy?: 'rows' | 'bytes';
      elapsedMs?: number;
    }
  | { kind: 'message'; message: string; isError: boolean };

export interface GridColumn {
  name: string;
  /** Declared engine type, else an inferred badge (`number`/`string`/…). */
  type: string;
}

/** The narrow, credential-FREE message posted into the webview. */
export interface GridMessage {
  type: 'result';
  title: string;
  engine: string;
  columns: GridColumn[];
  rows: string[][];
  meta: {
    rowCount: number;
    truncated: boolean;
    cappedBy?: 'rows' | 'bytes';
    elapsedMs?: number;
  };
}

interface RawResult {
  columns?: unknown;
  columnTypes?: unknown;
  rows?: unknown;
  rowCount?: unknown;
  truncated?: unknown;
  truncatedByCap?: unknown;
  cappedBy?: unknown;
  executionMs?: unknown;
  isDdl?: unknown;
  [k: string]: unknown;
}

/** Render one cell value to a safe display string (never `[object Object]`). */
export function renderCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Column-name list from either `string[]` or `{name|ColumnName}[]`. */
function columnNames(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  return columns.map((c, i) => {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      const n = o.name ?? o.ColumnName ?? o.columnName;
      if (typeof n === 'string') return n;
    }
    return `col${i + 1}`;
  });
}

/** Declared type for a column index, from `columnTypes[]` or `{type|DataType}`. */
function declaredType(columns: unknown, columnTypes: unknown, i: number): string | undefined {
  if (Array.isArray(columnTypes) && typeof columnTypes[i] === 'string' && columnTypes[i]) {
    return String(columnTypes[i]);
  }
  if (Array.isArray(columns) && columns[i] && typeof columns[i] === 'object') {
    const o = columns[i] as Record<string, unknown>;
    const t = o.type ?? o.DataType ?? o.dataType ?? o.ColumnType;
    if (typeof t === 'string' && t) return t;
  }
  return undefined;
}

/** Positional row from either a `[]` (kept) or a keyed record (ordered by name). */
function positionalRow(row: unknown, names: string[]): unknown[] {
  if (Array.isArray(row)) return row;
  if (row && typeof row === 'object') {
    const o = row as Record<string, unknown>;
    return names.map((n) => o[n]);
  }
  return [row];
}

/**
 * Infer a badge type from the actual (non-null) cell values in a column.
 * Honest: only ever runs when the engine did NOT declare a type. Order matters
 * — a column of all-integers reads `number`, a mix reads `string`.
 */
export function inferColumnType(values: unknown[]): string {
  let seen = 0;
  let allNumber = true;
  let allBoolean = true;
  let allDateish = true;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    seen++;
    if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))) {
      allNumber = false;
    }
    if (typeof v !== 'boolean' && v !== 'true' && v !== 'false') allBoolean = false;
    const s = v instanceof Date ? v.toISOString() : String(v);
    if (!(v instanceof Date) && Number.isNaN(Date.parse(s))) allDateish = false;
  }
  if (seen === 0) return 'null';
  if (allBoolean) return 'boolean';
  if (allNumber) return 'number';
  if (allDateish) return 'datetime';
  return 'string';
}

/**
 * Shape a raw SQL/KQL/preview envelope into a {@link GridModel}. A DDL result
 * (no columns) or an empty result becomes an honest `message`, not a blank grid.
 */
export function shapeGrid(raw: RawResult | null | undefined): GridModel {
  if (!raw) return { kind: 'message', message: 'No result returned.', isError: false };

  const names = columnNames(raw.columns);
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  const elapsedMs = typeof raw.executionMs === 'number' ? raw.executionMs : undefined;

  // DDL / command-only result — no columns. Show the Messages equivalent.
  if (names.length === 0) {
    if (raw.isDdl) {
      return { kind: 'message', message: 'Command(s) completed successfully.', isError: false };
    }
    if (rawRows.length === 0) {
      return { kind: 'message', message: 'The query returned no columns and no rows.', isError: false };
    }
  }

  const rows: string[][] = rawRows.map((r) => positionalRow(r, names).map(renderCell));

  const columns: GridColumn[] = names.map((name, i) => {
    const declared = declaredType(raw.columns, raw.columnTypes, i);
    const type = declared ?? inferColumnType(rawRows.map((r) => positionalRow(r, names)[i]));
    return { name, type };
  });

  const truncated = Boolean(raw.truncated) || Boolean(raw.truncatedByCap);
  const cappedBy = raw.cappedBy === 'rows' || raw.cappedBy === 'bytes' ? raw.cappedBy : undefined;
  const rowCount = typeof raw.rowCount === 'number' ? raw.rowCount : rows.length;

  return { kind: 'grid', columns, rows, rowCount, truncated, cappedBy, elapsedMs };
}

/**
 * Build the webview message from an already-shaped grid. Only column/row/meta
 * data crosses the boundary — asserted by a test that no key or value carries a
 * credential (PRP §2.3: no PAT/cookie/session ever reaches a webview).
 */
export function buildGridMessage(title: string, engine: string, model: GridModel): GridMessage {
  if (model.kind !== 'grid') {
    return {
      type: 'result',
      title,
      engine,
      columns: [],
      rows: [],
      meta: { rowCount: 0, truncated: false },
    };
  }
  return {
    type: 'result',
    title,
    engine,
    columns: model.columns,
    rows: model.rows,
    meta: {
      rowCount: model.rowCount,
      truncated: model.truncated,
      ...(model.cappedBy ? { cappedBy: model.cappedBy } : {}),
      ...(model.elapsedMs != null ? { elapsedMs: model.elapsedMs } : {}),
    },
  };
}
