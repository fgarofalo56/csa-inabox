/**
 * Mirror engine — the Azure-native backend that makes a Loom Mirrored Database
 * actually replicate (no Microsoft Fabric).
 *
 * Per .claude/rules/no-fabric-dependency.md the canonical Azure-native backend
 * for a mirrored database is **ADF CDC / Synapse Link copy → ADLS Bronze**. This
 * engine implements the directly-runnable core of that for the SQL family
 * (Azure SQL DB / MI / SQL Server):
 *
 *   1. Enable the source database **change feed** (real `sp_change_feed_enable_db`
 *      DDL) so ongoing changes are captured — the same CDC primitive Fabric
 *      mirroring consumes, but it is an Azure SQL feature.
 *   2. **Snapshot** each selected table (a real read-only SELECT over the source)
 *      and land it as **CSV in ADLS Bronze** under a stable per-mirror path.
 *   3. Emit, per table, the exact **OPENROWSET SELECT** + **abfss path** so the
 *      landed data is immediately queryable from Synapse Serverless SQL, a Loom
 *      notebook, or attachable to a lakehouse as a shortcut.
 *
 * Per .claude/rules/no-vaporware.md this runs REAL Azure operations (TDS reads +
 * ADLS writes + change-feed DDL). Sources that authenticate with their own
 * runtime (Postgres / Cosmos / Snowflake / open-mirroring) return an honest
 * gate rather than a fake "Running" — their copy runtime is a disclosed
 * follow-up, not a silent stub.
 */
import { executeParameterized, enableMirroring, type MirroringConfig } from './azure-sql-client';
import { listTables, sqlConfigGate } from './sql-objects-client';
import { uploadFile, pathToHttpsUrl, getAccountName } from './adls-client';
import { executePostgresQuery, listPostgresTables, postgresQueryGate } from './postgres-flex-client';
import { queryItems } from './cosmos-data-client';
import { listContainers } from './cosmos-account-client';

/** SQL-family sources the engine can snapshot directly via TDS. */
export const MIRROR_SQL_FAMILY = new Set(['AzureSqlDatabase', 'AzureSqlMI', 'SqlServer2025', 'MSSQL']);
/** PostgreSQL flexible server (snapshot over the pg wire protocol + Entra token). */
export const MIRROR_PG_FAMILY = new Set(['AzurePostgreSql']);
/** Cosmos DB SQL API (snapshot the container via the data-plane query). */
export const MIRROR_COSMOS_FAMILY = new Set(['CosmosDb']);
/** Any source the engine can snapshot today (vs. honest-gated). */
function engineCanSnapshot(t: string): boolean {
  return MIRROR_SQL_FAMILY.has(t) || MIRROR_PG_FAMILY.has(t) || MIRROR_COSMOS_FAMILY.has(t);
}

const BRONZE = 'bronze';
/** Cap a single snapshot so a huge table can't exhaust memory; disclosed. */
const MAX_ROWS = Number(process.env.LOOM_MIRROR_MAX_ROWS || 50_000);
/** Cap how many tables one Start replicates when none were explicitly chosen. */
const MAX_TABLES = Number(process.env.LOOM_MIRROR_MAX_TABLES || 50);

export interface MirrorTableSpec { schema: string; table: string }

export interface MirrorSource {
  sourceType: string;
  server: string;
  database: string;
  /** Explicit table subset; when empty the engine enumerates source tables. */
  tables?: MirrorTableSpec[];
}

export interface MirrorTableResult {
  schema: string;
  table: string;
  status: 'replicated' | 'error';
  rows: number;
  bytes: number;
  truncated: boolean;
  lastSync: string;
  /** abfss/https path of the landed snapshot folder (for shortcuts/notebooks). */
  path?: string;
  /** Ready-to-run Synapse Serverless query over the landed CSV. */
  openrowset?: string;
  /**
   * How this run landed the table:
   *   - `snapshot`    — full read of the source (first run, or any non-SQL family,
   *                     or an honest fallback when incremental was unavailable).
   *   - `incremental` — only the rows changed since the last sync (SQL family,
   *                     Change Tracking enabled), appended as a delta CSV.
   */
  mode?: 'snapshot' | 'incremental';
  /**
   * SQL Server Change Tracking watermark (CHANGE_TRACKING_CURRENT_VERSION) at the
   * end of a successful SQL-family run. Persisted in `state.tablesStatus` so the
   * next Start reads only changes since this version. Absent for non-SQL families.
   */
  syncVersion?: number;
  /**
   * Human-readable disclosure when incremental was requested but the engine fell
   * back to a full snapshot (no PK, CT not enabled / could not be enabled, or the
   * saved watermark aged out of the retention window). No-vaporware honesty.
   */
  note?: string;
  error?: string;
}

export interface MirrorRunResult {
  ok: boolean;
  status: 'Running' | 'Error' | 'Gated';
  backend: 'azure-native-cdc';
  changeFeed?: MirroringConfig;
  tables: MirrorTableResult[];
  /** Bronze landing root for the whole mirror (folder of folders). */
  basePath?: string;
  note: string;
  error?: string;
  gate?: { missing: string; message: string };
}

/**
 * Convert a landed snapshot's https dfs URL into the abfss form Spark reads:
 *   https://ACCT.dfs.core.windows.net/CONTAINER/PATH
 *     → abfss://CONTAINER@ACCT.dfs.core.windows.net/PATH
 * Returns the input unchanged if it isn't a dfs https URL.
 */
export function httpsToAbfss(httpsUrl: string): string {
  const m = (httpsUrl || '').match(/^https:\/\/([^.]+)\.dfs\.core\.windows\.net\/([^/]+)\/(.*)$/i);
  if (!m) return httpsUrl;
  const [, account, container, path] = m;
  return `abfss://${container}@${account}.dfs.core.windows.net/${path}`;
}

/** Is the ADLS Bronze landing zone configured? */
function bronzeConfigured(): boolean {
  if (!process.env.LOOM_BRONZE_URL) return false;
  try { getAccountName(); return true; } catch { return false; }
}

/** Bracket-quote a SQL identifier (double any `]`). */
function bracket(ident: string): string {
  return `[${String(ident).replace(/]/g, ']]')}]`;
}

/** RFC-4180 CSV cell: dates → ISO, null → empty, quote when needed. */
function csvCell(v: unknown): string {
  if (v == null) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Double-quote a PG identifier (escape embedded quotes). */
function pgQuote(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

/**
 * Shared landing: write CSV (header + rows) to Bronze and return the metrics +
 * the OPENROWSET/abfss accessors. `columns` is the ordered header; each row is
 * an object keyed by column name.
 */
async function writeCsvSnapshot(
  basePath: string, schema: string, table: string,
  columns: string[], rows: Record<string, unknown>[], truncated: boolean, lastSync: string,
): Promise<MirrorTableResult> {
  const lines: string[] = [];
  lines.push(columns.map(csvCell).join(','));
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  const buf = Buffer.from(lines.join('\n'), 'utf-8');

  const folder = `${basePath}/${schema}.${table}`;
  await uploadFile(BRONZE, `${folder}/snapshot.csv`, buf, 'text/csv');

  const folderUrl = pathToHttpsUrl(BRONZE, `${folder}/`);
  const openrowset =
    `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', ` +
    `FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE) AS rows`;
  return { schema, table, status: 'replicated', mode: 'snapshot', rows: rows.length, bytes: buf.length, truncated, lastSync, path: folderUrl, openrowset };
}

/**
 * Append a delta CSV (header + only the changed rows) beside the existing
 * `snapshot.csv` as `delta-<timestamp>.csv`. Synapse Serverless' OPENROWSET
 * BULK path already targets the whole folder (`${folder}/`), so the snapshot
 * and every delta are read together as one logical table — provided they share
 * the same header. Identical shape to `writeCsvSnapshot` but `mode:'incremental'`.
 */
async function writeDeltaCsv(
  basePath: string, schema: string, table: string,
  columns: string[], rows: Record<string, unknown>[], lastSync: string,
): Promise<MirrorTableResult> {
  const lines: string[] = [];
  lines.push(columns.map(csvCell).join(','));
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  const buf = Buffer.from(lines.join('\n'), 'utf-8');

  const folder = `${basePath}/${schema}.${table}`;
  await uploadFile(BRONZE, `${folder}/delta-${Date.now()}.csv`, buf, 'text/csv');

  const folderUrl = pathToHttpsUrl(BRONZE, `${folder}/`);
  const openrowset =
    `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', ` +
    `FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE) AS rows`;
  return { schema, table, status: 'replicated', mode: 'incremental', rows: rows.length, bytes: buf.length, truncated: false, lastSync, path: folderUrl, openrowset };
}

/**
 * Best-effort enable SQL Server Change Tracking at the database + table level so
 * subsequent Starts can read an incremental delta via CHANGETABLE. This is a
 * **separate, independent mechanism** from `sp_change_feed_enable_db` (which
 * `enableMirroring()` already calls for the Synapse/Fabric CDC log) — both can
 * be active at once. Failure is non-fatal: the engine falls back to a full
 * snapshot with an honest disclosure (no-vaporware). The database/schema/table
 * identifiers are bracket-quoted (already-validated source strings, same pattern
 * as `snapshotTable`); `ALTER DATABASE`/`ALTER TABLE` names cannot be bound
 * parameters. `OBJECT_ID(@p0)` uses a bound two-part-name parameter.
 */
async function enableChangeTracking(server: string, database: string, schema: string, table: string): Promise<void> {
  // DB-level: turn CT on with a 7-day retention window if it isn't already on.
  await executeParameterized(server, database,
    `IF (SELECT is_change_tracking_on FROM sys.databases WHERE database_id = DB_ID()) = 0 ` +
    `BEGIN ALTER DATABASE ${bracket(database)} SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 7 DAYS, AUTO_CLEANUP = ON) END`);
  // Table-level: enable CT on the specific table if it isn't already tracked.
  await executeParameterized(server, database,
    `IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_tables WHERE object_id = OBJECT_ID(@p0)) ` +
    `ALTER TABLE ${bracket(schema)}.${bracket(table)} ENABLE CHANGE_TRACKING`,
    [`${schema}.${table}`]);
}

/**
 * Probe Change Tracking for a table. Returns the current DB version and the
 * table's minimum-valid version, or null when CT is not enabled at the database
 * level (CHANGE_TRACKING_CURRENT_VERSION() is NULL). The caller compares the
 * saved watermark to `minValid`: if `saved < minValid` the watermark aged out of
 * the retention window (or the table was truncated) and a re-snapshot is required.
 */
async function changeTrackingStatus(
  server: string, database: string, schema: string, table: string,
): Promise<{ current: number; minValid: number | null } | null> {
  const rows = await executeParameterized<{ ctv: number | null; minV: number | null }>(server, database,
    `SELECT CHANGE_TRACKING_CURRENT_VERSION() AS ctv, CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(@p0)) AS minV`,
    [`${schema}.${table}`]);
  const r = rows[0];
  if (!r || r.ctv == null) return null;
  return { current: Number(r.ctv), minValid: r.minV == null ? null : Number(r.minV) };
}

/**
 * The primary-key columns of a table, in key order. CHANGETABLE requires a PK
 * join, so a table without a PK cannot use the incremental path (the engine
 * falls back to a full snapshot). `@p0` is the bound two-part name for OBJECT_ID.
 */
async function getPrimaryKeyColumns(server: string, database: string, schema: string, table: string): Promise<string[]> {
  const rows = await executeParameterized<{ name: string }>(server, database,
    `SELECT c.name FROM sys.index_columns ic ` +
    `JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id ` +
    `JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id ` +
    `WHERE i.is_primary_key = 1 AND ic.object_id = OBJECT_ID(@p0) ORDER BY ic.key_ordinal`,
    [`${schema}.${table}`]);
  return rows.map((r) => r.name).filter(Boolean);
}

/**
 * Read only the rows changed since `sinceVersion` via CHANGETABLE, joined back to
 * the user table on the PK so updated/inserted rows carry full column data and
 * deleted rows carry NULLs + SYS_CHANGE_OPERATION='D'. `sinceVersion` is embedded
 * as a bigint literal (CHANGETABLE's second argument must be a scalar/constant,
 * not a bound parameter); it is always a server-sourced number, never user input.
 * Identifiers are bracket-quoted. Returns the ordered column list + changed rows.
 */
async function readChangedRows(
  server: string, database: string, schema: string, table: string, sinceVersion: number, pkCols: string[],
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const pkJoin = pkCols.map((c) => `T.${bracket(c)} = CT.${bracket(c)}`).join(' AND ');
  const sql =
    `SELECT T.*, CT.SYS_CHANGE_OPERATION AS SYS_CHANGE_OPERATION ` +
    `FROM ${bracket(schema)}.${bracket(table)} AS T ` +
    `RIGHT OUTER JOIN CHANGETABLE(CHANGES ${bracket(schema)}.${bracket(table)}, ${BigInt(sinceVersion).toString()}) AS CT ` +
    `ON ${pkJoin}`;
  const recordset = await executeParameterized<Record<string, unknown>>(server, database, sql);
  const cols = recordset.length ? Object.keys(recordset[0]) : ['SYS_CHANGE_OPERATION'];
  return { columns: cols, rows: recordset };
}

/**
 * SQL-family incremental path: read changes since the saved watermark, append a
 * delta CSV, and stamp the result with the new watermark. Throws on any failure
 * so the caller (snapshotTable) can fall back to a full snapshot with a note.
 */
async function snapshotTableIncremental(
  src: MirrorSource, t: MirrorTableSpec, basePath: string, sinceVersion: number, pkCols: string[], lastSync: string,
): Promise<MirrorTableResult> {
  const { columns, rows } = await readChangedRows(src.server, src.database, t.schema, t.table, sinceVersion, pkCols);
  const result = await writeDeltaCsv(basePath, t.schema, t.table, columns, rows, lastSync);
  // Capture the new watermark for the next run (last committed version).
  const after = await changeTrackingStatus(src.server, src.database, t.schema, t.table);
  result.syncVersion = after ? after.current : sinceVersion;
  return result;
}

/** Snapshot one source table/container → CSV in Bronze, dispatched by source family. */
async function snapshotTable(
  src: MirrorSource, t: MirrorTableSpec, basePath: string, savedSyncVersion?: number,
): Promise<MirrorTableResult> {
  const lastSync = new Date().toISOString();
  try {
    if (MIRROR_PG_FAMILY.has(src.sourceType)) {
      // PostgreSQL — read via the pg wire protocol (Entra token). schema.table
      // identifiers are double-quoted; no value is interpolated.
      const sql = `SELECT * FROM ${pgQuote(t.schema)}.${pgQuote(t.table)} LIMIT ${MAX_ROWS + 1}`;
      const res = await executePostgresQuery(src.server, src.database, sql);
      const truncated = res.rows.length > MAX_ROWS;
      const sliced = truncated ? res.rows.slice(0, MAX_ROWS) : res.rows;
      const objs = sliced.map((row) => Object.fromEntries(res.columns.map((c, i) => [c, row[i]])));
      return await writeCsvSnapshot(basePath, t.schema, t.table, res.columns, objs, truncated, lastSync);
    }
    if (MIRROR_COSMOS_FAMILY.has(src.sourceType)) {
      // Cosmos DB — query the container (t.table = container; schema unused).
      // Flatten the union of top-level keys; nested objects/arrays → JSON string
      // (the same shape Fabric mirroring lands for Cosmos).
      const q = await queryItems(src.database, t.table, 'SELECT * FROM c', { maxItems: MAX_ROWS + 1, crossPartition: true });
      const docs = q.documents || [];
      const truncated = docs.length > MAX_ROWS;
      const rows = truncated ? docs.slice(0, MAX_ROWS) : docs;
      const colSet = new Set<string>();
      for (const d of rows) for (const k of Object.keys(d)) if (!k.startsWith('_')) colSet.add(k);
      const columns = Array.from(colSet);
      return await writeCsvSnapshot(basePath, 'cosmos', t.table, columns, rows, truncated, lastSync);
    }
    // SQL family (default) — read via TDS. Identifiers bracket-quoted.
    // Incremental path: only when this table has a saved watermark from a prior
    // run (the first Start is always a full snapshot). Any failure or unmet
    // precondition falls through to a full snapshot with an honest `note`.
    let fallbackNote: string | undefined;
    if (savedSyncVersion !== undefined && savedSyncVersion !== null) {
      try {
        const ct = await changeTrackingStatus(src.server, src.database, t.schema, t.table);
        if (!ct) {
          // CT not enabled at the DB level — try to turn it on for next run, then
          // full-snapshot now (it can't read deltas the very run it's enabled).
          try {
            await enableChangeTracking(src.server, src.database, t.schema, t.table);
            fallbackNote = 'Change tracking enabled this run; the next Start will sync incrementally.';
          } catch (ce: any) {
            fallbackNote =
              'Change tracking could not be enabled — falling back to full snapshot. ' +
              'Grant db_owner to the console identity to unlock incremental sync. ' +
              `(${ce?.message || String(ce)})`;
          }
        } else if (ct.minValid !== null && savedSyncVersion < ct.minValid) {
          fallbackNote = `Saved watermark (v${savedSyncVersion}) aged out of the change-tracking retention window (min valid v${ct.minValid}) or the table was truncated — full re-snapshot.`;
        } else {
          const pkCols = await getPrimaryKeyColumns(src.server, src.database, t.schema, t.table);
          if (!pkCols.length) {
            fallbackNote = 'Table has no primary key; incremental sync via CHANGETABLE is unavailable — full snapshot.';
          } else {
            return await snapshotTableIncremental(src, t, basePath, savedSyncVersion, pkCols, lastSync);
          }
        }
      } catch (ie: any) {
        fallbackNote = `Incremental sync failed (${ie?.message || String(ie)}); fell back to full snapshot.`;
      }
    }

    const sql = `SELECT TOP ${MAX_ROWS + 1} * FROM ${bracket(t.schema)}.${bracket(t.table)}`;
    const recordset = await executeParameterized<Record<string, unknown>>(src.server, src.database, sql);
    const truncated = recordset.length > MAX_ROWS;
    const rows = truncated ? recordset.slice(0, MAX_ROWS) : recordset;
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const result = await writeCsvSnapshot(basePath, t.schema, t.table, cols, rows, truncated, lastSync);
    result.mode = 'snapshot';
    if (fallbackNote) result.note = fallbackNote;
    // Stamp the watermark so the NEXT Start can read only changes since this run.
    // Only meaningful once CT is enabled for the table; null otherwise.
    try {
      const ctNow = await changeTrackingStatus(src.server, src.database, t.schema, t.table);
      if (ctNow) result.syncVersion = ctNow.current;
    } catch { /* CT probe is best-effort; absence simply means next run re-snapshots */ }
    return result;
  } catch (e: any) {
    return { schema: t.schema, table: t.table, status: 'error', rows: 0, bytes: 0, truncated: false, lastSync, error: e?.message || String(e) };
  }
}

/**
 * Run an Azure-native mirror Start: change feed + snapshot of the source's
 * tables into Bronze. Returns real per-table metrics for the editor's grid.
 */
export async function runMirrorSnapshot(
  mirrorId: string, workspaceId: string, src: MirrorSource, prevTableStatus?: MirrorTableResult[],
): Promise<MirrorRunResult> {
  const isSqlFamily = MIRROR_SQL_FAMILY.has(src.sourceType);
  // Per-table saved watermark from the prior run (SQL family only). The first
  // Start has no prior status → undefined → full snapshot.
  const prevByKey: Record<string, MirrorTableResult> = {};
  if (isSqlFamily) {
    for (const p of prevTableStatus || []) {
      if (p && p.schema != null && p.table != null) prevByKey[`${p.schema}.${p.table}`] = p;
    }
  }
  const isPg = MIRROR_PG_FAMILY.has(src.sourceType);
  const isCosmos = MIRROR_COSMOS_FAMILY.has(src.sourceType);
  const note =
    'Azure-native mirror (no Microsoft Fabric): each table/container is snapshotted to ADLS Bronze ' +
    'as CSV' + (isPg || isCosmos ? '' : ' and the source change feed is enabled (CDC)') +
    '. Query it from Synapse Serverless SQL, a Loom notebook, or attach it to a lakehouse via Weave.';

  if (!engineCanSnapshot(src.sourceType)) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', tables: [],
      gate: {
        missing: `${src.sourceType} copy runtime`,
        message:
          `${src.sourceType || 'This source'} authenticates with its own runtime — its Azure-native copy ` +
          '(ADF / Synapse Link) is a disclosed follow-up. Azure SQL DB/MI, SQL Server, PostgreSQL, and ' +
          'Cosmos DB replicate now via this engine.',
      },
      note,
    };
  }
  if (!src.server || !src.database) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', tables: [],
      gate: { missing: 'source server + database', message: 'This mirror has no source server/database set. Edit the mirror to choose its source and connection, then Start.' },
      note,
    };
  }
  // Source-reachability gate per family.
  if (isPg) {
    const pg = postgresQueryGate();
    if (pg) return { ok: false, status: 'Gated', backend: 'azure-native-cdc', tables: [], gate: { missing: pg.missing, message: pg.detail }, note };
  } else if (!isCosmos) {
    const sg = sqlConfigGate(src.server);
    if (sg) return { ok: false, status: 'Gated', backend: 'azure-native-cdc', tables: [], gate: { missing: sg.missing, message: `Source SQL not reachable: ${sg.missing}` }, note };
  }
  if (!bronzeConfigured()) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', tables: [],
      gate: { missing: 'LOOM_BRONZE_URL', message: 'The ADLS Bronze landing zone is not configured — set LOOM_BRONZE_URL (DLZ Bicep output) so mirrored data has somewhere to land.' },
      note,
    };
  }

  // 1) Enable the source change feed — SQL family only (real DDL; best-effort).
  //    PG (logical replication) + Cosmos (native change feed) ongoing-CDC is a
  //    disclosed follow-up; the snapshot below is the shipped path for them.
  let changeFeed: MirroringConfig | undefined;
  if (!isPg && !isCosmos) {
    try { changeFeed = await enableMirroring(src.server, src.database); }
    catch (e: any) { changeFeed = { enabled: false, backend: 'azure-native-cdc', state: 'Error', lastError: e?.message || String(e) }; }
  }

  // 2) Resolve the table/container set (explicit subset, else enumerate).
  let tableSpecs: MirrorTableSpec[];
  if (src.tables && src.tables.length) {
    tableSpecs = src.tables;
  } else {
    try {
      if (isPg) {
        tableSpecs = (await listPostgresTables(src.server, src.database)).slice(0, MAX_TABLES);
      } else if (isCosmos) {
        const conts = await listContainers(src.database);
        tableSpecs = conts.slice(0, MAX_TABLES).map((c: any) => ({ schema: 'cosmos', table: c.name || c.id }));
      } else {
        const all = await listTables(src.server, src.database);
        tableSpecs = all.slice(0, MAX_TABLES).map((t) => ({ schema: t.schema, table: t.name }));
      }
    } catch (e: any) {
      return { ok: false, status: 'Error', backend: 'azure-native-cdc', changeFeed, tables: [], note, error: `Could not enumerate source tables: ${e?.message || String(e)}` };
    }
  }
  if (!tableSpecs.length) {
    return { ok: false, status: 'Error', backend: 'azure-native-cdc', changeFeed, tables: [], note, error: 'No tables found on the source to mirror.' };
  }

  // 3) Snapshot each table → Bronze CSV (sequential to bound source load).
  const basePath = `mirrors/${workspaceId}/${mirrorId}`;
  const results: MirrorTableResult[] = [];
  for (const t of tableSpecs) {
    const saved = isSqlFamily ? prevByKey[`${t.schema}.${t.table}`]?.syncVersion : undefined;
    results.push(await snapshotTable(src, t, basePath, saved));
  }

  const anyOk = results.some((r) => r.status === 'replicated');
  return {
    ok: anyOk,
    status: anyOk ? 'Running' : 'Error',
    backend: 'azure-native-cdc',
    changeFeed,
    tables: results,
    basePath: pathToHttpsUrl(BRONZE, `${basePath}/`),
    note,
    error: anyOk ? undefined : 'No tables could be replicated — see per-table errors.',
  };
}
