/**
 * Delta Lake maintenance — pure helpers for OPTIMIZE / VACUUM / ZORDER BY jobs
 * submitted to a Synapse Spark Livy interactive session.
 *
 * Azure-native, NO Fabric: the maintenance SQL runs on Synapse Spark against
 * Delta tables stored in ADLS Gen2 (abfss://). OPTIMIZE bin-packs small Parquet
 * files into ~1 GB files; ZORDER BY co-locates related values to improve
 * data-skipping; VACUUM removes tombstoned files older than the retention
 * threshold. All three are Spark SQL commands — the Fabric Lakehouse
 * "Maintenance" dialog runs the same three commands.
 *
 * The Delta retention-duration safety check is relaxed
 * (spark.databricks.delta.retentionDurationCheck.enabled=false) so a retention
 * window shorter than the 168 h default is honored exactly as requested. The UI
 * only offers retention values >= 48 h and recommends 168 h.
 *
 * This module is intentionally free of Azure-SDK / next imports so the
 * validation + code generation can be unit-tested in isolation
 * (delta-maintenance.test.ts).
 */

/** Vacuum retention options surfaced in the UI (hours). Fixed allowlist —
 * never a free-form number, per the no-freeform-config rule. */
export const ALLOWED_RETENTION_HOURS = [48, 168, 336, 720, 1440] as const;
export type RetentionHours = (typeof ALLOWED_RETENTION_HOURS)[number];

/** SQL identifier guard — columns + pool names must match this exactly. Guards
 * against SQL/Livy-path injection because these values land in a Spark SQL
 * string and a Livy REST path respectively. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Synapse Spark Big-Data-pool names: letters + digits only, 1-64 chars. */
const POOL_RE = /^[A-Za-z0-9]{1,64}$/;
/** ADLS Gen2 container/filesystem name. */
const CONTAINER_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export interface MaintenanceRequest {
  container: string;
  tableName: string;
  pool: string;
  compaction: boolean;
  vacuumRetentionHours: number;
  zorderColumns: string[];
}

export type ValidationResult =
  | { ok: true; value: MaintenanceRequest }
  | { ok: false; error: string };

/**
 * Validate + normalize an inbound maintenance request body. Returns the cleaned
 * value on success or a precise error string (used verbatim in the 400 body).
 */
export function validateMaintenanceRequest(body: any): ValidationResult {
  const container = String(body?.container ?? '').trim();
  const tableName = String(body?.tableName ?? '').trim().replace(/^\/+|\/+$/g, '');
  const pool = String(body?.pool ?? '').trim();
  const compaction = body?.compaction === true;
  const vacuumRetentionHours = Number(body?.vacuumRetentionHours ?? 0);
  const zorderColumns: string[] = Array.isArray(body?.zorderColumns)
    ? body.zorderColumns.map((c: any) => String(c).trim()).filter(Boolean)
    : [];

  if (!container) return { ok: false, error: 'container is required' };
  if (!CONTAINER_RE.test(container)) {
    return { ok: false, error: 'container must be a valid ADLS Gen2 container name' };
  }
  if (!tableName) return { ok: false, error: 'tableName is required' };
  // Relative path under Tables/ — identifier segments separated by '/'. No '..'.
  if (tableName.includes('..') || !/^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,255}$/.test(tableName)) {
    return { ok: false, error: 'tableName contains invalid characters' };
  }
  if (!pool) return { ok: false, error: 'pool is required' };
  if (!POOL_RE.test(pool)) {
    return { ok: false, error: 'pool must be a valid Synapse Spark pool name (letters and digits only)' };
  }

  const vacuumEnabled = Number.isFinite(vacuumRetentionHours) && vacuumRetentionHours > 0;
  if (vacuumEnabled && !ALLOWED_RETENTION_HOURS.includes(vacuumRetentionHours as RetentionHours)) {
    return { ok: false, error: `vacuumRetentionHours must be one of ${ALLOWED_RETENTION_HOURS.join(', ')}` };
  }

  for (const col of zorderColumns) {
    if (!IDENT_RE.test(col)) {
      return { ok: false, error: `ZORDER column "${col}" is not a valid SQL identifier` };
    }
  }
  // dedupe z-order columns, preserve order
  const dedupZ = zorderColumns.filter((c, i) => zorderColumns.indexOf(c) === i);

  if (dedupZ.length > 0 && !compaction) {
    return { ok: false, error: 'ZORDER BY requires compaction (OPTIMIZE) to be enabled' };
  }
  if (!compaction && !vacuumEnabled) {
    return { ok: false, error: 'Enable compaction (OPTIMIZE) and/or VACUUM — nothing to do' };
  }

  return {
    ok: true,
    value: {
      container,
      tableName,
      pool,
      compaction,
      vacuumRetentionHours: vacuumEnabled ? vacuumRetentionHours : 0,
      zorderColumns: dedupZ,
    },
  };
}

/** Build the abfss URI for a Delta table stored under `<container>/Tables/<name>`. */
export function buildAbfssUri(container: string, account: string, tableName: string): string {
  const clean = tableName.replace(/^\/+|\/+$/g, '');
  return `abfss://${container}@${account}.dfs.core.windows.net/Tables/${clean}`;
}

/** Human-readable list of operations the request will run (used in receipts + UI). */
export function buildMaintenancePlan(req: MaintenanceRequest): string[] {
  const ops: string[] = [];
  if (req.compaction) {
    ops.push(req.zorderColumns.length ? `OPTIMIZE ZORDER BY (${req.zorderColumns.join(', ')})` : 'OPTIMIZE');
  }
  if (req.vacuumRetentionHours > 0) {
    ops.push(`VACUUM RETAIN ${req.vacuumRetentionHours} HOURS`);
  }
  return ops;
}

/**
 * Build the PySpark statement submitted to the Livy session. Returns the code
 * plus the human-readable op list. The Delta path is bound to a Python variable
 * and interpolated server-side from validated inputs (container/account fixed,
 * tableName + columns identifier-validated) so the generated SQL is injection-safe.
 */
export function buildMaintenancePySpark(req: MaintenanceRequest, account: string): { code: string; ops: string[] } {
  const uri = buildAbfssUri(req.container, account, req.tableName);
  const lines: string[] = [];
  lines.push('# Loom Delta maintenance — OPTIMIZE / VACUUM / ZORDER BY (Azure-native, Synapse Spark)');
  lines.push('spark.conf.set("spark.databricks.delta.retentionDurationCheck.enabled", "false")');
  lines.push(`_uri = ${JSON.stringify(uri)}`);
  lines.push('_results = []');

  if (req.compaction) {
    const optSql = req.zorderColumns.length
      ? 'OPTIMIZE delta.`{_uri}` ZORDER BY (' + req.zorderColumns.join(', ') + ')'
      : 'OPTIMIZE delta.`{_uri}`';
    lines.push('_opt = spark.sql(f' + JSON.stringify(optSql) + ')');
    lines.push('_results.append({"op": "OPTIMIZE", "metrics": [r.asDict(recursive=True) for r in _opt.collect()]})');
  }

  if (req.vacuumRetentionHours > 0) {
    const vacSql = 'VACUUM delta.`{_uri}` RETAIN ' + req.vacuumRetentionHours + ' HOURS';
    lines.push('_vac = spark.sql(f' + JSON.stringify(vacSql) + ')');
    lines.push('_results.append({"op": "VACUUM", "files": [r[0] for r in _vac.collect()]})');
  }

  lines.push('import json as _json');
  lines.push('print("loom-maintenance-result " + _json.dumps(_results, default=str))');
  lines.push('print("loom-maintenance-done")');

  return { code: lines.join('\n'), ops: buildMaintenancePlan(req) };
}

/**
 * Best-effort: extract column names from a `CREATE TABLE ... ( col type, ... )`
 * DDL string. Used to populate the ZORDER BY column picker from a content
 * bundle's deltaTables[].ddl when the live ADLS schema isn't loaded yet.
 * Handles nested type parens (DECIMAL(18,2)) and skips table-level constraints.
 */
export function parseDdlColumns(ddl: string): string[] {
  if (!ddl) return [];
  const open = ddl.indexOf('(');
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < ddl.length; i++) {
    if (ddl[i] === '(') depth++;
    else if (ddl[i] === ')') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return [];
  const inner = ddl.slice(open + 1, close);

  const segs: string[] = [];
  let d = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') d++;
    else if (inner[i] === ')') d--;
    else if (inner[i] === ',' && d === 0) { segs.push(inner.slice(start, i)); start = i + 1; }
  }
  segs.push(inner.slice(start));

  const cols: string[] = [];
  for (const seg of segs) {
    const t = seg.trim();
    if (!t) continue;
    if (/^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK|KEY)\b/i.test(t)) continue;
    const m = t.match(/^[`"[]?([A-Za-z_][A-Za-z0-9_]*)[`"\]]?\s/);
    if (m) cols.push(m[1]);
  }
  return cols;
}
