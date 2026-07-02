/**
 * POST /api/items/report/[id]/query
 *
 * Executes a report visual against the data source that backs this report and
 * returns the result rows. Used by the Loom-native report renderer and the
 * Visual Designer in ReportLikeEditor / ReportEditor to populate every visual
 * — no Fabric capacity required (no-fabric-dependency.md).
 *
 * THREE execution backends are dispatched. Paths 1 + 2 are unchanged; Path 3 is
 * the report-designer-v2 Azure-native default that needs no Analysis Services:
 *
 *   1. Power BI executeQueries (opt-in)
 *      Body: { workspaceId, datasetId, dax }
 *      Path: `executeDatasetQueries` against the Power BI REST `executeQueries`
 *      JSON endpoint. Reached ONLY when a Power BI workspace + dataset are bound
 *      (`NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi`), so it is never on the default
 *      no-Fabric path. Dataset id is the only required reference.
 *
 *   2. Azure Analysis Services (advanced / back-compat)
 *      Body: { query } | { visual } | { filters }
 *      Path: `resolveReportModel` → `{ backend:'aas', binding }` →
 *      `executeAasQuery` over XMLA. The DAX comes from `body.query` (raw) or
 *      `buildDaxFromVisual(body.visual)` (never hand-typed), and `body.filters`
 *      (the structured Filters pane) are appended via `wrapDaxWithFilters`
 *      (CALCULATETABLE) — so the user never types DAX (no-freeform-config.md).
 *
 *   3. Loom-native SQL over Synapse (Azure-native DEFAULT — report-designer v2)
 *      Body: { visual, filters }
 *      Path: `resolveReportModel` → `{ backend:'loom-native', tables, sqlSource }`
 *      where `sqlSource` is a Loom semantic-model (warehouse/lakehouse via SQL)
 *      or a direct-query derived SELECT. `buildSqlFromVisual(visual, filters,…)`
 *      compiles the field wells into a parameterized `SELECT … GROUP BY` and the
 *      structured filters into a `WHERE`/`HAVING`; the query runs through
 *      `synapse-sql-client.executeQuery` (dedicated pool for a warehouse source,
 *      serverless for a lakehouse source — the resolver already pinned the
 *      target). REAL aggregated rows, NO AAS / Power BI / Fabric, no mock
 *      (no-vaporware.md). Identifiers are whitelisted from the resolved model and
 *      bracket-quoted; values bind as TDS parameters (injection-safe).
 *
 *      SINGLE-TABLE LIMITATION (Power BI parity gap, honest): the wells→SQL
 *      compiler runs ONE FROM relation, so a loom-native visual binds from a
 *      SINGLE model table. This covers the default scaffold-from-query/table
 *      model. A visual whose wells/filters span >1 model table is NOT silently
 *      served from one table (which would drop the other table's fields) — it
 *      returns an honest 400 `code:'multi-table'` naming the remediation. A real
 *      cross-table JOIN needs relationship/foreign-key metadata that the resolver
 *      does not yet surface to this route (TableMapSqlSource carries only a
 *      table→relation map, no join keys); building it is a resolver change, not a
 *      route change. AAS-backed models, whose relationships are defined in the
 *      tabular model, answer cross-table visuals via Path 2.
 *
 * ── REPORT-DESIGNER PARITY · WAVE 1 — the well-fold + filter-channel contract ──
 *
 * Wave 1 widens the report designer toward Power BI authoring parity
 * (docs/fiab/parity/report-designer.md) WITHOUT adding a backend route: every
 * new capability renders REAL aggregated rows through the unchanged Path-3
 * wells→SQL path (or the Path-2 DAX mirror), and the rest applies client-side in
 * LoomChart. This route therefore does NOT branch per visual type, per format
 * option, per analytics line, or per interaction — it stays a pure
 * wells + filters → SQL/DAX compiler. Two client-side contracts keep that real:
 *
 *   1. WELL FOLD (expanded visual gallery). The eight new visual types — combo
 *      (line + clustered/stacked column), waterfall, funnel, gauge, KPI,
 *      treemap, multi-row card, ribbon — plus the bar/column stacking /
 *      clustered / 100% toggle, introduce new Power BI wells: Secondary values
 *      (combo), Target / Min / Max (gauge / KPI), Tooltips, Small multiples,
 *      Details (treemap). The designer's `queryVisual()` FOLDS these into the
 *      three wells this route already reads BEFORE the POST: Secondary-values /
 *      Target / Min / Max / Tooltips → extra `wells.values` aggregates; Small
 *      multiples / Details → extra `wells.category` (group) columns. The wire
 *      payload that reaches `/query` thus still carries only `category` /
 *      `values` / `legend` (DaxVisual.wells), so `buildSqlFromVisual` /
 *      `buildDaxFromVisual` compile the extra fields into the same `GROUP BY` +
 *      value aggregates and return REAL rows; LoomChart reads the extra result
 *      columns to draw the new chart shape. Because `referencedTables()` (the
 *      multi-table gate below) scans `category` / `values` / `legend`, it already
 *      covers every folded field — a Small-multiples / Tooltip field pointing at
 *      a second model table is still caught by the honest `code:'multi-table'`
 *      gate, never silently dropped (no-vaporware.md).
 *
 *   2. FILTER CHANNEL (richer Filters pane). The new Filters-pane ops — Top N
 *      (`op:'topN'`, N + by-measure) and Relative date (`op:'relativeDate'`,
 *      last/next N day / month / year) — plus per-card lock/hide ride the
 *      EXISTING `body.filters` channel (`ReportFilterInput[]`, whose `op` union
 *      already includes `topN` / `relativeDate`). wells-to-sql compiles Top N to
 *      `TOP N … ORDER BY <measure> DESC` and relative-date to a parameterized
 *      date-range `WHERE` (with the `wrapDaxWithFilters` DAX mirror), so the route
 *      passes `filters` straight through to both backends unchanged.
 *
 * Deep Format (data/total labels, background / border / shadow, plot area,
 * position/size, styles preset, structured conditional formatting), the Analytics
 * pane (Trend / Constant / Min / Max / Average / Median reference lines computed
 * over the result series) and Visual interactions (filter / highlight / none
 * cross-filtering) are pure LoomChart client concerns over THESE rows — no
 * request to this route changes for them. Net effect on this file: documentation
 * only; the dispatch, `resolveReportModel`, the single-table multi-table gate, and
 * `referencedTables()` are intentionally untouched and already Wave-1-complete. AI
 * visuals, R/Python, maps / ArcGIS / bubble, bookmarks / themes / export,
 * drillthrough and personalize remain honest gate / MISSING follow-on waves in
 * the parity doc.
 *
 * ── REPORT-DESIGNER PARITY · WAVE 2 — per-table STORAGE MODES (source groups) ──
 *
 * A model table's Power BI storage mode now really changes execution, all Azure-
 * native (no Fabric / Power BI — no-fabric-dependency.md). When the report has
 * per-table storage configured, `resolveReportModel` hands Path 3 a
 * `source-groups` sqlSource — a model-table → { live, cache } binding map. For
 * each visual this route picks the relation per the table's mode (DirectQuery /
 * Dual-live → the pinned live pool + base relation; Import / Dual-cache / Direct
 * Lake → serverless `OPENROWSET` over the materialized — or own — Delta) and runs
 * the compiled SQL on THAT relation's own Synapse target instead of one fixed
 * target. So Import really reads the materialized Delta cache, DirectQuery really
 * runs live, and Dual picks per-visual (cache for aggregations once built, live
 * otherwise) — no mock, no dead control (no-vaporware.md). A visual that joins
 * tables across storage-mode groups is a "limited relationship": it requires the
 * smaller side's Import cache and otherwise returns an honest 412 naming the
 * exact table to materialize (extending the multi-table gate, never a silent
 * partial). Reports with no per-table storage keep the single-source path below
 * byte-for-byte. The StorageMode union is owned by storage-mode-pane.tsx; the
 * resolver owns SourceGroupSqlSource / TableSourceBinding and wells-to-sql owns
 * the pick helpers — consumed here through small string-validated LOCAL MIRRORS
 * (the same client→server mirror pattern Wave 1 used for ReportConnType).
 *
 * When no data source is configured the resolver returns an honest 412 gate
 * naming the exact remediation ("pick a data source", or the precise AAS /
 * Synapse env var) — never a silent empty result.
 *
 * 200 OK → { ok: true, rows, sql | daxQuery }
 * 412    → { ok: false, code: 'unbound', error } (honest, actionable)
 * 4xx/5xx → { ok: false, error, status? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeDatasetQueries, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  executeAasQuery,
  buildDaxFromVisual,
  flattenAasRows,
  AasError,
  type DaxVisual,
} from '@/lib/azure/aas-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import { executeQuery, serverlessTarget, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import {
  resolveReportModel,
  readReportDataSource,
  reportTableMlvSpec,
  bracket,
  isStorageMode,
  type ConnectionExecutor,
  type FieldTable,
  type ReportSqlSource,
  type ResolvedReportModel,
} from '@/lib/azure/report-model-resolver';
import { resolveMlvDeltaUrl } from '@/lib/azure/materialized-lake-view-engine';
import {
  buildSqlFromVisual,
  wrapDaxWithFilters,
  type SqlDialect,
  type SqlSource,
  type SqlSourceColumn,
  type SqlSourceFrom,
  type ReportFilterInput,
  type DrillState,
  type ScalarParamBinding,
  type VisualCompileOptions,
} from '@/lib/azure/wells-to-sql';
import {
  fromLegacyState,
  hasTransform,
  reportTransformMode,
} from '@/lib/editors/report/report-data-source';
import { foldAppliedStepsToSql, parseSharedQueries } from '@/lib/components/pipeline/dataflow/m-script';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface QueryRequest {
  // Path 1 — Power BI Visual Designer path (opt-in)
  workspaceId?: string;
  datasetId?: string;
  dax?: string;
  // Path 2 — AAS (legacy single-field + rich field wells from the designer)
  query?: string;
  visual?: DaxVisual & Record<string, unknown>;
  // Paths 2 + 3 — structured Filters-pane predicates (report/page/visual scope,
  // already merged by the designer). Compiled to a DAX CALCULATETABLE (AAS) or a
  // SQL WHERE/HAVING (loom-native) server-side — the user never types DAX/SQL.
  filters?: ReportFilterInput[];
  // Wave-8 interactivity (additive; undefined ⇒ byte-identical compile):
  //   • `drill` — the in-visual drill state (active hierarchy level + ancestor
  //     path) so the loom-native compiler truncates the GROUP BY + adds the path
  //     WHERE, re-querying REAL Synapse rows for the sub-level.
  //   • `whatIf` — bound numeric what-if values flowed into the value aggregates.
  // Forwarded straight to `buildSqlFromVisual`'s 4th options arg.
  drill?: DrillState;
  whatIf?: ScalarParamBinding[];
}

// ── loom-native bridge ────────────────────────────────────────────────────────
//
// The resolver hands `/query` a `ReportSqlSource` (a model-table→base-relation
// map, or a direct-query derived SELECT) plus the Fields-pane `tables`. The
// wells→SQL compiler runs over a SINGLE FROM relation with a flat column
// whitelist, so we project the resolved model onto that shape: for a derived
// source the single synthetic table; for a table-map source the ONE model table
// the visual references (the common scaffold-from-query case is single-table).
// Identifiers come only from the resolved model — never from the request.
//
// Multi-table honesty (no-vaporware): when a visual's wells/filters reference
// MORE THAN ONE mapped model table, the single-FROM projection would silently
// drop every field of the non-chosen table (a `resolveColumn` whitelist miss),
// returning a partial-but-real-looking result. Instead, `toSqlSource` detects
// that case and the route returns an honest 400 (`code:'multi-table'`) naming
// the limitation + remediation. A genuine cross-table JOIN is intentionally NOT
// faked here: no relationship metadata reaches this route to author one safely.

/** Collect the model-table names a visual + its filters reference. */
function referencedTables(visual: DaxVisual, filters: ReportFilterInput[] | undefined): string[] {
  const out = new Set<string>();
  const wells = visual.wells || {};
  for (const arr of [wells.category, wells.values, wells.legend]) {
    for (const w of arr || []) if (w?.table) out.add(w.table);
  }
  for (const f of filters || []) if (f?.table) out.add(f.table);
  return [...out];
}

/** Map resolved Fields columns of one table to the compiler's column whitelist. */
function whitelist(table: FieldTable | undefined): SqlSourceColumn[] {
  return (table?.columns || []).map((c) => ({
    table: table?.name,
    name: c.name,
    dataType: c.dataType,
  }));
}

/**
 * Outcome of projecting the resolved model onto the single-FROM SQL compiler:
 *   • `ok`          — a bindable `SqlSource` (one model table or the derived
 *                     SELECT). `target` is set ONLY on the Wave-2 source-groups
 *                     path, where the chosen relation (live pool vs serverless
 *                     Delta cache) runs on its OWN Synapse target; absent ⇒ the
 *                     single-source caller keeps the resolver-pinned target.
 *   • `no-columns`  — nothing bindable resolved (caller → generic 400)
 *   • `multi-table` — the visual binds across >1 model table; the single-FROM
 *                     compiler can't join them, so the caller returns an honest
 *                     400 naming the tables + remediation (never a silent drop).
 *   • `limited`     — Wave-2 cross-storage-group ("limited relationship") visual;
 *                     the caller returns an honest 412 naming the smaller side to
 *                     materialize (never a silent partial join).
 */
type ToSqlSourceResult =
  | { kind: 'ok'; source: SqlSource; target?: SynapseTarget }
  | { kind: 'no-columns' }
  | { kind: 'multi-table'; tables: string[] }
  | { kind: 'limited'; smaller: string; cacheReady: boolean; groups: string[] };

// ── REPORT-DESIGNER PARITY · WAVE 2 — per-table STORAGE MODES (source groups) ──
//
// The resolver emits a `source-groups` ReportSqlSource ONLY when the report has
// per-table storage configured (else it keeps emitting the single-source
// table-map / derived arms below, byte-identical). Its bindings map each model
// table to a { live, cache } relation pair + the table's storage mode; this
// route picks live-vs-cache per visual and runs the compiled SQL on THAT
// relation's own Synapse target (the pinned pool for live, serverless for an
// Import/Dual/Direct-Lake Delta cache). Azure-native end to end — no Fabric /
// Power BI (no-fabric-dependency.md), no mock (no-vaporware.md).
//
// SHARED CONTRACT: storage-mode-pane.tsx owns the `StorageMode` union; the
// resolver owns `SourceGroupSqlSource` / `TableSourceBinding`; wells-to-sql owns
// the `isAggregateVisual` / `pickRelation` / `groupVisualBindings` helpers. They
// are consumed here through small string-validated LOCAL MIRRORS — the exact
// client→server mirror pattern Wave 1 used for `ReportConnType` — so this route
// compiles standalone and stays robust to the landing order of its sibling
// modules, while binding to the SAME `resolved.sqlSource` shape at runtime.

/** Local mirror of the storage-mode-pane `StorageMode` union (string-validated). */
type StorageMode = 'DirectQuery' | 'Import' | 'Dual' | 'DirectLake';

/** Local mirror of the resolver's per-table source-group binding (relation pair
 *  + storage mode). `live` is the DirectQuery / Dual-live relation on its Synapse
 *  pool; `cache` is the Import / Dual-cache / Direct-Lake serverless OPENROWSET
 *  over Delta. `cacheReady` is true once an Import/Dual cache has materialized
 *  (Direct Lake reads its own Delta, so the resolver marks it ready). */
interface TableSourceBinding {
  group: string;
  storageMode: StorageMode;
  live?: { from: SqlSourceFrom; target: SynapseTarget; kind: 'warehouse' | 'lakehouse' };
  cache?: { from: SqlSourceFrom; target: SynapseTarget; deltaUrl: string };
  cacheReady: boolean;
  rowEstimate?: number;
}

/** Local mirror of the resolver's generalized `source-groups` SQL-source arm. */
interface SourceGroupSqlSource {
  mode: 'source-groups';
  target: SynapseTarget;
  kind: 'warehouse' | 'lakehouse';
  bindings: Record<string, TableSourceBinding>;
}

/**
 * Structural detection of a `source-groups` ReportSqlSource. Reads the value as
 * `unknown` so it never trips a no-overlap (TS2367) comparison whether or not the
 * resolver's `ReportSqlSource` union has grown to carry the arm yet. Returns the
 * binding map when present, else null (the single-source table-map / derived case).
 */
function asSourceGroups(ss: unknown): SourceGroupSqlSource | null {
  if (
    ss && typeof ss === 'object' &&
    (ss as { mode?: unknown }).mode === 'source-groups' &&
    (ss as { bindings?: unknown }).bindings &&
    typeof (ss as { bindings?: unknown }).bindings === 'object'
  ) {
    return ss as SourceGroupSqlSource;
  }
  return null;
}

/** Aggregating visuals (card / chart / matrix) vs row visuals (table / slicer).
 *  Mirror of wells-to-sql.isAggregateVisual — drives the Dual cache-vs-live pick. */
function isAggregateVisual(visual: DaxVisual): boolean {
  const t = (visual.type || '').toLowerCase();
  return t !== 'table' && t !== 'slicer';
}

/**
 * Per-table relation pick (mirror of wells-to-sql.pickRelation):
 *   • Import / DirectLake → `cache`, falling back to `live` when no cache yet;
 *   • Dual                → `cache` when (cacheReady && the visual aggregates),
 *                           else `live` (always a live fallback);
 *   • DirectQuery         → `live`.
 */
function pickRelation(b: TableSourceBinding, isAggregate: boolean): 'live' | 'cache' {
  switch (b.storageMode) {
    case 'Import':
    case 'DirectLake':
      return b.cacheReady ? 'cache' : 'live';
    case 'Dual':
      return b.cacheReady && isAggregate ? 'cache' : 'live';
    case 'DirectQuery':
    default:
      return 'live';
  }
}

/**
 * Group a visual's referenced model tables by `binding.group` (mirror of
 * wells-to-sql.groupVisualBindings). One group → the representative table to
 * bind (the single-relation pick); many groups → a limited relationship via the
 * materialized SMALLER side (least `rowEstimate`) — the table the caller requires
 * an Import cache for.
 */
function groupVisualBindings(
  s: SourceGroupSqlSource,
  refs: string[],
): { single: string } | { groups: string[]; smaller: string } {
  const present = refs.filter((r) => s.bindings[r]);
  const groups = Array.from(new Set(present.map((r) => s.bindings[r].group)));
  if (groups.length <= 1) {
    return { single: present[0] || Object.keys(s.bindings)[0] || '' };
  }
  let smaller = present[0];
  let best = Number.POSITIVE_INFINITY;
  for (const r of present) {
    const est = s.bindings[r].rowEstimate ?? Number.MAX_SAFE_INTEGER;
    if (est < best) {
      best = est;
      smaller = r;
    }
  }
  return { groups, smaller };
}

/**
 * Project a `source-groups` SQL source onto the single-FROM wells→SQL compiler
 * for ONE visual: pick the live-vs-cache relation per the table's storage mode
 * and return the bindable `SqlSource` + the Synapse target to run it on. A
 * cross-group visual returns a `limited` gate (no silent partial); a single group
 * that still spans >1 model table returns the existing honest `multi-table` gate
 * (the single-FROM compiler can't join them without relationship keys).
 */
function projectSourceGroups(
  tables: FieldTable[],
  sg: SourceGroupSqlSource,
  visual: DaxVisual,
  filters: ReportFilterInput[] | undefined,
): ToSqlSourceResult {
  const refs = Array.from(
    new Set(referencedTables(visual, filters).filter((t) => sg.bindings[t])),
  );
  const grouped = groupVisualBindings(sg, refs);

  // Cross-group → limited relationship via the materialized smaller side.
  if ('groups' in grouped) {
    const b = sg.bindings[grouped.smaller];
    return {
      kind: 'limited',
      smaller: grouped.smaller,
      cacheReady: !!(b && b.cacheReady),
      groups: grouped.groups,
    };
  }

  // Single group but >1 distinct model table → the single-FROM compiler can't
  // join them here (no relationship keys surfaced); honest multi-table gate.
  if (refs.length > 1) return { kind: 'multi-table', tables: refs };

  const key = grouped.single || refs[0] || Object.keys(sg.bindings)[0] || '';
  const b = sg.bindings[key];
  if (!b) return { kind: 'no-columns' };

  const rel = pickRelation(b, isAggregateVisual(visual));
  // Import / Dual without a built cache fall back to live; Direct Lake's "cache"
  // is its own-Delta OPENROWSET. Guard a missing relation either way.
  const chosen = rel === 'cache' ? (b.cache ?? b.live) : (b.live ?? b.cache);
  if (!chosen) return { kind: 'no-columns' };

  const columns = whitelist(tables.find((t) => t.name === key) || tables[0]);
  if (!columns.length) return { kind: 'no-columns' };

  return {
    kind: 'ok',
    source: { from: chosen.from, columns, measures: [] },
    target: chosen.target,
  };
}

/**
 * Build the wells→SQL `SqlSource` (FROM relation + identifier whitelist) for a
 * loom-native report from the resolver's `ReportSqlSource` + Fields `tables`.
 *
 * Returns `{ kind:'no-columns' }` when nothing bindable resolves, and
 * `{ kind:'multi-table' }` when the visual/filters span more than one mapped
 * model table — the single-FROM compiler can only serve a single table, so the
 * caller surfaces an honest gate rather than silently dropping the other table's
 * fields (Power BI parity gap; see the file header + bridge comment).
 */
function toSqlSource(
  tables: FieldTable[],
  sqlSource: ReportSqlSource,
  visual: DaxVisual,
  filters: ReportFilterInput[] | undefined,
): ToSqlSourceResult {
  // Wave 2 — per-table storage modes. When the resolver emits a `source-groups`
  // arm (only when the report has per-table storage configured), pick the live-
  // vs-cache relation per visual and run it on that relation's own target.
  // Detected structurally so this stays type-safe regardless of whether the
  // resolver's `ReportSqlSource` union has grown to carry the arm yet.
  const sg = asSourceGroups(sqlSource);
  if (sg) return projectSourceGroups(tables, sg, visual, filters);

  // Past here only the original single-source modes are reachable; narrow the
  // (possibly-grown) union so the table-map access below stays type-safe.
  if (sqlSource.mode !== 'derived' && sqlSource.mode !== 'table-map') {
    return { kind: 'no-columns' };
  }

  // direct-query: the resolver already validated the SELECT (and flattened any
  // model into a single derived relation); expose the introspected table's
  // columns as the whitelist.
  if (sqlSource.mode === 'derived') {
    const columns = whitelist(tables.find((t) => t.name === sqlSource.tableName) || tables[0]);
    if (!columns.length) return { kind: 'no-columns' };
    return {
      kind: 'ok',
      source: { from: { kind: 'derived', sql: sqlSource.sql }, columns, measures: [] },
    };
  }

  // table-map: the wells→SQL compiler runs over ONE FROM relation, so this route
  // can only serve a visual whose fields all come from a SINGLE model table.
  const map = sqlSource.tableMap;
  const mapped = Object.keys(map);
  if (!mapped.length) return { kind: 'no-columns' };

  // Honest multi-table gate (no-vaporware): a visual (or its column filters)
  // that binds across >1 mapped model table can't be answered by a single-table
  // SELECT, and no relationship metadata is surfaced here to author a JOIN.
  // Rather than picking one table and silently dropping the other's fields,
  // report the spanned tables so the caller can name the exact remediation.
  const referenced = Array.from(
    new Set(referencedTables(visual, filters).filter((t) => map[t])),
  );
  if (referenced.length > 1) {
    return { kind: 'multi-table', tables: referenced };
  }

  // ≤1 referenced table → bind it; else the only mapped table, else the first
  // mapped table with bindable columns (the single-table scaffold default).
  const chosen: string =
    referenced[0] ||
    (mapped.length === 1 ? mapped[0] : '') ||
    tables.map((t) => t.name).find((n) => map[n]) ||
    mapped[0];

  const relation = map[chosen];
  if (!relation) return { kind: 'no-columns' };
  const columns = whitelist(tables.find((t) => t.name === chosen));
  if (!columns.length) return { kind: 'no-columns' };
  return {
    kind: 'ok',
    source: {
      from: { kind: 'table', schema: relation.schema, table: relation.table },
      columns,
      // Loom-native measures are name-only in the Fields tree (no SQL expression
      // is resolved for them here); value wells aggregate their bound COLUMN via
      // the compiler's default agg, so column-backed visuals render real rows.
      measures: [],
    },
  };
}

/** Zip executeQuery's columnar result into object rows keyed by column alias —
 *  the same row shape the AAS (flattenAasRows) and Power BI paths return, so the
 *  client renders every backend identically. */
function objectRows(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      o[c] = r[i];
    });
    return o;
  });
}

// ── REPORT-BUILDER PARITY · WAVE 4 — Power Query "Transform Data" fold ──────────
//
// A report's data source can carry an OPTIONAL Power Query transform authored by
// the report Transform host — the SAME `PowerQueryHost` the Dataflow Gen2 editor
// mounts — persisted on `state.dataSource.appliedSteps` as a full M section built
// exclusively via `m-script.appendStep` (structured dialogs / ribbon, never
// hand-typed — no-freeform-config). DirectQuery (the default) FOLDS those applied
// steps onto the resolved source's base SELECT: `foldAppliedStepsToSql` emits
// nested, dialect-quoted derived SELECTs so EVERY visual runs over the TRANSFORMED
// data — real rows on Synapse / the connector dialect, no mock (no-vaporware),
// 100% Azure-native (no api.fabric / api.powerbi / onelake host on any path —
// no-fabric-dependency). A non-foldable step (parse JSON/XML, transpose, pivot,
// examples-heuristics …) is an HONEST 409 (`code:'not-foldable'`) naming the step
// + the Import remediation, never a silently-wrong read. The Import path
// materializes the steps via the report /refresh Spark/wrangling Delta cache and
// the fold then runs over that cache (the W2 cache-read).
//
// The transform mixin (`appliedSteps`/`transformMode`) is read from persisted
// state via the CLIENT data-source parser (`fromLegacyState` — it carries the
// Wave-4 mixin; the resolver's `readReportDataSource` intentionally drops it,
// exactly as the sibling /native-query + /profile routes do). A report WITHOUT a
// transform skips all of this and behaves byte-for-byte as before (back-compat).

/** The Loom-native report path folds + compiles over the Synapse SQL family. */
const TRANSFORM_DIALECT: SqlDialect = 'synapse';

/** Strip a trailing `;` so a base SELECT splices cleanly as a derived relation. */
function stripSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

/** The base SELECT a transform folds onto, from a resolved FROM relation: a
 *  derived source's own SELECT, or `SELECT * FROM [schema].[table]` for a table. */
function baseSelectFromFrom(from: SqlSourceFrom): string {
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
function connectionBaseSelect(source: ReturnType<typeof readReportDataSource>): string | null {
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
type TransformFold =
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
function foldTransformOntoSource(
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
async function tryConnectionCacheRead(
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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as QueryRequest;
  const filters = Array.isArray(body.filters) ? body.filters : undefined;
  // Wave-8 interactivity compile options (drill + what-if). Structured + bounded
  // by the wells-to-sql compiler; undefined ⇒ the pre-Wave-8 compile (no change).
  const compileOpts: VisualCompileOptions | undefined =
    body.drill || (Array.isArray(body.whatIf) && body.whatIf.length)
      ? { ...(body.drill ? { drill: body.drill } : {}), ...(Array.isArray(body.whatIf) ? { whatIf: body.whatIf } : {}) }
      : undefined;

  // ------------------------------------------------------------------
  // Path 1 — Power BI executeQueries (opt-in Visual Designer path)
  // ------------------------------------------------------------------
  const workspaceId = body.workspaceId?.trim();
  const datasetId = body.datasetId?.trim();
  const dax = body.dax?.trim();
  if (workspaceId && datasetId && dax) {
    const hasEvaluate = /\bEVALUATE\b/i.test(dax);
    if (!hasEvaluate) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'The visual has no fields yet — add a category/value field to generate a runnable query.',
        },
        { status: 400 },
      );
    }
    // Filters are applied via CALCULATETABLE when the dax is a wrappable EVALUATE.
    const wrapped = wrapDaxWithFilters(dax, filters);
    try {
      const result = await executeDatasetQueries(workspaceId, datasetId, wrapped);
      const table = result?.results?.[0]?.tables?.[0];
      return NextResponse.json({ ok: true, rows: table?.rows || [], dax: wrapped });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json(
        { ok: false, error: e?.message || String(e), status },
        { status },
      );
    }
  }

  // ------------------------------------------------------------------
  // Load the report item (loom: content id OR plain Cosmos id), owner-checked.
  // ------------------------------------------------------------------
  const id = (await ctx.params).id;
  const rawQuery: string = (body?.query || '').toString().trim();

  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) {
      return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
    }
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) {
      return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
    }
  }

  // ------------------------------------------------------------------
  // Resolve the report's DATA SOURCE → backend (Azure-native default). This is
  // the one place the new sourcing logic lives; the route just dispatches.
  // ------------------------------------------------------------------
  let resolved: ResolvedReportModel;
  try {
    resolved = await resolveReportModel(item, session.claims.oid);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }

  // Honest gate — name the exact remediation ("pick a data source", or the
  // precise AAS / Synapse env var), never a silent empty result.
  if (resolved.backend === 'unbound') {
    return NextResponse.json(
      { ok: false, code: 'unbound', error: resolved.gate.error },
      { status: 412 },
    );
  }

  // ------------------------------------------------------------------
  // Path 3 — Loom-native SQL over Synapse (Azure-native DEFAULT)
  // ------------------------------------------------------------------
  if (resolved.backend === 'loom-native') {
    if (!body?.visual) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'This report uses a Loom-native (Synapse) data source — pass a visual with field ' +
            'wells so the query can be compiled. Raw DAX (query) only applies to an Azure ' +
            'Analysis Services source.',
        },
        { status: 400 },
      );
    }
    const projected = toSqlSource(resolved.tables, resolved.sqlSource, body.visual, filters);
    // Honest parity gate: the visual binds across >1 model table and the
    // single-FROM compiler can't join them. Name the spanned tables + the exact
    // remediation instead of returning a silently partial result.
    if (projected.kind === 'multi-table') {
      return NextResponse.json(
        {
          ok: false,
          code: 'multi-table',
          error:
            `This visual binds fields from more than one table of the semantic model ` +
            `(${projected.tables.join(', ')}). The Loom-native (Synapse) report renderer runs ` +
            `each visual over a single model table, so cross-table visuals aren’t supported on ` +
            `this Azure-native path yet. Use a semantic model — or a direct-query SELECT — whose ` +
            `single table already joins these fields, or bind the report to an Azure Analysis ` +
            `Services model where the table relationships are defined.`,
        },
        { status: 400 },
      );
    }
    // Wave-2 cross-storage-group "limited relationship": the visual joins tables
    // that live in different storage-mode groups. Power BI serves these only via
    // the materialized smaller side, so the renderer requires that side's Import
    // cache. Return an honest 412 naming the exact table to materialize — never a
    // silent partial / cross join (no-vaporware.md). Azure-native throughout.
    if (projected.kind === 'limited') {
      return NextResponse.json(
        {
          ok: false,
          code: 'limited-relationship',
          error: projected.cacheReady
            ? `This visual combines tables that live in different storage-mode groups ` +
              `(${projected.groups.join(', ')}). Cross-group ("limited relationship") joins need ` +
              `relationship keys defined in the model; the Loom-native (Synapse) renderer runs each ` +
              `visual over a single relation and won't cross-join "${projected.smaller}" with the ` +
              `other group's source. Model these fields in one semantic-model table (or a direct-query ` +
              `SELECT that already joins them), or use an Azure Analysis Services model where the ` +
              `relationships are defined. No Power BI / Fabric workspace required either way.`
            : `This visual combines tables across storage-mode groups via the smaller side ` +
              `"${projected.smaller}", but that table has no materialized Import cache yet. Set ` +
              `"${projected.smaller}" to Import (or Dual) in Storage mode and run Refresh to ` +
              `materialize its Delta cache, then re-run — the cross-group ("limited relationship") ` +
              `visual reads the materialized smaller side. This is Azure-native (serverless ` +
              `OPENROWSET over Delta); no Power BI / Fabric workspace is required.`,
          missing: projected.smaller,
        },
        { status: 412 },
      );
    }
    if (projected.kind === 'no-columns') {
      return NextResponse.json(
        { ok: false, error: 'The report’s data source has no bindable columns for this visual.' },
        { status: 400 },
      );
    }
    // ── WAVE-4: fold any Power Query transform onto the resolved relation ───────
    // DirectQuery folds the applied steps to a derived SELECT here; Import's
    // resolved relation (the W2 source-groups arm already picked live-vs-cache as
    // `projected.source.from`) is folded the SAME way, so the visual always runs
    // over the TRANSFORMED data. A non-foldable step is an honest 409 (Import
    // materializes it via the report /refresh run), never a silently-wrong read.
    // No transform ⇒ byte-identical to before (back-compat).
    const reportSource = fromLegacyState((item.state || {}) as Record<string, unknown>);
    const fold = foldTransformOntoSource(projected.source, reportSource);
    if (fold.kind === 'unparseable') {
      return NextResponse.json(
        {
          ok: false,
          code: 'gate',
          error:
            'The report’s Power Query transform could not be parsed. Re-open Transform data and ' +
            're-apply the steps.',
        },
        { status: 412 },
      );
    }
    if (fold.kind === 'not-foldable') {
      const importMode = reportTransformMode(reportSource) === 'import';
      return NextResponse.json(
        {
          ok: false,
          code: 'not-foldable',
          unfoldableStep: fold.step,
          error:
            `Step '${fold.step}' can't fold to a native query — switch this query to Import.` +
            (importMode
              ? ' This query is already set to Import — run Refresh to materialize it via the dataflow run, then it reads the materialized Delta.'
              : ' Set this query to Import in Transform data and run Refresh to materialize it (Synapse-Spark → Delta), or remove/replace the non-foldable step.'),
        },
        { status: 409 },
      );
    }
    const sqlSource = fold.kind === 'folded' ? fold.source : projected.source;
    const compiled = buildSqlFromVisual(body.visual, filters, sqlSource, compileOpts);
    if (!compiled) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'The visual has no fields yet — add a category/value field to generate a runnable query.',
        },
        { status: 400 },
      );
    }
    try {
      // Wave-2 source-group visuals run on THEIR chosen relation's target —
      // serverless for an Import / Dual / Direct-Lake Delta cache, the pinned
      // pool for a live (DirectQuery / Dual-live) relation. Single-source reports
      // set no override and keep the resolver-pinned target, byte-for-byte.
      const runTarget = projected.target ?? resolved.sqlSource.target;
      const result = await executeQuery(runTarget, compiled.sql, 30_000, compiled.parameters);
      return NextResponse.json({
        ok: true,
        rows: objectRows(result.columns, result.rows),
        sql: compiled.sql,
        elapsedMs: result.executionMs,
        rowCount: result.rowCount,
      });
    } catch (e: any) {
      return NextResponse.json(
        { ok: false, error: e?.message || String(e), status: 502 },
        { status: 502 },
      );
    }
  }

  // ------------------------------------------------------------------
  // Path 4 — Get Data (WAVE 1): a connection / file-backed report source
  // (Azure-native, opt-in NEVER required). A NEW, PARALLEL dispatch arm next to
  // Path 2 (AAS) and Path 3 (loom-native Synapse) — the existing paths above are
  // untouched. The resolver already loaded the LoomConnection (or resolved the
  // ADLS/upload file path), resolved any KV secret, checked the per-engine env
  // gate, and handed back a `ConnectionExecutor` wired to a REAL Azure data-plane
  // client (azure-sql / synapse / databricks / postgres / cosmos / serverless
  // OPENROWSET). Unbindable/unconfigured sources are already a 412 honest gate
  // (handled above), so this arm is the bound, runnable case only.
  //
  // The route stays a thin dispatcher (same contract as the loom-native arm):
  // require a `visual` (the user never types SQL/KQL — wells compile server-side,
  // no-freeform-config), call `executor.runVisual`, and return the REAL object
  // rows the executor produced plus the emitted query text under `sql` (sql /
  // nosql engines) or `kql` (ADX). No mock data (no-vaporware), no Fabric
  // (no-fabric-dependency). A backend execution failure is surfaced verbatim as
  // an honest 502.
  // ------------------------------------------------------------------
  if (resolved.backend === 'connection') {
    if (!body?.visual) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'This report uses a Get Data (connection) source — pass a visual with field ' +
            'wells so the query can be compiled. Raw DAX (query) only applies to an Azure ' +
            'Analysis Services source.',
        },
        { status: 400 },
      );
    }
    // ── WAVE-4: a Power Query transform layered on a Get-Data connection source ──
    // The resolver-owned LIVE executor can't accept a folded FROM, so a connection
    // transform is served Azure-native by folding over the materialized Delta CACHE
    // (serverless OPENROWSET) — the SAME Delta the report /refresh Spark batch
    // writes (reportTableMlvSpec, shared SoT). We NEVER fall through to runVisual
    // when a transform is set (that would read the untransformed source — a silent
    // wrong result, no-vaporware). Foldability is validated up front so a
    // non-foldable step is an honest 409.
    const connSource = fromLegacyState((item.state || {}) as Record<string, unknown>);
    if (hasTransform(connSource) && connSource?.appliedSteps) {
      const queries = parseSharedQueries(connSource.appliedSteps);
      if (!queries.length) {
        return NextResponse.json(
          {
            ok: false,
            code: 'gate',
            error:
              'The report’s Power Query transform could not be parsed. Re-open Transform data and ' +
              're-apply the steps.',
          },
          { status: 412 },
        );
      }
      const base = connectionBaseSelect(readReportDataSource(item));
      if (base) {
        const probe = foldAppliedStepsToSql(base, queries[0].body, TRANSFORM_DIALECT);
        if (!probe.ok) {
          return NextResponse.json(
            {
              ok: false,
              code: 'not-foldable',
              unfoldableStep: probe.unfoldableStep,
              error:
                `Step '${probe.unfoldableStep}' can't fold to a native query — switch this query to ` +
                `Import. Set this query to Import in Transform data, set the table’s Storage mode to ` +
                `Import, and run Refresh to materialize it (Synapse-Spark → Delta); the transformed ` +
                `read then serves from the materialized cache.`,
            },
            { status: 409 },
          );
        }
      }
      // Import → fold over the materialized Delta cache (serverless OPENROWSET over
      // the report-table MLV Delta the refresh route wrote). Returns null when no
      // cache is built yet / the source's storage isn't Import-Dual — handled by
      // the honest gate below, never an untransformed read.
      try {
        const cached = await tryConnectionCacheRead(
          item,
          resolved.executor,
          body.visual,
          filters,
          queries[0].body,
        );
        if (cached) {
          return NextResponse.json({ ok: true, rows: cached.rows, sql: cached.sql });
        }
      } catch (e: any) {
        return NextResponse.json(
          { ok: false, error: e?.message || String(e), status: 502 },
          { status: 502 },
        );
      }
      // No materialized transformed cache to read (the transform is DirectQuery over
      // a live connection — which the resolver-owned executor can't fold through
      // without a resolver change — or its Import cache isn't built yet). Honest 412
      // naming the exact remediation; never an untransformed read. Azure-native
      // (serverless OPENROWSET over Delta); no Fabric / Power BI.
      return NextResponse.json(
        {
          ok: false,
          code: 'transform-import-required',
          missing: resolved.connType,
          error:
            `A Power Query transform over a Get Data "${resolved.connType}" connection source is ` +
            `served Azure-native by materializing it to a Delta cache. Set this query to Import in ` +
            `Transform data, set the table’s Storage mode to Import, and run Refresh — the ` +
            `transformed visual then reads the materialized cache (serverless OPENROWSET over ` +
            `Delta). No Fabric / Power BI workspace is required.`,
        },
        { status: 412 },
      );
    }
    try {
      // WAVE-2 FIX — per-table storage now really changes execution for a Get-Data
      // CONNECTION source too. When the bound table is Import/Dual AND its Delta
      // cache has materialized, read the serverless OPENROWSET over the SAME Delta
      // the Azure-native refresh route wrote (reportTableMlvSpec — shared SoT), so
      // an Import connection table is served from cache instead of being silently
      // re-queried live (the half-functional gap this closes). Returns null for
      // DirectQuery / no-cache-yet / a non-aggregate Dual visual / any setup-or-read
      // miss, so we fall through to the live executor below and the visual always
      // returns real rows (no blank/mock). No Power BI / Fabric / OneLake host.
      const cached = await tryConnectionCacheRead(item, resolved.executor, body.visual, filters);
      if (cached) {
        return NextResponse.json({ ok: true, rows: cached.rows, sql: cached.sql });
      }
      const { rows, query, lang } = await resolved.executor.runVisual(body.visual, filters);
      // Rows are already object-shaped (Record<string, unknown>[]) — identical to
      // the AAS / Power BI / loom-native paths — so the client renders every
      // backend the same way. The emitted query text rides under `kql` for ADX,
      // `sql` for every SQL/NoSQL engine (per the /query response contract).
      return NextResponse.json({
        ok: true,
        rows,
        ...(lang === 'kql' ? { kql: query } : { sql: query }),
      });
    } catch (e: any) {
      return NextResponse.json(
        { ok: false, error: e?.message || String(e), status: 502 },
        { status: 502 },
      );
    }
  }

  // ------------------------------------------------------------------
  // Path 2 — Azure Analysis Services (advanced / back-compat)
  // ------------------------------------------------------------------
  let daxQuery = rawQuery;
  if (!daxQuery && body?.visual) {
    daxQuery = buildDaxFromVisual(body.visual) ?? '';
  }
  if (!daxQuery) {
    return NextResponse.json(
      { ok: false, error: 'query or visual.field required' },
      { status: 400 },
    );
  }
  // Append the structured Filters pane as a CALCULATETABLE wrapper (no-op when
  // there are no applicable filters or the DAX isn't a wrappable EVALUATE).
  daxQuery = wrapDaxWithFilters(daxQuery, filters);

  try {
    const result = await executeAasQuery(
      resolved.binding.region,
      resolved.binding.serverName,
      resolved.binding.database,
      daxQuery,
    );
    const rows = flattenAasRows(result);
    return NextResponse.json({ ok: true, rows, daxQuery });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
