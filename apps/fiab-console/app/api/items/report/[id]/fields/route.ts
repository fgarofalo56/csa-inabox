/**
 * GET /api/items/report/[id]/fields
 *
 * Returns the tabular-model SCHEMA (tables → columns[] + measures[]) that backs
 * this report so the Loom-native report DESIGNER can populate its Fields pane
 * and let the author drag columns/measures into a visual's field wells.
 *
 * ── Data-source model (report-designer v2) ─────────────────────────────────
 * The report binds to a DATA SOURCE persisted on `state.dataSource` (the
 * discriminated union in `lib/editors/report/report-data-source.ts`). This
 * route resolves that source and dispatches on its backend — it is no longer
 * AAS-only:
 *
 *   • semantic-model  (DEFAULT, Azure-native) → the referenced Loom
 *     `semantic-model` item is read from Cosmos. If that model is itself
 *     Loom-native (`state.content` = SemanticModelContent over a
 *     warehouse/lakehouse via SQL), its tables/columns/measures are returned
 *     directly — NO AAS, NO Fabric, NO Power BI workspace. If the model item
 *     declares its own AAS binding, we fall through to the XMLA path.
 *   • direct-query    (Azure-native) → the author's guarded `SELECT` is
 *     introspected over Synapse (`SELECT TOP 0` derived-table probe via
 *     `executeQuery`) to surface its real column names. No mock schema.
 *   • aas             (advanced / back-compat) → the existing TMSCHEMA Discover
 *     over XMLA (`readModel()`), unchanged. Reports saved before
 *     `state.dataSource` existed synthesize `{kind:'aas'}` from the legacy
 *     `state.aasServer/aasDatabase` (via `fromLegacyState`) so they keep
 *     working.
 *   • connection / file-upload / adls-file  (Get Data, WAVE 1, Azure-native) →
 *     a reusable KV-backed Loom Connection, an uploaded file, or an existing
 *     ADLS path. `buildConnectionExecutor` (the shared resolver) loads the
 *     connection, enforces the per-engine env gate, resolves the KV secret, and
 *     returns a real `ConnectionExecutor`; this route calls `introspectFields()`
 *     to surface its real schema (INFORMATION_SCHEMA for SQL engines, sampled
 *     document keys for Cosmos, serverless OPENROWSET `SELECT TOP 0` / delta-log
 *     for ADLS files). No XMLA, no Fabric, no Power BI workspace.
 *
 * Rules compliance: no-fabric-dependency (the DEFAULT path is a Loom semantic
 * model over Synapse/lakehouse — never gates on a Fabric/Power BI workspace),
 * no-vaporware (real model content / real `executeQuery` introspection / real
 * XMLA Discover — every unconfigured branch is an honest 412 gate naming the
 * exact env var / item binding to set, never mock data), no-freeform-config
 * (the source is a picker choice; only the advanced AAS URI + the guarded SQL
 * escape hatch are free text).
 *
 * 200 OK → { ok: true, backend, aasServer, aasDatabase, database, tables }
 * 412    → { ok: false, code: 'unbound', error } (honest, actionable)
 * 4xx/5xx→ { ok: false, error, status? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readModel, resolveAasBinding, AasError } from '@/lib/azure/aas-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import { extractContent } from '@/lib/azure/tabular-model';
import { executeQuery, dedicatedTarget, serverlessTarget, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import { fromLegacyState, hasTransform, reportTransformMode } from '@/lib/editors/report/report-data-source';
import type { DirectQueryTarget, ReportDataSource } from '@/lib/editors/report/report-data-source';
import { buildConnectionExecutor } from '@/lib/azure/report-model-resolver';
import type { ConnectionExecutor, ReportConnType } from '@/lib/azure/report-model-resolver';
import { withQueryCache } from '@/lib/azure/query-cache';
import { foldAppliedStepsToSql, parseSharedQueries } from '@/lib/components/pipeline/dataflow/m-script';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One model column surfaced to the Fields pane. */
export interface FieldColumn {
  name: string;
  dataType: string;
  /** Default summarization hint (Sum/Count/None…) from the model. */
  summarizeBy?: string;
  isHidden: boolean;
}
/** One model measure surfaced to the Fields pane. */
export interface FieldMeasure {
  name: string;
  isHidden: boolean;
}
/** A table node in the Fields tree. */
export interface FieldTable {
  name: string;
  columns: FieldColumn[];
  measures: FieldMeasure[];
}

// ── Resolver ──────────────────────────────────────────────────────────────
//
// The report's data source resolves to one of three backends. The /fields and
// /query routes share this dispatch shape; the loom-native paths return real
// schema with no AAS/Fabric dependency.

type ResolvedReportModel =
  /** XMLA Discover over the bound AAS tabular model (existing path). */
  | { backend: 'aas'; database: string; server?: string }
  /** Loom-native schema (semantic-model content or direct-query introspection). */
  | { backend: 'loom-native'; tables: FieldTable[] }
  /**
   * Get Data (WAVE 1): a reusable, KV-backed Loom Connection, an uploaded file,
   * or an existing ADLS path — resolved by the shared resolver to a real Azure
   * data-plane `ConnectionExecutor` (introspect/query/preview). Azure-native:
   * never a Fabric / Power BI dependency.
   */
  | { backend: 'connection'; connType: ReportConnType; executor: ConnectionExecutor }
  /** Genuinely unbound — drives an honest 412 gate naming the remediation. */
  | { backend: 'unbound'; gate: string };

/** Default Fields-pane summarization hint inferred from a column's data type. */
function summarizeByForType(dataType: string): string | undefined {
  const t = (dataType || '').toLowerCase();
  if (/(int|long|double|decimal|number|float|money|real|numeric|bigint|smallint|tinyint|currency)/.test(t)) {
    return 'Sum';
  }
  return 'None';
}

/**
 * Build the Fields tree from a Loom-native semantic-model item's persisted
 * content (`extractContent` reads `state.content` = SemanticModelContent —
 * real columns + measures, no mock). Measures are grouped under their owning
 * table; model-level measures fall into a synthetic "Measures" table (Power BI
 * parity).
 */
function loomNativeTables(model: WorkspaceItem): FieldTable[] {
  const { tables, measures } = extractContent(model);

  const tableNames = new Set(tables.map((t) => t.name));
  const byTable = new Map<string, FieldMeasure[]>();
  const leftover: FieldMeasure[] = [];
  for (const m of measures) {
    const fm: FieldMeasure = { name: m.name, isHidden: false };
    if (m.table && tableNames.has(m.table)) {
      const arr = byTable.get(m.table) || [];
      arr.push(fm);
      byTable.set(m.table, arr);
    } else {
      leftover.push(fm);
    }
  }

  const out: FieldTable[] = tables.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      summarizeBy: summarizeByForType(c.dataType),
      isHidden: false,
    })),
    measures: byTable.get(t.name) || [],
  }));
  if (leftover.length) out.push({ name: 'Measures', columns: [], measures: leftover });

  // Drop tables that have nothing the author can bind.
  return out.filter((t) => t.columns.length > 0 || t.measures.length > 0);
}

/**
 * Introspect a direct-query `SELECT`'s output columns WITHOUT scanning data:
 * wrap it as a derived table and run `SELECT TOP 0 *` over Synapse so the
 * recordset metadata yields the real column names. Dedicated pool for a
 * warehouse target, serverless for a lakehouse target.
 */
async function directQueryTables(target: DirectQueryTarget, sql: string): Promise<FieldTable[]> {
  const tgt = target === 'lakehouse' ? serverlessTarget() : dedicatedTarget();
  const probe = `SELECT TOP 0 * FROM (\n${sql}\n) AS _loom_probe`;
  const res = await executeQuery(tgt, probe, 30_000);
  const columns: FieldColumn[] = res.columns.map((name) => ({
    name,
    dataType: 'string',
    summarizeBy: undefined,
    isHidden: false,
  }));
  return columns.length ? [{ name: 'Query', columns, measures: [] }] : [];
}

// ── REPORT-BUILDER PARITY · WAVE 4 — Power Query "Transform Data" ───────────────
//
// When a Power Query transform authored by the report Transform host (the SAME
// `PowerQueryHost` the Dataflow Gen2 editor mounts) is layered on the source
// (`state.dataSource.appliedSteps`) in the DEFAULT DirectQuery mode, the Fields
// pane must reflect the TRANSFORMED schema (renamed / added / split / grouped
// columns), not the raw source schema. We FOLD the applied steps to nested derived
// SELECTs (`m-script.foldAppliedStepsToSql` — the same query-folding the /query and
// /profile routes run) over the resolved base relation and probe the folded SELECT
// for its real post-transform columns. 100% Azure-native over Synapse — no
// api.fabric / api.powerbi / onelake host (no-fabric-dependency.md), no mock columns
// (no-vaporware.md); the M was authored exclusively via `m-script.appendStep`
// (structured dialogs / ribbon), never hand-typed (no-freeform-config.md).

/** Synapse/T-SQL identifier quote (resolver / objectRef names only — injection-safe). */
function brkt(ident: string): string {
  return `[${String(ident).replace(/]/g, ']]')}]`;
}

/**
 * The base SELECT + Synapse target a report's DirectQuery transform folds over —
 * resolved ONLY for the sources whose base relation genuinely lives in Synapse and
 * can therefore be probed here:
 *   • direct-query (inline SQL, not yet scaffolded into a model) → the guarded
 *     SELECT, on `ds.target`'s pool (dedicated warehouse / serverless lakehouse);
 *   • a Synapse-family connection (`synapse-dedicated` / `synapse-serverless`)
 *     reading a table or a custom query → `SELECT * FROM [schema].[table]` (or the
 *     guarded custom SELECT), on the matching pool.
 * Returns null for every other resolved case — a multi-table semantic model, a
 * non-Synapse connection engine (Azure SQL / Databricks / PostgreSQL / Cosmos), a
 * file/KQL connection object, or AAS — so those keep the base schema below (the
 * fold is still enforced at /query + /profile, where the owning engine runs it, and
 * Import materializes the full M via the report /refresh Spark/wrangling run). Never
 * a fabricated transformed column.
 */
function transformBaseRelation(
  ds: ReportDataSource,
  resolved: ResolvedReportModel,
): { baseSelect: string; target: SynapseTarget } | null {
  if (resolved.backend === 'loom-native' && ds.kind === 'direct-query' && !ds.modelItemId) {
    const guard = readOnlySelect(ds.sql);
    if (!guard.ok) return null;
    return { baseSelect: guard.sql, target: ds.target === 'lakehouse' ? serverlessTarget() : dedicatedTarget() };
  }
  if (
    resolved.backend === 'connection' &&
    ds.kind === 'connection' &&
    (ds.connType === 'synapse-dedicated' || ds.connType === 'synapse-serverless')
  ) {
    const ref = ds.objectRef;
    let baseSelect: string;
    if (ref.mode === 'table') {
      baseSelect = `SELECT * FROM ${ref.schema ? `${brkt(ref.schema)}.${brkt(ref.table)}` : brkt(ref.table)}`;
    } else if (ref.mode === 'query') {
      const guard = readOnlySelect(ref.sql);
      if (!guard.ok) return null;
      baseSelect = guard.sql;
    } else {
      return null; // file / kql objects have no plain SQL base relation to fold over
    }
    const target = ds.connType === 'synapse-dedicated' ? dedicatedTarget() : serverlessTarget();
    return { baseSelect, target };
  }
  return null;
}

/**
 * Probe a folded derived SELECT for its REAL post-transform column names —
 * `SELECT TOP 0 *` over Synapse (recordset metadata only; no data scan), the same
 * primitive `directQueryTables` uses. Returns the single "Query" `FieldTable` the
 * Fields pane binds (renamed / added / split columns included), or [] when the fold
 * yields no columns.
 */
async function foldedProbeTables(target: SynapseTarget, foldedSql: string): Promise<FieldTable[]> {
  const probe = `SELECT TOP 0 * FROM (\n${foldedSql}\n) AS _loom_fold_probe`;
  const res = await executeQuery(target, probe, 30_000);
  const columns: FieldColumn[] = res.columns.map((name) => ({
    name,
    dataType: 'string',
    summarizeBy: undefined,
    isHidden: false,
  }));
  return columns.length ? [{ name: 'Query', columns, measures: [] }] : [];
}

/**
 * Pick the query the Transform host is acting on from the persisted M section.
 * The host can author MULTIPLE `shared` queries and reports the ACTIVE one (via
 * `onActiveQueryChange`); honoring that name probes THAT query's folded schema
 * for multi-query parity instead of an implicit `queries[0]`. Falls back to the
 * first query when no name is supplied (single-query reports — the common case)
 * or the supplied name isn't present (stale client state), preserving the
 * original single-query behavior. Returns undefined only when the section parsed
 * to no queries.
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
 * Resolve a loaded `semantic-model` item to a backend. AAS only when the model
 * ITEM ITSELF declares a binding (`state.aasServer` + `state.aasDatabase`) — we
 * deliberately do NOT use the env-fallback form here so a global
 * `LOOM_AAS_SERVER` cannot hijack a Loom-native model. Otherwise the model is
 * Loom-native: read its content schema.
 */
function resolveLoadedModel(model: WorkspaceItem): ResolvedReportModel {
  const mState = (model.state || {}) as Record<string, unknown>;
  const mServer = typeof mState.aasServer === 'string' ? mState.aasServer.trim() : '';
  const mDatabase = typeof mState.aasDatabase === 'string' ? mState.aasDatabase.trim() : '';
  if (mServer && mDatabase) {
    return { backend: 'aas', database: mDatabase, server: mServer };
  }

  const tables = loomNativeTables(model);
  if (!tables.length) {
    const nm = (model as { name?: string; displayName?: string }).name
      || (model as { name?: string; displayName?: string }).displayName
      || 'The bound semantic model';
    return {
      backend: 'unbound',
      gate:
        `${nm} has no tables yet. Open the semantic model and define its tables/columns ` +
        '(or bind it to a warehouse/lakehouse), then re-open this report.',
    };
  }
  return { backend: 'loom-native', tables };
}

/**
 * Resolve the report item's data source to a backend descriptor. Mirrors the
 * shared `report-model-resolver` design but is self-contained for this route.
 */
async function resolveReportModel(item: WorkspaceItem, oid: string): Promise<ResolvedReportModel> {
  const state = (item.state || {}) as Record<string, unknown>;
  const ds = fromLegacyState(state);

  if (!ds) {
    return {
      backend: 'unbound',
      gate:
        'This report has no data source. Open the designer and choose a data source — a Loom ' +
        'semantic model (default, Azure-native over Synapse/lakehouse), a direct SQL query, or ' +
        '(advanced) an Azure Analysis Services model. No Power BI / Fabric workspace is required.',
    };
  }

  // Advanced / back-compat: explicit AAS source (env fallback preserved).
  if (ds.kind === 'aas') {
    const binding = resolveAasBinding(ds.server, ds.database);
    if (!binding) {
      return {
        backend: 'unbound',
        gate:
          'The Analysis Services data source is not fully bound. Set the AAS server (XMLA URI, ' +
          'e.g. asazure://eastus2.asazure.windows.net/my-server) + database on the source, or ' +
          'configure LOOM_AAS_SERVER + LOOM_AAS_DATABASE (admin-plane/main.bicep). The Console ' +
          'UAMI must be a server admin on the AAS instance.',
      };
    }
    return { backend: 'aas', database: binding.database, server: ds.server };
  }

  // DEFAULT, Azure-native: a Loom semantic-model item.
  if (ds.kind === 'semantic-model') {
    const itemId = (ds.itemId || '').trim();
    if (!itemId) {
      return {
        backend: 'unbound',
        gate: 'Pick a semantic model for this report in the designer’s Data source panel.',
      };
    }
    const model = await loadModelItem(itemId, 'semantic-model', oid);
    if (!model) {
      return {
        backend: 'unbound',
        gate:
          `The bound semantic-model item (${itemId}) was not found in your workspace. ` +
          'Re-pick a data source in the designer.',
      };
    }
    return resolveLoadedModel(model);
  }

  // Get Data (WAVE 1), Azure-native: a reusable, KV-backed Loom Connection, a
  // user-uploaded file (staged to ADLS landing), or an existing ADLS Gen2 path.
  // The shared resolver owns ALL backend knowledge — it loads the LoomConnection,
  // checks the per-engine env gate, resolves the KV secret when authNeedsSecret,
  // and returns a real `ConnectionExecutor` wired to an Azure data-plane client
  // (azure-sql / synapse / databricks / postgres / cosmos / serverless OPENROWSET)
  // — or an honest 'unbound' gate naming the exact connection / role / env. No
  // new credential code, no mock data, no Fabric/Power BI on this path.
  if (ds.kind === 'connection' || ds.kind === 'file-upload' || ds.kind === 'adls-file') {
    const built = await buildConnectionExecutor(ds, oid);
    if (built.backend === 'unbound') {
      return { backend: 'unbound', gate: built.gate.error };
    }
    return { backend: 'connection', connType: built.connType, executor: built.executor };
  }

  // Azure-native: a direct SQL query. Prefer the governed model once scaffolded.
  const modelItemId = (ds.modelItemId || '').trim();
  if (modelItemId) {
    const model = await loadModelItem(modelItemId, 'semantic-model', oid);
    if (model) return resolveLoadedModel(model);
  }
  const guard = readOnlySelect(ds.sql);
  if (!guard.ok) {
    return { backend: 'unbound', gate: `Direct-query data source: ${guard.error}` };
  }
  try {
    const tables = await directQueryTables(ds.target, guard.sql);
    if (!tables.length) {
      return {
        backend: 'unbound',
        gate: 'The direct query returned no columns to bind. Adjust the SELECT and try again.',
      };
    }
    return { backend: 'loom-native', tables };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/Missing env var/i.test(msg)) {
      return {
        backend: 'unbound',
        gate:
          'Direct-query reports run over Synapse. Set LOOM_SYNAPSE_WORKSPACE + ' +
          'LOOM_SYNAPSE_DEDICATED_POOL (warehouse target) or LOOM_SYNAPSE_WORKSPACE ' +
          '(serverless/lakehouse target) so the designer can introspect the query schema. The ' +
          'Console UAMI must have db_datareader on the target.',
      };
    }
    throw e; // a genuine SQL error — surfaced as 502 with the real message
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const id = (await ctx.params).id;

  // Optional active-query name. The Transform host can author MULTIPLE `shared`
  // queries; honoring the active one (via `onActiveQueryChange`) probes THAT
  // query's folded schema. Absent ⇒ the first query (single-query reports —
  // back-compat).
  const queryName = req.nextUrl.searchParams.get('queryName') || undefined;

  // Load the report item (loom: content id OR plain Cosmos id), owner-checked.
  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
  }

  // Resolve the report's data source → backend descriptor (Azure-native default).
  // Expensive read (AAS Discover / Synapse probe / connection introspect) wrapped
  // in withQueryCache — passthrough unless LOOM_QUERY_CACHE=on (identical when off);
  // oid-prefixed key so no cross-tenant bleed.
  let resolved: ResolvedReportModel;
  try {
    resolved = await withQueryCache(
      session.claims.oid,
      `report:fields:${id}:${queryName || ''}`,
      30_000,
      () => resolveReportModel(item, session.claims.oid),
    );
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }

  // Honest gate — name the exact remediation (now "choose a data source", not
  // merely LOOM_AAS_SERVER_URL).
  if (resolved.backend === 'unbound') {
    return NextResponse.json({ ok: false, code: 'unbound', error: resolved.gate }, { status: 412 });
  }

  // ── REPORT-BUILDER PARITY · WAVE 4 — Power Query "Transform Data" ────────────
  // A DirectQuery Power Query transform layered on the source (authored by the
  // report Transform host, the same PowerQueryHost the Dataflow Gen2 editor mounts)
  // must reflect the TRANSFORMED schema in the Fields pane. The transform M is read
  // via the CLIENT data-source parser (`fromLegacyState`), which carries the Wave-4
  // mixin — the resolver's `readReportDataSource` intentionally drops it. We FOLD
  // the applied steps to nested derived SELECTs and probe the folded relation for
  // its real post-transform columns (renamed / added / split / grouped), Azure-
  // native over Synapse. Import mode reads the materialized Delta cache (same
  // columns the base resolved) → falls through to the base response below. A non-
  // foldable step is an honest 409 ("switch this query to Import"). Sources whose
  // base relation isn't on Synapse (multi-table semantic model, a non-Synapse
  // connection engine, file/KQL objects, AAS) keep the base schema — the fold is
  // still enforced at /query + /profile where the owning engine runs it.
  const ds = fromLegacyState((item.state || {}) as Record<string, unknown>);
  if (
    ds &&
    hasTransform(ds) &&
    reportTransformMode(ds) !== 'import' &&
    (resolved.backend === 'loom-native' || resolved.backend === 'connection')
  ) {
    const base = transformBaseRelation(ds, resolved);
    if (base && ds.appliedSteps) {
      const queries = parseSharedQueries(ds.appliedSteps);
      const active = pickActiveQuery(queries, queryName);
      if (active) {
        const folded = foldAppliedStepsToSql(base.baseSelect, active.body, 'synapse');
        if (!folded.ok) {
          // DirectQuery can't fold this step to native SQL — honest 409 (the Import
          // path materializes the full M via the report /refresh Spark/wrangling run).
          return NextResponse.json(
            {
              ok: false,
              code: 'not-foldable',
              error: `Step '${folded.unfoldableStep}' can't fold to a native query — switch this query to Import.`,
              unfoldableStep: folded.unfoldableStep,
            },
            { status: 409 },
          );
        }
        try {
          const tables = await foldedProbeTables(base.target, folded.sql);
          return NextResponse.json({
            ok: true,
            backend: resolved.backend,
            ...(resolved.backend === 'connection' ? { connType: resolved.connType } : {}),
            aasServer: null,
            aasDatabase: null,
            database: null,
            transformed: true,
            tables,
          });
        } catch (e: any) {
          const status = e instanceof AasError ? e.status : 502;
          return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
        }
      }
    }
    // base === null or unparseable M → fall through to the base schema below
    // (additive; the transform is still enforced at /query + /profile).
  }

  // Loom-native: schema came straight from the semantic-model content or the
  // direct-query introspection — no XMLA, no Fabric, no Power BI workspace.
  if (resolved.backend === 'loom-native') {
    return NextResponse.json({
      ok: true,
      backend: 'loom-native',
      aasServer: null,
      aasDatabase: null,
      database: null,
      tables: resolved.tables,
    });
  }

  // Get Data (WAVE 1): real schema via the connection's executor —
  // INFORMATION_SCHEMA.COLUMNS (azure-sql / synapse / generic-sql / postgres /
  // databricks), sampled-document key union (Cosmos), or a serverless OPENROWSET
  // `SELECT TOP 0` / delta-log read (ADLS/Blob files). The per-engine env gates
  // (postgresQueryGate / databricksConfigGate / LOOM_SYNAPSE_WORKSPACE / a bound
  // connection) were already enforced by buildConnectionExecutor → 412 above; an
  // introspection throw here is a genuine backend error (502). No mock, no XMLA.
  if (resolved.backend === 'connection') {
    try {
      const tables = await resolved.executor.introspectFields();
      return NextResponse.json({
        ok: true,
        backend: 'connection',
        connType: resolved.connType,
        aasServer: null,
        aasDatabase: null,
        database: null,
        tables,
      });
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
    }
  }

  // AAS backend: real TMSCHEMA Discover against the bound model — no mock.
  try {
    const tables = await readModel(resolved.database);
    const out: FieldTable[] = tables.map((t) => ({
      name: t.name,
      columns: (t.columns || [])
        // Hide RowNumber/internal columns; keep author-relevant fields.
        .filter((c) => !c.isHidden)
        .map((c) => ({
          name: c.name,
          dataType: String(c.dataType || 'string'),
          summarizeBy: c.summarizeBy ? String(c.summarizeBy) : undefined,
          isHidden: !!c.isHidden,
        })),
      measures: (t.measures || [])
        .filter((m) => !m.isHidden)
        .map((m) => ({ name: m.name, isHidden: !!m.isHidden })),
    }))
    // Drop tables that have nothing the author can bind.
    .filter((t) => t.columns.length > 0 || t.measures.length > 0);

    return NextResponse.json({
      ok: true,
      backend: 'aas',
      aasServer: resolved.server || process.env.LOOM_AAS_SERVER || null,
      aasDatabase: resolved.database,
      database: resolved.database,
      tables: out,
    });
  } catch (e: any) {
    // readModel() throws AasError(412) when no XMLA endpoint is configured.
    if (e instanceof AasError && e.status === 412) {
      return NextResponse.json(
        {
          ok: false,
          code: 'unbound',
          error:
            'The Fields pane reads the model schema over XMLA. Set LOOM_AAS_SERVER_URL to the ' +
            'AAS XMLA endpoint of the bound model (e.g. asazure://eastus2.asazure.windows.net/my-server) ' +
            'so the designer can list tables, columns and measures. The Console UAMI must be a server ' +
            'admin on that AAS instance.',
        },
        { status: 412 },
      );
    }
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
