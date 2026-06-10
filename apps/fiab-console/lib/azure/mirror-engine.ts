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
import { uploadFile, pathToHttpsUrl, getAccountName, listPaths, resolveAbfssRoot, type PathEntry } from './adls-client';
import { submitSparkBatchJob, type SparkBatchRequest } from './synapse-dev-client';
import { listPipelineRuns, adfConfigGate } from './adf-client';
import { executePostgresQuery, listPostgresTables, postgresQueryGate } from './postgres-flex-client';
import { queryItems } from './cosmos-data-client';
import { listContainers } from './cosmos-account-client';
import {
  upsertAdfCdc, startAdfCdc, adfCdcConfigGate,
  type AdfCdcSpec, type MapperConnection, type MapperTable,
} from './adf-client';
import { dfsSuffix } from './cloud-endpoints';
// httpsToAbfss lives in cloud-endpoints (pure, sovereign-aware) so it is unit-
// testable without this module's mssql/identity native chain; re-exported here
// for the existing `@/lib/azure/mirror-engine` consumers (Thread edges).
export { httpsToAbfss } from './cloud-endpoints';

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
  /**
   * Snowflake-only (Fabric Build 2026 parity): also enumerate + replicate
   * Snowflake-managed Apache Iceberg tables, not just standard tables. Ignored
   * for non-Snowflake sources.
   */
  includeIcebergTables?: boolean;
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
  /**
   * Which Azure-native engine ran:
   *   - `csv-snapshot` — the built-in TDS/PG/Cosmos read → CSV-in-Bronze engine
   *     (the default, no extra infra).
   *   - `adf-cdc`      — an Azure Data Factory ChangeDataCapture resource doing an
   *     initial full load + continuous CDC → Delta-in-Bronze (opt-in: needs
   *     LOOM_ADF_NAME + the two linked-service env vars). The canonical no-Fabric
   *     mirrored-database backend per no-fabric-dependency.md.
   */
  engine?: 'csv-snapshot' | 'adf-cdc';
  /** ADF CDC resource name (the run-id receipt) when engine === 'adf-cdc'. */
  cdcName?: string;
  changeFeed?: MirroringConfig;
  tables: MirrorTableResult[];
  /** Bronze landing root for the whole mirror (folder of folders). */
  basePath?: string;
  note: string;
  error?: string;
  gate?: { missing: string; message: string };
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
 * the user table on the PK so updated/inserted rows carry full column data. The
 * delta CSV deliberately carries **only the user table's columns** (`T.*`) and NOT
 * `CT.SYS_CHANGE_OPERATION`: the snapshot and every delta land in the same Bronze
 * folder and are read together by one folder-scoped OPENROWSET(BULK '<folder>/',
 * HEADER_ROW=TRUE), so all files must share an identical header — an extra
 * change-op column would misalign columns across files and break the "one logical
 * table" query. Deleted rows (SYS_CHANGE_OPERATION='D') are therefore filtered out
 * here (they would otherwise be all-NULL non-PK columns); delete propagation is a
 * disclosed follow-up. `sinceVersion` is embedded as a bigint literal (CHANGETABLE's
 * second argument must be a scalar/constant, not a bound parameter); it is always a
 * server-sourced number, never user input. Identifiers are bracket-quoted. Returns
 * the ordered column list (matching the snapshot header) + changed rows.
 */
async function readChangedRows(
  server: string, database: string, schema: string, table: string, sinceVersion: number, pkCols: string[],
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const pkJoin = pkCols.map((c) => `T.${bracket(c)} = CT.${bracket(c)}`).join(' AND ');
  const sql =
    `SELECT T.* ` +
    `FROM ${bracket(schema)}.${bracket(table)} AS T ` +
    `JOIN CHANGETABLE(CHANGES ${bracket(schema)}.${bracket(table)}, ${BigInt(sinceVersion).toString()}) AS CT ` +
    `ON ${pkJoin}`;
  const recordset = await executeParameterized<Record<string, unknown>>(server, database, sql);
  const cols = recordset.length ? Object.keys(recordset[0]) : [];
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
  // Capture the new watermark for the next run (last committed version).
  const after = await changeTrackingStatus(src.server, src.database, t.schema, t.table);
  const newVersion = after ? after.current : sinceVersion;
  // No changes since the last watermark — don't write an empty/headerless delta
  // CSV into the folder-scoped read (it would have no columns to align). Just
  // advance the watermark and report a clean zero-row incremental run.
  if (!rows.length) {
    const folderUrl = pathToHttpsUrl(BRONZE, `${basePath}/${t.schema}.${t.table}/`);
    const openrowset =
      `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', ` +
      `FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE) AS rows`;
    return { schema: t.schema, table: t.table, status: 'replicated', mode: 'incremental', rows: 0, bytes: 0, truncated: false, lastSync, path: folderUrl, openrowset, syncVersion: newVersion, note: 'No changes since the last sync.' };
  }
  const result = await writeDeltaCsv(basePath, t.schema, t.table, columns, rows, lastSync);
  result.syncVersion = newVersion;
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
    // Change Tracking must be ON for the table to produce a watermark; on the very
    // first Start (no saved watermark) it isn't yet, so enable it here — otherwise
    // CHANGE_TRACKING_CURRENT_VERSION() returns NULL forever and the engine loops
    // on full snapshots and never reaches the incremental path.
    try {
      let ctNow = await changeTrackingStatus(src.server, src.database, t.schema, t.table);
      if (!ctNow) {
        try {
          await enableChangeTracking(src.server, src.database, t.schema, t.table);
          ctNow = await changeTrackingStatus(src.server, src.database, t.schema, t.table);
          if (ctNow && !fallbackNote) result.note = 'Change tracking enabled this run; the next Start will sync incrementally.';
        } catch (ce: any) {
          if (!fallbackNote) result.note =
            'Change tracking could not be enabled — the next Start will re-snapshot. ' +
            'Grant db_owner to the console identity to unlock incremental sync. ' +
            `(${ce?.message || String(ce)})`;
        }
      }
      if (ctNow) result.syncVersion = ctNow.current;
    } catch { /* CT probe is best-effort; absence simply means next run re-snapshots */ }
    return result;
  } catch (e: any) {
    return { schema: t.schema, table: t.table, status: 'error', rows: 0, bytes: 0, truncated: false, lastSync, error: e?.message || String(e) };
  }
}

// ============================================================
// ADF Change Data Capture path (opt-in) — the canonical no-Fabric backend:
// ADF CDC resource → ADLS Bronze **Delta**. Selected when LOOM_ADF_NAME and the
// two linked-service env vars are set (and the source is a relational family ADF
// can capture). Otherwise the built-in CSV snapshot engine below runs — both are
// Azure-native; neither needs Microsoft Fabric.
// ============================================================

/** The pre-existing ADF source linked service to bind, or null when unset. */
function mirrorSourceLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_SOURCE_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}
/** The pre-existing ADF AzureBlobFS (ADLS) linked service to bind, or null. */
function mirrorAdlsLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}

/** Is the opt-in ADF CDC path fully configured (factory + both linked services)? */
function adfCdcConfigured(): boolean {
  return !!process.env.LOOM_ADF_NAME
    && !adfCdcConfigGate()
    && !!mirrorSourceLinkedService()
    && !!mirrorAdlsLinkedService();
}

/** Loom source type → the ADF CDC mapper connector type for the source connection. */
function adfSourceConnectorType(sourceType: string): string {
  if (sourceType === 'AzureSqlDatabase') return 'AzureSqlDatabase';
  if (sourceType === 'AzureSqlMI') return 'AzureSqlMI';
  if (sourceType === 'AzurePostgreSql') return 'AzurePostgreSql';
  return 'SqlServer'; // SqlServer2025 / MSSQL
}

/** ADF resource names allow [A-Za-z0-9_]; derive a stable, safe CDC name. */
function adfCdcName(mirrorId: string): string {
  const safe = (mirrorId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'mirror';
  return `loom_mirror_${safe}`;
}

/**
 * Provision + start an ADF ChangeDataCapture resource that does an initial full
 * load followed by continuous CDC from the relational source into ADLS Bronze in
 * **Delta** format. Returns a MirrorRunResult carrying the CDC resource name (the
 * ADF run-id receipt) and per-table Delta landing paths. The two linked services
 * (relational source + AzureBlobFS) are pre-existing ADF linked services bound by
 * env var. Real ARM calls (upsertAdfCdc + startAdfCdc); failures surface verbatim.
 */
export async function runMirrorAdfCdc(
  mirrorId: string, workspaceId: string, src: MirrorSource, tableSpecs: MirrorTableSpec[], note: string,
): Promise<MirrorRunResult> {
  const sourceLs = mirrorSourceLinkedService();
  const adlsLs = mirrorAdlsLinkedService();
  const adfGate = adfCdcConfigGate();
  if (adfGate || !sourceLs || !adlsLs) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', engine: 'adf-cdc', tables: [],
      gate: {
        missing: adfGate?.missing || 'LOOM_MIRROR_SOURCE_LINKED_SERVICE / LOOM_MIRROR_ADLS_LINKED_SERVICE',
        message:
          'ADF CDC mirroring needs the env-pinned factory plus two pre-existing ADF linked services: ' +
          'set LOOM_MIRROR_SOURCE_LINKED_SERVICE to the relational source linked service and ' +
          'LOOM_MIRROR_ADLS_LINKED_SERVICE to the AzureBlobFS linked service pointing at the DLZ ADLS account.',
      },
      note,
    };
  }
  if (!tableSpecs.length) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', engine: 'adf-cdc', tables: [],
      gate: { missing: 'tables', message: 'Select at least one source table to mirror, or load the source tables in the wizard.' },
      note,
    };
  }

  const cdcName = adfCdcName(mirrorId);
  const basePath = `mirrors/${workspaceId}/${mirrorId}`;
  const account = getAccountName();
  const abfssBase = `abfss://${BRONZE}@${account}.${dfsSuffix()}/${basePath}/`;
  const srcConnType = adfSourceConnectorType(src.sourceType);

  // Source entities — one per selected table, carrying the schema/table DSL props.
  const sourceEntities: MapperTable[] = tableSpecs.map((t) => ({
    name: `${t.schema}.${t.table}`,
    dslConnectorProperties: [
      { name: 'schemaName', value: t.schema },
      { name: 'tableName', value: t.table },
    ],
  }));
  // Target entities — one Delta folder per table under the per-mirror Bronze root.
  const targetEntities: MapperTable[] = tableSpecs.map((t) => ({
    name: `${t.schema}.${t.table}`,
    dslConnectorProperties: [
      { name: 'fileSystem', value: BRONZE },
      { name: 'folderPath', value: `${basePath}/${t.schema}.${t.table}` },
      { name: 'format', value: 'delta' },
    ],
  }));

  const sourceConn: MapperConnection = {
    linkedService: { referenceName: sourceLs, type: 'LinkedServiceReference' },
    linkedServiceType: srcConnType,
    type: 'linkedservicetype',
    isInlineDataset: false,
  };
  const targetConn: MapperConnection = {
    linkedService: { referenceName: adlsLs, type: 'LinkedServiceReference' },
    linkedServiceType: 'AzureBlobFS',
    type: 'linkedservicetype',
    isInlineDataset: false,
  };

  const spec: AdfCdcSpec = {
    description: `Loom mirrored database ${mirrorId} (${src.sourceType} → ADLS Bronze Delta)`,
    folder: { name: 'loom-mirrors' },
    policy: { mode: 'Continuous' },
    sourceConnectionsInfo: [{ sourceEntities, connection: sourceConn }],
    targetConnectionsInfo: [{ targetEntities, connection: targetConn }],
    allowVNetOverride: false,
  };

  const adfNote =
    'Azure-native mirror via ADF Change Data Capture (no Microsoft Fabric): an initial full load + ' +
    `continuous CDC lands each selected table as Delta in ADLS Bronze. ADF CDC resource: ${cdcName}. ` +
    `Bronze root: ${abfssBase}`;

  try {
    await upsertAdfCdc(cdcName, spec);
    await startAdfCdc(cdcName);
  } catch (e: any) {
    return {
      ok: false, status: 'Error', backend: 'azure-native-cdc', engine: 'adf-cdc', cdcName, tables: [],
      basePath: pathToHttpsUrl(BRONZE, `${basePath}/`), note: adfNote,
      error: `ADF CDC provisioning failed: ${e?.message || String(e)}`,
    };
  }

  const lastSync = new Date().toISOString();
  const tables: MirrorTableResult[] = tableSpecs.map((t) => {
    const folderUrl = pathToHttpsUrl(BRONZE, `${basePath}/${t.schema}.${t.table}/`);
    const openrowset = `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', FORMAT = 'DELTA') AS rows`;
    return {
      schema: t.schema, table: t.table, status: 'replicated', mode: 'snapshot',
      rows: 0, bytes: 0, truncated: false, lastSync, path: folderUrl, openrowset,
      note: 'ADF CDC: initial full load in progress, then continuous CDC. Row/byte metrics populate in the ADF monitor.',
    };
  });

  return {
    ok: true, status: 'Running', backend: 'azure-native-cdc', engine: 'adf-cdc', cdcName, tables,
    basePath: pathToHttpsUrl(BRONZE, `${basePath}/`), note: adfNote,
  };
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

  // Opt-in ADF CDC path (continuous CDC → ADLS Bronze **Delta**) — the canonical
  // no-Fabric mirrored-database backend per no-fabric-dependency.md. Selected when
  // LOOM_ADF_NAME + the two linked-service env vars are set and the source is a
  // relational family ADF can capture (SQL / PG). When unset, the built-in CSV
  // snapshot engine below runs instead — both are Azure-native, no Fabric.
  if ((isSqlFamily || isPg) && adfCdcConfigured()) {
    if (!bronzeConfigured()) {
      return {
        ok: false, status: 'Gated', backend: 'azure-native-cdc', engine: 'adf-cdc', tables: [],
        gate: { missing: 'LOOM_BRONZE_URL', message: 'The ADLS Bronze landing zone is not configured — set LOOM_BRONZE_URL (DLZ Bicep output) so mirrored Delta data has somewhere to land.' },
        note,
      };
    }
    // Resolve the table subset: the wizard's explicit selection, else enumerate
    // (best-effort). On enumeration failure the CDC helper gates asking the user
    // to select tables — no silent empty mirror.
    let adfTables: MirrorTableSpec[] = (src.tables && src.tables.length) ? src.tables : [];
    if (!adfTables.length) {
      try {
        adfTables = isPg
          ? (await listPostgresTables(src.server, src.database)).slice(0, MAX_TABLES)
          : (await listTables(src.server, src.database)).slice(0, MAX_TABLES).map((t) => ({ schema: t.schema, table: t.name }));
      } catch { /* leave empty → runMirrorAdfCdc gates asking to select tables */ }
    }
    return await runMirrorAdfCdc(mirrorId, workspaceId, src, adfTables, note);
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

// ============================================================
// Open mirroring (push model) — Azure-native, no Microsoft Fabric.
//
// Fabric's "open mirroring" lets an external producer push Parquet (+ an
// optional `_metadata.json` describing key columns) into a per-mirror landing
// zone; Fabric folds it into a managed Delta table the consumer queries.
//
// The Azure-native default reproduces this 1:1 with NO Fabric/OneLake:
//   - Landing zone  = ADLS Gen2 `landing` container, path `<mirrorId>/<table>/`
//   - Managed Delta = ADLS Gen2 `bronze` container, path
//                     `mirrors/<workspaceId>/<mirrorId>/Tables/<table>`
//   - Merge engine  = a Synapse Spark Livy batch (submitSparkBatchJob) that
//                     reads the new Parquet and MERGEs/append into the Delta
//                     table (Delta Lake `MERGE`/`append`).
//   - Query surface = Synapse Serverless `OPENROWSET(... FORMAT='DELTA')`.
//
// All host suffixes come from `resolveAbfssRoot` (derived from the configured
// LOOM_{LANDING,BRONZE}_URL), so the abfss URIs are sovereign-cloud-correct
// automatically — no hard-coded `.dfs.core.windows.net`.
// ============================================================

/** Merge schedule options — fixed allowlist, no free-form input (loom-no-freeform-config). */
export const MERGE_SCHEDULE_OPTIONS = ['on-demand', '15min', '1h', '4h', 'daily'] as const;
export type MergeSchedule = (typeof MERGE_SCHEDULE_OPTIONS)[number];

export interface OpenMirrorConfig {
  /** abfss:// landing zone root for this mirror's producer drops. */
  landingPath: string;
  /** abfss:// managed Delta output root (bronze container). */
  deltaBasePath: string;
  mergeSchedule: MergeSchedule;
  /** Key columns for MERGE semantics (UPSERT/DELETE). Empty = full append. */
  keyColumns: string[];
  lastMergeAt?: string;
  lastMergeJobId?: number;
  lastMergeStatus?: string;
  lastMergeRows?: number;
  lastMergeError?: string;
}

export interface OpenMirrorRunResult {
  ok: boolean;
  status: 'Submitted' | 'NoNewFiles' | 'Gated' | 'Error';
  jobId?: number;
  landingPath: string;
  deltaPath: string;
  filesFound: number;
  note: string;
  gate?: { missing: string; message: string };
  error?: string;
}

const LANDING = 'landing' as const;
/** Bronze path the inline PySpark merge script is uploaded to before each run. */
const OPEN_MIRROR_SCRIPT_PATH = 'scripts/open-mirror-merge.py';

/** abfss:// landing zone root for a mirror (sovereign-cloud suffix via the URL). */
export function openMirrorLandingAbfss(mirrorId: string): string | null {
  return resolveAbfssRoot(LANDING, mirrorId);
}

/** abfss:// managed Delta "Tables" root for a mirror. */
export function openMirrorDeltaAbfss(workspaceId: string, mirrorId: string): string | null {
  return resolveAbfssRoot(BRONZE, `mirrors/${workspaceId}/${mirrorId}/Tables`);
}

/** Synapse Serverless OPENROWSET SELECT COUNT(*) over a managed Delta table. */
export function openMirrorOpenrowset(workspaceId: string, mirrorId: string, tableName: string): string {
  const url = pathToHttpsUrl(BRONZE, `mirrors/${workspaceId}/${mirrorId}/Tables/${tableName}`);
  return `SELECT COUNT(*) AS row_count FROM OPENROWSET(BULK '${url}', FORMAT = 'DELTA') AS rows`;
}

/**
 * List Parquet files a producer dropped in the landing zone for one table,
 * optionally only those modified after `sinceIso`. `listPaths` returns the full
 * path (`<mirrorId>/<table>/<file>.parquet`) so the `.parquet` filter is exact.
 */
export async function listLandingFiles(
  mirrorId: string,
  tableName: string,
  sinceIso?: string,
): Promise<PathEntry[]> {
  const prefix = `${mirrorId}/${tableName}`;
  const entries = await listPaths(LANDING, prefix, 500);
  const parquets = entries.filter((e) => !e.isDirectory && e.name.toLowerCase().endsWith('.parquet'));
  if (!sinceIso) return parquets;
  const sinceMs = new Date(sinceIso).getTime();
  return parquets.filter((e) => (e.lastModified ? new Date(e.lastModified).getTime() > sinceMs : true));
}

/**
 * PySpark merge script — reads the new Parquet from the landing zone and folds
 * it into the managed Delta table. When `_metadata.json` declared key columns
 * AND the Parquet carries Fabric's `__rowMarker__` column, it does a Delta
 * MERGE (upsert + delete); otherwise it appends. Uploaded to Bronze at submit
 * time (idempotent — same bytes), then run as a Livy batch.
 */
const OPEN_MIRROR_MERGE_SCRIPT = `\
from pyspark.sql import SparkSession
from delta.tables import DeltaTable
import sys

landing_path = sys.argv[1]   # abfss://landing@<acct>/<mirrorId>/<table>
delta_path   = sys.argv[2]   # abfss://bronze@<acct>/mirrors/<wsId>/<mirrorId>/Tables/<table>
key_cols_raw = sys.argv[3]   # comma-separated, or empty string

spark = (SparkSession.builder
    .appName("loom-open-mirror-merge")
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
    .config("spark.sql.catalog.spark_catalog",
            "org.apache.spark.sql.delta.catalog.DeltaCatalog")
    .getOrCreate())

df = spark.read.parquet(landing_path)
row_count = df.count()
key_cols = [c.strip() for c in key_cols_raw.split(",") if c.strip()]

if "__rowMarker__" in df.columns and key_cols:
    merge_cond = " AND ".join("tgt.\`%s\` = src.\`%s\`" % (c, c) for c in key_cols)
    upsert_df = df.filter(df["__rowMarker__"].isin([0, 1, 4])).drop("__rowMarker__")
    delete_df = df.filter(df["__rowMarker__"] == 2).drop("__rowMarker__")
    if DeltaTable.isDeltaTable(spark, delta_path):
        dt = DeltaTable.forPath(spark, delta_path)
        if upsert_df.count() > 0:
            (dt.alias("tgt").merge(upsert_df.alias("src"), merge_cond)
               .whenMatchedUpdateAll().whenNotMatchedInsertAll().execute())
        if delete_df.count() > 0:
            (dt.alias("tgt").merge(delete_df.alias("src"), merge_cond)
               .whenMatchedDelete().execute())
    else:
        upsert_df.write.format("delta").mode("overwrite").save(delta_path)
else:
    df.write.format("delta").mode("append").save(delta_path)

print("LOOM_MERGE_RESULT: rows=%d delta=%s" % (row_count, delta_path))
`;

/** Synapse Spark pool that runs the merge job (same convention as other jobs). */
function openMirrorPool(): string {
  return (
    process.env.LOOM_OPEN_MIRROR_POOL ||
    process.env.LOOM_SYNAPSE_SPARK_POOL ||
    process.env.LOOM_SPARK_POOL ||
    'loompool'
  ).trim();
}

/** Honest infra gate for the open-mirror merge path. Null = ready. */
function openMirrorGate(): { missing: string; message: string } | null {
  if (!process.env.LOOM_LANDING_URL) {
    return {
      missing: 'LOOM_LANDING_URL',
      message:
        'ADLS landing container not configured — set LOOM_LANDING_URL (DLZ Bicep output landingContainerUrl) ' +
        'so producers have somewhere to drop Parquet.',
    };
  }
  if (!bronzeConfigured()) {
    return {
      missing: 'LOOM_BRONZE_URL',
      message: 'ADLS Bronze not configured — set LOOM_BRONZE_URL so the managed Delta table has a home.',
    };
  }
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return {
      missing: 'LOOM_SYNAPSE_WORKSPACE',
      message:
        'Synapse workspace not configured — set LOOM_SYNAPSE_WORKSPACE (and a Spark pool via LOOM_SPARK_POOL) ' +
        'so the Parquet→Delta merge job can be submitted.',
    };
  }
  return null;
}

/**
 * Upload the merge script (idempotent) and submit a Synapse Spark Livy batch
 * job that folds new Parquet from the landing zone into managed Delta.
 * Returns the Livy batch id (for the receipt) plus the resolved paths.
 */
export async function runOpenMirrorMerge(
  mirrorId: string,
  workspaceId: string,
  tableName: string,
  keyColumns: string[],
  sinceIso?: string,
): Promise<OpenMirrorRunResult> {
  const note =
    'Azure-native open mirroring (no Microsoft Fabric): Parquet files pushed to the ADLS landing zone are merged ' +
    'into a managed Delta table by a Synapse Spark Livy batch. Query it from Synapse Serverless SQL (FORMAT=\'DELTA\').';
  const landingRoot = openMirrorLandingAbfss(mirrorId);
  const deltaRoot = openMirrorDeltaAbfss(workspaceId, mirrorId);

  const gate = openMirrorGate();
  if (gate) {
    return { ok: false, status: 'Gated', landingPath: landingRoot ?? '', deltaPath: deltaRoot ?? '', filesFound: 0, note, gate };
  }
  if (!landingRoot || !deltaRoot) {
    return {
      ok: false, status: 'Gated', landingPath: landingRoot ?? '', deltaPath: deltaRoot ?? '', filesFound: 0, note,
      gate: { missing: 'abfss path', message: 'Could not resolve the landing/Delta abfss paths — check LOOM_LANDING_URL and LOOM_BRONZE_URL.' },
    };
  }

  const tableLandingPath = `${landingRoot}/${tableName}`;
  const tableDeltaPath = `${deltaRoot}/${tableName}`;

  // 1) Detect new Parquet drops for this table since the last merge.
  let files: PathEntry[];
  try {
    files = await listLandingFiles(mirrorId, tableName, sinceIso);
  } catch (e: any) {
    return { ok: false, status: 'Error', landingPath: landingRoot, deltaPath: deltaRoot, filesFound: 0, note, error: `Listing the landing zone failed: ${e?.message || String(e)}` };
  }
  if (!files.length) {
    return { ok: true, status: 'NoNewFiles', landingPath: landingRoot, deltaPath: deltaRoot, filesFound: 0, note: note + ' No new Parquet files found in the landing zone since the last merge.' };
  }

  // 2) Upload the merge script to Bronze (idempotent — same bytes each run).
  let scriptAbfss: string | null;
  try {
    await uploadFile(BRONZE, OPEN_MIRROR_SCRIPT_PATH, Buffer.from(OPEN_MIRROR_MERGE_SCRIPT, 'utf-8'), 'text/x-python');
    scriptAbfss = resolveAbfssRoot(BRONZE, OPEN_MIRROR_SCRIPT_PATH);
  } catch (e: any) {
    return { ok: false, status: 'Error', landingPath: landingRoot, deltaPath: deltaRoot, filesFound: files.length, note, error: `Uploading the merge script failed: ${e?.message || String(e)}` };
  }
  if (!scriptAbfss) {
    return { ok: false, status: 'Gated', landingPath: landingRoot, deltaPath: deltaRoot, filesFound: files.length, note, gate: { missing: 'LOOM_BRONZE_URL', message: 'Could not resolve the merge-script abfss path — check LOOM_BRONZE_URL.' } };
  }

  // 3) Submit the Synapse Spark Livy batch merge job.
  const job: SparkBatchRequest = {
    name: `loom-open-mirror-${mirrorId.slice(0, 8)}-${tableName}-${Date.now()}`,
    file: scriptAbfss,
    args: [tableLandingPath, tableDeltaPath, keyColumns.join(',')],
    conf: {
      'spark.sql.extensions': 'io.delta.sql.DeltaSparkSessionExtension',
      'spark.sql.catalog.spark_catalog': 'org.apache.spark.sql.delta.catalog.DeltaCatalog',
    },
    driverMemory: '4g', driverCores: 2,
    executorMemory: '4g', executorCores: 2, numExecutors: 2,
  };
  try {
    const batch = await submitSparkBatchJob(openMirrorPool(), job);
    return { ok: true, status: 'Submitted', jobId: batch.id, landingPath: landingRoot, deltaPath: deltaRoot, filesFound: files.length, note };
  } catch (e: any) {
    return { ok: false, status: 'Error', landingPath: landingRoot, deltaPath: deltaRoot, filesFound: files.length, note, error: `Submitting the Spark merge batch failed: ${e?.message || String(e)}` };
  }
}
/* ────────────────────────────────────────────────────────────────────────────
 * MONITOR + LIFECYCLE
 *
 * The Monitor tab needs a real-time, GET-able snapshot of per-table replication
 * status, true row counts, and last-sync timestamps, plus the provisioner-backed
 * ADF pipeline-run telemetry. Lifecycle (stop/start/restart) is implemented in
 * the BFF route, but the shared status assembly + the restart primitive live
 * here so the route and the editor agree on shapes.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A single per-table row for the Monitor grid. */
export interface MirrorTableMonitorRow {
  schema: string;
  table: string;
  status: 'Replicated' | 'Error' | 'NotStarted' | 'Syncing';
  /** Rows landed by the last engine run (Cosmos tablesStatus). */
  rows: number;
  bytes: number;
  lastSync: string | null;
  error?: string;
  mode?: 'snapshot' | 'incremental';
  note?: string;
  /** ADLS probe: CSV files in the table's Bronze landing folder. */
  landingFiles?: number;
  /** ADLS probe: total bytes of those landing files. */
  landingBytes?: number;
}

/** A best-effort summary of the most recent ADF Bronze-copy pipeline run. */
export interface AdfRunSummary {
  runId: string;
  pipelineName: string;
  status: string;
  runStart?: string;
  runEnd?: string;
  durationMs?: number;
}

/** The full payload returned by the Monitor route + lifecycle receipts. */
export interface MirrorMonitorPayload {
  mirroringStatus: string;
  tables: MirrorTableMonitorRow[];
  lastStateChange?: string | null;
  basePath?: string | null;
  /** ADF pipeline-run telemetry when the provisioner-backed pipeline is found. */
  adfLastRun?: AdfRunSummary;
  note?: string;
}

/**
 * ADF object name: letters/digits/_ only, first char a letter. Byte-for-byte
 * the same transform the provisioner's `adfName()` applies, so the derived
 * pipeline name matches the one `provisionAdfCdc()` created (`<name>_to_bronze`).
 */
function adfSafeName(s: string): string {
  let n = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 120);
  if (!/^[A-Za-z]/.test(n)) n = `t_${n}`;
  return n || 'loom_mirror';
}

/**
 * Assemble a monitor snapshot for a mirrored database:
 *   1. Project Cosmos `tablesStatus` → typed MirrorTableMonitorRow[] (primary,
 *      real per-table status + true row counts + real last-sync timestamps).
 *   2. Probe the ADLS Bronze landing folder per table → landingFiles +
 *      landingBytes (a real `_delta_log`-style file/byte probe of what is
 *      actually committed on storage).
 *   3. If ADF is configured, queryPipelineRuns the provisioner-backed
 *      `<name>_to_bronze` pipeline → adfLastRun (real ADF run-state telemetry).
 * All three sources are best-effort and degrade gracefully with disclosure —
 * no mocks, no fabricated values (no-vaporware).
 */
export async function getMirrorStatus(
  mirrorId: string,
  workspaceId: string,
  state: Record<string, any>,
  displayName: string,
): Promise<MirrorMonitorPayload> {
  const mirroringStatus = String(state.mirroringStatus || 'NotStarted');
  const storedTables: any[] = Array.isArray(state.tablesStatus) ? state.tablesStatus : [];
  const lastStateChange = state.lastStateChange || state.updatedAt || null;
  const basePath = state.lastRun?.basePath || null;

  // 1) Project Cosmos tablesStatus → typed rows.
  const tableRows: MirrorTableMonitorRow[] = storedTables.map((t) => ({
    schema: t.schema || '',
    table: t.table || '',
    status: t.status === 'replicated' ? 'Replicated' : t.status === 'error' ? 'Error' : 'NotStarted',
    rows: typeof t.rows === 'number' ? t.rows : 0,
    bytes: typeof t.bytes === 'number' ? t.bytes : 0,
    lastSync: t.lastSync || null,
    error: t.error,
    mode: t.mode,
    note: t.note,
  }));

  // 2) ADLS probe — list the landing folder per table to get committed file
  //    counts + byte sums. Best-effort: a failure simply omits the probe.
  const basePrefix = `mirrors/${workspaceId}/${mirrorId}`;
  if (bronzeConfigured()) {
    for (const row of tableRows) {
      try {
        const prefix = `${basePrefix}/${row.schema}.${row.table}`;
        const paths = await listPaths(BRONZE, prefix, 500);
        const files = paths.filter((p) => !p.isDirectory && p.name.endsWith('.csv'));
        row.landingFiles = files.length;
        row.landingBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
      } catch { /* probe failed — omit landingFiles/landingBytes for this table */ }
    }
  }

  // 3) ADF pipeline-run telemetry — derive the pipeline name from displayName
  //    (mirrors the provisioner). Only attempted when ADF is fully configured.
  let adfLastRun: AdfRunSummary | undefined;
  if (!adfConfigGate()) {
    const pipelineName = `${adfSafeName(displayName)}_to_bronze`;
    try {
      const runs = await listPipelineRuns(pipelineName, 7);
      const last = runs[0];
      if (last) {
        adfLastRun = {
          runId: last.runId,
          pipelineName: last.pipelineName,
          status: last.status || 'Unknown',
          runStart: last.runStart,
          runEnd: last.runEnd ?? undefined,
          durationMs: last.durationInMs,
        };
      }
    } catch { /* ADF telemetry unavailable — omit adfLastRun */ }
  }

  const note =
    'Per-table status, row counts, and last-sync are from the last direct-engine run (Cosmos). ' +
    'Landing file/byte counts are a live probe of what is committed in ADLS Bronze. ' +
    `ADF pipeline-run telemetry is shown when the provisioner-backed '${adfSafeName(displayName)}_to_bronze' ` +
    'pipeline is found in the factory (45-day native window).';

  return { mirroringStatus, tables: tableRows, lastStateChange, basePath, adfLastRun, note };
}

/**
 * Restart: clear all per-table Change-Tracking watermarks (empty
 * `prevTableStatus`) so every table is re-snapshotted from scratch on this run
 * — identical to a first Start, even for SQL-family tables that previously
 * synced incrementally. The source change feed is re-enabled by the snapshot
 * path. Disclosure: any prior incremental delta CSVs remain in the Bronze
 * folder; the fresh `snapshot.csv` is read together with them by the
 * folder-scoped OPENROWSET, so the re-snapshot supersedes stale rows on the
 * next query rather than physically deleting old files.
 */
export async function restartMirrorSnapshot(
  mirrorId: string, workspaceId: string, src: MirrorSource,
): Promise<MirrorRunResult> {
  return runMirrorSnapshot(mirrorId, workspaceId, src, /* prevTableStatus = */ []);
}
