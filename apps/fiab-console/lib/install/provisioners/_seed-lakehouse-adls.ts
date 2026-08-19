/**
 * Shared lakehouse-materialization helper — turn a `LakehouseContent` bundle
 * into a real ADLS Gen2 folder tree with seeded Delta-table CSVs.
 *
 * Lifted out of `lakehouse.ts` (`provisionAzureNative`'s folder + delta-table
 * loops, plus the DDL/CSV helpers they depend on) so the INSTALL path and the
 * OPEN-time auto-bind path (`lib/azure/auto-bind-seed.seedLakehouseFromContent`)
 * materialize a lakehouse the same way. Before #3549 only install did it:
 * `auto-bind-providers.lakehouseAutoBind.create()` made the ROOT DIRECTORY and
 * stopped, so a config-gated install left a real-but-empty lakehouse whose
 * declared folders and seeded tables were nowhere on disk.
 *
 * The optional Synapse serverless OPENROWSET view layer is NOT here: it needs a
 * serverless user database, the installer itself treats it as skippable, and it
 * is a queryability convenience rather than the lakehouse. `onTableSeeded` lets
 * the installer keep registering those views without this module knowing about
 * Synapse at all.
 */
import {
  createDirectory as adlsCreateDirectory,
  uploadFile as adlsUploadFile,
  type KnownContainer,
} from '@/lib/azure/adls-client';
import { safeAdlsRelPath } from '@/lib/azure/backing-name';

/**
 * Extract column names from a `CREATE TABLE name ( col TYPE, … )` DDL.
 *
 * Splits the column list on top-level commas (commas inside type parens such
 * as DECIMAL(18,2) or a CHECK (... BETWEEN x AND y) are NOT column separators)
 * and skips table-level constraint clauses (CONSTRAINT/PRIMARY/FOREIGN/UNIQUE/
 * CHECK) so they don't leak in as phantom columns and misalign the seed CSV.
 */
export function columnsFromDdl(ddl: string): string[] {
  const open = ddl.indexOf('(');
  const close = ddl.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inner = ddl.slice(open + 1, close);

  // Split on commas that are at paren-depth 0 only.
  const segments: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      segments.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segments.push(cur);

  const CONSTRAINT_KEYWORDS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY']);
  return segments
    .map((seg) => seg.trim().split(/\s+/)[0])
    .filter((c) => c && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) && !CONSTRAINT_KEYWORDS.has(c.toUpperCase()));
}

/** CSV-escape a single value (RFC-4180-ish: quote if it has comma/quote/newline). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build CSV text (header + rows) from column names and array-of-array rows. */
export function buildCsv(columns: string[], rows: any[][]): string {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((_, i) => csvCell(r[i])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

/** What the materialization achieved. The caller decides what is fatal. */
export interface LakehouseSeedResult {
  /** Bundle folder paths created under the root. */
  createdFolders: string[];
  /** Tables whose sample rows were written as a seed CSV. */
  seeded: string[];
  /** Table folders created with no rows (no sampleRows, or no derivable columns). */
  emptyTables: string[];
  /**
   * Set when a 401/403 aborted the work. The caller maps it to its own
   * remediation shape — no amount of retrying fixes a missing role.
   */
  authGate?: { status: number; message: string };
}

/** One seeded table, handed to `onTableSeeded` so the caller can register a view. */
export interface SeededTable {
  /** Sanitized table name (the directory leaf). */
  name: string;
  /** Schema the table belongs to when `schemasEnabled`, else ''. */
  schema: string;
  /** Container-relative path of the seed CSV. */
  csvPath: string;
  /** Column names parsed from the table DDL. */
  columns: string[];
  /** Rows written. */
  rowCount: number;
}

/**
 * Materialize a `LakehouseContent` bundle under `root` in `container`.
 *
 * The root directory itself is assumed to exist (both callers create it before
 * getting here — install as its first ADLS write, auto-bind as its `create()`).
 * Per-folder / per-table failures are logged into `steps` and counted rather
 * than thrown, so one bad table cannot sink a lakehouse; a 401/403 short-
 * circuits into `authGate` because every subsequent write would fail the same
 * way.
 */
export async function seedLakehouseAdls(
  container: KnownContainer,
  root: string,
  content: any,
  steps: string[],
  onTableSeeded?: (t: SeededTable) => Promise<void>,
): Promise<LakehouseSeedResult> {
  const out: LakehouseSeedResult = { createdFolders: [], seeded: [], emptyTables: [] };

  const folders: Array<{ path: string; description?: string }> = Array.isArray(content?.folders)
    ? content.folders
    : [];
  const deltaTables: Array<{ name: string; ddl?: string; schema?: string; sampleRows?: any[][] }> =
    Array.isArray(content?.deltaTables) ? content.deltaTables : [];
  // F9 — multi-schema support. When schemasEnabled, tables live under
  // Tables/<schema>/<table>/ and register as `<schema>.<view>`; otherwise the
  // classic flat Tables/<table>/ layout is used.
  const schemasEnabled: boolean = content?.schemasEnabled === true;

  const authOf = (e: any): { status: number; message: string } | null =>
    e?.statusCode === 401 || e?.statusCode === 403
      ? { status: e.statusCode, message: e?.message || String(e) }
      : null;

  // 1. Every declared folder as a real directory.
  for (const f of folders) {
    const rel = safeAdlsRelPath(f?.path || '');
    if (!rel) continue;
    const dir = `${root}/${rel}`;
    try {
      await adlsCreateDirectory(container, dir);
      out.createdFolders.push(rel);
      steps.push(`Created folder ${container}/${dir}.`);
    } catch (e: any) {
      const auth = authOf(e);
      if (auth) { out.authGate = auth; return out; }
      steps.push(`Folder ${rel}: create failed ${e?.statusCode || ''} ${e?.message || String(e)}`);
    }
  }

  // 2. Seed each deltaTable's sampleRows as a real CSV under Tables/<name>/.
  //    The table folder is created even when there are no sampleRows so the
  //    Tables/ tree is browsable; columns come from the DDL (array-of-array
  //    sampleRows are aligned to those columns).
  for (const t of deltaTables) {
    const tName = safeAdlsRelPath(t?.name || '');
    if (!tName) continue;
    const tSchema = schemasEnabled ? (String(t.schema || 'dbo').replace(/[^A-Za-z0-9_]/g, '_') || 'dbo') : '';
    const tableDir = schemasEnabled ? `${root}/Tables/${tSchema}/${tName}` : `${root}/Tables/${tName}`;
    try {
      await adlsCreateDirectory(container, tableDir);
    } catch (e: any) {
      const auth = authOf(e);
      if (auth) { out.authGate = auth; return out; }
      steps.push(`Table ${tName}: directory create failed ${e?.message || String(e)}`);
      continue;
    }

    const rows = Array.isArray(t.sampleRows) ? t.sampleRows : [];
    if (rows.length === 0) {
      out.emptyTables.push(tName);
      steps.push(`Table ${tName}: no sampleRows in bundle; created empty Tables/${tName}/.`);
      continue;
    }
    const columns = t.ddl ? columnsFromDdl(t.ddl) : [];
    if (columns.length === 0) {
      steps.push(`Table ${tName}: could not derive columns from DDL; created empty Tables/${tName}/.`);
      out.emptyTables.push(tName);
      continue;
    }

    const csv = buildCsv(columns, rows);
    const csvPath = `${tableDir}/${tName}.csv`;
    try {
      await adlsUploadFile(container, csvPath, Buffer.from(csv, 'utf-8'), 'text/csv');
      out.seeded.push(tName);
      steps.push(`Table ${tName}: wrote ${rows.length}-row seed CSV to ${container}/${csvPath}.`);
    } catch (e: any) {
      const auth = authOf(e);
      if (auth) { out.authGate = auth; return out; }
      steps.push(`Table ${tName}: seed CSV write failed ${e?.statusCode || ''} ${e?.message || String(e)}`);
      continue;
    }

    if (onTableSeeded) {
      // Best-effort: the view layer is a convenience over a file that is
      // already real, so its failure must never unwind a successful seed.
      try {
        await onTableSeeded({ name: tName, schema: tSchema, csvPath, columns, rowCount: rows.length });
      } catch (e: any) {
        steps.push(`Table ${tName}: post-seed hook failed: ${e?.message || String(e)}`);
      }
    }
  }

  return out;
}
