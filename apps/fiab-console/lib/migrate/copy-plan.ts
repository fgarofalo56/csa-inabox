/**
 * M2 — copy-in PLAN BUILDER (PURE).
 *
 * Consumes M1's {@link ReadinessReport} (lib/migrate/assessment.ts — the shared
 * substrate) and turns the per-object mapping into a concrete DATA COPY-IN plan:
 * which assessed source objects are copyable TABLES, which Loom lakehouse /
 * warehouse table each lands in, and how columns map. It is the input to the
 * copy engine (lib/migrate/copy-engine.ts), which realizes it as an ADF/Synapse
 * Copy pipeline (Delta landing into Bronze / managed Delta) — the N7b/N7c
 * mirror/CDC substrate run IN REVERSE (external estate → Loom lake), reusing the
 * SAME adf-client orchestration path (no second orchestrator).
 *
 * PURE: zero server-only / React / Azure-SDK imports (it may import the equally
 * pure `load-to-table-codegen` for the shared Delta-table-name rule). Same report
 * in → same plan out, so it is unit-testable without Azure.
 *
 * NO-VAPORWARE / honesty: the builder NEVER invents columns or data. M1's
 * `AssessedObject` carries no column list, so the copy maps columns BY NAME
 * (ADF's documented default TabularTranslator behavior) — an honest strategy
 * that needs no fabricated schema. Non-table objects (reports, semantic models,
 * notebooks, views, procedures, …) are NOT copied here — they are SKIPPED with a
 * reason pointing at their real path (M3 code translation / semantic rebuild).
 */
import { suggestTableName, validateLoadTableName } from '@/lib/azure/load-to-table-codegen';
import type {
  ReadinessReport, AssessedObject, MigrationSourceType, SourceObjectKind,
} from './assessment';

/** The Loom target an assessed table lands in. Both are Azure-native (managed
 * Delta in ADLS Bronze); the kind drives the read-back (Spark table vs Synapse
 * SQL). Never a Fabric target — a Fabric/Power BI estate is only ever a SOURCE. */
export type CopyTargetKind = 'lakehouse' | 'warehouse';

/** Source object kinds that carry COPYABLE tabular DATA (rows to move). A
 * `sql-view` maps to a warehouse item but has no rows of its own — it is code
 * (M3), not a data copy — so it is deliberately absent here. */
export const COPYABLE_SOURCE_KINDS: ReadonlySet<SourceObjectKind> = new Set<SourceObjectKind>([
  'relational-table', 'lakehouse', 'warehouse',
]);

/** How the copy maps columns. `by-name` = ADF default mapping (no explicit
 * translator; sink columns matched to source columns by name) — the honest
 * default when M1 surfaced no column list. */
export type ColumnMappingStrategy = 'by-name';

/** One copyable source object → its Loom landing target. */
export interface CopyObjectPlan {
  /** Fully-qualified source reference, verbatim from the assessment. */
  source: {
    database?: string;
    schema?: string;
    name: string;
    sourceKind: SourceObjectKind;
    rawType?: string;
  };
  /** Which Loom item type the data lands in (managed Delta either way). */
  targetKind: CopyTargetKind;
  /** Safe managed-Delta table name (validated; see load-to-table-codegen). */
  targetTable: string;
  /** Bronze landing sub-path segment (`<db>.<schema>.<name>`), stable per object. */
  landingSegment: string;
  /** Column-mapping strategy (honest default — never fabricated columns). */
  columnMapping: ColumnMappingStrategy;
}

/** One assessed object the copy step does NOT handle, with the honest reason. */
export interface SkippedObject {
  name: string;
  sourceKind: SourceObjectKind;
  loomItemType: string;
  reason: string;
}

/** The complete copy-in plan the engine executes + the monitor renders. */
export interface CopyInPlan {
  sourceType: MigrationSourceType;
  sourceLabel?: string;
  /** ISO-8601 build time. */
  generatedAt: string;
  objects: CopyObjectPlan[];
  skipped: SkippedObject[];
  totals: {
    copyable: number;
    skipped: number;
    /** Count of copyable objects grouped by target kind. */
    byTargetKind: Record<CopyTargetKind, number>;
  };
}

/** Options for {@link buildCopyInPlan}. */
export interface BuildCopyInPlanOptions {
  /**
   * Fallback target when the assessment's `loomItemType` is neither `lakehouse`
   * nor `warehouse` (e.g. a `relational-table` whose M1 mapping resolved to
   * `lakehouse` — already covered — or an edge kind). Default `lakehouse`
   * (managed Delta), the lowest-friction landing.
   */
  defaultTargetKind?: CopyTargetKind;
  /** Override the build clock for deterministic tests. */
  now?: string;
}

/** Bronze landing segment for an object — dotted `<db>.<schema>.<name>`, with
 * empty parts dropped. Mirrors the mirror-engine `<schema>.<table>` folder
 * convention so the same Bronze read-back paths apply. */
export function landingSegmentFor(o: Pick<AssessedObject, 'database' | 'schema' | 'name'>): string {
  return [o.database, o.schema, o.name].map((p) => (p || '').trim()).filter(Boolean).join('.');
}

/**
 * Safe managed-Delta table name from an assessed object. Prefers a slug of the
 * bare object name; when that collides or is unusable, qualifies with the schema.
 * Reuses the SAME rule the Lakehouse "Load to Table" wizard enforces
 * (LOAD_TABLE_NAME_RE) so a migrated table is indistinguishable from a natively
 * loaded one. `used` de-duplicates within one plan.
 */
export function targetTableNameFor(o: Pick<AssessedObject, 'schema' | 'name'>, used: Set<string>): string {
  const base = suggestTableName(o.name);
  let candidate = base;
  // Qualify with schema on collision (schema_name), then numeric suffixes.
  if (used.has(candidate) && o.schema) {
    candidate = suggestTableName(`${o.schema}_${o.name}`);
  }
  let n = 2;
  let final = candidate;
  while (used.has(final) || validateLoadTableName(final) !== null) {
    // validateLoadTableName only rejects on a genuinely bad slug; suggestTableName
    // already guarantees a valid base, so this loop almost always runs only for
    // de-dup. Cap the suffix so an adversarial estate can't spin here.
    final = `${candidate}_${n}`.slice(0, 64);
    n += 1;
    if (n > 10_000) { final = `${candidate}_${used.size}`.slice(0, 64); break; }
  }
  used.add(final);
  return final;
}

/** Resolve the Loom target kind for an assessed table object. */
function targetKindFor(a: AssessedObject, fallback: CopyTargetKind): CopyTargetKind {
  if (a.loomItemType === 'warehouse') return 'warehouse';
  if (a.loomItemType === 'lakehouse') return 'lakehouse';
  return fallback;
}

/** Human reason a non-table assessed object is skipped by the copy step. */
function skipReasonFor(a: AssessedObject): string {
  switch (a.sourceKind) {
    case 'sql-view':
      return 'View — no rows of its own to copy. The view SQL is rebuilt on the target dialect by M3 (code translation).';
    case 'stored-routine':
      return 'Stored procedure / UDF — re-implemented as a Loom user-data-function or notebook by M3 (code translation).';
    case 'notebook':
      return 'Notebook — its cell source is carried over by the notebook migrator, not a data copy.';
    case 'semantic-model':
      return 'Semantic model — rebuilt on the Loom-native tabular layer over the copied tables, not a data copy.';
    case 'report':
    case 'paginated-report':
    case 'dashboard':
      return 'Report / dashboard — rebuilt on the Loom-native renderer over the copied tables, not a data copy.';
    case 'data-pipeline':
    case 'dataflow':
      return 'Pipeline / dataflow — its activity graph is migrated by the pipeline migrator, not a data copy.';
    case 'kql-database':
    case 'eventhouse':
    case 'eventstream':
    case 'streaming-object':
      return 'Real-time object — lands on ADX / Event Hubs via its own item migrator, not this batch data copy.';
    case 'mirrored-database':
      return 'Mirrored database — set up ongoing replication with the Loom mirrored-database item (mirror engine), not a one-time copy.';
    case 'ml-model':
      return 'ML model — artifact + serving endpoint are recreated by the ml-model migrator, not a data copy.';
    default:
      return `No copyable table data for source kind '${a.sourceKind}'; handled outside the data copy step.`;
  }
}

/**
 * Build the copy-in plan from an M1 readiness report. Copyable table objects
 * (relational tables + lakehouse/warehouse tables) become {@link CopyObjectPlan}
 * rows targeting a Loom lakehouse/warehouse managed-Delta table; every other
 * assessed object is SKIPPED with an honest reason. Pure + deterministic.
 */
export function buildCopyInPlan(
  report: ReadinessReport,
  opts: BuildCopyInPlanOptions = {},
): CopyInPlan {
  const fallback = opts.defaultTargetKind ?? 'lakehouse';
  const now = opts.now ?? new Date().toISOString();
  const usedNames = new Set<string>();

  const objects: CopyObjectPlan[] = [];
  const skipped: SkippedObject[] = [];
  const byTargetKind: Record<CopyTargetKind, number> = { lakehouse: 0, warehouse: 0 };

  for (const a of report.objects) {
    if (!COPYABLE_SOURCE_KINDS.has(a.sourceKind)) {
      skipped.push({ name: a.name, sourceKind: a.sourceKind, loomItemType: String(a.loomItemType), reason: skipReasonFor(a) });
      continue;
    }
    const targetKind = targetKindFor(a, fallback);
    objects.push({
      source: { database: a.database, schema: a.schema, name: a.name, sourceKind: a.sourceKind, rawType: a.rawType },
      targetKind,
      targetTable: targetTableNameFor(a, usedNames),
      landingSegment: landingSegmentFor(a) || a.name,
      columnMapping: 'by-name',
    });
    byTargetKind[targetKind] += 1;
  }

  return {
    sourceType: report.sourceType,
    sourceLabel: report.sourceLabel,
    generatedAt: now,
    objects,
    skipped,
    totals: { copyable: objects.length, skipped: skipped.length, byTargetKind },
  };
}
