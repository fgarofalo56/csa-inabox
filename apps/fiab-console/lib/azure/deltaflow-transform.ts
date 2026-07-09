/**
 * DeltaFlow analytics-ready CDC transform (FGC-15) — Fabric Eventstream parity,
 * Azure-native (no OneLake / Fabric).
 *
 * Fabric's CDC connectors expose a schema-handling MODE:
 *   - "Raw CDC events"  emit the Debezium change envelope as-is (today's
 *     cdc-flatten operator).
 *   - "Analytics-ready" (DeltaFlow) auto-transform the CDC stream into an
 *     analytics table: the change envelope is normalized into typed change-type
 *     + change-timestamp columns, keyed for upsert/merge, landing in an
 *     auto-managed destination table whose schema evolves automatically.
 * Source: https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-postgresql-database-change-data-capture
 *
 * This module is the PURE compiler for the analytics-ready mode: it emits the
 * Stream Analytics SELECT list that normalizes the envelope, and describes the
 * auto-managed destination (change-type/timestamp columns, key columns, schema
 * evolution) that the eventstream provisioner materializes as the ASA → ADLS
 * Delta sink. No Azure I/O here — deterministic string/spec output for tests.
 */

export type CdcSchemaMode = 'raw-flatten' | 'analytics-ready';

/** The subset of a TransformNode this module reads (kept structural so the
 *  asa-query-compiler TransformNode and the editor operator both satisfy it). */
export interface DeltaFlowConfig {
  /** Schema-handling mode. Absent ⇒ 'raw-flatten' (back-compat with cdc-flatten). */
  cdcSchemaMode?: CdcSchemaMode;
  /** Data columns to project from the change envelope. */
  cdcColumns?: string[];
  cdcBeforeField?: string;
  cdcAfterField?: string;
  cdcOpField?: string;
  cdcTsField?: string;
  cdcSourceField?: string;
  cdcMetaPrefix?: string;
  // ── analytics-ready extras ──
  /** Upsert/merge key column(s) for the destination table. */
  cdcKeyColumns?: string[];
  /** Normalized change-type column name (default '__change_type'). */
  cdcChangeTypeColumn?: string;
  /** Change-commit timestamp column name (default '__change_ts'). */
  cdcChangeTsColumn?: string;
  /** Auto-managed destination Delta table the analytics stream lands in. */
  cdcDestinationTable?: string;
  /** Automatic schema evolution (add new source columns to the destination). Default true. */
  cdcSchemaEvolution?: boolean;
}

export const CHANGE_TYPE_COLUMN_DEFAULT = '__change_type';
export const CHANGE_TS_COLUMN_DEFAULT = '__change_ts';

/** Is the node configured for the analytics-ready DeltaFlow mode? */
export function isAnalyticsReady(t: DeltaFlowConfig): boolean {
  return (t.cdcSchemaMode || 'raw-flatten') === 'analytics-ready';
}

/**
 * Normalize a Debezium op code to an analytics change type:
 *   c → Insert, r → Snapshot (initial read), u → Update, d → Delete.
 * Returns the SAQL CASE expression over the op field.
 */
export function changeTypeCaseExpr(opField: string): string {
  const op = (opField || 'op').trim() || 'op';
  return (
    `CASE ${op} ` +
    `WHEN 'c' THEN 'Insert' ` +
    `WHEN 'r' THEN 'Snapshot' ` +
    `WHEN 'u' THEN 'Update' ` +
    `WHEN 'd' THEN 'Delete' ` +
    `ELSE ${op} END`
  );
}

/** Pure op→change-type mapping (mirrors changeTypeCaseExpr for tests/UI). */
export function mapChangeType(op: string): string {
  switch ((op || '').toLowerCase()) {
    case 'c': return 'Insert';
    case 'r': return 'Snapshot';
    case 'u': return 'Update';
    case 'd': return 'Delete';
    default: return op;
  }
}

/**
 * The analytics-ready SELECT list. Each data column is COALESCE(after, before)
 * (so deletes keep their keys), plus the normalized change-type column, the
 * change-commit timestamp, and — for auditability — the key columns marked. The
 * ASA job writing this projection to the destination Delta table is what
 * mirrors DeltaFlow without OneLake.
 */
export function deltaflowSelectList(t: DeltaFlowConfig): string {
  const after = (t.cdcAfterField || 'after').trim() || 'after';
  const before = (t.cdcBeforeField || 'before').trim() || 'before';
  const op = (t.cdcOpField || 'op').trim() || 'op';
  const ts = (t.cdcTsField || 'ts_ms').trim() || 'ts_ms';
  const changeTypeCol = (t.cdcChangeTypeColumn || CHANGE_TYPE_COLUMN_DEFAULT).trim() || CHANGE_TYPE_COLUMN_DEFAULT;
  const changeTsCol = (t.cdcChangeTsColumn || CHANGE_TS_COLUMN_DEFAULT).trim() || CHANGE_TS_COLUMN_DEFAULT;
  const cols = (t.cdcColumns || []).map((c) => c.trim()).filter(Boolean);
  const parts: string[] = [];

  for (const c of cols) {
    parts.push(`COALESCE(${after}.${c}, ${before}.${c}) AS ${c}`);
  }
  // Normalized change type (Insert/Update/Delete/Snapshot) + commit timestamp.
  parts.push(`${changeTypeCaseExpr(op)} AS ${changeTypeCol}`);
  parts.push(
    `DATEADD(millisecond, CAST(${ts} AS bigint), CAST('1970-01-01T00:00:00Z' AS datetime)) AS ${changeTsCol}`,
  );
  const src = (t.cdcSourceField || '').trim();
  if (src) {
    parts.push(`${src}.schema AS __schema`);
    parts.push(`${src}.table AS __table`);
  }
  return parts.length ? parts.join(', ') : '*';
}

export interface DeltaFlowDestinationSpec {
  /** The auto-managed destination Delta table (in ADLS via delta-rs). */
  table: string;
  /** Upsert/merge key columns (empty ⇒ append-only). */
  keyColumns: string[];
  changeTypeColumn: string;
  changeTsColumn: string;
  /** Whether new source columns are auto-added to the destination schema. */
  schemaEvolution: boolean;
  /** Data columns written (excludes change-metadata columns). */
  dataColumns: string[];
}

/**
 * Describe the auto-managed destination for an analytics-ready node — the spec
 * the eventstream provisioner uses to create/evolve the ADLS Delta table (via
 * delta-rs schema merge) that the ASA job writes into. Deterministic + pure.
 */
export function deltaflowDestinationSpec(t: DeltaFlowConfig): DeltaFlowDestinationSpec {
  return {
    table: (t.cdcDestinationTable || '').trim() || 'cdc_analytics',
    keyColumns: (t.cdcKeyColumns || []).map((c) => c.trim()).filter(Boolean),
    changeTypeColumn: (t.cdcChangeTypeColumn || CHANGE_TYPE_COLUMN_DEFAULT).trim() || CHANGE_TYPE_COLUMN_DEFAULT,
    changeTsColumn: (t.cdcChangeTsColumn || CHANGE_TS_COLUMN_DEFAULT).trim() || CHANGE_TS_COLUMN_DEFAULT,
    schemaEvolution: t.cdcSchemaEvolution !== false,
    dataColumns: (t.cdcColumns || []).map((c) => c.trim()).filter(Boolean),
  };
}

/** Validate an analytics-ready node. Returns a precise message or null. */
export function validateDeltaFlow(t: DeltaFlowConfig): string | null {
  if (!isAnalyticsReady(t)) return null;
  const cols = (t.cdcColumns || []).map((c) => c.trim()).filter(Boolean);
  if (cols.length === 0) {
    return 'Analytics-ready mode needs at least one data column to project from the change envelope.';
  }
  const keys = (t.cdcKeyColumns || []).map((c) => c.trim()).filter(Boolean);
  for (const k of keys) {
    if (!cols.includes(k)) return `Key column '${k}' must also be one of the projected data columns.`;
  }
  return null;
}
