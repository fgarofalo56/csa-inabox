/**
 * lib/report/transform-fold.ts
 *
 * The report renderer's Power Query "Transform data" FOLD + the per-table
 * Import/Dual connection CACHE read, extracted verbatim from
 * app/api/items/report/[id]/query/route.ts (rel-T64). Behaviour-preserving: pure
 * code movement, same real Synapse / serverless-OPENROWSET calls, same honest
 * gates, no mock (no-vaporware.md), 100% Azure-native (no Fabric / Power BI /
 * OneLake host on any path — no-fabric-dependency.md).
 *
 * ── REPORT-BUILDER PARITY · WAVE 4 — Power Query "Transform Data" fold ──────────
 *
 * A report's data source can carry an OPTIONAL Power Query transform authored by
 * the report Transform host — the SAME `PowerQueryHost` the Dataflow Gen2 editor
 * mounts — persisted on `state.dataSource.appliedSteps` as a full M section built
 * exclusively via `m-script.appendStep` (structured dialogs / ribbon, never
 * hand-typed — no-freeform-config). DirectQuery (the default) FOLDS those applied
 * steps onto the resolved source's base SELECT: `foldAppliedStepsToSql` emits
 * nested, dialect-quoted derived SELECTs so EVERY visual runs over the TRANSFORMED
 * data. A non-foldable step (parse JSON/XML, transpose, pivot, examples-heuristics
 * …) is an HONEST 409 (`code:'not-foldable'`) named by the CALLER, never a
 * silently-wrong read. The Import path materializes the steps via the report
 * /refresh Spark/wrangling Delta cache and the fold then runs over that cache.
 */

import { type DaxVisual } from '@/lib/azure/aas-client';
import { executeQuery, serverlessTarget, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import {
  readReportDataSource,
  reportTableMlvSpec,
  bracket,
  isStorageMode,
  type ConnectionExecutor,
} from '@/lib/azure/report-model-resolver';
import { resolveMlvDeltaUrl } from '@/lib/azure/materialized-lake-view-engine';
import {
  buildSqlFromVisual,
  type SqlDialect,
  type SqlSource,
  type SqlSourceColumn,
  type SqlSourceFrom,
  type ReportFilterInput,
} from '@/lib/azure/wells-to-sql';
import { fromLegacyState, hasTransform } from '@/lib/editors/report/report-data-source';
import { foldAppliedStepsToSql, parseSharedQueries } from '@/lib/components/pipeline/dataflow/m-script';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { whitelist, isAggregateVisual, objectRows } from './query-projection';

/** The Loom-native report path folds + compiles over the Synapse SQL family. */
export const TRANSFORM_DIALECT: SqlDialect = 'synapse';

/** Strip a trailing `;` so a base SELECT splices cleanly as a derived relation. */
export function stripSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

/** The base SELECT a transform folds onto, from a resolved FROM relation: a
 *  derived source's own SELECT, or `SELECT * FROM [schema].[table]` for a table. */
export function baseSelectFromFrom(from: SqlSourceFrom): string {
  if (from.kind === 'derived') return stripSemicolons(from.sql);
  const schema = from.schema ? `${bracket(from.schema)}.` : '';
  return `SELECT * FROM ${schema}${bracket(from.table)}`;
}

/**
 * The base SELECT for a Get-Data CONNECTION source (`table` → `SELECT *`; `query`
 * → its own validated SELECT). Reconstructed IDENTICALLY to tryConnectionCacheRead
 * so foldability is validated against the same relation the cache materializes.
 * Returns null for file / kql refs (no tabular base SELECT) and non-connection
 * sources — the caller then skips the foldability probe.
 */
export function connectionBaseSelect(source: ReturnType<typeof readReportDataSource>): string | null {
  if (!source || source.kind !== 'connection') return null;
  const ref = source.objectRef;
  if (ref.mode === 'table') {
    const rel = ref.schema ? `${bracket(ref.schema)}.${bracket(ref.table)}` : bracket(ref.table);
    return `SELECT * FROM ${rel}`;
  }
  if (ref.mode === 'query') return stripSemicolons(ref.sql);
  return null;
}

/** Outcome of folding a Wave-4 transform onto a resolved SqlSource. */
export type TransformFold =
  | { kind: 'none' }                        // no transform → use the source as-is
  | { kind: 'folded'; source: SqlSource }   // applied steps folded into a derived FROM
  | { kind: 'not-foldable'; step: string }  // a step can't fold → honest 409
  | { kind: 'unparseable' };                // the M section couldn't be parsed → honest 412

/**
 * Fold a report data source's OPTIONAL Power Query transform onto `source`,
 * returning a new SqlSource whose FROM is the folded derived SELECT (DirectQuery
 * query-folding). Byte-identical no-op when the source carries no transform. The
 * column whitelist is left as the resolver's base-schema whitelist — a renamed /
 * added column referenced by a well is simply not whitelisted (never a wrong
 * identifier — injection-safe); the common foldable transforms preserve names, so
 * the wells still resolve. The dialect is the source's own (Synapse default), so
 * the folded inner SELECT and the outer wells→SQL quote identifiers identically.
 */
export function foldTransformOntoSource(
  source: SqlSource,
  ds: ReturnType<typeof fromLegacyState>,
): TransformFold {
  if (!hasTransform(ds) || !ds?.appliedSteps) return { kind: 'none' };
  const queries = parseSharedQueries(ds.appliedSteps);
  if (!queries.length) return { kind: 'unparseable' };
  const folded = foldAppliedStepsToSql(
    baseSelectFromFrom(source.from),
    queries[0].body,
    source.dialect ?? TRANSFORM_DIALECT,
  );
  if (!folded.ok) return { kind: 'not-foldable', step: folded.unfoldableStep };
  return { kind: 'folded', source: { ...source, from: { kind: 'derived', sql: folded.sql } } };
}

/**
 * WAVE-2 FIX — per-table storage now really changes execution for a Get-Data
 * CONNECTION source too (not just loom-native Synapse).
 *
 * Path 4 (a bound connection) historically ALWAYS ran the live executor
 * (`executor.runVisual`), so a per-table Import/Dual storage mode changed nothing
 * for a connection table: the Azure-native refresh route (its
 * `materializableFromConnection`) would still build an Import/Dual Delta cache for
 * that table and the editor badge would read "Cache built", yet every visual kept
 * querying the live source — the cache was written but never read (half-functional
 * Import, a no-vaporware.md gap). This closes it.
 *
 * When the bound connection table is Import or Dual AND a cache has materialized
 * (`state.lastRefresh[table]` present), serve the visual from a serverless
 * `OPENROWSET(FORMAT='DELTA')` over the SAME report-table MLV Delta the refresh
 * route's Spark batch writes. `reportTableMlvSpec` is the SHARED source of truth
 * for that Delta location (same `item.id` + table → same schema/viewName →
 * `resolveMlvDeltaUrl` returns the same URL), so the Delta read here == the Delta
 * written there. The cache-vs-live pick mirrors `wells-to-sql.pickRelation`:
 * Import → cache; Dual → cache for aggregating visuals, live for table/slicer
 * (Dual always keeps a live fallback). The columns/derived-OPENROWSET shape is the
 * exact one `makeFileExecutor` already uses for an ADLS Delta read (real schema via
 * `introspectFields`, never a mock).
 *
 * Returns the real cache rows + emitted SQL, or `null` for EVERY reason the cache
 * can't serve — DirectQuery, no cache yet, a non-aggregate Dual visual, the
 * file/KQL connection objects that have no tabular cache, serverless/ADLS not
 * configured, an introspection miss, or a runtime read failure (e.g. the submitted
 * Spark batch hasn't finished). The caller then falls through to the live executor,
 * so the visual ALWAYS returns real rows, never a blank/mock (no-vaporware.md).
 * 100% Azure-native (serverless Synapse over ADLS Delta); no Power BI / Fabric /
 * OneLake host is reached (no-fabric-dependency.md).
 */
export async function tryConnectionCacheRead(
  item: WorkspaceItem,
  executor: ConnectionExecutor,
  visual: DaxVisual,
  filters: ReportFilterInput[] | undefined,
  appliedStepsBody?: string,
): Promise<{ rows: Record<string, unknown>[]; sql: string } | null> {
  // The connection's Fields-pane table name + the base SELECT its cache holds,
  // reconstructed IDENTICALLY to the refresh route's `materializableFromConnection`
  // so `reportTableMlvSpec` resolves the SAME Delta URL the Spark batch wrote.
  const source = readReportDataSource(item);
  if (!source || source.kind !== 'connection') return null;
  const ref = source.objectRef;
  let table: string;
  let baseSelectSql: string;
  if (ref.mode === 'table') {
    table = ref.table;
    const rel = ref.schema ? `${bracket(ref.schema)}.${bracket(ref.table)}` : bracket(ref.table);
    baseSelectSql = `SELECT * FROM ${rel}`;
  } else if (ref.mode === 'query') {
    table = 'Query';
    baseSelectSql = ref.sql;
  } else {
    // file / kql connection objects are not a materializable tabular cache.
    return null;
  }

  const state = (item.state || {}) as Record<string, unknown>;

  // Per-table storage must be Import or Dual (DirectQuery = live, the default).
  const tsBag = state.tableStorage;
  const tsRaw =
    tsBag && typeof tsBag === 'object' ? (tsBag as Record<string, unknown>)[table] : undefined;
  const mode = tsRaw && typeof tsRaw === 'object' ? (tsRaw as Record<string, unknown>).mode : undefined;
  if (!isStorageMode(mode) || (mode !== 'Import' && mode !== 'Dual')) return null;

  // A cache must actually exist (a refresh has run) — else fall back to live so the
  // editor's "Run Refresh to materialize" badge stays honest, never a blank/mock.
  const lr = state.lastRefresh;
  const lrRec = lr && typeof lr === 'object' ? (lr as Record<string, unknown>)[table] : undefined;
  if (!lrRec || typeof lrRec !== 'object') return null;

  // Dual serves the cache only for aggregating visuals (cards/charts/matrix); a
  // table/slicer reads live (Dual always keeps a live fallback). Import → cache.
  const useCache = mode === 'Import' || isAggregateVisual(visual);
  if (!useCache) return null;

  // Resolve the cache's Delta URL from the SHARED MLV spec + the serverless target.
  // Either being unconfigured ⇒ live fallback (never a crash/blank).
  const deltaUrl = resolveMlvDeltaUrl(reportTableMlvSpec(item.id, table, baseSelectSql));
  if (!deltaUrl) return null;
  let target: SynapseTarget;
  try {
    target = serverlessTarget('master');
  } catch {
    return null;
  }

  // Real schema (no mock) for the identifier whitelist — the cache Delta exposes
  // the same columns as the source table (it materialized `SELECT * FROM (base)`).
  let columns: SqlSourceColumn[];
  try {
    const fieldTables = await executor.introspectFields();
    columns = whitelist(fieldTables[0]);
  } catch {
    return null;
  }
  if (!columns.length) return null;

  // Compile the wells over a serverless OPENROWSET(FORMAT='DELTA') derived source —
  // the SAME proven shape `makeFileExecutor` uses for an ADLS Delta read.
  const u = deltaUrl.replace(/'/g, "''");
  const sqlSource: SqlSource = {
    from: { kind: 'derived', sql: `SELECT * FROM OPENROWSET(BULK '${u}', FORMAT='DELTA') AS r` },
    columns,
    measures: [],
    dialect: 'synapse',
  };
  // WAVE-4: when a Power Query transform is layered on this connection source, fold
  // its applied steps onto the cache's OPENROWSET base SELECT so the cached (base)
  // Delta is read THROUGH the transform — real transformed rows, never the
  // untransformed cache. A non-foldable step ⇒ null (the caller already returned an
  // honest 409; this guards a direct call). Pure SQL fold, still 100% serverless
  // Synapse over ADLS Delta — no Fabric / Power BI / OneLake host.
  if (appliedStepsBody) {
    const folded = foldAppliedStepsToSql(
      (sqlSource.from as { kind: 'derived'; sql: string }).sql,
      appliedStepsBody,
      'synapse',
    );
    if (!folded.ok) return null;
    sqlSource.from = { kind: 'derived', sql: folded.sql };
  }
  const compiled = buildSqlFromVisual(visual, filters, sqlSource);
  if (!compiled) return null; // no fields yet → the live executor surfaces the honest gate.

  try {
    const result = await executeQuery(target, compiled.sql, 30_000, compiled.parameters);
    return { rows: objectRows(result.columns, result.rows), sql: compiled.sql };
  } catch {
    // The cache record exists but the Delta isn't readable yet (e.g. the submitted
    // Spark batch hasn't completed) — fall back to live so the visual still renders
    // real rows. The last-refreshed badge (GET /refresh) reports cache state.
    return null;
  }
}
