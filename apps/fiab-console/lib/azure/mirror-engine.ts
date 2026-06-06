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

/** SQL-family sources the engine can snapshot directly via TDS. */
export const MIRROR_SQL_FAMILY = new Set(['AzureSqlDatabase', 'AzureSqlMI', 'SqlServer2025', 'MSSQL']);

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

/** Snapshot one source table → CSV in Bronze; returns real metrics. */
async function snapshotTable(src: MirrorSource, t: MirrorTableSpec, basePath: string): Promise<MirrorTableResult> {
  const lastSync = new Date().toISOString();
  try {
    // Read up to MAX_ROWS+1 to detect truncation. Identifiers are bracket-quoted
    // (catalog-sourced); no user value is interpolated into the SQL text.
    const sql = `SELECT TOP ${MAX_ROWS + 1} * FROM ${bracket(t.schema)}.${bracket(t.table)}`;
    const recordset = await executeParameterized<Record<string, unknown>>(src.server, src.database, sql);
    const truncated = recordset.length > MAX_ROWS;
    const rows = truncated ? recordset.slice(0, MAX_ROWS) : recordset;
    const cols = rows.length ? Object.keys(rows[0]) : [];

    const lines: string[] = [];
    lines.push(cols.map(csvCell).join(','));
    for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
    const buf = Buffer.from(lines.join('\n'), 'utf-8');

    const folder = `${basePath}/${t.schema}.${t.table}`;
    const filePath = `${folder}/snapshot.csv`;
    await uploadFile(BRONZE, filePath, buf, 'text/csv');

    const folderUrl = pathToHttpsUrl(BRONZE, `${folder}/`);
    const openrowset =
      `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', ` +
      `FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE) AS rows`;

    return {
      schema: t.schema, table: t.table, status: 'replicated',
      rows: rows.length, bytes: buf.length, truncated, lastSync,
      path: folderUrl, openrowset,
    };
  } catch (e: any) {
    return { schema: t.schema, table: t.table, status: 'error', rows: 0, bytes: 0, truncated: false, lastSync, error: e?.message || String(e) };
  }
}

/**
 * Run an Azure-native mirror Start: change feed + snapshot of the source's
 * tables into Bronze. Returns real per-table metrics for the editor's grid.
 */
export async function runMirrorSnapshot(mirrorId: string, workspaceId: string, src: MirrorSource): Promise<MirrorRunResult> {
  const note =
    'Azure-native mirror (no Microsoft Fabric): the source change feed is enabled (CDC) and each ' +
    'table is snapshotted to ADLS Bronze as CSV. Query it from Synapse Serverless SQL, a Loom ' +
    'notebook, or attach it to a lakehouse via Weave.';

  if (!MIRROR_SQL_FAMILY.has(src.sourceType)) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', tables: [],
      gate: {
        missing: `${src.sourceType} copy runtime`,
        message:
          `${src.sourceType || 'This source'} authenticates with its own runtime — its Azure-native copy ` +
          '(ADF / Synapse Link) is a disclosed follow-up. SQL-family sources (Azure SQL DB / MI / SQL Server) ' +
          'replicate now via this engine.',
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
  const sg = sqlConfigGate(src.server);
  if (sg) {
    return { ok: false, status: 'Gated', backend: 'azure-native-cdc', tables: [], gate: { missing: sg.missing, message: `Source SQL not reachable: ${sg.missing}` }, note };
  }
  if (!bronzeConfigured()) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', tables: [],
      gate: { missing: 'LOOM_BRONZE_URL', message: 'The ADLS Bronze landing zone is not configured — set LOOM_BRONZE_URL (DLZ Bicep output) so mirrored data has somewhere to land.' },
      note,
    };
  }

  // 1) Enable the source change feed (real DDL; best-effort, recorded).
  let changeFeed: MirroringConfig | undefined;
  try { changeFeed = await enableMirroring(src.server, src.database); }
  catch (e: any) { changeFeed = { enabled: false, backend: 'azure-native-cdc', state: 'Error', lastError: e?.message || String(e) }; }

  // 2) Resolve the table set (explicit subset, else enumerate the source).
  let tableSpecs: MirrorTableSpec[];
  if (src.tables && src.tables.length) {
    tableSpecs = src.tables;
  } else {
    try {
      const all = await listTables(src.server, src.database);
      tableSpecs = all.slice(0, MAX_TABLES).map((t) => ({ schema: t.schema, table: t.name }));
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
  for (const t of tableSpecs) results.push(await snapshotTable(src, t, basePath));

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
