/**
 * GET|POST /api/items/report/[id]/profile  — REPORT-BUILDER PARITY · WAVE 4
 *
 * Column profiling for the report Transform host (the Power Query "Transform
 * Data" surface that reuses the proven Dataflow Gen2 `PowerQueryHost`). Renders
 * the REAL per-column quality + distribution stats `data-profiling.tsx` draws as
 * Fluent mini bar charts under each column header — exactly the profiling Power
 * Query Online shows, computed Azure-native over Synapse (NO Fabric / Power BI;
 * no-fabric-dependency.md), NO mock columns (no-vaporware.md).
 *
 * ── How it works (the same source resolution the /query route uses) ───────────
 *   1. Owner-load the report item (a `loom:` content id OR a plain Cosmos id),
 *      tenant-scoped, exactly like /query and /fields.
 *   2. `resolveReportModel` → the Azure-native backend. Profiling runs over the
 *      Loom-native SQL path (semantic-model / direct-query → Synapse warehouse
 *      dedicated pool or lakehouse serverless), the report-designer-v2 DEFAULT
 *      and the path the Wave-4 Transform host folds onto. `unbound` → honest 412.
 *      `aas` / `connection` backends profile over their own model/connector, not
 *      this SQL path → honest 412 gate naming the limitation (never a mock).
 *   3. Resolve the source's BASE SELECT (a derived query, or `SELECT * FROM
 *      [schema].[table]` for the model table the profile targets), then — when a
 *      Wave-4 Power Query transform is layered on top (`state.dataSource
 *      .appliedSteps`) — WRAP the FROM by folding the applied steps to nested
 *      derived SELECTs via `m-script.foldAppliedStepsToSql` (DirectQuery query-
 *      folding). A non-foldable step (parse JSON/XML, transpose, pivot, windowed
 *      fill, examples-heuristics …) returns an HONEST 412 gate naming the step +
 *      remediation ("switch this query to Import and run Refresh to materialize
 *      it") instead of a silently wrong result.
 *   4. Probe the resolved/folded relation (`SELECT TOP 0 *`) for its REAL post-
 *      transform column names, then for each column (or `body.column`) run REAL
 *      aggregate SQL via `synapse-sql-client.executeQuery`:
 *        • COUNT(*)              → row count
 *        • COUNT(<col>)          → non-null count (⇒ nulls = count − non-null)
 *        • COUNT(DISTINCT <col>) → distinct values
 *        • MIN(<col>) / MAX(<col>) → range (skipped for non-orderable types)
 *        • TOP 12 … GROUP BY <col> ORDER BY COUNT(*) DESC → value distribution
 *      Identifiers are resolver-whitelisted + bracket-quoted (injection-safe).
 *
 * Response contract (shared report + dataflow):
 *   200 → { ok:true, rowCount, sampled, columns:[{ name, dataType?, count,
 *           distinct, nulls, nullPct, min?, max?, distribution:[{value,count}] }] }
 *   412 → { ok:false, code:'gate'|'unbound', error, missing?, unfoldableStep? }
 *   502 → { ok:false, error, status }  (verbatim backend error)
 *
 * no-vaporware: every number is a real aggregate over a real Synapse relation —
 * no mock columns, no `return []`. no-freeform-config: the transform M was
 * authored through `m-script.appendStep` (structured dialogs / ribbon) and is
 * FOLDED to SQL here, never hand-typed. no-fabric-dependency: Synapse only — no
 * api.fabric / api.powerbi / onelake host on any path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadModelItem } from '@/lib/azure/model-binding';
import { AasError } from '@/lib/azure/aas-client';
import { executeQuery, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import {
  resolveReportModel,
  bracket,
  type FieldTable,
  type ReportSqlSource,
  type ResolvedReportModel,
} from '@/lib/azure/report-model-resolver';
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

/** Profiling runs every aggregate on the Synapse SQL family → bracket-quoted. */
const DIALECT = 'synapse' as const;

/** Per-column SQL timeout (serverless cold-start safe; verbatim 502 on overrun). */
const PROFILE_TIMEOUT_MS = 30_000;

/** TOP-N value distribution returned per column (Power Query parity). */
const DISTRIBUTION_TOP = 12;

/** Bound the all-columns sweep so a wide source doesn't fan out unboundedly. The
 *  designer requests `body.column` per column header, so the common call is one
 *  column; this caps the convenience "profile everything" request. */
const MAX_PROFILE_COLUMNS = 50;

interface ProfileColumn {
  name: string;
  dataType?: string;
  /** Total rows (COUNT(*)). */
  count: number;
  /** Distinct non-null values (COUNT(DISTINCT col)). */
  distinct: number;
  /** Null values (count − COUNT(col)). */
  nulls: number;
  /** Null percentage 0–100. */
  nullPct: number;
  /** Real MIN(col) (omitted for non-orderable types). */
  min?: string | number;
  /** Real MAX(col) (omitted for non-orderable types). */
  max?: string | number;
  /** Real TOP-12 GROUP BY value distribution, busiest first. */
  distribution: Array<{ value: string; count: number }>;
}

interface ProfileBody {
  column?: string;
  /**
   * The Transform host's ACTIVE query name (the host can author MULTIPLE `shared`
   * queries). Honored so profiling folds THAT query for multi-query parity instead
   * of an implicit first-query; absent ⇒ the first query (back-compat).
   */
  queryName?: string;
}

/** Bracket-quote a Synapse/T-SQL identifier (resolver-whitelisted names only). */
function q(ident: string): string {
  return bracket(ident);
}

/** Strip a trailing `;` so a base SELECT splices cleanly as a derived relation. */
function stripSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

/** Normalize a TDS scalar (MIN/MAX) to the response's string|number|undefined. */
function normScalar(v: unknown): string | number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Normalize a distribution bucket value to a display string ('' for null). */
function distValue(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Coerce a TDS count cell (number | bigint | numeric string) to a JS number. */
function asCount(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Zip a single-row QueryResult into a column-alias → value record. */
function firstRowRecord(columns: string[], rows: unknown[][]): Record<string, unknown> {
  const row = rows[0] || [];
  const rec: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    rec[c] = row[i];
  });
  return rec;
}

/**
 * The base SELECT + Synapse target a loom-native report profiles over. A derived
 * source uses its own validated SELECT; a table-map / source-groups model uses
 * `SELECT * FROM [schema].[table]` for the table the profile targets — the table
 * owning `column` (when supplied), else the first model table with bindable
 * columns. Both run on the resolver-pinned `sqlSource.target` (dedicated pool for
 * a warehouse source, serverless for a lakehouse source).
 */
function baseRelation(
  tables: FieldTable[],
  sqlSource: ReportSqlSource,
  column: string | undefined,
): { baseSelect: string; target: SynapseTarget } | null {
  if (sqlSource.mode === 'derived') {
    return { baseSelect: stripSemicolons(sqlSource.sql), target: sqlSource.target };
  }
  // table-map | source-groups → both carry the model-table → base-relation map.
  const tableMap = sqlSource.tableMap;
  const keys = Object.keys(tableMap || {});
  if (!keys.length) return null;

  let chosen = '';
  if (column) {
    const want = column.trim().toLowerCase();
    const owner = tables.find(
      (t) => tableMap[t.name] && t.columns.some((c) => c.name.toLowerCase() === want),
    );
    if (owner) chosen = owner.name;
  }
  if (!chosen) {
    const withCols = tables.find((t) => tableMap[t.name] && t.columns.length > 0);
    chosen = withCols?.name || keys[0];
  }
  const rel = tableMap[chosen];
  if (!rel) return null;
  return { baseSelect: `SELECT * FROM ${rel.relation}`, target: sqlSource.target };
}

/** Best-effort data-type for a probed column, from the resolved model schema. */
function dataTypeOf(tables: FieldTable[], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const t of tables) {
    const c = t.columns.find((x) => x.name.toLowerCase() === want);
    if (c && c.dataType) return c.dataType;
  }
  return undefined;
}

/**
 * Run the per-column aggregate stats over `relation` (a complete SELECT, wrapped
 * as a derived table). Tries MIN/MAX first; on any failure retries WITHOUT them
 * (non-orderable types), so an orderable column reports a real range while a
 * text/binary column still profiles its counts. A second failure rethrows → the
 * caller surfaces the verbatim 502 (an honest backend error, never a mock).
 */
async function runColumnStats(
  target: SynapseTarget,
  relation: string,
  col: string,
): Promise<{ total: number; nonnull: number; distinct: number; min?: string | number; max?: string | number }> {
  const c = q(col);
  const from = `FROM (${relation}) AS _p`;
  const withMinMax =
    `SELECT COUNT_BIG(*) AS total, COUNT_BIG(${c}) AS nonnull, ` +
    `COUNT_BIG(DISTINCT ${c}) AS distinctc, MIN(${c}) AS minv, MAX(${c}) AS maxv ${from}`;
  try {
    const r = await executeQuery(target, withMinMax, PROFILE_TIMEOUT_MS);
    const rec = firstRowRecord(r.columns, r.rows);
    return {
      total: asCount(rec.total),
      nonnull: asCount(rec.nonnull),
      distinct: asCount(rec.distinctc),
      min: normScalar(rec.minv),
      max: normScalar(rec.maxv),
    };
  } catch {
    // Non-orderable column (or MIN/MAX unsupported) — retry counts only. A second
    // failure rethrows so a genuine backend error still surfaces as a 502.
    const countsOnly =
      `SELECT COUNT_BIG(*) AS total, COUNT_BIG(${c}) AS nonnull, COUNT_BIG(DISTINCT ${c}) AS distinctc ${from}`;
    const r = await executeQuery(target, countsOnly, PROFILE_TIMEOUT_MS);
    const rec = firstRowRecord(r.columns, r.rows);
    return { total: asCount(rec.total), nonnull: asCount(rec.nonnull), distinct: asCount(rec.distinctc) };
  }
}

/**
 * Real TOP-12 value distribution (busiest first). Returns [] on failure (a type
 * that can't GROUP BY, e.g. varbinary) — an honest "no distribution for this
 * type", never a thrown 500: the per-column stats already proved the backend is
 * reachable, so a distribution miss is type-specific, not a backend outage.
 */
async function runColumnDistribution(
  target: SynapseTarget,
  relation: string,
  col: string,
): Promise<Array<{ value: string; count: number }>> {
  const c = q(col);
  const sql =
    `SELECT TOP ${DISTRIBUTION_TOP} ${c} AS val, COUNT_BIG(*) AS cnt ` +
    `FROM (${relation}) AS _p GROUP BY ${c} ORDER BY COUNT_BIG(*) DESC`;
  try {
    const r = await executeQuery(target, sql, PROFILE_TIMEOUT_MS);
    return r.rows.map((row) => ({ value: distValue(row[0]), count: asCount(row[1]) }));
  } catch {
    return [];
  }
}

/** Load the report item (loom: content id OR plain Cosmos id), owner-checked. */
async function loadReport(id: string, oid: string): Promise<WorkspaceItem | null> {
  if (isLoomContentId(id)) {
    return loadContentBackedItem(cosmosIdFromLoomId(id), 'report', oid);
  }
  return loadModelItem(id, 'report', oid);
}

/** A typed JSON error response. */
function err(status: number, payload: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: false, ...payload }, { status });
}

/**
 * Pick the query the Transform host is acting on from the persisted M section.
 * The host can author MULTIPLE `shared` queries and reports the ACTIVE one (via
 * `onActiveQueryChange`, sent as `body.queryName`); honoring that name folds THAT
 * query for multi-query parity instead of an implicit `queries[0]`. Falls back to
 * the first query when no name is supplied (single-query reports — the common
 * case) or the supplied name isn't present (stale client state), preserving the
 * original single-query behavior. Returns undefined only when the section parsed
 * to no queries (→ the honest parse gate).
 */
function pickActiveQuery(
  queries: Array<{ name: string; body: string }>,
  queryName: string | undefined,
): { name: string; body: string } | undefined {
  if (queryName) {
    const want = queryName.trim().toLowerCase();
    const match = queries.find((qq) => qq.name.toLowerCase() === want);
    if (match) return match;
  }
  return queries[0];
}

/**
 * Shared GET/POST handler. `column` (optional) profiles a single column; absent
 * profiles every column of the resolved/folded relation (capped). `queryName`
 * (optional) selects which of the Transform host's `shared` queries to fold;
 * absent ⇒ the first query (single-query reports — back-compat).
 */
async function handle(
  id: string,
  column: string | undefined,
  queryName: string | undefined,
): Promise<NextResponse> {
  const session = getSession();
  if (!session) return err(401, { error: 'unauthenticated' });

  const item = await loadReport(id, session.claims.oid);
  if (!item) return err(404, { error: 'report item not found' });

  // Resolve the report's data source → Azure-native backend (same as /query).
  let resolved: ResolvedReportModel;
  try {
    resolved = await resolveReportModel(item, session.claims.oid);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return err(status, { error: e?.message || String(e), status });
  }

  if (resolved.backend === 'unbound') {
    return err(412, { code: 'unbound', error: resolved.gate.error, missing: resolved.gate.missing });
  }

  // Column profiling runs over the Loom-native Synapse SQL path. AAS-bound and
  // Get-Data connection sources profile via their own model / connector, not this
  // SQL aggregate path — honest gate naming the limitation (no mock, no Fabric).
  if (resolved.backend === 'aas') {
    return err(412, {
      code: 'gate',
      error:
        'Column profiling runs over the Loom-native Synapse SQL path. This report is bound to ' +
        'Azure Analysis Services (XMLA), which profiles via the tabular model rather than SQL — ' +
        'switch the data source to a Loom semantic model or a warehouse/lakehouse query to profile ' +
        'columns here. No Fabric / Power BI workspace required.',
    });
  }
  if (resolved.backend === 'connection') {
    return err(412, {
      code: 'gate',
      error:
        `Column profiling runs over the Loom-native Synapse SQL path (semantic-model / direct-query ` +
        `sources). This report uses a Get Data "${resolved.connType}" connection — preview it from the ` +
        `Navigator, or bind a Loom semantic model / warehouse-lakehouse query to profile columns here. ` +
        `Azure-native; no Fabric / Power BI.`,
      missing: resolved.connType,
    });
  }

  // ── loom-native: resolve the base SELECT + Synapse target ───────────────────
  const base = baseRelation(resolved.tables, resolved.sqlSource, column);
  if (!base) {
    return err(412, {
      code: 'gate',
      error: 'The report’s data source has no bindable relation to profile. Re-pick a data source in the designer.',
    });
  }

  // ── Wave-4 transform fold: wrap the FROM in the folded applied steps ─────────
  // The transform M (`appliedSteps`) is read from persisted state via the CLIENT
  // data-source parser, which carries the optional Wave-4 mixin (the resolver's
  // `readReportDataSource` intentionally drops it). DirectQuery folds the steps to
  // SQL here; a non-foldable step is an honest gate (Import materializes it via
  // the report /refresh Spark/wrangling run — out of this read path).
  let relation = base.baseSelect;
  const ds = fromLegacyState((item.state || {}) as Record<string, unknown>);
  if (hasTransform(ds) && ds?.appliedSteps) {
    const queries = parseSharedQueries(ds.appliedSteps);
    const active = pickActiveQuery(queries, queryName);
    if (!active) {
      return err(412, {
        code: 'gate',
        error: 'The report’s Power Query transform could not be parsed. Re-open Transform data and re-apply the steps.',
      });
    }
    const folded = foldAppliedStepsToSql(base.baseSelect, active.body, DIALECT);
    if (!folded.ok) {
      const importMode = reportTransformMode(ds) === 'import';
      return err(412, {
        code: 'gate',
        unfoldableStep: folded.unfoldableStep,
        error:
          `Column profiling runs live (DirectQuery), but the transform step "${folded.unfoldableStep}" ` +
          `can’t be folded to SQL. ${
            importMode
              ? 'This query is set to Import — run Refresh to materialize it via the dataflow run, then profile the materialized data.'
              : 'Switch this query to Import and run Refresh to materialize it via the dataflow run, or remove/replace the non-foldable step.'
          } Azure-native (Synapse / ADF); no Fabric / Power BI.`,
      });
    }
    relation = folded.sql;
  }

  const target = base.target;

  // ── Probe the resolved/folded relation for its REAL post-transform columns ───
  let probedColumns: string[];
  try {
    const probe = await executeQuery(target, `SELECT TOP 0 * FROM (${relation}) AS _probe`, PROFILE_TIMEOUT_MS);
    probedColumns = probe.columns;
  } catch (e: any) {
    return err(502, { error: e?.message || String(e), status: 502 });
  }
  if (!probedColumns.length) {
    return err(412, {
      code: 'gate',
      error: 'The resolved data source returned no columns to profile. Adjust the source / transform and retry.',
    });
  }

  // Which columns to profile: the requested one (must exist post-transform), else
  // every column (capped). A bad `column` is a client error (400), not a gate.
  let columnsToProfile: string[];
  if (column) {
    const match = probedColumns.find((c) => c.toLowerCase() === column.trim().toLowerCase());
    if (!match) {
      return err(400, {
        error: `Column "${column}" is not present in the report’s data (after any transform). Available: ${probedColumns
          .slice(0, 50)
          .join(', ')}.`,
      });
    }
    columnsToProfile = [match];
  } else {
    columnsToProfile = probedColumns.slice(0, MAX_PROFILE_COLUMNS);
  }

  // ── Total row count (one real COUNT over the relation) ──────────────────────
  let rowCount = 0;
  try {
    const rc = await executeQuery(target, `SELECT COUNT_BIG(*) AS cnt FROM (${relation}) AS _p`, PROFILE_TIMEOUT_MS);
    rowCount = asCount(firstRowRecord(rc.columns, rc.rows).cnt);
  } catch (e: any) {
    return err(502, { error: e?.message || String(e), status: 502 });
  }

  // ── Per-column REAL aggregate profiling ─────────────────────────────────────
  let columns: ProfileColumn[];
  try {
    columns = await Promise.all(
      columnsToProfile.map(async (name): Promise<ProfileColumn> => {
        const stats = await runColumnStats(target, relation, name);
        const distribution = await runColumnDistribution(target, relation, name);
        const nulls = Math.max(0, stats.total - stats.nonnull);
        const nullPct = stats.total > 0 ? Math.round((nulls / stats.total) * 10000) / 100 : 0;
        return {
          name,
          dataType: dataTypeOf(resolved.tables, name),
          count: stats.total,
          distinct: stats.distinct,
          nulls,
          nullPct,
          ...(stats.min !== undefined ? { min: stats.min } : {}),
          ...(stats.max !== undefined ? { max: stats.max } : {}),
          distribution,
        };
      }),
    );
  } catch (e: any) {
    // A genuine backend failure (auth / connectivity / invalid folded SQL) — the
    // verbatim message is the honest gate, never a mock column (no-vaporware.md).
    return err(502, { error: e?.message || String(e), status: 502 });
  }

  return NextResponse.json({ ok: true, rowCount, sampled: false, columns });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = (await ctx.params).id;
  const column = req.nextUrl.searchParams.get('column') || undefined;
  const queryName = req.nextUrl.searchParams.get('queryName') || undefined;
  return handle(id, column?.trim() || undefined, queryName?.trim() || undefined);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = (await ctx.params).id;
  const body = (await req.json().catch(() => ({}))) as ProfileBody;
  const column = typeof body.column === 'string' ? body.column.trim() : undefined;
  const queryName = typeof body.queryName === 'string' ? body.queryName.trim() : undefined;
  return handle(id, column || undefined, queryName || undefined);
}
