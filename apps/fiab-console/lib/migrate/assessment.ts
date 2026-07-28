/**
 * M1 — migration assessment engine + the SHARED READINESS-REPORT SHAPE.
 *
 * This is the inbound-migration on-ramp's core: given an ENUMERATED INVENTORY
 * of a source estate (Snowflake / Databricks Unity Catalog / Microsoft Fabric /
 * Power BI — enumerated by the `apps/loom-migrate` ACA reader), it produces a
 * MIGRATION-READINESS REPORT — a per-object mapping to a Loom item type with a
 * `1:1` / `needs-review` effort flag and a human reason.
 *
 * The exported {@link ReadinessReport} / {@link AssessedObject} / {@link
 * EnumeratedInventory} shapes are the SHARED SUBSTRATE the sibling migration
 * items consume: M2 (copy-in / object migration) reads the same per-object
 * mapping to know what to create, and M3 (code translation) reads it to know
 * which objects carry translatable source (views, procedures, notebooks). Keep
 * this module PURE (zero server-only / React imports) and its exports stable.
 *
 * NO-VAPORWARE: this file NEVER invents inventory. It maps only what the reader
 * actually enumerated; an object kind with no confident Loom target resolves to
 * `needs-review` with a reason — never a fabricated 1:1.
 *
 * The Loom item-type slugs the mapping targets are drawn from the catalog
 * item-type vocabulary (`lib/catalog/item-types/*` — e.g. `lakehouse`,
 * `warehouse`, `semantic-model`, `report`, `notebook`, `data-pipeline`,
 * `kql-database`, `eventhouse`, `eventstream`, `mirrored-database`, `dataflow`,
 * `paginated-report`, `dashboard`, `ml-model`). Kept as string literals here so
 * the engine stays free of the (React/icon-bearing) catalog import graph.
 */

/** The four inbound-migration source estates M1 assesses. A Fabric / Power BI
 * estate is ONLY ever a migration SOURCE here — Loom itself has no Fabric
 * dependency (.claude/rules/no-fabric-dependency.md). */
export type MigrationSourceType = 'snowflake' | 'databricks-uc' | 'fabric' | 'powerbi';

/** Canonical, connector-normalized source-object kind. Each connector in the
 * reader maps its own raw kind onto exactly one of these before assessment, so
 * the mapping table below is source-agnostic. `unknown` is the honest catch-all
 * for a kind the reader surfaced but the engine has no confident target for. */
export type SourceObjectKind =
  | 'lakehouse'
  | 'warehouse'
  | 'relational-table'
  | 'sql-view'
  | 'semantic-model'
  | 'report'
  | 'paginated-report'
  | 'dashboard'
  | 'notebook'
  | 'data-pipeline'
  | 'dataflow'
  | 'kql-database'
  | 'eventhouse'
  | 'eventstream'
  | 'mirrored-database'
  | 'ml-model'
  | 'stored-routine'
  | 'streaming-object'
  | 'unknown';

/** One object the reader enumerated from the source estate. */
export interface SourceObject {
  /** Canonical kind (the connector already normalized its raw type to this). */
  kind: SourceObjectKind;
  /** Object name (table / report / notebook / …). */
  name: string;
  /** Containing schema, when the source has one (Snowflake / UC). */
  schema?: string;
  /** Containing database / catalog / workspace, when the source has one. */
  database?: string;
  /** The connector's OWN raw type label, preserved verbatim for the review. */
  rawType?: string;
  /** Opaque per-object metadata the connector chose to pass through. */
  meta?: Record<string, unknown>;
}

/** The reader's enumeration output — the assessment engine's sole input. */
export interface EnumeratedInventory {
  sourceType: MigrationSourceType;
  /** Human label of the enumerated estate (workspace / account / catalog). */
  sourceLabel?: string;
  objects: SourceObject[];
}

/** Migration effort flag for one object. `1:1` = a direct Loom item exists and
 * the move is mechanical; `needs-review` = a human must review (data copy, SQL
 * dialect rewrite, or no direct target). */
export type MigrationEffort = '1:1' | 'needs-review';

/** One assessed object — the per-object row of the readiness report. */
export interface AssessedObject {
  sourceType: MigrationSourceType;
  sourceKind: SourceObjectKind;
  name: string;
  schema?: string;
  database?: string;
  rawType?: string;
  /** The Loom item-type slug this maps to, or the literal `needs-review` when
   * there is no confident 1:1 target. */
  loomItemType: string | 'needs-review';
  effort: MigrationEffort;
  reason: string;
}

/** The migration-readiness report — the SHARED SUBSTRATE (M2/M3 consume this). */
export interface ReadinessReport {
  sourceType: MigrationSourceType;
  sourceLabel?: string;
  /** ISO-8601 time the report was produced. */
  generatedAt: string;
  totals: { objects: number; oneToOne: number; needsReview: number };
  /** Count of assessed objects grouped by resolved Loom item type (the
   * `needs-review` bucket is keyed by the literal `needs-review`). */
  byLoomItemType: Record<string, number>;
  objects: AssessedObject[];
}

interface MappingRule {
  loomItemType: string | 'needs-review';
  effort: MigrationEffort;
  reason: string;
}

/**
 * Source-agnostic mapping from a canonical source kind to its Loom target +
 * effort. This table is the heart of the on-ramp: it encodes the Azure-native
 * landing target for each source object class per no-fabric-dependency (a
 * Fabric Lakehouse lands on ADLS+Delta, a Power BI dataset lands on the
 * Loom-native semantic layer, an Eventhouse lands on ADX, etc.).
 */
const MAPPING: Record<SourceObjectKind, MappingRule> = {
  lakehouse: {
    loomItemType: 'lakehouse', effort: '1:1',
    reason: 'Lake table store → Loom lakehouse (ADLS Gen2 + Delta). Same open format; a metadata + data copy lands it 1:1.',
  },
  warehouse: {
    loomItemType: 'warehouse', effort: 'needs-review',
    reason: 'Relational warehouse → Loom warehouse (Synapse dedicated SQL). SQL dialect differences and a bulk data copy need review.',
  },
  'relational-table': {
    loomItemType: 'lakehouse', effort: 'needs-review',
    reason: 'Source table → Loom lakehouse Delta table. A data copy / CDC pass is required; column-type mapping needs review.',
  },
  'sql-view': {
    loomItemType: 'warehouse', effort: 'needs-review',
    reason: 'Source view → Loom warehouse view. The view SQL must be re-expressed in the target dialect (M3 code-translation input).',
  },
  'semantic-model': {
    loomItemType: 'semantic-model', effort: '1:1',
    reason: 'Tabular / semantic model → Loom-native semantic model (tabular layer over the warehouse/lakehouse). No Power BI workspace required.',
  },
  report: {
    loomItemType: 'report', effort: '1:1',
    reason: 'Report → Loom report (native renderer over the semantic layer). No Power BI workspace required.',
  },
  'paginated-report': {
    loomItemType: 'paginated-report', effort: '1:1',
    reason: 'Paginated (RDL) report → Loom paginated-report.',
  },
  dashboard: {
    loomItemType: 'dashboard', effort: 'needs-review',
    reason: 'Dashboard → Loom dashboard. Pinned-tile layout is rebuilt from the underlying reports; not a byte-for-byte copy.',
  },
  notebook: {
    loomItemType: 'notebook', effort: '1:1',
    reason: 'Notebook → Loom notebook (Synapse/Databricks Spark). Cell source is carried over (M3 may adjust engine-specific calls).',
  },
  'data-pipeline': {
    loomItemType: 'data-pipeline', effort: '1:1',
    reason: 'Pipeline → Loom data-pipeline (Synapse pipeline / ADF). Activity graph maps across.',
  },
  dataflow: {
    loomItemType: 'dataflow', effort: '1:1',
    reason: 'Dataflow → Loom dataflow (mapping data flow over Synapse/Spark).',
  },
  'kql-database': {
    loomItemType: 'kql-database', effort: '1:1',
    reason: 'KQL database → Loom kql-database (Azure Data Explorer). KQL and schema carry over directly.',
  },
  eventhouse: {
    loomItemType: 'eventhouse', effort: '1:1',
    reason: 'Eventhouse → Loom eventhouse (ADX cluster).',
  },
  eventstream: {
    loomItemType: 'eventstream', effort: '1:1',
    reason: 'Eventstream → Loom eventstream (Azure Event Hubs + Stream Analytics).',
  },
  'mirrored-database': {
    loomItemType: 'mirrored-database', effort: '1:1',
    reason: 'Mirrored database → Loom mirrored-database (ADF CDC / Synapse Link copy → Bronze Delta).',
  },
  'ml-model': {
    loomItemType: 'ml-model', effort: 'needs-review',
    reason: 'Registered ML model → Loom ml-model. Model artifact + serving endpoint recreation need review.',
  },
  'stored-routine': {
    loomItemType: 'needs-review', effort: 'needs-review',
    reason: 'Stored procedure / UDF has no 1:1 Loom item — re-implement as a user-data-function or notebook (M3 code-translation input).',
  },
  'streaming-object': {
    loomItemType: 'needs-review', effort: 'needs-review',
    reason: 'Streaming object (task / stream) → a Loom eventstream or pipeline; requires manual redesign.',
  },
  unknown: {
    loomItemType: 'needs-review', effort: 'needs-review',
    reason: 'No direct Loom item-type mapping for this source object; manual review required.',
  },
};

/**
 * Assess ONE enumerated object → its per-object readiness row. An unrecognized
 * kind falls through to the `unknown` rule (→ needs-review with a reason),
 * never a fabricated 1:1.
 */
export function assessObject(obj: SourceObject, sourceType: MigrationSourceType): AssessedObject {
  const rule = MAPPING[obj.kind] ?? MAPPING.unknown;
  return {
    sourceType,
    sourceKind: obj.kind,
    name: obj.name,
    schema: obj.schema,
    database: obj.database,
    rawType: obj.rawType,
    loomItemType: rule.loomItemType,
    effort: rule.effort,
    reason: rule.reason,
  };
}

/**
 * Assess a full enumerated inventory → the migration-readiness report. Pure:
 * same inventory in → same report out (modulo `generatedAt`, which the caller
 * may override for a deterministic test).
 */
export function assessInventory(
  inventory: EnumeratedInventory,
  now: string = new Date().toISOString(),
): ReadinessReport {
  const objects = inventory.objects.map((o) => assessObject(o, inventory.sourceType));
  const byLoomItemType: Record<string, number> = {};
  let oneToOne = 0;
  let needsReview = 0;
  for (const a of objects) {
    byLoomItemType[a.loomItemType] = (byLoomItemType[a.loomItemType] ?? 0) + 1;
    if (a.effort === '1:1') oneToOne += 1;
    else needsReview += 1;
  }
  return {
    sourceType: inventory.sourceType,
    sourceLabel: inventory.sourceLabel,
    generatedAt: now,
    totals: { objects: objects.length, oneToOne, needsReview },
    byLoomItemType,
    objects,
  };
}

/** Human labels for the source-type dropdown / report header (surface reuse). */
export const MIGRATION_SOURCE_LABELS: Record<MigrationSourceType, string> = {
  snowflake: 'Snowflake',
  'databricks-uc': 'Databricks Unity Catalog',
  fabric: 'Microsoft Fabric workspace',
  powerbi: 'Power BI workspace',
};

/** Fluent Badge intent for an effort flag (surface reuse — pure, no imports). */
export function effortBadgeColor(effort: MigrationEffort): 'success' | 'warning' {
  return effort === '1:1' ? 'success' : 'warning';
}
