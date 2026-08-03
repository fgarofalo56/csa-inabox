/**
 * Databricks **system tables** reads — `system.access.audit`,
 * `system.billing.usage`, `system.query.history`,
 * `system.data_classification.results`.
 *
 * These reach the catalog over the Databricks **SQL Statement Execution** API
 * (a SQL warehouse), NOT the UC REST surface, so they do NOT flow through the
 * LU-3 REST choke point (`ucFetch`). Since #2622 they DO produce a Loom audit
 * row: the shared reader goes through `ucSql` (lib/azure/uc-sql.ts), whose
 * `finally` records the statement — success, failure, or DENIED — without ever
 * copying the SQL text onto the row. `scripts/ci/check-unity-audit-chokepoint.mjs`
 * pins this file at ZERO raw `executeStatement(` exits so the wrapper cannot be
 * bypassed again.
 *
 * ## Why this is its own module
 *
 * It was 165 lines inside `unity-catalog-client.ts`, which sits AT its frozen
 * `check-file-size` ceiling (2900 LOC). LU-3 has to add the audit `try/finally`
 * to `ucFetch` in that file, and the ratchet's documented remedy is
 * decomposition, never a raised ceiling — so this block moved out.
 *
 * NO behaviour change and NO caller change: the five exported readers, their SQL,
 * their clamps and their honest `UnityCatalogError` remediation text are
 * identical to what shipped inside the client, and the client RE-EXPORTS them, so
 * every existing `import { readAccessAudit } from '.../unity-catalog-client'`
 * still resolves. Shared leaves (`UnityCatalogError`, `ucRows`, `clampInt`) live
 * in `./uc-primitives` so every import edge points one way and there is no cycle.
 */
import type { DbxQueryParam } from './databricks-client';
import { ucSql } from './uc-sql';
import { UnityCatalogError, ucRows, clampInt } from './uc-primitives';

export interface SystemReadResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
}

/**
 * Run a `system.*` read and convert a "schema not enabled / not authorized"
 * failure into a typed {@link UnityCatalogError} that names the exact remediation
 * (enable the system schema + grant the UAMI USE CATALOG/USE SCHEMA/SELECT),
 * rather than returning a silent empty result (per no-vaporware.md).
 */
async function runSystemTableRead(
  warehouseId: string,
  fullTable: string,     // e.g. system.access.audit
  systemSchema: string,  // e.g. access
  sql: string,
  params?: DbxQueryParam[],
): Promise<SystemReadResult> {
  try {
    const r = await ucSql(warehouseId, sql, { params, target: fullTable });
    return { columns: r.columns, rows: ucRows(r), rowCount: r.rowCount, executionMs: r.executionMs };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/TABLE_OR_VIEW_NOT_FOUND|PERMISSION_DENIED|does not exist|cannot be found|UNRESOLVED|INSUFFICIENT_PERMISSIONS|SCHEMA_NOT_FOUND|REQUIRES_SINGLE_PART_NAMESPACE|system\./i.test(msg)) {
      throw new UnityCatalogError(
        `The Databricks system table ${fullTable} is unavailable: ${msg}. Enable the ` +
          `system.${systemSchema} schema (as a metastore admin: PUT /api/2.1/unity-catalog/` +
          `metastores/{metastore_id}/systemschemas/${systemSchema}) and grant the Loom UAMI ` +
          `USE CATALOG on \`system\` + USE SCHEMA on system.${systemSchema} + SELECT (see ` +
          `scripts/csa-loom/grant-databricks-system-tables-role.sh).`,
        typeof e?.status === 'number' ? e.status : 403,
        e?.body,
        fullTable,
      );
    }
    throw e;
  }
}

/** Recent rows from `system.access.audit` (the UC audit log). Filter on
 *  `event_date` (partition) for performance. */
export async function readAccessAudit(
  warehouseId: string,
  opts: { days?: number; limit?: number; service?: string; action?: string } = {},
): Promise<SystemReadResult> {
  const days = clampInt(opts.days, 7, 1, 365);
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const params: DbxQueryParam[] = [];
  const filters = [`event_date >= current_date() - INTERVAL ${days} DAYS`];
  if (opts.service?.trim()) { filters.push('service_name = :service'); params.push({ name: 'service', value: opts.service.trim(), type: 'STRING' }); }
  if (opts.action?.trim()) { filters.push('action_name = :action'); params.push({ name: 'action', value: opts.action.trim(), type: 'STRING' }); }
  const sql = `SELECT event_time, workspace_id, service_name, action_name, user_identity.email AS user_email, source_ip_address, request_id
    FROM system.access.audit
    WHERE ${filters.join(' AND ')}
    ORDER BY event_time DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.access.audit', 'access', sql, params.length ? params : undefined);
}

/** Billable-usage summary from `system.billing.usage`, aggregated by product +
 *  SKU over a recent window (the audit pane's "spend" tab). */
export async function readBillingUsage(
  warehouseId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<SystemReadResult> {
  const days = clampInt(opts.days, 30, 1, 365);
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const sql = `SELECT billing_origin_product, sku_name, usage_unit, ROUND(SUM(usage_quantity), 4) AS usage_quantity, COUNT(*) AS records
    FROM system.billing.usage
    WHERE usage_date >= current_date() - INTERVAL ${days} DAYS
    GROUP BY billing_origin_product, sku_name, usage_unit
    ORDER BY usage_quantity DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.billing.usage', 'billing', sql);
}

/** Recent statements from `system.query.history`. `statement_text` may be
 *  `<Redacted>` for non-admins (Databricks-side redaction) — surfaced as-is. */
export async function readQueryHistory(
  warehouseId: string,
  opts: { days?: number; limit?: number; status?: string } = {},
): Promise<SystemReadResult> {
  const days = clampInt(opts.days, 7, 1, 365);
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const params: DbxQueryParam[] = [];
  const filters = [`start_time >= current_timestamp() - INTERVAL ${days} DAYS`];
  if (opts.status?.trim()) { filters.push('execution_status = :status'); params.push({ name: 'status', value: opts.status.trim().toUpperCase(), type: 'STRING' }); }
  const sql = `SELECT start_time, executed_by, statement_type, execution_status, total_duration_ms, produced_rows, statement_text
    FROM system.query.history
    WHERE ${filters.join(' AND ')}
    ORDER BY start_time DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.query.history', 'query', sql, params.length ? params : undefined);
}

// ---- 3. UC-native data classification (auto-PII) ---------------------

/** Column-level sensitive-class detections from `system.data_classification.results`
 *  (HIGH/LOW confidence per `class_tag`). Honest-gated when the
 *  `data_classification` system schema isn't enabled. */
export async function readDataClassification(
  warehouseId: string,
  opts: { catalog?: string; schema?: string; table?: string; confidence?: string; limit?: number } = {},
): Promise<SystemReadResult> {
  const limit = clampInt(opts.limit, 200, 1, 1000);
  const params: DbxQueryParam[] = [];
  const filters = ['class_tag IS NOT NULL'];
  if (opts.catalog?.trim()) { filters.push('catalog_name = :catalog'); params.push({ name: 'catalog', value: opts.catalog.trim(), type: 'STRING' }); }
  if (opts.schema?.trim()) { filters.push('schema_name = :schema'); params.push({ name: 'schema', value: opts.schema.trim(), type: 'STRING' }); }
  if (opts.table?.trim()) { filters.push('table_name = :table'); params.push({ name: 'table', value: opts.table.trim(), type: 'STRING' }); }
  if (opts.confidence?.trim()) { filters.push('confidence = :confidence'); params.push({ name: 'confidence', value: opts.confidence.trim().toUpperCase(), type: 'STRING' }); }
  const sql = `SELECT catalog_name, schema_name, table_name, column_name, class_tag, confidence, frequency, latest_detected_time
    FROM system.data_classification.results
    WHERE ${filters.join(' AND ')}
    ORDER BY confidence DESC, latest_detected_time DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.data_classification.results', 'data_classification', sql, params.length ? params : undefined);
}

/**
 * "List monitors + their latest status" over the documented data-quality system
 * table. Returns the LATEST row per monitored table (ROW_NUMBER window per the
 * Learn example), projecting the consolidated table-level `status` plus the
 * freshness / completeness sub-statuses. Unhealthy tables are ordered first.
 * Honest-gated via {@link runSystemTableRead} when the system schema isn't
 * enabled or the UAMI lacks SELECT.
 */
export async function readDataQualityMonitorResults(
  warehouseId: string,
  opts: { catalog?: string; schema?: string; table?: string; status?: string; limit?: number } = {},
): Promise<SystemReadResult> {
  const limit = clampInt(opts.limit, 200, 1, 1000);
  const params: DbxQueryParam[] = [];
  const innerFilters: string[] = [];
  if (opts.catalog?.trim()) { innerFilters.push('catalog_name = :catalog'); params.push({ name: 'catalog', value: opts.catalog.trim(), type: 'STRING' }); }
  if (opts.schema?.trim()) { innerFilters.push('schema_name = :schema'); params.push({ name: 'schema', value: opts.schema.trim(), type: 'STRING' }); }
  if (opts.table?.trim()) { innerFilters.push('table_name = :table'); params.push({ name: 'table', value: opts.table.trim(), type: 'STRING' }); }
  const inner = innerFilters.length ? `WHERE ${innerFilters.join(' AND ')}` : '';
  let outer = 'WHERE rn = 1';
  if (opts.status?.trim()) { outer += ' AND status = :status'; params.push({ name: 'status', value: opts.status.trim(), type: 'STRING' }); }
  const sql = `WITH latest_rows AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY table_id ORDER BY event_time DESC) AS rn
      FROM system.data_quality_monitoring.table_results
      ${inner}
    )
    SELECT catalog_name, schema_name, table_name, status,
           freshness.status AS freshness_status,
           completeness.status AS completeness_status,
           event_time
    FROM latest_rows
    ${outer}
    ORDER BY CASE WHEN status = 'Unhealthy' THEN 0 WHEN status = 'Unknown' THEN 1 ELSE 2 END, event_time DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.data_quality_monitoring.table_results', 'data_quality_monitoring', sql, params.length ? params : undefined);
}
