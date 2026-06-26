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
import { resolveAasBinding, type DaxVisual } from '@/lib/azure/aas-dax';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery,
  buildDeltaOpenRowsetSql,
  type SynapseTarget,
  type SynapseQueryParam,
} from '@/lib/azure/synapse-sql-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '@/app/api/items/_lib/pbi-content-fallback';
import type { SemanticModelContent } from '@/lib/apps/content-bundles/types';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import {
  buildSqlFromVisual,
  type ReportFilterInput,
  type SqlSource,
  type SqlSourceColumn,
  type SqlSourceFrom,
} from '@/lib/azure/wells-to-sql';
import {
  loadConnection,
  authNeedsSecret,
  type LoomConnection,
} from '@/lib/azure/connections-store';
import { getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import {
  executeQuery as azureSqlExecuteQuery,
  executeWithCredential,
  executeParameterized,
} from '@/lib/azure/azure-sql-client';
import { executeStatement, databricksConfigGate, warehouseConfigGate } from '@/lib/azure/databricks-client';
import { executePostgresQuery, postgresQueryGate } from '@/lib/azure/postgres-flex-client';
import { queryItems } from '@/lib/azure/cosmos-data-client';
import { pathToHttpsUrl, downloadFile } from '@/lib/azure/adls-client';
import { parseDeltaSchema } from '@/lib/azure/delta-schema-parse';
import { resolveMlvDeltaUrl } from '@/lib/azure/materialized-lake-view-engine';
import { safeSegment, type MlvSpec } from '@/lib/azure/materialized-lake-view-model';

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

// ───────────────────────────────────────────────────────────────────────────
// Get Data (WAVE 1) — three NEW Azure-native data-source kinds. These mirror
// lib/editors/report/report-data-source.ts (the client SHARED CONTRACT) EXACTLY;
// do not diverge. They flow through the SAME resolve→/fields→/query→
// /connector-preview pipeline as the existing kinds, via buildConnectionExecutor.
// ───────────────────────────────────────────────────────────────────────────

/** Loom `ConnectionType` + forward-compat report keys (kept a plain string in
 *  the persisted union for resilience; validated against this set on read).
 *  `adx`/`mysql` are honest-gate / forward-compat — there is no bindable
 *  LoomConnection for them in Wave 1. */
export type ReportConnType =
  | 'azure-sql' | 'synapse-dedicated' | 'synapse-serverless' | 'generic-sql'
  | 'databricks-sql' | 'postgres' | 'cosmos' | 'storage-adls'
  | 'adx' | 'mysql';

export const REPORT_CONN_TYPES: readonly ReportConnType[] = [
  'azure-sql', 'synapse-dedicated', 'synapse-serverless', 'generic-sql',
  'databricks-sql', 'postgres', 'cosmos', 'storage-adls', 'adx', 'mysql',
];

/** What to read inside a bound connection (discriminated by `mode`). */
export type ReportObjectRef =
  | { mode: 'table'; schema?: string; table: string }        // SQL-family (schema+table); Cosmos (table=collection); ADX (table)
  | { mode: 'query'; sql: string }                           // SQL-family custom SELECT (sql-guard'd)
  | { mode: 'file'; containerPath: string; format: string }  // storage-adls connection: delta|parquet|csv|json
  | { mode: 'kql'; kql: string };                            // ADX raw KQL (advanced)

/** A report sourced from a reusable, KV-backed Loom Connection (Get Data path). */
export interface ConnectionDataSource {
  kind: 'connection';
  /** LoomConnection.id (GET /api/connections). '' until bound → isBound()=false. */
  connectionId: string;
  /** Mirror of the bound LoomConnection.type for fast labelling/dispatch. */
  connType: ReportConnType;
  /** Object inside the connection to read. */
  objectRef: ReportObjectRef;
}

/** A user-uploaded file staged to ADLS landing (POST /api/lakehouse/upload),
 *  read tabularly through Synapse serverless OPENROWSET (Console MI). */
export interface FileUploadDataSource {
  kind: 'file-upload';
  /** Display name of the uploaded file. */
  fileName: string;
  /** 'csv'|'parquet'|'json'|'delta'. */
  format: string;
  /** Full https/abfss path of the staged file/folder returned by the upload route. */
  containerPath: string;
}

/** An existing ADLS Gen2 path (no connection needed; Console MI via adls-client). */
export interface AdlsFileDataSource {
  kind: 'adls-file';
  /** Container (e.g. 'bronze'|'silver'|'gold'|'landing'). */
  container: string;
  /** Path within the container. */
  path: string;
  /** 'delta'|'parquet'|'csv'|'json'. */
  format: string;
}

export type ReportDataSource =
  | SemanticModelDataSource
  | DirectQueryDataSource
  | AasDataSource
  | ConnectionDataSource     // NEW (Get Data)
  | FileUploadDataSource     // NEW (Get Data)
  | AdlsFileDataSource;      // NEW (Get Data)

export const REPORT_DATA_SOURCE_KINDS: ReadonlyArray<ReportDataSource['kind']> = [
  'semantic-model',
  'direct-query',
  'aas',
  'connection',
  'file-upload',
  'adls-file',
];

function isReportConnType(v: unknown): v is ReportConnType {
  return typeof v === 'string' && (REPORT_CONN_TYPES as readonly string[]).includes(v);
}

/** Defensive parse of a persisted/wire `ReportObjectRef` (defaults to `table`). */
function parseObjectRef(value: unknown): ReportObjectRef {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  switch (v.mode) {
    case 'query':
      return { mode: 'query', sql: str(v.sql) || '' };
    case 'file':
      return { mode: 'file', containerPath: str(v.containerPath) || '', format: str(v.format) || 'parquet' };
    case 'kql':
      return { mode: 'kql', kql: str(v.kql) || '' };
    case 'table':
    default: {
      const schema = str(v.schema);
      return { mode: 'table', table: str(v.table) || '', ...(schema ? { schema } : {}) };
    }
  }
}

/** Is a `ReportObjectRef` fully specified for its `mode`? */
function objectRefComplete(ref: ReportObjectRef): boolean {
  switch (ref.mode) {
    case 'table': return !!ref.table && ref.table.trim().length > 0;
    case 'query': return !!ref.sql && ref.sql.trim().length > 0;
    case 'file': return !!ref.containerPath && ref.containerPath.trim().length > 0;
    case 'kql': return !!ref.kql && ref.kql.trim().length > 0;
    default: return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Storage mode (WAVE 2) — string-validated MIRROR of the `StorageMode` /
// `ConnectivityMode` union OWNED BY lib/editors/report/storage-mode-pane.tsx (a
// `'use client'` module this server file cannot import). This is the SAME
// mirroring pattern WAVE 1 used for `ReportConnType` across
// report-data-source.ts ↔ this resolver: the pane is the single documented
// definition; the resolver + wells-to-sql carry validated string mirrors so the
// contract is shared without a client→server import.
//
// Each Power BI storage mode maps 1:1 to an Azure-native execution, with NO
// Fabric / Power BI workspace and NO OneLake on the default path
// (no-fabric-dependency.md):
//   • DirectQuery → today's live Synapse / connector SQL (byte-identical default)
//   • Import      → a MATERIALIZED Delta cache (materialized-lake-view-engine),
//                   read with serverless OPENROWSET(FORMAT='DELTA')
//   • Dual        → both; the cache serves aggregations once materialized, live
//                   Synapse is the always-available fallback
//   • DirectLake  → serverless OPENROWSET over the table's own Delta (no
//                   materialization step)
// ───────────────────────────────────────────────────────────────────────────

/** Power BI storage modes mapped 1:1 to Azure-native execution (pane mirror). */
export type StorageMode = 'DirectQuery' | 'Import' | 'Dual' | 'DirectLake';

/** Every `StorageMode`, in picker order (drives `isStorageMode`). */
export const STORAGE_MODES: readonly StorageMode[] = ['DirectQuery', 'Import', 'Dual', 'DirectLake'];

/** True when `v` is one of the recognized `StorageMode` literals. */
export function isStorageMode(v: unknown): v is StorageMode {
  return typeof v === 'string' && (STORAGE_MODES as readonly string[]).includes(v);
}

/** Per-table storage selection persisted on report `state.tableStorage[table]`
 *  (additive — absent ⇒ every table DirectQuery in one 'primary' group). */
export interface TableStorage {
  mode: StorageMode;
  /** Source-group id; default 'primary'. Cross-group = a limited relationship. */
  group?: string;
}
export type TableStorageMap = Record<string, TableStorage>;

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

/**
 * One model table's per-table SOURCE-GROUP binding (WAVE 2): the live relation +
 * (when Import/Dual/DirectLake) its materialized Delta cache relation, plus the
 * storage mode and a `cacheReady` flag. Consumed by the wells→SQL cache-vs-live
 * pick (`wells-to-sql.pickRelation` / `groupVisualBindings`) and the two routes'
 * `source-groups` branch. `live` runs on its Synapse pool; `cache` is a
 * serverless OPENROWSET over the report-table MLV's Delta (the SAME Delta the
 * Azure-native refresh route's Spark batch writes — see `reportTableMlvSpec`).
 */
export interface TableSourceBinding {
  /** Source-group id ('primary' for single-source reports). */
  group: string;
  /** Mirror of the owned `StorageMode` union (string-validated). */
  storageMode: StorageMode;
  /** LIVE relation (DirectQuery / Dual-live) + the Synapse pool it runs on. */
  live?: { from: SqlSourceFrom; target: SynapseTarget; kind: 'warehouse' | 'lakehouse' };
  /** CACHE relation (Import / Dual-cache / DirectLake): serverless OPENROWSET over Delta. */
  cache?: { from: SqlSourceFrom; target: SynapseTarget; deltaUrl: string };
  /** True once an Import/Dual cache exists (state.lastRefresh[table] present). */
  cacheReady: boolean;
  /** Smaller-side detection for cross-group ("limited relationship") joins. */
  rowEstimate?: number;
}

/**
 * GENERALIZED arm (WAVE 2): model-table → its per-table source-group binding.
 * Emitted ONLY when `state.tableStorage` has entries (or >1 source group exists);
 * otherwise the resolver keeps emitting `TableMapSqlSource` / `DerivedSqlSource`
 * byte-identical (zero behavioural change for existing single-source reports).
 *
 * `tableMap` is carried alongside `bindings` purely for BACK-COMPAT: it is the
 * flattened LIVE (DirectQuery) relation map, so any consumer that has not yet
 * grown a `mode === 'source-groups'` branch (the routes' `toSqlSource`, which
 * today only special-cases `'derived'` and otherwise reads `.tableMap`) keeps
 * type-checking AND runs the live relation — the correct, honest fallback (live
 * Synapse rows, never a mock/blank) until that branch lands. The rich `bindings`
 * are what the WAVE-2 source-groups branch consumes for the cache-vs-live pick.
 * `target`/`kind` are the PRIMARY group's.
 */
export interface SourceGroupSqlSource extends SqlSourceCommon {
  mode: 'source-groups';
  /** Per-model-table source-group binding (live + cache + storage mode). */
  bindings: Record<string, TableSourceBinding>;
  /** Back-compat: flattened live-relation map for un-upgraded `.tableMap` reads. */
  tableMap: Record<string, SqlBaseRelation>;
}

export type ReportSqlSource = TableMapSqlSource | DerivedSqlSource | SourceGroupSqlSource;


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
  | {
      backend: 'connection';
      connType: ReportConnType;
      executor: ConnectionExecutor;
      source: ReportDataSource;
    }
  | { backend: 'unbound'; gate: ReportModelGate };

// ───────────────────────────────────────────────────────────────────────────
// ConnectionExecutor — the uniform surface every Get-Data connType implements.
// Routes (/fields, /query, /connector-preview) call ONLY these; they never
// touch a data-plane client directly. This mirrors the aas/loom-native dispatch
// pattern: the resolver owns ALL backend knowledge, routes stay thin.
// ───────────────────────────────────────────────────────────────────────────

/** A single executed visual's result + the emitted query text and language. */
export interface ConnectionVisualResult {
  rows: Record<string, unknown>[];
  query: string;
  lang: 'sql' | 'kql' | 'nosql';
}

/** Navigator preview rows for a connector source. */
export interface ConnectionPreviewResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export interface ConnectionExecutor {
  connType: ReportConnType;
  /** Real schema → Fields pane (IDENTICAL FieldTable[] shape as today). */
  introspectFields(): Promise<FieldTable[]>;
  /** Compile wells+filters → run → object rows + emitted query text. */
  runVisual(
    visual: DaxVisual,
    filters: ReportFilterInput[] | undefined,
  ): Promise<ConnectionVisualResult>;
  /** Navigator preview: real SELECT/take TOP N (or list-objects). */
  preview(limit: number): Promise<ConnectionPreviewResult>;
}

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
      case 'connection': {
        const connectionId = str(raw.connectionId) || '';
        const connType = isReportConnType(raw.connType) ? raw.connType : 'azure-sql';
        return { kind: 'connection', connectionId, connType, objectRef: parseObjectRef(raw.objectRef) };
      }
      case 'file-upload': {
        const containerPath = str(raw.containerPath);
        const format = str(raw.format);
        if (containerPath && format) {
          return { kind: 'file-upload', fileName: str(raw.fileName) || '', format, containerPath };
        }
        break;
      }
      case 'adls-file': {
        const container = str(raw.container);
        const path = str(raw.path);
        const format = str(raw.format);
        if (container && path && format) {
          return { kind: 'adls-file', container, path, format };
        }
        break;
      }
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
    case 'connection':
      return (
        typeof o.connectionId === 'string' &&
        o.connectionId.trim().length > 0 &&
        isReportConnType(o.connType) &&
        !!o.objectRef &&
        objectRefComplete(parseObjectRef(o.objectRef))
      );
    case 'file-upload':
      return (
        typeof o.containerPath === 'string' && o.containerPath.trim().length > 0 &&
        typeof o.format === 'string' && o.format.trim().length > 0
      );
    case 'adls-file':
      return (
        typeof o.container === 'string' && o.container.trim().length > 0 &&
        typeof o.path === 'string' && o.path.trim().length > 0 &&
        typeof o.format === 'string' && o.format.trim().length > 0
      );
    default:
      return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Per-table source groups (WAVE 2) — Azure-native storage modes.
//
// `reportTableMlvSpec` is the SHARED source of truth used by BOTH this resolver's
// cache path AND the Azure-native refresh route, so the Delta URL the resolver
// reads from is EXACTLY the Delta the refresh route's Spark batch writes. The
// resolver wraps the existing table→relation map into a `SourceGroupSqlSource`
// ONLY when `state.tableStorage` is set (or >1 group exists); otherwise it keeps
// emitting the existing `TableMapSqlSource` / `DerivedSqlSource` byte-identical.
// Nothing here reaches Fabric / Power BI / OneLake — every cache is a serverless
// OPENROWSET over an ADLS Delta produced by the Synapse Spark MLV engine.
// ───────────────────────────────────────────────────────────────────────────

/** Strip a `loom:` content prefix so the bare-Cosmos-id and the `loom:<id>`
 *  content-id form of a report id derive the SAME MLV schema. The resolver reads
 *  the cache the refresh route writes — both call `reportTableMlvSpec`, so this
 *  normalization keeps their Delta paths aligned regardless of which id form each
 *  caller passes. */
function normalizeReportId(reportId: string): string {
  return String(reportId).replace(/^loom:/, '');
}

/**
 * The MLV spec for one report table's Import/Dual materialized Delta cache —
 * the SHARED SoT for the resolver's cache relation AND the Azure-native refresh
 * route's Spark batch. Both resolve the cache's Delta URL from this same spec
 * (`resolveMlvDeltaUrl`), so the report reads exactly what the refresh batch
 * writes. 100% Azure-native (Synapse Spark → ADLS Delta); no Fabric required.
 */
export function reportTableMlvSpec(reportId: string, table: string, baseSelectSql: string): MlvSpec {
  return {
    language: 'sql',
    container: 'silver',
    schema: `report_${safeSegment(normalizeReportId(reportId))}`,
    viewName: safeSegment(table),
    sql: `SELECT * FROM (${baseSelectSql}) AS _src`,
    refreshMode: 'full',
  };
}

/** What each model table contributes to the source-group wrap: its LIVE relation
 *  FROM, the base SELECT its Import/Dual cache materializes, and (when table-
 *  backed) the `SqlBaseRelation` used to flatten the back-compat `tableMap`. */
interface BaseTableInput {
  liveFrom: SqlSourceFrom;
  baseSelectSql: string;
  baseRelation?: SqlBaseRelation;
}

/** Validate a persisted `state.tableStorage` bag into a `TableStorageMap`. */
function parseTableStorageState(value: unknown): TableStorageMap {
  if (!value || typeof value !== 'object') return {};
  const out: TableStorageMap = {};
  for (const [table, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!isStorageMode(r.mode)) continue;
    const group = typeof r.group === 'string' && r.group.trim() ? r.group.trim() : undefined;
    out[table] = { mode: r.mode, ...(group ? { group } : {}) };
  }
  return out;
}

/** Tables that have a materialized cache (a `state.lastRefresh[table]` record). */
function parseLastRefreshTables(value: unknown): Set<string> {
  const set = new Set<string>();
  if (value && typeof value === 'object') {
    for (const [table, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw && typeof raw === 'object') set.add(table);
    }
  }
  return set;
}

/**
 * Build a table's CACHE relation — a serverless OPENROWSET over the report-table
 * MLV's Delta. Returns null when serverless SQL isn't configured (the binding
 * then keeps only its live relation, so Import/Dual tables fall back to live —
 * never a blank or a mock). The Delta URL == `resolveMlvDeltaUrl(reportTableMlvSpec(…))`,
 * the exact location the refresh route's Spark batch writes.
 */
function buildTableCacheRelation(
  reportId: string,
  table: string,
  baseSelectSql: string,
): { from: SqlSourceFrom; target: SynapseTarget; deltaUrl: string } | null {
  const deltaUrl = resolveMlvDeltaUrl(reportTableMlvSpec(reportId, table, baseSelectSql));
  if (!deltaUrl) return null;
  let target: SynapseTarget;
  try {
    target = serverlessTarget('master');
  } catch {
    return null;
  }
  const url = deltaUrl.replace(/'/g, "''");
  return {
    from: { kind: 'derived', sql: `SELECT * FROM OPENROWSET(BULK '${url}', FORMAT='DELTA') AS r` },
    target,
    deltaUrl,
  };
}

/**
 * Wrap a loom-native table→relation map into a `SourceGroupSqlSource` when the
 * report has per-table storage config (`state.tableStorage`) or more than one
 * source group. Returns null otherwise, so the caller emits its existing
 * `TableMapSqlSource` / `DerivedSqlSource` byte-identical (back-compat). Each
 * table's `live` is its current relation + target; `cache` (Import/Dual/DirectLake)
 * is a serverless OPENROWSET over `reportTableMlvSpec`'s Delta; `cacheReady` reads
 * `state.lastRefresh`. A table with no persisted entry defaults to DirectQuery in
 * the 'primary' group (the same base relation it has today).
 */
function buildSourceGroups(
  reportItem: WorkspaceItem,
  common: SqlSourceCommon,
  relations: Record<string, BaseTableInput>,
): SourceGroupSqlSource | null {
  const state = (reportItem.state || {}) as Record<string, unknown>;
  const tableStorage = parseTableStorageState(state.tableStorage);
  const cachedTables = parseLastRefreshTables(state.lastRefresh);

  const groups = new Set<string>();
  for (const ts of Object.values(tableStorage)) groups.add(ts.group || 'primary');

  // Back-compat: no per-table storage AND a single group ⇒ DON'T wrap.
  if (Object.keys(tableStorage).length === 0 && groups.size <= 1) return null;

  const reportId = reportItem.id;
  const bindings: Record<string, TableSourceBinding> = {};
  const tableMap: Record<string, SqlBaseRelation> = {};

  for (const [tableName, rel] of Object.entries(relations)) {
    const ts = tableStorage[tableName];
    const storageMode: StorageMode = ts?.mode ?? 'DirectQuery';
    const group = ts?.group || 'primary';

    const live: TableSourceBinding['live'] = { from: rel.liveFrom, target: common.target, kind: common.kind };

    let cache: TableSourceBinding['cache'];
    let cacheReady = false;
    if (storageMode === 'Import' || storageMode === 'Dual' || storageMode === 'DirectLake') {
      const built = buildTableCacheRelation(reportId, tableName, rel.baseSelectSql);
      if (built) {
        cache = built;
        cacheReady = cachedTables.has(tableName);
      }
    }

    bindings[tableName] = { group, storageMode, live, ...(cache ? { cache } : {}), cacheReady };
    if (rel.baseRelation) tableMap[tableName] = rel.baseRelation;
  }

  return { mode: 'source-groups', target: common.target, kind: common.kind, bindings, tableMap };
}

/** Adapt a semantic-model `tableMap` to the source-group wrap input (each model
 *  table → its live base relation + the SELECT its cache would materialize). */
function relationsFromTableMap(tableMap: Record<string, SqlBaseRelation>): Record<string, BaseTableInput> {
  const out: Record<string, BaseTableInput> = {};
  for (const [name, rel] of Object.entries(tableMap)) {
    out[name] = {
      liveFrom: { kind: 'table', schema: rel.schema, table: rel.table },
      baseSelectSql: `SELECT * FROM ${rel.relation}`,
      baseRelation: rel,
    };
  }
  return out;
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
  reportItem: WorkspaceItem,
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

  const tableMap = tableMapFromContent(content, schema);
  const base: TableMapSqlSource = {
    mode: 'table-map',
    target: built.target,
    kind: sourceKind,
    tableMap,
  };
  return {
    backend: 'loom-native',
    tables,
    // WAVE 2: wrap into per-table source groups when `state.tableStorage` is set;
    // else emit the existing TableMapSqlSource byte-identical (back-compat).
    sqlSource:
      buildSourceGroups(reportItem, { target: built.target, kind: sourceKind }, relationsFromTableMap(tableMap)) ??
      base,
    source,
  };
}

/** Resolve a `direct-query` data source — introspect the SELECT for real
 *  column names, then expose it as a single-table derived source. */
async function resolveDirectQuery(
  source: DirectQueryDataSource,
  reportItem: WorkspaceItem,
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

  const derived: DerivedSqlSource = {
    mode: 'derived',
    target: built.target,
    kind: source.target,
    sql: guarded.sql,
    tableName,
  };
  return {
    backend: 'loom-native',
    tables: [{ name: tableName, columns: fieldColumns, measures: [] }],
    // WAVE 2: a single-table direct query is one 'primary' group; wrap into
    // source groups only when per-table storage is set, else emit the
    // DerivedSqlSource byte-identical (back-compat).
    sqlSource:
      buildSourceGroups(reportItem, { target: built.target, kind: source.target }, {
        [tableName]: { liveFrom: { kind: 'derived', sql: guarded.sql }, baseSelectSql: guarded.sql },
      }) ?? derived,
    source,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Get Data (WAVE 1) — connection / file backends. buildConnectionExecutor()
// loads the LoomConnection (or resolves the file path), checks the per-engine
// env gate, resolves a KV secret when authNeedsSecret, and returns a
// ConnectionExecutor wired to a REAL Azure data-plane client — or an honest
// 'unbound' gate naming the exact connection/role/env. NEVER mock data.
// ───────────────────────────────────────────────────────────────────────────

/** SQL dialect a connType compiles its wells against (mirrors wells-to-sql). */
type ReportSqlDialect = 'tsql' | 'synapse' | 'generic-sql' | 'postgres' | 'mysql' | 'databricks-sql';

/** Flatten a columns + row-matrix result into row objects (Fields-pane shape). */
function rowsToRecords(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
}

/** A normalized read against a SQL-family engine. Binds `@p<n>` params only when
 *  the engine supports the T-SQL marker syntax (params is otherwise empty). */
type SqlRunner = (
  sql: string,
  params?: SynapseQueryParam[],
) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;

/** Quote a SQL identifier per dialect (injection-safe — doubles the closer). */
function quoteIdent(name: string, dialect: ReportSqlDialect): string {
  if (dialect === 'postgres') return `"${name.replace(/"/g, '""')}"`;
  if (dialect === 'databricks-sql' || dialect === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `[${name.replace(/]/g, ']]')}]`; // tsql | synapse | generic-sql
}

/** Bracket-quote a `[schema].[table]`-style relation for a dialect. */
function relationRef(dialect: ReportSqlDialect, schema: string | undefined, table: string): string {
  return (schema ? `${quoteIdent(schema, dialect)}.` : '') + quoteIdent(table, dialect);
}

/** A single-quoted SQL string literal (doubles embedded quotes). */
function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** `SELECT TOP n *` (T-SQL family) / `SELECT * … LIMIT n` (Postgres/Databricks/MySQL). */
function topSelectStar(dialect: ReportSqlDialect, n: number, fromBody: string): string {
  if (dialect === 'postgres' || dialect === 'databricks-sql' || dialect === 'mysql') {
    return `SELECT * ${fromBody} LIMIT ${n}`;
  }
  return `SELECT TOP ${n} * ${fromBody}`;
}

/** Build the FROM body (`FROM <relation|derived>`) for an object ref. */
function fromBodyFor(dialect: ReportSqlDialect, ref: ReportObjectRef): string {
  if (ref.mode === 'query') return `FROM (${ref.sql.trim().replace(/;+\s*$/, '')}) AS _loom_q`;
  if (ref.mode === 'table') return `FROM ${relationRef(dialect, ref.schema, ref.table)}`;
  // 'file' / 'kql' are handled by their own executors — never reached here.
  return 'FROM (SELECT 1 AS _x) AS _loom_q';
}

/** Build a SqlSource for buildSqlFromVisual. Attaches `dialect` (consumed by the
 *  wells-to-sql dialect parametrization) via assertion so it compiles whether or
 *  not that optional field has landed in the SqlSource type yet. */
function makeSqlSource(
  from: SqlSource['from'],
  columns: SqlSourceColumn[],
  dialect: ReportSqlDialect,
): SqlSource {
  return { from, columns, dialect } as SqlSource;
}

/** Read column key from a metadata row case-insensitively (INFORMATION_SCHEMA
 *  returns COLUMN_NAME on T-SQL, column_name on Postgres/Databricks). */
function pickKey(row: Record<string, unknown>, want: string): unknown {
  const lc = want.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lc) return row[k];
  }
  return undefined;
}

/** Build FieldTable[] from a flat column list (numeric → default Sum). */
function fieldTableFromColumns(
  tableName: string,
  cols: Array<{ name: string; dataType?: string }>,
): FieldTable[] {
  const columns: FieldColumn[] = cols
    .filter((c) => !!c.name)
    .map((c) => ({
      name: c.name,
      dataType: c.dataType || 'string',
      summarizeBy: defaultSummarizeBy(c.dataType),
      isHidden: false,
    }));
  if (!columns.length) return [];
  return [{ name: tableName, columns, measures: [] }];
}

// ── SQL-family executor (azure-sql | generic-sql | synapse | databricks | postgres) ──

interface SqlExecutorWiring {
  connType: ReportConnType;
  dialect: ReportSqlDialect;
  run: SqlRunner;
  objectRef: ReportObjectRef;
  /** Display name for the single Fields-pane table. */
  tableName: string;
  /**
   * Whether the runner actually binds the `@p<n>` markers buildSqlFromVisual
   * emits. This is an AUTH property, NOT a dialect one: only the entra-mi
   * Azure-SQL/Synapse runners bind params (executeParameterized / Synapse param
   * binding). The credentialed (connection-string / sql-password) runners call
   * executeWithCredential, which IGNORES the params arg — so pushing WHERE/HAVING
   * predicates there would emit unbound `@p0` markers and fail at runtime the
   * moment a visual has a filter. Computed at the dispatch site where
   * conn.authMethod is known; false → filters are re-applied client-side and the
   * visual is never blanked.
   */
  canParam: boolean;
}

function makeSqlExecutor(w: SqlExecutorWiring): ConnectionExecutor {
  const { connType, dialect, run, objectRef, tableName, canParam } = w;

  async function introspectColumns(): Promise<Array<{ name: string; dataType?: string }>> {
    if (objectRef.mode === 'table') {
      // Real schema via INFORMATION_SCHEMA (gives column types for summarizeBy).
      try {
        const where =
          `WHERE TABLE_NAME = ${sqlLiteral(objectRef.table)}` +
          (objectRef.schema ? ` AND TABLE_SCHEMA = ${sqlLiteral(objectRef.schema)}` : '');
        const meta = await run(
          `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS ${where} ORDER BY ORDINAL_POSITION`,
        );
        const cols = meta.rows
          .map((r) => ({ name: String(pickKey(r, 'COLUMN_NAME') ?? ''), dataType: String(pickKey(r, 'DATA_TYPE') ?? '') }))
          .filter((c) => c.name);
        if (cols.length) return cols;
      } catch {
        /* fall through to a zero-row projection below */
      }
    }
    // Custom query, or a table INFORMATION_SCHEMA couldn't describe → zero-row probe.
    const probe = await run(topSelectStar(dialect, 0, fromBodyFor(dialect, objectRef)));
    return probe.columns.map((name) => ({ name }));
  }

  return {
    connType,
    async introspectFields(): Promise<FieldTable[]> {
      const cols = await introspectColumns();
      return fieldTableFromColumns(tableName, cols);
    },
    async runVisual(visual, filters): Promise<ConnectionVisualResult> {
      const cols = await introspectColumns();
      const whitelist: SqlSourceColumn[] = cols.map((c) => ({
        table: tableName,
        name: c.name,
        dataType: c.dataType,
      }));
      const from: SqlSource['from'] =
        objectRef.mode === 'query'
          ? { kind: 'derived', sql: objectRef.sql }
          : { kind: 'table', schema: objectRef.mode === 'table' ? objectRef.schema : undefined, table: objectRef.mode === 'table' ? objectRef.table : tableName };
      const sqlSource = makeSqlSource(from, whitelist, dialect);
      // Only push WHERE/HAVING into the engine when its param markers can bind.
      const compiled = buildSqlFromVisual(visual, canParam ? filters : undefined, sqlSource);
      if (!compiled) {
        throw new Error('This visual has no fields to query yet — drop a field into a well.');
      }
      const res = await run(compiled.sql, canParam ? compiled.parameters : undefined);
      return { rows: res.rows, query: compiled.sql, lang: 'sql' };
    },
    async preview(limit): Promise<ConnectionPreviewResult> {
      const n = clampRows(limit);
      const res = await run(topSelectStar(dialect, n, fromBodyFor(dialect, objectRef)));
      return { columns: res.columns, rows: res.rows.slice(0, n), truncated: res.rows.length > n };
    },
  };
}

/** Clamp a caller-supplied preview row cap to a safe positive integer. */
function clampRows(n: number | undefined, max = 1000): number {
  if (n == null || !Number.isFinite(n)) return 100;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

// ── Cosmos executor (NoSQL aggregate) ───────────────────────────────────────

const COSMOS_AGG_FN: Record<string, string> = { Sum: 'SUM', Avg: 'AVG', Count: 'COUNT', Min: 'MIN', Max: 'MAX' };
const COSMOS_SCALAR_OP: Record<string, string> = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=' };

/** Cosmos `c["name"]` path reference (JSON-escaped — injection-safe). */
function cosmosRef(name: string): string {
  return `c[${JSON.stringify(name)}]`;
}

interface CosmosCompiled { query: string; parameters: Array<{ name: string; value: unknown }> }

/** Compile a designer visual + filters into a Cosmos SQL aggregate. Row cap is
 *  applied via the queryItems `maxItems` page size, not TOP (Cosmos restricts
 *  TOP with GROUP BY). Values bind as `@p<n>` parameters. */
function buildCosmosSql(visual: DaxVisual, filters: ReportFilterInput[] | undefined): CosmosCompiled {
  const wells = visual.wells || {};
  const type = (visual.type || '').toLowerCase();
  const params: Array<{ name: string; value: unknown }> = [];
  const addParam = (v: unknown): string => {
    const name = `@p${params.length}`;
    params.push({ name, value: v });
    return name;
  };
  const fieldName = (w: { table?: string; column?: string }): string | null =>
    w.column && w.column.trim() ? w.column.trim() : null;

  const groups = (type === 'card' ? [] : [...(wells.category || []), ...(wells.legend || [])])
    .map(fieldName)
    .filter((n): n is string => !!n);
  const uniqGroups = Array.from(new Set(groups));

  const aggs = (wells.values || [])
    .map((w) => {
      const name = fieldName(w);
      if (!name) return null;
      const useAgg = w.aggregation && w.aggregation !== 'None';
      const fn = useAgg ? COSMOS_AGG_FN[w.aggregation as string] || 'SUM' : 'SUM';
      const alias = useAgg ? `${w.aggregation} of ${name}` : `Sum of ${name}`;
      return { expr: `${fn}(${cosmosRef(name)})`, alias };
    })
    .filter((a): a is { expr: string; alias: string } => !!a);

  // WHERE from column filters (scalar ops + contains/in/between).
  const where: string[] = [];
  for (const f of filters || []) {
    if (f.measure) continue; // measure filters not modeled for Cosmos
    const name = f.column?.trim();
    if (!name) continue;
    const ref = cosmosRef(name);
    if (COSMOS_SCALAR_OP[f.op] && f.value != null && f.value !== '') {
      where.push(`${ref} ${COSMOS_SCALAR_OP[f.op]} ${addParam(f.value)}`);
    } else if (f.op === 'contains' && f.value) {
      where.push(`CONTAINS(${ref}, ${addParam(f.value)})`);
    } else if (f.op === 'between' && f.value && f.value2) {
      where.push(`${ref} >= ${addParam(f.value)} AND ${ref} <= ${addParam(f.value2)}`);
    } else if (f.op === 'in') {
      const set = (f.values && f.values.length ? f.values : (f.value || '').split(','))
        .map((v) => v.trim()).filter(Boolean);
      if (set.length) where.push(`${ref} IN (${set.map((v) => addParam(v)).join(', ')})`);
    }
  }
  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  // Shape: distinct (no values) vs aggregate (with values).
  if (aggs.length === 0) {
    const sel = uniqGroups.length
      ? `DISTINCT ${uniqGroups.map((g) => `${cosmosRef(g)} AS ${JSON.stringify(g)}`).join(', ')}`
      : '*';
    return { query: `SELECT ${sel} FROM c${whereClause}`, parameters: params };
  }
  const selectCols = [
    ...uniqGroups.map((g) => `${cosmosRef(g)} AS ${JSON.stringify(g)}`),
    ...aggs.map((a) => `${a.expr} AS ${JSON.stringify(a.alias)}`),
  ];
  const groupBy = uniqGroups.length ? ` GROUP BY ${uniqGroups.map(cosmosRef).join(', ')}` : '';
  return { query: `SELECT ${selectCols.join(', ')} FROM c${whereClause}${groupBy}`, parameters: params };
}

const COSMOS_SYS_KEYS = new Set(['_rid', '_self', '_etag', '_attachments', '_ts']);

function makeCosmosExecutor(db: string, ref: ReportObjectRef): ConnectionExecutor {
  const coll = ref.mode === 'table' ? ref.table : '';
  const customQuery = ref.mode === 'query' ? ref.sql : null;

  async function sampleColumns(): Promise<string[]> {
    const r = await queryItems(db, coll, 'SELECT TOP 20 * FROM c', { maxItems: 20 });
    const keys = new Set<string>();
    for (const doc of r.documents) {
      for (const k of Object.keys(doc)) if (!COSMOS_SYS_KEYS.has(k)) keys.add(k);
    }
    return Array.from(keys);
  }

  return {
    connType: 'cosmos',
    async introspectFields(): Promise<FieldTable[]> {
      // Sample documents to infer fields; numeric sample values → default Sum.
      const r = await queryItems(db, coll, 'SELECT TOP 20 * FROM c', { maxItems: 20 });
      const types = new Map<string, string>();
      for (const doc of r.documents) {
        for (const [k, v] of Object.entries(doc)) {
          if (COSMOS_SYS_KEYS.has(k)) continue;
          if (!types.has(k)) types.set(k, typeof v === 'number' ? 'number' : 'string');
        }
      }
      return fieldTableFromColumns(coll || 'Items', Array.from(types, ([name, dataType]) => ({ name, dataType })));
    },
    async runVisual(visual, filters): Promise<ConnectionVisualResult> {
      if (customQuery) {
        const r = await queryItems(db, coll, customQuery, { maxItems: 1000 });
        return { rows: r.documents, query: customQuery, lang: 'nosql' };
      }
      const compiled = buildCosmosSql(visual, filters);
      const r = await queryItems(db, coll, compiled.query, { maxItems: 1000, parameters: compiled.parameters });
      return { rows: r.documents, query: compiled.query, lang: 'nosql' };
    },
    async preview(limit): Promise<ConnectionPreviewResult> {
      const n = clampRows(limit);
      const q = customQuery || `SELECT TOP ${n} * FROM c`;
      const r = await queryItems(db, coll, q, { maxItems: n });
      const cols = new Set<string>();
      for (const doc of r.documents) for (const k of Object.keys(doc)) if (!COSMOS_SYS_KEYS.has(k)) cols.add(k);
      return { columns: Array.from(cols), rows: r.documents, truncated: r.continuation != null };
    },
  };
}

// ── ADLS / file executor (Synapse serverless OPENROWSET) ────────────────────

/** Resolve a Get-Data file source to an https BULK URL (+container/path when
 *  known, for delta-log schema reads). Converts abfss → https. */
function resolveFileTarget(
  source: FileUploadDataSource | AdlsFileDataSource | { containerPath: string; format: string },
): { url: string; container?: string; path?: string; format: string } | null {
  let raw: string;
  let format: string;
  let container: string | undefined;
  let path: string | undefined;

  if ('kind' in source && source.kind === 'adls-file') {
    container = source.container;
    path = source.path;
    format = source.format;
    return { url: pathToHttpsUrl(source.container, source.path), container, path, format };
  }
  raw = ('kind' in source && source.kind === 'file-upload') ? source.containerPath : (source as { containerPath: string }).containerPath;
  format = ('kind' in source && source.kind === 'file-upload') ? source.format : (source as { format: string }).format;
  raw = (raw || '').trim();
  if (!raw) return null;

  let url: string;
  if (/^abfss:\/\//i.test(raw)) {
    // abfss://<container>@<host>/<path> → https://<host>/<container>/<path>
    const m = /^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/i.exec(raw);
    if (!m) return null;
    container = m[1]; path = m[3];
    url = `https://${m[2]}/${m[1]}/${m[3]}`;
  } else if (/^https?:\/\//i.test(raw)) {
    url = raw.replace(/^http:/i, 'https:');
    const m = /^https:\/\/[^/]+\/([^/]+)\/(.*)$/i.exec(url);
    if (m) { container = m[1]; path = m[2]; }
  } else {
    // container-relative "container/path…"
    const clean = raw.replace(/^\/+/, '');
    const slash = clean.indexOf('/');
    if (slash <= 0) return null;
    container = clean.slice(0, slash);
    path = clean.slice(slash + 1);
    url = pathToHttpsUrl(container, path);
  }
  return { url, container, path, format };
}

/** OPENROWSET source clause for a serverless read (delta/parquet/csv). */
function openRowsetClause(url: string, format: string): string {
  const u = url.replace(/'/g, "''");
  const f = (format || 'parquet').toLowerCase();
  if (f === 'delta') return `OPENROWSET(BULK '${u}', FORMAT = 'DELTA') AS r`;
  if (f === 'csv') return `OPENROWSET(BULK '${u}', FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE) AS r`;
  return `OPENROWSET(BULK '${u}', FORMAT = 'PARQUET') AS r`; // parquet default
}

/** Best-effort Delta `_delta_log` schema read (typed columns) for a primary-
 *  account container+path. Returns [] on any miss so callers fall back to a
 *  zero-row OPENROWSET probe. */
async function tryDeltaSchema(container?: string, path?: string): Promise<Array<{ name: string; dataType?: string }>> {
  if (!container || !path) return [];
  const root = path.replace(/\/+$/, '');
  for (const v of ['00000000000000000000.json']) {
    try {
      const { body } = await downloadFile(container, `${root}/_delta_log/${v}`);
      const fields = parseDeltaSchema(body.toString('utf-8'));
      if (fields.length) return fields.map((f) => ({ name: f.name, dataType: f.type }));
    } catch { /* not readable on this account — fall back */ }
  }
  return [];
}

function makeFileExecutor(
  target: { url: string; container?: string; path?: string; format: string },
  tableName: string,
): ConnectionExecutor {
  const { url, container, path, format } = target;
  const fmt = (format || 'parquet').toLowerCase();
  const synapseTarget = serverlessTarget('master');

  async function introspectColumns(): Promise<Array<{ name: string; dataType?: string }>> {
    if (fmt === 'delta') {
      const typed = await tryDeltaSchema(container, path);
      if (typed.length) return typed;
    }
    const probeSql =
      fmt === 'delta'
        ? `SELECT TOP 0 * FROM ${openRowsetClause(url, 'delta')}`
        : `SELECT TOP 0 * FROM ${openRowsetClause(url, fmt)}`;
    const probe = await executeQuery(synapseTarget, probeSql, 60_000);
    return probe.columns.map((name) => ({ name }));
  }

  return {
    connType: 'storage-adls',
    async introspectFields(): Promise<FieldTable[]> {
      return fieldTableFromColumns(tableName, await introspectColumns());
    },
    async runVisual(visual, filters): Promise<ConnectionVisualResult> {
      const cols = await introspectColumns();
      const whitelist: SqlSourceColumn[] = cols.map((c) => ({ table: tableName, name: c.name, dataType: c.dataType }));
      const innerSql = `SELECT * FROM ${openRowsetClause(url, fmt)}`;
      const sqlSource = makeSqlSource({ kind: 'derived', sql: innerSql }, whitelist, 'synapse');
      const compiled = buildSqlFromVisual(visual, filters, sqlSource);
      if (!compiled) {
        throw new Error('This visual has no fields to query yet — drop a field into a well.');
      }
      const r = await executeQuery(synapseTarget, compiled.sql, 60_000, compiled.parameters);
      return { rows: rowsToRecords(r.columns, r.rows), query: compiled.sql, lang: 'sql' };
    },
    async preview(limit): Promise<ConnectionPreviewResult> {
      const n = clampRows(limit);
      const sql =
        fmt === 'delta'
          ? buildDeltaOpenRowsetSql(url, n)
          : `SELECT TOP ${n} * FROM ${openRowsetClause(url, fmt)}`;
      const r = await executeQuery(synapseTarget, sql, 60_000);
      return { columns: r.columns, rows: rowsToRecords(r.columns, r.rows), truncated: r.truncated };
    },
  };
}

// ── Per-connType wiring + the public dispatch ───────────────────────────────

/** Resolve a connection's KV secret (when its auth method needs one). Throws an
 *  honest, gate-ready error naming Key Vault when the secret can't be read. */
async function resolveConnectionSecret(conn: LoomConnection): Promise<string | null> {
  if (!authNeedsSecret(conn.authMethod)) return null;
  if (!conn.secretRef) {
    throw new Error(
      `Connection "${conn.name}" uses ${conn.authMethod} auth but has no stored secret. ` +
        'Re-create it via Add existing connection so its secret lands in Key Vault.',
    );
  }
  return getKeyVaultSecretValue(conn.secretRef);
}

/**
 * Re-key the wells-to-sql `@p<n>` parameter bag into the POSITIONAL array
 * `executeParameterized` expects. That client binds the array purely by index —
 * `request.input(`p${i}`, array[i])` (azure-sql-client) — so each value MUST sit
 * at the array index matching its OWN `@p<n>` marker, NOT merely at its position
 * in `parameters[]`. `buildSqlFromVisual` emits the bag in marker order today
 * (`parameters[i].name === 'p' + i`), so a plain `params.map(p => p.value)` is
 * correct now — but it silently relies on that invariant. Binding by the index
 * parsed from each marker name keeps the values aligned with the `@p<n>` markers
 * in the SQL even if the bag order ever changes; otherwise an Azure-SQL entra-mi
 * report's WHERE/HAVING predicates would bind the wrong literals at runtime.
 * Gaps (which sequential allocation never produces) are filled with '' so every
 * referenced `@p<i>` has a bound input. Values bind as strings — the same
 * NVARCHAR-and-let-T-SQL-coerce contract synapse-sql-client.bindParams uses.
 */
function toPositionalParams(params: SynapseQueryParam[]): string[] {
  const out: string[] = [];
  let maxIdx = -1;
  for (let i = 0; i < params.length; i++) {
    const m = /^p(\d+)$/.exec(params[i].name);
    const idx = m ? Number(m[1]) : i;
    out[idx] = String(params[i].value ?? '');
    if (idx > maxIdx) maxIdx = idx;
  }
  for (let i = 0; i <= maxIdx; i++) if (out[i] === undefined) out[i] = '';
  return out;
}

/**
 * Build the per-engine SQL runner for an Azure-SQL-family connection
 * (azure-sql | generic-sql). entra-mi binds `@p<n>` via executeParameterized;
 * credentialed auth runs through executeWithCredential (no param binding — the
 * caller passes `undefined` filters for those, the client re-applies them).
 */
async function azureSqlRunner(conn: LoomConnection): Promise<SqlRunner> {
  const host = conn.host || '';
  const db = conn.database || '';
  if (conn.authMethod === 'entra-mi') {
    return async (sql, params) => {
      if (params && params.length) {
        // executeParameterized binds the array by index as @p0,@p1,… — re-key the
        // bag by each marker's own index so the bound inputs always line up with
        // the @p<n> markers compiled into `sql` (see toPositionalParams).
        const recs = await executeParameterized<Record<string, unknown>>(
          host, db, sql, toPositionalParams(params),
        );
        return { columns: recs.length ? Object.keys(recs[0]) : [], rows: recs };
      }
      const r = await azureSqlExecuteQuery(host, db, sql);
      return { columns: r.columns, rows: rowsToRecords(r.columns, r.rows) };
    };
  }
  const secret = await resolveConnectionSecret(conn);
  if (conn.authMethod === 'connection-string') {
    const connectionString = secret || '';
    return async (sql) => {
      const recs = await executeWithCredential<Record<string, unknown>>('', '', sql, { connectionString });
      return { columns: recs.length ? Object.keys(recs[0]) : [], rows: recs };
    };
  }
  // sql-password
  const user = conn.username || '';
  const password = secret || '';
  return async (sql) => {
    const recs = await executeWithCredential<Record<string, unknown>>(host, db, sql, { user, password });
    return { columns: recs.length ? Object.keys(recs[0]) : [], rows: recs };
  };
}

/** Synapse (dedicated/serverless) runner over the CONNECTION's coordinates. */
async function synapseConnRunner(conn: LoomConnection): Promise<SqlRunner> {
  if (conn.authMethod === 'entra-mi') {
    const target: SynapseTarget = {
      server: conn.host || '',
      database: conn.database || 'master',
      cacheKey: `conn:synapse:${conn.id}`,
    };
    return async (sql, params) => {
      const r = await executeQuery(target, sql, 60_000, params);
      return { columns: r.columns, rows: rowsToRecords(r.columns, r.rows) };
    };
  }
  // Password fallback via the Azure SQL TDS credential path (Synapse speaks TDS).
  const secret = await resolveConnectionSecret(conn);
  const host = conn.host || '';
  const db = conn.database || '';
  if (conn.authMethod === 'connection-string') {
    const connectionString = secret || '';
    return async (sql) => {
      const recs = await executeWithCredential<Record<string, unknown>>('', '', sql, { connectionString });
      return { columns: recs.length ? Object.keys(recs[0]) : [], rows: recs };
    };
  }
  const user = conn.username || '';
  const password = secret || '';
  return async (sql) => {
    const recs = await executeWithCredential<Record<string, unknown>>(host, db, sql, { user, password });
    return { columns: recs.length ? Object.keys(recs[0]) : [], rows: recs };
  };
}

/** Honest unbound gate for a connection that can't be queried as a report source. */
function connGate(error: string, missing?: string): { backend: 'unbound'; gate: ReportModelGate } {
  return { backend: 'unbound', gate: { code: 'unbound', error, missing } };
}

/**
 * Load the LoomConnection / resolve the file path, check the per-engine env
 * gate, resolve any KV secret, and return a real ConnectionExecutor — or an
 * honest 'unbound' gate naming the exact connection / role / env. NEVER mock.
 */
export async function buildConnectionExecutor(
  source: ConnectionDataSource | FileUploadDataSource | AdlsFileDataSource,
  tenantId: string,
): Promise<
  | { backend: 'connection'; connType: ReportConnType; executor: ConnectionExecutor; source: ReportDataSource }
  | { backend: 'unbound'; gate: ReportModelGate }
> {
  // ── File sources (no connection): Synapse serverless OPENROWSET via Console MI.
  if (source.kind === 'file-upload' || source.kind === 'adls-file') {
    const target = resolveFileTarget(source);
    if (!target) {
      return connGate(
        'The file data source has no resolvable path. Re-pick the file or ADLS path in the report\'s Data source panel.',
        'dataSource',
      );
    }
    if ((target.format || '').toLowerCase() === 'json') {
      return connGate(
        'JSON files are not yet queryable as a report source. Convert the file to Parquet, CSV, or Delta — or load it through a notebook — then re-pick it.',
        'format',
      );
    }
    // Serverless OPENROWSET needs LOOM_SYNAPSE_WORKSPACE; honest-gate when unset.
    try {
      serverlessTarget('master');
    } catch (e: any) {
      return connGate(`${SYNAPSE_HINT} (${e?.message || 'missing env var'})`, 'LOOM_SYNAPSE_WORKSPACE');
    }
    const tableName =
      source.kind === 'file-upload'
        ? (source.fileName || target.path?.split('/').filter(Boolean).pop() || 'File')
        : (target.path?.split('/').filter(Boolean).pop() || source.container);
    return {
      backend: 'connection',
      connType: 'storage-adls',
      executor: makeFileExecutor(target, tableName),
      source,
    };
  }

  // ── Connection source: load the LoomConnection (tenant-scoped) and dispatch.
  if (!source.connectionId) {
    return connGate(
      'This report\'s Get Data source has no connection bound yet. Open "Data source" and pick (or add) a connection.',
      'connection',
    );
  }
  const conn = await loadConnection(tenantId, source.connectionId);
  if (!conn) {
    return connGate(
      `The bound connection (${source.connectionId}) was not found in this tenant. Re-pick a connection in the report's Data source panel.`,
      'connection',
    );
  }

  const ref = source.objectRef;
  try {
    switch (conn.type) {
      case 'azure-sql':
      case 'generic-sql': {
        if (ref.mode === 'file' || ref.mode === 'kql') {
          return connGate('A SQL connection reads a table or a custom SELECT, not a file/KQL object.', 'objectRef');
        }
        const run = await azureSqlRunner(conn);
        const dialect: ReportSqlDialect = conn.type === 'generic-sql' ? 'generic-sql' : 'tsql';
        const tableName = ref.mode === 'table' ? ref.table : 'Query';
        return {
          backend: 'connection',
          connType: conn.type,
          executor: makeSqlExecutor({ connType: conn.type, dialect, run, objectRef: ref, tableName, canParam: conn.authMethod === 'entra-mi' }),
          source,
        };
      }
      case 'synapse-dedicated':
      case 'synapse-serverless': {
        if (ref.mode === 'file' || ref.mode === 'kql') {
          return connGate('A Synapse connection reads a table or a custom SELECT, not a file/KQL object.', 'objectRef');
        }
        const run = await synapseConnRunner(conn);
        const tableName = ref.mode === 'table' ? ref.table : 'Query';
        return {
          backend: 'connection',
          connType: conn.type,
          executor: makeSqlExecutor({ connType: conn.type, dialect: 'synapse', run, objectRef: ref, tableName, canParam: conn.authMethod === 'entra-mi' }),
          source,
        };
      }
      case 'postgres': {
        if (ref.mode === 'file' || ref.mode === 'kql') {
          return connGate('A PostgreSQL connection reads a table or a custom SELECT.', 'objectRef');
        }
        const gate = postgresQueryGate();
        if (gate) return connGate(gate.detail, gate.missing);
        const fqdn = conn.host || '';
        const db = conn.database || 'postgres';
        const run: SqlRunner = async (sql) => {
          const r = await executePostgresQuery(fqdn, db, sql);
          return { columns: r.columns, rows: rowsToRecords(r.columns, r.rows) };
        };
        const tableName = ref.mode === 'table' ? ref.table : 'Query';
        return {
          backend: 'connection',
          connType: 'postgres',
          // executePostgresQuery binds no params (uses $1-style markers, not @p<n>).
          executor: makeSqlExecutor({ connType: 'postgres', dialect: 'postgres', run, objectRef: ref, tableName, canParam: false }),
          source,
        };
      }
      case 'databricks-sql': {
        if (ref.mode === 'file' || ref.mode === 'kql') {
          return connGate('A Databricks SQL connection reads a table or a custom SELECT.', 'objectRef');
        }
        const cfg = databricksConfigGate();
        if (cfg) {
          return connGate(
            `Databricks SQL is not configured for this deployment. Set ${cfg.missing} on the Loom Console.`,
            cfg.missing,
          );
        }
        const whCfg = warehouseConfigGate();
        if (whCfg) {
          return connGate(
            `No Databricks SQL warehouse is configured. Set ${whCfg.missing} on the Loom Console (the warehouse used to run report queries).`,
            whCfg.missing,
          );
        }
        const warehouseId = (process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '').trim();
        // conn.database carries an optional `catalog` or `catalog.schema` default namespace.
        const [catalog, schemaPart] = (conn.database || '').split('.');
        const schema = ref.mode === 'table' ? (ref.schema || schemaPart) : schemaPart;
        const run: SqlRunner = async (sql) => {
          const r = await executeStatement(warehouseId, sql, catalog || undefined, schema || undefined);
          return { columns: r.columns, rows: rowsToRecords(r.columns, r.rows) };
        };
        const tableName = ref.mode === 'table' ? ref.table : 'Query';
        return {
          backend: 'connection',
          connType: 'databricks-sql',
          // executeStatement binds no @p<n> params (Databricks uses ?-style markers).
          executor: makeSqlExecutor({ connType: 'databricks-sql', dialect: 'databricks-sql', run, objectRef: ref, tableName, canParam: false }),
          source,
        };
      }
      case 'cosmos': {
        if (ref.mode === 'file' || ref.mode === 'kql') {
          return connGate('A Cosmos DB connection reads a container (collection) or a custom Cosmos SQL query.', 'objectRef');
        }
        const db = conn.database || '';
        if (!db) {
          return connGate(
            `The Cosmos connection "${conn.name}" has no database set. Re-pick it with a database, or set its database in the connection.`,
            'database',
          );
        }
        return {
          backend: 'connection',
          connType: 'cosmos',
          executor: makeCosmosExecutor(db, ref),
          source,
        };
      }
      case 'storage-adls': {
        if (ref.mode !== 'file') {
          return connGate('An ADLS / Storage connection reads a file path (delta/parquet/csv). Pick a file object.', 'objectRef');
        }
        if ((ref.format || '').toLowerCase() === 'json') {
          return connGate(
            'JSON files are not yet queryable as a report source. Convert to Parquet, CSV, or Delta — or load it through a notebook.',
            'format',
          );
        }
        const target = resolveFileTarget({ containerPath: ref.containerPath, format: ref.format });
        if (!target) {
          return connGate('The ADLS file path could not be resolved. Re-pick the file in the connection.', 'objectRef');
        }
        try {
          serverlessTarget('master');
        } catch (e: any) {
          return connGate(`${SYNAPSE_HINT} (${e?.message || 'missing env var'})`, 'LOOM_SYNAPSE_WORKSPACE');
        }
        const tableName = target.path?.split('/').filter(Boolean).pop() || conn.name;
        return {
          backend: 'connection',
          connType: 'storage-adls',
          executor: makeFileExecutor(target, tableName),
          source,
        };
      }
      // event-hub | service-bus | key-vault are real Loom connection types but
      // are NOT queryable as a tabular report source — honest gate (no mock).
      default:
        return connGate(
          `A "${conn.type}" connection isn't queryable as a report source. Pick an Azure SQL, Synapse, Databricks SQL, ` +
            'PostgreSQL, Cosmos DB, or ADLS/Blob connection.',
          'connType',
        );
    }
  } catch (e: any) {
    // Config-time failure (KV secret read, gate construction) → honest gate,
    // never a crash. Runtime query failures surface from the executor methods.
    return connGate(
      `The connection "${conn.name}" could not be prepared as a report source: ${e?.message || String(e)}.`,
      'connection',
    );
  }
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
      return resolveSemanticModel(source, tenantId, reportItem);
    case 'direct-query':
      return resolveDirectQuery(source, reportItem);
    case 'connection':
    case 'file-upload':
    case 'adls-file':
      // Get Data (WAVE 1): the resolver owns ALL backend knowledge; the executor
      // wires the real Azure data-plane client (or returns an honest gate).
      return buildConnectionExecutor(source, tenantId);
    default: {
      // Exhaustiveness guard — a new kind must add a branch above.
      const _never: never = source;
      return unbound(PICK_SOURCE_HINT, 'dataSource');
    }
  }
}
