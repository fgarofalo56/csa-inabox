/**
 * Synapse / ADLS Gen2 Delta catalog scanner.
 *
 * Discovers the REAL Delta (and ad-hoc Parquet) tables that live under the
 * `Tables/` directory of each lakehouse medallion container, the way the
 * Fabric Lakehouse explorer enumerates them — but Azure-native, with NO
 * dependency on a Fabric workspace.
 *
 * Why ADLS scan + `_delta_log` probe (not INFORMATION_SCHEMA):
 *   Synapse Serverless `INFORMATION_SCHEMA.TABLES` only surfaces tables that
 *   were synchronized into a Lake database via Spark `createTable`. Tables
 *   created by an ADLS upload, ADF copy, or Databricks job — but never
 *   registered — would be silently dropped, which is vaporware for the general
 *   lakehouse case. The directory scan + Delta-transaction-log read is the
 *   ground truth: every physical table directory is found, and Delta status /
 *   version come straight from `_delta_log/*.json`.
 *
 * Row counts are OPTIONAL (opts.rowCounts) and use Synapse Serverless
 * OPENROWSET `SELECT COUNT(*) ... FORMAT='DELTA'`. They return `null` — never a
 * fabricated 0 — when Serverless is offline / not provisioned, per no-vaporware.
 *
 * Auth: the Console UAMI must hold Storage Blob Data Reader on the lakehouse
 * container (granted by synapse-storage-rbac.bicep). Reader is sufficient — the
 * scan only lists paths and reads `_delta_log` entries; it never writes.
 */

import {
  KNOWN_CONTAINERS,
  getServiceClientFor,
  getAccountName,
  pathToHttpsUrl,
} from './adls-client';
import { executeQuery, serverlessTarget } from './synapse-sql-client';

export type TableFormat = 'delta' | 'parquet' | 'unknown';
export type TableStatus = 'ok' | 'empty' | 'broken';

export interface CatalogTable {
  /** Container the table lives in (used as the schema/layer node). */
  schema: string;
  /** Leaf directory name under `Tables/`. */
  name: string;
  /** `container/Tables/<name>` — the ADLS path of the table directory. */
  adlsPath: string;
  /** Full https BULK URL for an OPENROWSET FORMAT='DELTA' query. */
  bulkUrl: string;
  format: TableFormat;
  status: TableStatus;
  /** Latest Delta commit version (max `_delta_log/<n>.json`), or null. */
  latestVersion: number | null;
  /** OPENROWSET COUNT(*) when requested + Serverless reachable; else null. */
  rowCount: number | null;
  /** Sum of data-file bytes under the table dir (excludes `_delta_log`), or null. */
  sizeBytes: number | null;
  /** Most-recent data-file lastModified (ISO), or null. */
  lastModified: string | null;
}

export interface ScanOptions {
  /** Containers to scan; defaults to every container with a LOOM_*_URL set. */
  containers?: string[];
  /** Run a Serverless COUNT(*) per Delta table. Default false (slow / cold-start). */
  rowCounts?: boolean;
  /** Per-table COUNT(*) timeout. Default 30s. */
  rowCountTimeoutMs?: number;
  /** Max directory entries walked per table (size aggregation cap). Default 5000. */
  maxEntriesPerTable?: number;
}

function leaf(path: string): string {
  const trimmed = String(path).replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.substring(i + 1) : trimmed;
}

/** Which of the requested containers are actually configured + known. */
function resolveContainers(requested?: string[]): string[] {
  const known = KNOWN_CONTAINERS as readonly string[];
  if (requested && requested.length) {
    return requested.filter((c) => known.includes(c));
  }
  // Only scan containers whose URL env var is set (avoids 403/404 noise).
  return known.filter((c) => {
    const env = `LOOM_${c.toUpperCase()}_URL`;
    return !!process.env[env];
  });
}

interface TableProbe {
  format: TableFormat;
  status: TableStatus;
  latestVersion: number | null;
  sizeBytes: number;
  lastModified: string | null;
}

/**
 * Single recursive walk of one table directory. Derives Delta vs Parquet,
 * latest commit version, total data size, and last-modified in one pass.
 */
async function probeTable(container: string, tablePath: string, maxEntries: number): Promise<TableProbe> {
  const fs = getServiceClientFor(getAccountName()).getFileSystemClient(container);
  const iter = fs.listPaths({ path: tablePath, recursive: true });

  let hasDeltaLog = false;
  let commitMax: number | null = null;
  let dataBytes = 0;
  let hasParquetData = false;
  let lastModMs = 0;
  let seen = 0;

  for await (const p of iter) {
    if (++seen > maxEntries) break;
    if (p.isDirectory) continue;
    const name = p.name ?? '';
    const rel = name.startsWith(`${tablePath}/`) ? name.slice(tablePath.length + 1) : leaf(name);

    if (rel.startsWith('_delta_log/') || rel === '_delta_log') {
      hasDeltaLog = true;
      // Delta commit files: _delta_log/<zero-padded version>.json
      const m = rel.match(/_delta_log\/0*(\d+)\.json$/);
      if (m) {
        const v = Number(m[1]);
        if (commitMax === null || v > commitMax) commitMax = v;
      }
      continue; // log files are not counted as data
    }

    // Data file (parquet under the table root or partition subdirs).
    const size = typeof p.contentLength === 'number' ? p.contentLength : Number(p.contentLength ?? 0);
    if (Number.isFinite(size)) dataBytes += size;
    if (/\.parquet$/i.test(rel)) hasParquetData = true;
    if (p.lastModified) {
      const ms = new Date(p.lastModified).getTime();
      if (ms > lastModMs) lastModMs = ms;
    }
  }

  let format: TableFormat;
  let status: TableStatus;
  if (hasDeltaLog) {
    format = 'delta';
    // Delta log dir present but no parseable commit json → broken table.
    status = commitMax === null ? 'broken' : 'ok';
  } else if (hasParquetData) {
    format = 'parquet';
    status = 'ok';
  } else {
    format = 'unknown';
    status = 'empty';
  }

  return {
    format,
    status,
    latestVersion: commitMax,
    sizeBytes: dataBytes,
    lastModified: lastModMs ? new Date(lastModMs).toISOString() : null,
  };
}

async function countRows(container: string, tablePath: string, timeoutMs: number): Promise<number | null> {
  try {
    const bulk = pathToHttpsUrl(container, tablePath);
    const sql = `SELECT COUNT_BIG(*) AS n FROM OPENROWSET(BULK '${bulk}', FORMAT = 'DELTA') AS r;`;
    const res = await executeQuery(serverlessTarget(), sql, timeoutMs);
    const v = res.rows?.[0]?.[0];
    const n = typeof v === 'bigint' ? Number(v) : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    // Serverless offline / not provisioned / region-gated (e.g. IL5) → honest null.
    return null;
  }
}

/**
 * Scan every requested lakehouse container's `Tables/` directory and return a
 * flat, sorted array of the real tables found. Honest-empty ([]) when no
 * tables exist. Never fabricates rows.
 */
export async function scanLakehouseTables(opts: ScanOptions = {}): Promise<CatalogTable[]> {
  const containers = resolveContainers(opts.containers);
  const rowCounts = !!opts.rowCounts;
  const rowCountTimeoutMs = opts.rowCountTimeoutMs ?? 30_000;
  const maxEntries = opts.maxEntriesPerTable ?? 5_000;

  const out: CatalogTable[] = [];

  for (const container of containers) {
    // Top-level directory listing under Tables/. If Tables/ doesn't exist yet
    // (first-provision 404) or the identity lacks read, skip this container.
    let dirs: { name: string }[] = [];
    try {
      const fs = getServiceClientFor(getAccountName()).getFileSystemClient(container);
      const iter = fs.listPaths({ path: 'Tables', recursive: false });
      for await (const p of iter) {
        if (p.isDirectory) dirs.push({ name: p.name ?? '' });
      }
    } catch {
      continue;
    }

    for (const d of dirs) {
      const name = leaf(d.name);
      if (!name || name === '_delta_log') continue;
      const tablePath = `Tables/${name}`;
      let probe: TableProbe;
      try {
        probe = await probeTable(container, tablePath, maxEntries);
      } catch {
        probe = { format: 'unknown', status: 'broken', latestVersion: null, sizeBytes: 0, lastModified: null };
      }

      let rowCount: number | null = null;
      if (rowCounts && probe.format === 'delta' && probe.status === 'ok') {
        rowCount = await countRows(container, tablePath, rowCountTimeoutMs);
      }

      out.push({
        schema: container,
        name,
        adlsPath: `${container}/${tablePath}`,
        bulkUrl: pathToHttpsUrl(container, tablePath),
        format: probe.format,
        status: probe.status,
        latestVersion: probe.latestVersion,
        rowCount,
        sizeBytes: probe.sizeBytes,
        lastModified: probe.lastModified,
      });
    }
  }

  out.sort((a, b) => (a.schema === b.schema ? a.name.localeCompare(b.name) : a.schema.localeCompare(b.schema)));
  return out;
}
