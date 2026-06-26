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
import { executeQuery } from '@/lib/azure/synapse-sql-client';
import {
  resolveReportModel,
  type FieldTable,
  type ReportSqlSource,
  type ResolvedReportModel,
} from '@/lib/azure/report-model-resolver';
import {
  buildSqlFromVisual,
  wrapDaxWithFilters,
  type SqlSource,
  type SqlSourceColumn,
  type ReportFilterInput,
} from '@/lib/azure/wells-to-sql';
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
 *   • `ok`          — a bindable `SqlSource` (one model table or the derived SELECT)
 *   • `no-columns`  — nothing bindable resolved (caller → generic 400)
 *   • `multi-table` — the visual binds across >1 model table; the single-FROM
 *                     compiler can't join them, so the caller returns an honest
 *                     400 naming the tables + remediation (never a silent drop).
 */
type ToSqlSourceResult =
  | { kind: 'ok'; source: SqlSource }
  | { kind: 'no-columns' }
  | { kind: 'multi-table'; tables: string[] };

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as QueryRequest;
  const filters = Array.isArray(body.filters) ? body.filters : undefined;

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
    if (projected.kind === 'no-columns') {
      return NextResponse.json(
        { ok: false, error: 'The report’s data source has no bindable columns for this visual.' },
        { status: 400 },
      );
    }
    const sqlSource = projected.source;
    const compiled = buildSqlFromVisual(body.visual, filters, sqlSource);
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
      const result = await executeQuery(resolved.sqlSource.target, compiled.sql, 30_000, compiled.parameters);
      return NextResponse.json({
        ok: true,
        rows: objectRows(result.columns, result.rows),
        sql: compiled.sql,
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
    try {
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
