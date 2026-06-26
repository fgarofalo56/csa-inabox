/**
 * report-model-resolver — the ONE place the Loom report DATA-SOURCE abstraction
 * is resolved, shared by `/api/items/report/[id]/fields` (schema → Fields pane)
 * and `/api/items/report/[id]/query` (visual execution).
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * Before this, both report routes resolved a model EXCLUSIVELY via
 * `resolveAasBinding(state.aasServer, state.aasDatabase)`. With Azure Analysis
 * Services unset they honest-gated 412 and the designer rendered nothing — a
 * report could only ever be sourced from AAS/XMLA. There was no way to bind a
 * report to a Loom `semantic-model` item, a warehouse/lakehouse query, or a
 * notebook-derived SELECT.
 *
 * ── The model (NO-FABRIC-DEPENDENCY.md) ────────────────────────────────────
 * A report now persists a `state.dataSource` discriminated union. The DEFAULT
 * Azure-native source is a Loom `semantic-model` item, which is itself either:
 *   • Loom-native — a `SemanticModelContent` over a Synapse warehouse (dedicated
 *     pool) or a lakehouse external table (serverless), queried with plain SQL.
 *     NO Analysis Services, NO Power BI, NO Fabric workspace required; OR
 *   • AAS-bound  — the model item carries `state.aasServer`/`state.aasDatabase`
 *     and is read over XMLA (the existing advanced path).
 * `direct-query` scaffolds an implicit single-table model from a SELECT, and
 * `aas` is the legacy XMLA binding kept for back-compat.
 *
 * This resolver dispatches on that union and returns ONE of three honest
 * outcomes — never a mock (NO-VAPORWARE.md):
 *   • `{ backend:'aas', binding }`            → existing readModel()/executeAasQuery()
 *   • `{ backend:'loom-native', tables, sqlSource }`
 *                                             → real SQL aggregation over Synapse
 *   • `{ backend:'unbound', gate }`           → 412 naming the EXACT remediation
 *
 * `tables` (FieldTable[]) matches the existing `/fields` output shape verbatim,
 * so the designer's Fields tree is unchanged. `sqlSource` describes how the SQL
 * compiler (wells-to-sql) should run a visual: which Synapse target + either a
 * model-table→base-relation map (semantic-model) or a derived SELECT
 * (direct-query). No network call is made for the AAS path; the loom-native
 * path makes only the same kind of real Synapse query the rest of Loom uses.
 *
 * The item/workspace lookups are real Cosmos queries scoped to the caller's
 * tenant (same RBAC pattern as model-binding.ts / pbi-content-fallback.ts).
 */

import type { WorkspaceItem } from '@/lib/types/workspace';
import { resolveAasBinding } from '@/lib/azure/aas-dax';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery,
  type SynapseTarget,
} from '@/lib/azure/synapse-sql-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '@/app/api/items/_lib/pbi-content-fallback';
import type { SemanticModelContent } from '@/lib/apps/content-bundles/types';
import { readOnlySelect } from '@/lib/thread/sql-guard';

export const SEMANTIC_MODEL_ITEM_TYPE = 'semantic-model';

// ───────────────────────────────────────────────────────────────────────────
// Field schema shapes — identical to the existing /fields route output so the
// designer's Fields tree consumes either source without change.
// ───────────────────────────────────────────────────────────────────────────

/** One model column surfaced to the Fields pane. */
export interface FieldColumn {
  name: string;
  dataType: string;
  /** Default summarization hint (sum/count/none…) — drives the well's default agg. */
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

// ───────────────────────────────────────────────────────────────────────────
// Data-source union — persisted on report `state.dataSource`. Mirrored on the
// client in lib/editors/report/report-data-source.ts; kept here as the
// server-side source of truth the routes validate against.
// ───────────────────────────────────────────────────────────────────────────

/** DEFAULT Azure-native: a report binds to a Loom `semantic-model` item. */
export interface SemanticModelDataSource {
  kind: 'semantic-model';
  /** The semantic-model item id (a Cosmos id, or a `loom:` content id). */
  itemId: string;
}

/**
 * An implicit single-table model from a read-only SELECT over a warehouse
 * (dedicated pool) or lakehouse external table (serverless). The designer
 * scaffolds this into a real `semantic-model` item on first save; until then
 * the resolver introspects + runs it inline.
 */
export interface DirectQueryDataSource {
  kind: 'direct-query';
  target: 'warehouse' | 'lakehouse';
  /** Read-only single SELECT (guarded by sql-guard). */
  sql: string;
  /** Serverless lakehouse database the views live in (default 'master'). */
  database?: string;
  /** Set once scaffolded to a reusable semantic-model item. */
  modelItemId?: string;
}

/** Advanced / legacy: a direct Azure Analysis Services XMLA binding. */
export interface AasDataSource {
  kind: 'aas';
  /** XMLA server URI (asazure://…); falls back to LOOM_AAS_SERVER when absent. */
  server?: string;
  /** Model/database name; falls back to LOOM_AAS_DATABASE when absent. */
  database?: string;
}

export type ReportDataSource =
  | SemanticModelDataSource
  | DirectQueryDataSource
  | AasDataSource;

export const REPORT_DATA_SOURCE_KINDS: ReadonlyArray<ReportDataSource['kind']> = [
  'semantic-model',
  'direct-query',
  'aas',
];

// ───────────────────────────────────────────────────────────────────────────
// SQL-source descriptor — what the loom-native backend hands to the wells→SQL
// compiler so it can build a `SELECT … GROUP BY` for each visual. Either a
// base-table map (one relation per model table) or a single derived SELECT.
// ───────────────────────────────────────────────────────────────────────────

/** A model table mapped to its physical base relation on a Synapse pool. */
export interface SqlBaseRelation {
  /** Schema the table/view lives in (e.g. 'dbo'). */
  schema: string;
  /** Physical table/view name. */
  table: string;
  /** Bracket-quoted `[schema].[table]` — ready to splice as a FROM relation. */
  relation: string;
}

interface SqlSourceCommon {
  /** Synapse pool the compiler runs the visual SQL against. */
  target: SynapseTarget;
  /** 'warehouse' = dedicated pool; 'lakehouse' = serverless OPENROWSET views. */
  kind: 'warehouse' | 'lakehouse';
}

/** semantic-model: each model table maps 1:1 to a base relation. */
export interface TableMapSqlSource extends SqlSourceCommon {
  mode: 'table-map';
  /** Model-table name → its base relation. The wells reference model tables. */
  tableMap: Record<string, SqlBaseRelation>;
}

/** direct-query: a single validated SELECT wrapped as a derived table. */
export interface DerivedSqlSource extends SqlSourceCommon {
  mode: 'derived';
  /** The read-only SELECT (sql-guard validated). */
  sql: string;
  /** The single synthetic table name the introspected fields hang under. */
  tableName: string;
}

export type ReportSqlSource = TableMapSqlSource | DerivedSqlSource;

// ───────────────────────────────────────────────────────────────────────────
// Resolver result.
// ───────────────────────────────────────────────────────────────────────────

/** An honest, actionable 412 gate (never a silent failure / mock). */
export interface ReportModelGate {
  code: 'unbound';
  /** Human-readable remediation naming the exact data-source / env / resource. */
  error: string;
  /** Machine hint: env var name, or a known token (`dataSource`/`semantic-model`). */
  missing?: string;
}

export type ResolvedReportModel =
  | {
      backend: 'aas';
      binding: { region: string; serverName: string; database: string };
      source: ReportDataSource;
    }
  | {
      backend: 'loom-native';
      tables: FieldTable[];
      sqlSource: ReportSqlSource;
      source: ReportDataSource;
    }
  | { backend: 'unbound'; gate: ReportModelGate };

// ───────────────────────────────────────────────────────────────────────────
// Honest-gate copy (shared so /fields + /query surface identical remediation).
// ───────────────────────────────────────────────────────────────────────────

const PICK_SOURCE_HINT =
  'This report has no data source yet. Open "Data source" in the designer and pick a ' +
  'Loom semantic model, a warehouse/lakehouse query, or (advanced) an Azure Analysis ' +
  'Services XMLA binding. The Azure-native default needs NO Fabric / Power BI workspace.';

const AAS_HINT =
  'This report is bound to Azure Analysis Services but no server/database resolved. Set the ' +
  'item\'s state.aasServer (XMLA URI, e.g. asazure://eastus2.asazure.windows.net/my-server) + ' +
  'state.aasDatabase, or the LOOM_AAS_SERVER + LOOM_AAS_DATABASE environment variables. The ' +
  'Console UAMI must be a server administrator on the AAS instance. Or switch the data source to ' +
  'a Loom semantic model (the Azure-native default, no AAS required).';

const SYNAPSE_HINT =
  'A SQL data source for this report needs a Synapse SQL endpoint. Set LOOM_SYNAPSE_WORKSPACE ' +
  '(and LOOM_SYNAPSE_DEDICATED_POOL for a warehouse source) — deployed by ' +
  'platform/fiab/bicep/modules/landing-zone. The Console UAMI is the workspace AAD admin.';

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers.
// ───────────────────────────────────────────────────────────────────────────

/** Bracket-quote a SQL identifier the T-SQL way (double any `]`). */
export function bracket(ident: string): string {
  return `[${String(ident).replace(/]/g, ']]')}]`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Map a tabular/SQL data type to a Fields-pane summarization default. Numerics
 * default to Sum (so dropping a measure-like column into Values aggregates,
 * matching Power BI); everything else defaults to none.
 */
export function defaultSummarizeBy(dataType: string | undefined): string {
  const t = (dataType || '').toLowerCase();
  if (/int|decimal|numeric|double|float|real|money|number|currency/.test(t)) {
    return 'sum';
  }
  return 'none';
}

/**
 * Read + normalize the report's data source. Prefers an explicit
 * `state.dataSource`; otherwise synthesizes a legacy AAS source from
 * `state.aasServer`/`state.aasDatabase` so already-saved reports keep working
 * unchanged. Returns null when nothing is configured.
 */
export function readReportDataSource(item: WorkspaceItem): ReportDataSource | null {
  const state = (item.state || {}) as Record<string, unknown>;
  const raw = state.dataSource as Record<string, unknown> | undefined;

  if (raw && typeof raw === 'object' && typeof raw.kind === 'string') {
    switch (raw.kind) {
      case 'semantic-model': {
        const itemId = str(raw.itemId);
        if (itemId) return { kind: 'semantic-model', itemId };
        break;
      }
      case 'direct-query': {
        const sql = str(raw.sql);
        const target = raw.target === 'lakehouse' ? 'lakehouse' : 'warehouse';
        if (sql) {
          return {
            kind: 'direct-query',
            target,
            sql,
            database: str(raw.database),
            modelItemId: str(raw.modelItemId),
          };
        }
        break;
      }
      case 'aas':
        return { kind: 'aas', server: str(raw.server), database: str(raw.database) };
    }
  }

  // Back-compat: a report saved before state.dataSource existed but with the
  // legacy AAS binding → treat it as an AAS source.
  const legacyServer = str(state.aasServer);
  const legacyDatabase = str(state.aasDatabase);
  if (legacyServer || legacyDatabase) {
    return { kind: 'aas', server: legacyServer, database: legacyDatabase };
  }
  return null;
}

/** Type guard the `/data-source` PUT route uses to validate a posted union. */
export function isReportDataSource(v: unknown): v is ReportDataSource {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case 'semantic-model':
      return typeof o.itemId === 'string' && o.itemId.trim().length > 0;
    case 'direct-query':
      return (
        typeof o.sql === 'string' &&
        o.sql.trim().length > 0 &&
        (o.target === 'warehouse' || o.target === 'lakehouse')
      );
    case 'aas':
      return true; // server/database optional (env fallback)
    default:
      return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Backend builders.
// ───────────────────────────────────────────────────────────────────────────

function unbound(error: string, missing?: string): ResolvedReportModel {
  return { backend: 'unbound', gate: { code: 'unbound', error, missing } };
}

/** AAS source (or a semantic-model item that is itself AAS-bound). */
function resolveAas(
  server: string | undefined,
  database: string | undefined,
  source: ReportDataSource,
): ResolvedReportModel {
  const binding = resolveAasBinding(server, database);
  if (!binding) return unbound(AAS_HINT, 'LOOM_AAS_SERVER');
  return { backend: 'aas', binding, source };
}

/**
 * Build the Synapse target for a SQL-backed source. `dedicatedTarget()` /
 * `serverlessTarget()` throw when their env vars are unset — caught here and
 * turned into an honest gate (never a crash).
 */
function buildSynapseTarget(
  kind: 'warehouse' | 'lakehouse',
  database?: string,
): { target: SynapseTarget } | { gate: ResolvedReportModel } {
  try {
    const target =
      kind === 'lakehouse'
        ? serverlessTarget(database || 'master')
        : dedicatedTarget();
    return { target };
  } catch (e: any) {
    const missing = /LOOM_SYNAPSE_DEDICATED_POOL/.test(String(e?.message))
      ? 'LOOM_SYNAPSE_DEDICATED_POOL'
      : 'LOOM_SYNAPSE_WORKSPACE';
    return { gate: unbound(`${SYNAPSE_HINT} (${e?.message || 'missing env var'})`, missing) };
  }
}

/** Build FieldTable[] from a Loom-native SemanticModelContent. */
function fieldTablesFromContent(content: SemanticModelContent): FieldTable[] {
  const measuresByTable = new Map<string, FieldMeasure[]>();
  for (const m of content.measures || []) {
    const list = measuresByTable.get(m.table) || [];
    list.push({ name: m.name, isHidden: false });
    measuresByTable.set(m.table, list);
  }
  return (content.tables || [])
    .map((t) => ({
      name: t.name,
      columns: (t.columns || []).map((c) => ({
        name: c.name,
        dataType: String(c.dataType || 'string'),
        summarizeBy: defaultSummarizeBy(c.dataType),
        isHidden: false,
      })),
      measures: measuresByTable.get(t.name) || [],
    }))
    // Drop tables the author can't bind anything from.
    .filter((t) => t.columns.length > 0 || t.measures.length > 0);
}

/** Build the base-relation map for a Loom-native semantic model. */
function tableMapFromContent(
  content: SemanticModelContent,
  schema: string,
): Record<string, SqlBaseRelation> {
  const map: Record<string, SqlBaseRelation> = {};
  for (const t of content.tables || []) {
    map[t.name] = {
      schema,
      table: t.name,
      relation: `${bracket(schema)}.${bracket(t.name)}`,
    };
  }
  return map;
}

/** Resolve a `semantic-model` data source (loom-native default, or AAS-bound). */
async function resolveSemanticModel(
  source: SemanticModelDataSource,
  tenantId: string,
): Promise<ResolvedReportModel> {
  const id = source.itemId;
  const model = isLoomContentId(id)
    ? await loadContentBackedItem(cosmosIdFromLoomId(id), SEMANTIC_MODEL_ITEM_TYPE, tenantId)
    : await loadModelItem(id, SEMANTIC_MODEL_ITEM_TYPE, tenantId);

  if (!model) {
    return unbound(
      `The bound semantic model (${id}) was not found in this tenant. Re-pick a semantic ` +
        'model in the report\'s Data source panel, or build one from a warehouse/lakehouse query.',
      'semantic-model',
    );
  }

  const mstate = (model.state || {}) as Record<string, unknown>;

  // The model item may itself be AAS-bound → read it over XMLA.
  const modelAasServer = str(mstate.aasServer);
  const modelAasDatabase = str(mstate.aasDatabase);
  if (modelAasServer || modelAasDatabase) {
    return resolveAas(modelAasServer, modelAasDatabase, source);
  }

  // Loom-native: a SemanticModelContent over a Synapse warehouse/lakehouse.
  const content = (mstate.content as any)?.kind === 'semantic-model'
    ? (mstate.content as SemanticModelContent)
    : null;
  if (!content) {
    return unbound(
      `Semantic model "${model.displayName}" has no Loom-native content or AAS binding to query. ` +
        'Open it and define tables/measures (or bind it to Azure Analysis Services), then retry.',
      'semantic-model',
    );
  }

  const sourceKind: 'warehouse' | 'lakehouse' =
    mstate.sourceTarget === 'lakehouse' ? 'lakehouse' : 'warehouse';
  const schema = str(mstate.sourceSchema) || 'dbo';
  const database = str(mstate.sourceDatabase);

  const built = buildSynapseTarget(sourceKind, database);
  if ('gate' in built) return built.gate;

  const tables = fieldTablesFromContent(content);
  if (tables.length === 0) {
    return unbound(
      `Semantic model "${model.displayName}" defines no columns or measures yet — add at least ` +
        'one table column or measure so the report can bind a field.',
      'semantic-model',
    );
  }

  return {
    backend: 'loom-native',
    tables,
    sqlSource: {
      mode: 'table-map',
      target: built.target,
      kind: sourceKind,
      tableMap: tableMapFromContent(content, schema),
    },
    source,
  };
}

/** Resolve a `direct-query` data source — introspect the SELECT for real
 *  column names, then expose it as a single-table derived source. */
async function resolveDirectQuery(
  source: DirectQueryDataSource,
): Promise<ResolvedReportModel> {
  const guarded = readOnlySelect(source.sql);
  if (!guarded.ok) {
    return unbound(`The report's SQL data source is invalid: ${guarded.error}`, 'direct-query');
  }

  const built = buildSynapseTarget(source.target, source.database);
  if ('gate' in built) return built.gate;

  const tableName = 'Query';
  // Real schema, no mock: ask the engine for the result-set columns via a
  // zero-row projection of the wrapped SELECT.
  let columns: string[];
  try {
    const probe = await executeQuery(
      built.target,
      `SELECT TOP 0 * FROM (\n${guarded.sql}\n) AS _loom_rpt`,
      30_000,
    );
    columns = probe.columns;
  } catch (e: any) {
    return unbound(
      `The report's SQL data source could not be introspected against Synapse: ${
        e?.message || String(e)
      }. Fix the query or the Synapse binding and retry.`,
      'direct-query',
    );
  }

  if (!columns.length) {
    return unbound(
      'The report\'s SQL data source returned no columns. Adjust the SELECT so it projects at ' +
        'least one column.',
      'direct-query',
    );
  }

  const fieldColumns: FieldColumn[] = columns.map((name) => ({
    name,
    dataType: 'string',
    summarizeBy: undefined,
    isHidden: false,
  }));

  return {
    backend: 'loom-native',
    tables: [{ name: tableName, columns: fieldColumns, measures: [] }],
    sqlSource: {
      mode: 'derived',
      target: built.target,
      kind: source.target,
      sql: guarded.sql,
      tableName,
    },
    source,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry point.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve the model backing a report item into a `{ backend, … }` the `/fields`
 * and `/query` routes dispatch on. Reads `state.dataSource` (or synthesizes a
 * legacy AAS source) and returns:
 *   • `aas`          — XMLA binding for readModel()/executeAasQuery()
 *   • `loom-native`  — Fields tables + a SQL source the wells→SQL compiler runs
 *   • `unbound`      — an honest 412 gate naming the exact remediation
 *
 * Pure of side effects beyond the Cosmos item lookup + (direct-query only) a
 * single zero-row Synapse introspection probe. No mock data is ever returned.
 */
export async function resolveReportModel(
  reportItem: WorkspaceItem,
  tenantId: string,
): Promise<ResolvedReportModel> {
  const source = readReportDataSource(reportItem);
  if (!source) return unbound(PICK_SOURCE_HINT, 'dataSource');

  switch (source.kind) {
    case 'aas':
      return resolveAas(source.server, source.database, source);
    case 'semantic-model':
      return resolveSemanticModel(source, tenantId);
    case 'direct-query':
      return resolveDirectQuery(source);
    default: {
      // Exhaustiveness guard — a new kind must add a branch above.
      const _never: never = source;
      return unbound(PICK_SOURCE_HINT, 'dataSource');
    }
  }
}
