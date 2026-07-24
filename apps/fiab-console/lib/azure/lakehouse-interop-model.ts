/**
 * loom-lakehouse-interop — doc shapes + PURE state helpers + MIG1 versioned
 * migration registration for N1 (Iceberg REST catalog + Delta↔Iceberg dual
 * metadata).
 *
 * One doc per (tenant, lakehouse container) records which Delta tables are ALSO
 * exposed as Apache Iceberg: the emit path that produced the metadata
 * (`delta-uniform` | `xtable`), the metadata location in the customer's OWN
 * ADLS Gen2, the Iceberg namespace the table is registered under in the REST
 * catalog, and the last Spark job that flipped it. The Interop tab and
 * /admin/catalog read exactly this — no derived guesses, no mock rows.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` (no cosmos-client,
 * no Azure SDK, no next) so `cosmos-client` can import it at module scope to
 * register the migrator chain before any read materializes — the
 * copilot-evals-model / semantic-contract-model / prompt-registry-model
 * precedent. It is also therefore safe to import from a client component for
 * the shared types.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking shape change bumps LAKEHOUSE_INTEROP_SCHEMA_VERSION to N+1
 * and registers its `fromVersion: N` migrator in
 * {@link registerLakehouseInteropMigrators} (called at module scope). Per MIG1
 * there is deliberately NO v1 migrator today.
 *
 * Per-cloud: identical Commercial / GCC-High / IL5 — the doc is pure metadata in
 * the deployment's own Cosmos. SOVEREIGN MOAT: nothing here (or anything it
 * points at) leaves the boundary; the metadata location is an abfss:// path in
 * the customer's own lake and the catalog is the in-VNet container app.
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';

export const LAKEHOUSE_INTEROP_CONTAINER = 'loom-lakehouse-interop';
export const LAKEHOUSE_INTEROP_SCHEMA_VERSION = 1;

/** How the Iceberg metadata for a table was produced. */
export type InteropEmitVia = 'delta-uniform' | 'xtable' | 'none';

/** Lifecycle of the Spark job that last flipped a table's Iceberg exposure. */
export type InteropJobState = 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Interop state of ONE Delta table under a lakehouse container. */
export interface InteropTableState {
  /** Table path relative to `Tables/` (may include a schema segment). */
  table: string;
  /** Iceberg namespace the table is registered under (e.g. `gold` / `gold.sales`). */
  namespace: string;
  /**
   * Always true. A Loom lakehouse table IS Delta — the toggle only ever adds or
   * removes the SECOND (Iceberg) metadata tree; the Parquet data files and the
   * `_delta_log` are never touched, so Delta readability can never be lost.
   */
  delta: true;
  /** True when Iceberg metadata generation is enabled for this table. */
  iceberg: boolean;
  /** How the Iceberg metadata was produced (`none` while iceberg is false). */
  via: InteropEmitVia;
  /** `<table-root>/metadata` in the customer's own lake — where readers look. */
  metadataLocation?: string;
  /** abfss:// root of the Delta table (the zero-copy data location). */
  tableRootUri?: string;
  /** Metadata files observed by the last emit job (0 = not yet materialised). */
  metadataFiles?: number;
  /** True once the table was registered in the Iceberg REST catalog. */
  registeredInCatalog?: boolean;
  /** Last emit/disable job submitted for this table. */
  lastJobId?: string;
  lastJobState?: InteropJobState;
  /** Honest detail from the last run (Spark error, xtable-unavailable, …). */
  lastDetail?: string;
  updatedAt: string;
  updatedBy: string;
}

/** The `loom-lakehouse-interop` doc. PK /tenantId; id `interop:<container>`. */
export interface LakehouseInteropDoc {
  id: string;
  /** Partition key — the owning principal's Entra oid (Loom tenant scope). */
  tenantId: string;
  docType: 'lakehouse-interop';
  /** ADLS Gen2 container backing the lakehouse (bronze/silver/gold/…). */
  container: string;
  tables: InteropTableState[];
  schemaVersion: number;
  updatedAt: string;
}

/** Cosmos id for a container's interop doc. */
export function interopDocId(container: string): string {
  return `interop:${String(container).trim()}`;
}

/** A fresh, empty interop doc (used when Cosmos has none yet). */
export function emptyInteropDoc(tenantId: string, container: string): LakehouseInteropDoc {
  return {
    id: interopDocId(container),
    tenantId,
    docType: 'lakehouse-interop',
    container,
    tables: [],
    schemaVersion: LAKEHOUSE_INTEROP_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Normalize a table path to the key this model indexes by: no leading/trailing
 * slashes, no `Tables/` prefix (that segment is structural, not part of the
 * table identity). Returns '' for anything unusable so callers can 400.
 */
export function normalizeTableKey(table: unknown): string {
  const s = String(table ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/^Tables\//i, '');
  if (!s || s.includes('..')) return '';
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,255}$/.test(s)) return '';
  return s;
}

/**
 * Derive the default Iceberg namespace for a table: the lakehouse container,
 * plus the table's own schema segment when the lakehouse is schema-enabled
 * (`gold` + `sales/orders` → `gold.sales`). Multi-level namespaces are dotted,
 * exactly as the Iceberg REST spec renders them for humans.
 */
export function defaultNamespaceFor(container: string, tableKey: string): string {
  const base = String(container).trim().replace(/[^A-Za-z0-9_-]/g, '') || 'default';
  const segs = tableKey.split('/').filter(Boolean);
  if (segs.length > 1) return [base, ...segs.slice(0, -1)].join('.');
  return base;
}

/** The bare table name (last path segment) used as the Iceberg table id. */
export function tableNameOf(tableKey: string): string {
  const segs = tableKey.split('/').filter(Boolean);
  return segs[segs.length - 1] || tableKey;
}

/**
 * PURE upsert of one table's interop state into a doc. Returns a NEW doc
 * (never mutates the input) with the table row replaced or appended and the
 * doc's `updatedAt` refreshed. Table rows stay sorted by key so the Interop tab
 * and /admin/catalog render deterministically.
 */
export function upsertTableState(
  doc: LakehouseInteropDoc,
  next: InteropTableState,
): LakehouseInteropDoc {
  const key = normalizeTableKey(next.table);
  const rows = doc.tables.filter((t) => normalizeTableKey(t.table) !== key);
  rows.push({ ...next, table: key });
  rows.sort((a, b) => a.table.localeCompare(b.table));
  return { ...doc, tables: rows, updatedAt: next.updatedAt, schemaVersion: LAKEHOUSE_INTEROP_SCHEMA_VERSION };
}

/** Look up one table's state, or null. */
export function findTableState(
  doc: LakehouseInteropDoc | null | undefined,
  table: string,
): InteropTableState | null {
  if (!doc) return null;
  const key = normalizeTableKey(table);
  return doc.tables.find((t) => normalizeTableKey(t.table) === key) ?? null;
}

/** Count of tables currently exposed as Iceberg (the admin-overview tile). */
export function icebergExposedCount(doc: LakehouseInteropDoc | null | undefined): number {
  if (!doc) return 0;
  return doc.tables.filter((t) => t.iceberg).length;
}

/**
 * MIG1 — register the `loom-lakehouse-interop` migrator chain. Called at module
 * scope so the chain is in place before `cosmos-client` materializes any read.
 * There is deliberately NO v1 migrator: version 1 is the initial shape.
 */
export function registerLakehouseInteropMigrators(): void {
  const chain: Array<[number, DocMigrator]> = [];
  for (const [fromVersion, migrate] of chain) {
    registerMigrator(LAKEHOUSE_INTEROP_CONTAINER, fromVersion, migrate);
  }
}

registerLakehouseInteropMigrators();
