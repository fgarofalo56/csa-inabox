/**
 * report-data-source — the client-side REPORT DATA SOURCE abstraction.
 *
 * Today the report designer binds to Azure Analysis Services ONLY: it reads
 * `state.aasServer` / `state.aasDatabase` and gates on
 * `bound = !!(aasServer && aasDatabase)`. There is no way to source a report
 * from a Loom semantic-model item, a query, or a notebook.
 *
 * This module is the single source of truth for the discriminated union that
 * the designer holds in React state, persists on `state.dataSource`, and that
 * the server resolver (`lib/azure/report-model-resolver.ts`) mirrors. It is
 * PURE types + helpers — no React, no fetch, no Node APIs — so it can be
 * imported by the designer, the data-source picker, the report routes, and the
 * Weave "Build report" actions without dragging in client/server deps. (The one
 * import below is `CONN_TYPE_LABEL` from `connectable-types`, itself a pure
 * mapping module whose only dependency on `connections-store` is `import type`,
 * so nothing here drags in the Azure SDK / Cosmos / Node `crypto`.)
 *
 * ── Get Data (WAVE 1) ──────────────────────────────────────────────────────
 * Beyond the original `semantic-model | direct-query | aas` arms, three NEW
 * Azure-native arms let a report source from the Power BI-style "Get Data"
 * experience — all flowing through the SAME resolver → /fields → /query →
 * /connector-preview pipeline as the existing kinds:
 *   • `connection`  — a reusable, KV-backed Loom Connection (Azure SQL, Synapse,
 *                     Databricks SQL, PostgreSQL, Cosmos, ADLS/Blob files, …),
 *                     reading a table / custom query / file / KQL inside it.
 *   • `file-upload` — a user-uploaded file staged to ADLS landing (the existing
 *                     POST /api/lakehouse/upload route), read via serverless
 *                     OPENROWSET.
 *   • `adls-file`   — an existing ADLS Gen2 path (Console MI via adls-client).
 *
 * Rules compliance:
 *  - no-fabric-dependency: the DEFAULT kind is `semantic-model` (a Loom-native
 *    model over Synapse/lakehouse via SQL, or AAS tabular). Every new arm is
 *    Azure-native (Azure SQL / Synapse / Databricks / PostgreSQL / Cosmos / ADLS
 *    via real data-plane clients). OneLake / Fabric / Power BI are reached only
 *    via the opt-in publish path, never from this union.
 *  - no-freeform-config: the union encodes picker choices (kind, connection id,
 *    connType, mode-discriminated object ref). The only free text is the
 *    advanced AAS XMLA URI, the direct-query SQL, and the connection's custom
 *    `mode:'query'` / `mode:'kql'` escape hatch — all guarded server-side.
 *  - no-vaporware: `isBound()` is honest — a source is only "bound" when it is
 *    fully specified (connection id + a complete object ref, or a file path +
 *    format); an unbound source drives the designer's Fluent gate rather than a
 *    silent empty render. No mock arrays live here.
 *  - back-compat: `fromLegacyState()` synthesizes `{kind:'aas'}` for reports
 *    saved before `state.dataSource` existed, so they keep working unchanged.
 */
import { CONN_TYPE_LABEL } from '@/lib/azure/connectable-types';

// ── Model ─────────────────────────────────────────────────────────────────────

/** Azure-native SQL targets a direct-query source can compile against. */
export type DirectQueryTarget = 'warehouse' | 'lakehouse';

/** The kinds of data source a report can bind to. */
export type ReportDataSourceKind =
  | 'semantic-model' | 'direct-query' | 'aas'        // existing — UNCHANGED
  | 'connection' | 'file-upload' | 'adls-file';      // NEW (Get Data, WAVE 1)

/**
 * Loom `ConnectionType` + forward-compat report keys. Kept a plain string in the
 * persisted union for resilience (parse coerces unknown values), but validated
 * against this set on read. `adx` / `mysql` are honest-gate / forward-compat —
 * there is no bindable LoomConnection for them in Wave 1, so the resolver
 * returns an honest gate; they exist here so the gallery + dispatch can name
 * them without a string literal escaping the type system.
 */
export type ReportConnType =
  | 'azure-sql' | 'synapse-dedicated' | 'synapse-serverless' | 'generic-sql'
  | 'databricks-sql' | 'postgres' | 'cosmos' | 'storage-adls'
  | 'adx' | 'mysql';

/** Every valid `ReportConnType`, in dispatch order (drives `isReportConnType`). */
export const REPORT_CONN_TYPES: readonly ReportConnType[] = [
  'azure-sql', 'synapse-dedicated', 'synapse-serverless', 'generic-sql',
  'databricks-sql', 'postgres', 'cosmos', 'storage-adls', 'adx', 'mysql',
];

/**
 * Human label per `ReportConnType`. Reuses `CONN_TYPE_LABEL` (the shared
 * connection labelling map) for every queryable type, and adds the two
 * forward-compat keys it does not carry (`adx` / `mysql`).
 */
export const REPORT_CONN_TYPE_LABEL: Record<ReportConnType, string> = {
  'azure-sql': CONN_TYPE_LABEL['azure-sql'],
  'synapse-dedicated': CONN_TYPE_LABEL['synapse-dedicated'],
  'synapse-serverless': CONN_TYPE_LABEL['synapse-serverless'],
  'generic-sql': CONN_TYPE_LABEL['generic-sql'],
  'databricks-sql': CONN_TYPE_LABEL['databricks-sql'],
  'postgres': CONN_TYPE_LABEL['postgres'],
  'cosmos': CONN_TYPE_LABEL['cosmos'],
  'storage-adls': CONN_TYPE_LABEL['storage-adls'],
  'adx': 'Azure Data Explorer',
  'mysql': 'MySQL',
};

/**
 * What to read inside a bound connection. Discriminated by `mode` (NOT
 * all-optional structural arms — consumers MUST switch on `mode`). Maps the
 * task's {schema?;table?} | {sql} | {containerPath;format} | {kql} onto explicit
 * arms:
 *   • `table` — SQL-family (schema + table); Cosmos (table = collection, db from
 *               conn); ADX (table, db from conn).
 *   • `query` — SQL-family custom SELECT (sql-guard'd upstream).
 *   • `file`  — storage-adls connection: format is 'delta'|'parquet'|'csv'|'json'.
 *   • `kql`   — ADX raw KQL (advanced).
 */
export type ReportObjectRef =
  | { mode: 'table'; schema?: string; table: string }
  | { mode: 'query'; sql: string }
  | { mode: 'file'; containerPath: string; format: string }
  | { mode: 'kql'; kql: string };

/**
 * ── Transform (WAVE 4) ────────────────────────────────────────────────────────
 * The OPTIONAL Power Query "Transform Data" mixin carried by EVERY arm of the
 * union. Authored by the report Transform host — the SAME `PowerQueryHost` the
 * Dataflow Gen2 editor mounts — so the M shape persisted here is byte-identical
 * to what the dataflow editor persists, and the structured dialogs emit each
 * applied step through `m-script.appendStep` (no raw-typed M; no-freeform-config).
 *
 * It is mixed into each `*DataSource` interface (rather than a 7th union arm) so
 * a transform rides ALONGSIDE the already-resolved source — `isBound()` is
 * UNCHANGED (a transform is optional sugar on top of an already-bound source),
 * and a report saved before Wave 4 omits both fields and behaves byte-identically
 * (full back-compat). The server folds the chained steps onto the source's base
 * `SELECT` (DirectQuery) or materializes them via the report `/refresh` Spark/
 * wrangling path (Import) — all Azure-native (Synapse/ADF), no Fabric/Power BI.
 */
export interface ReportTransform {
  /**
   * Full Power Query M section authored over THIS source by the Transform host:
   *   `section Section1;\nshared Query = let Source = <opaque source ref>, <steps…> in <result>;`
   * Single source of truth — the identical M shape the dataflow editor persists.
   * The `Source` step is an opaque reference the host treats verbatim; the server
   * folds the chained applied steps onto the source's base SELECT. Absent ⇒ read
   * the source as-is (no transform). The M is authored exclusively via
   * `m-script.appendStep` (structured dialogs / ribbon), never hand-typed, so it
   * is NOT re-typed server-side on persist.
   */
  appliedSteps?: string;
  /**
   * Power Query connectivity choice for the transform:
   *   • `'directQuery'` (DEFAULT) — fold `appliedSteps` to SQL at read time
   *     (`/fields` / `/query` / `/native-query` / `/profile` wrap the resolved
   *     FROM in the folded derived SELECT before introspect/compile).
   *   • `'import'`               — materialize a Delta cache via the report
   *     `/refresh` POST (Synapse-Spark MLV → ADLS Delta, served by the W2 cache
   *     read), then fold over the cache. REQUIRED for non-foldable steps.
   * Only meaningful when `appliedSteps` is present; defaults to `'directQuery'`
   * in that case, and is `undefined` when there is no transform.
   */
  transformMode?: 'directQuery' | 'import';
}

/**
 * DEFAULT, Azure-native. Points at a Loom `semantic-model` item. That item is
 * itself either Loom-native (SQL over a warehouse/lakehouse — the common case,
 * no AAS) or AAS-bound; the server resolver dispatches on the model's backend.
 */
export interface SemanticModelDataSource extends ReportTransform {
  kind: 'semantic-model';
  /** Cosmos id of the bound `semantic-model` item ('' until the user picks one). */
  itemId: string;
}

/**
 * Azure-native. Scaffolds an implicit single-table model from a `SELECT`. On
 * first save the designer mints a real `semantic-model` item and rewrites the
 * source to `kind:'semantic-model'`; until then it runs the SQL inline.
 */
export interface DirectQueryDataSource extends ReportTransform {
  kind: 'direct-query';
  /** Which Synapse path the SQL runs against (dedicated warehouse vs serverless lakehouse). */
  target: DirectQueryTarget;
  /** The author's `SELECT …` (guarded server-side by `sql-guard`). */
  sql: string;
  /** Once scaffolded, the id of the minted `semantic-model` item. */
  modelItemId?: string;
}

/**
 * Advanced. The existing XMLA binding to an Azure Analysis Services tabular
 * model. Kept for parity + back-compat; the resolver routes it to `readModel()`
 * (fields) + DAX (`executeAasQuery`) unchanged.
 */
export interface AasDataSource extends ReportTransform {
  kind: 'aas';
  /** AAS server name (or XMLA URI, e.g. asazure://eastus2.asazure.windows.net/my-server). */
  server: string;
  /** Tabular database/model name on that server. */
  database: string;
}

/**
 * NEW (Get Data). A report sourced from a reusable, KV-backed Loom Connection.
 * The resolver loads the connection (`loadConnection`), resolves its KV secret
 * when `authNeedsSecret`, and runs a real introspect/query/preview against the
 * mapped Azure data-plane client. No new credential code lives here — only the
 * non-secret coordinates needed to pick which connection + object to read.
 */
export interface ConnectionDataSource extends ReportTransform {
  kind: 'connection';
  /** LoomConnection.id (GET /api/connections). '' until bound → isBound()=false. */
  connectionId: string;
  /** Mirror of the bound LoomConnection.type for fast client labelling/dispatch. */
  connType: ReportConnType;
  /** Object inside the connection to read. */
  objectRef: ReportObjectRef;
}

/**
 * NEW (Get Data). A user-uploaded file staged to ADLS landing via
 * POST /api/lakehouse/upload, read tabularly through Synapse serverless
 * OPENROWSET (Console MI).
 */
export interface FileUploadDataSource extends ReportTransform {
  kind: 'file-upload';
  /** Display name of the uploaded file. */
  fileName: string;
  /** 'csv'|'parquet'|'json'|'delta'. */
  format: string;
  /** Full https/abfss path of the staged file/folder returned by the upload route. */
  containerPath: string;
}

/**
 * NEW (Get Data). An existing ADLS Gen2 path (no connection needed; Console MI
 * via adls-client), read tabularly through Synapse serverless OPENROWSET.
 */
export interface AdlsFileDataSource extends ReportTransform {
  kind: 'adls-file';
  /** Container (e.g. 'bronze'|'silver'|'gold'|'landing'). */
  container: string;
  /** Path within the container. */
  path: string;
  /** 'delta'|'parquet'|'csv'|'json'. */
  format: string;
}

/** Discriminated union persisted on report `state.dataSource`. */
export type ReportDataSource =
  | SemanticModelDataSource
  | DirectQueryDataSource
  | AasDataSource
  | ConnectionDataSource   // NEW
  | FileUploadDataSource   // NEW
  | AdlsFileDataSource;    // NEW

/** A source that may not be set yet (brand-new / never-bound report). */
export type MaybeReportDataSource = ReportDataSource | null | undefined;

/** Valid direct-query targets, for the picker's target dropdown. */
export const DIRECT_QUERY_TARGETS: readonly DirectQueryTarget[] = ['warehouse', 'lakehouse'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Narrow string coercion for defensive parsing of persisted/wire values. */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** True when `v` is one of the recognized `ReportConnType` literals. */
export function isReportConnType(v: unknown): v is ReportConnType {
  return typeof v === 'string' && (REPORT_CONN_TYPES as readonly string[]).includes(v);
}

/** Coerce an arbitrary persisted value to a valid `ReportConnType` (default azure-sql). */
function coerceReportConnType(v: unknown): ReportConnType {
  return isReportConnType(v) ? v : 'azure-sql';
}

/**
 * Extract the OPTIONAL Wave-4 transform mixin (`appliedSteps` + `transformMode`)
 * from an arbitrary persisted/wire bag, returning ONLY the fields that are
 * present so it can be spread onto each parsed source arm without disturbing
 * back-compat:
 *   • `appliedSteps` — carried only when a non-empty string (the host always
 *     persists a full M section; blank/missing ⇒ no transform, omit entirely).
 *   • `transformMode` — validated against the 2-value enum. When `appliedSteps`
 *     is present and `transformMode` is absent/invalid it defaults to
 *     `'directQuery'` (the Power Query default); when there is NO transform it is
 *     omitted (`undefined`) so a Wave-4-naïve report round-trips byte-identically.
 * The M is NEVER re-typed here — it was authored via `m-script.appendStep`.
 */
function parseTransform(v: Record<string, unknown>): {
  appliedSteps?: string;
  transformMode?: 'directQuery' | 'import';
} {
  const appliedSteps =
    typeof v.appliedSteps === 'string' && v.appliedSteps.trim().length > 0
      ? v.appliedSteps
      : undefined;
  if (!appliedSteps) return {};
  const transformMode: 'directQuery' | 'import' =
    v.transformMode === 'import' ? 'import' : 'directQuery';
  return { appliedSteps, transformMode };
}

/**
 * True when a (Wave-4) Power Query transform is layered on top of the bound
 * source. Pure convenience for the Transform host / report routes that fold or
 * materialize the applied steps — never affects `isBound()`.
 */
export function hasTransform(ds: MaybeReportDataSource): boolean {
  return !!ds && typeof ds.appliedSteps === 'string' && ds.appliedSteps.trim().length > 0;
}

/**
 * Effective Power Query connectivity mode for the source's transform. Returns
 * `'directQuery'` (fold to SQL at read time) by default and `'import'` only when
 * explicitly chosen. When there is no transform the value is irrelevant; callers
 * gate on `hasTransform()` first — the `'directQuery'` default is harmless.
 */
export function reportTransformMode(ds: MaybeReportDataSource): 'directQuery' | 'import' {
  return ds && ds.transformMode === 'import' ? 'import' : 'directQuery';
}

/**
 * The Azure-native default selection used to seed the data-source picker for a
 * brand-new report: an (as-yet-unbound) semantic-model source. `itemId` is ''
 * until the user picks a model, so `isBound()` reports false and the designer
 * shows its honest "pick a data source" gate. Never defaults to Fabric/Power BI
 * (no-fabric-dependency.md).
 */
export function defaultDataSource(): SemanticModelDataSource {
  return { kind: 'semantic-model', itemId: '' };
}

/** Type guard: a Get-Data connection source. */
export function isConnectionSource(ds: MaybeReportDataSource): ds is ConnectionDataSource {
  return !!ds && ds.kind === 'connection';
}

/** Type guard: a file-backed source (uploaded file OR an existing ADLS path). */
export function isFileSource(ds: MaybeReportDataSource): ds is FileUploadDataSource | AdlsFileDataSource {
  return !!ds && (ds.kind === 'file-upload' || ds.kind === 'adls-file');
}

/**
 * Is a connection's object reference fully specified for its `mode`? Mirrors the
 * task's "table|sql|containerPath|kql non-empty" rule. The `!!ref.x` guards
 * tolerate malformed persisted state that bypassed `parseDataSource`.
 */
function objectRefComplete(ref: ReportObjectRef): boolean {
  switch (ref.mode) {
    case 'table':
      return !!ref.table && ref.table.trim().length > 0;
    case 'query':
      return !!ref.sql && ref.sql.trim().length > 0;
    case 'file':
      return !!ref.containerPath && ref.containerPath.trim().length > 0;
    case 'kql':
      return !!ref.kql && ref.kql.trim().length > 0;
    default:
      return false;
  }
}

/**
 * Type guard: true only when the source is fully specified (and therefore
 * runnable). Narrows `MaybeReportDataSource` → `ReportDataSource`. Drives the
 * designer's `bound` gate (replaces `!!(aasServer && aasDatabase)`).
 */
export function isBound(ds: MaybeReportDataSource): ds is ReportDataSource {
  if (!ds) return false;
  switch (ds.kind) {
    case 'semantic-model':
      return typeof ds.itemId === 'string' && ds.itemId.trim().length > 0;
    case 'direct-query':
      return (
        (ds.target === 'warehouse' || ds.target === 'lakehouse') &&
        typeof ds.sql === 'string' &&
        ds.sql.trim().length > 0
      );
    case 'aas':
      return (
        typeof ds.server === 'string' && ds.server.trim().length > 0 &&
        typeof ds.database === 'string' && ds.database.trim().length > 0
      );
    case 'connection':
      return (
        typeof ds.connectionId === 'string' && ds.connectionId.trim().length > 0 &&
        !!ds.objectRef && objectRefComplete(ds.objectRef)
      );
    case 'file-upload':
      return (
        typeof ds.containerPath === 'string' && ds.containerPath.trim().length > 0 &&
        typeof ds.format === 'string' && ds.format.trim().length > 0
      );
    case 'adls-file':
      return (
        typeof ds.container === 'string' && ds.container.trim().length > 0 &&
        typeof ds.path === 'string' && ds.path.trim().length > 0 &&
        typeof ds.format === 'string' && ds.format.trim().length > 0
      );
    default:
      return false;
  }
}

/** Short description of what a bound connection reads (the `· <…>` suffix). */
function describeObjectRef(ref: ReportObjectRef): string {
  switch (ref.mode) {
    case 'table':
      return ref.schema ? `${ref.schema}.${ref.table}` : ref.table;
    case 'query':
      return 'Custom query';
    case 'file':
      return ref.containerPath.split('/').filter(Boolean).pop() || ref.containerPath;
    case 'kql':
      return 'KQL query';
    default:
      return '';
  }
}

/**
 * Human label for the ribbon "Data source" badge. Concise + parity-friendly:
 *   • unbound / not set        → "No data source"
 *   • semantic-model (bound)   → "Semantic model"
 *   • direct-query             → "Direct query · Warehouse" | "… · Lakehouse"
 *   • aas                      → "Analysis Services · <database>"
 *   • connection               → "<ConnType label> · <table|file|query|kql>"
 *   • file-upload              → "File · <fileName>"
 *   • adls-file                → "ADLS · <container>/<path>"
 *
 * When a Wave-4 Power Query transform is layered on top (`appliedSteps` set), a
 * cosmetic " · transformed" suffix is appended to the bound label.
 */
export function describeSource(ds: MaybeReportDataSource): string {
  if (!isBound(ds)) return 'No data source';
  const suffix = hasTransform(ds) ? ' · transformed' : '';
  switch (ds.kind) {
    case 'semantic-model':
      return `Semantic model${suffix}`;
    case 'direct-query':
      return `Direct query · ${ds.target === 'warehouse' ? 'Warehouse' : 'Lakehouse'}${suffix}`;
    case 'aas':
      return `${ds.database ? `Analysis Services · ${ds.database}` : 'Analysis Services'}${suffix}`;
    case 'connection': {
      const label = REPORT_CONN_TYPE_LABEL[ds.connType] ?? 'Connection';
      return `${label} · ${describeObjectRef(ds.objectRef)}${suffix}`;
    }
    case 'file-upload':
      return `${ds.fileName ? `File · ${ds.fileName}` : 'Uploaded file'}${suffix}`;
    case 'adls-file':
      return `ADLS · ${ds.container}${ds.path ? `/${ds.path}` : ''}${suffix}`;
    default:
      return 'No data source';
  }
}

/**
 * Normalize an arbitrary persisted/wire value into a `ReportObjectRef`,
 * discriminated by `mode` (defaults to `table` for unrecognized/legacy shapes).
 */
function parseObjectRef(value: unknown): ReportObjectRef {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  switch (v.mode) {
    case 'query':
      return { mode: 'query', sql: asStr(v.sql) };
    case 'file':
      return { mode: 'file', containerPath: asStr(v.containerPath), format: asStr(v.format) };
    case 'kql':
      return { mode: 'kql', kql: asStr(v.kql) };
    case 'table':
    default: {
      const schema = asStr(v.schema);
      return { mode: 'table', table: asStr(v.table), ...(schema ? { schema } : {}) };
    }
  }
}

/**
 * Validate an arbitrary persisted/wire value into the union (defensive — the
 * value comes from Cosmos `state.dataSource` or a PUT body). Returns null when
 * the shape is unrecognized so callers can fall back to a legacy/AAS source or
 * the unbound gate. Does NOT require completeness — use `isBound()` for that.
 */
export function parseDataSource(value: unknown): ReportDataSource | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  // Wave 4: the OPTIONAL transform mixin rides on EVERY arm (spread onto each
  // returned kind; absent ⇒ {} ⇒ byte-identical back-compat).
  const transform = parseTransform(v);
  switch (v.kind) {
    case 'semantic-model':
      return { kind: 'semantic-model', itemId: typeof v.itemId === 'string' ? v.itemId : '', ...transform };
    case 'direct-query': {
      const target: DirectQueryTarget = v.target === 'lakehouse' ? 'lakehouse' : 'warehouse';
      return {
        kind: 'direct-query',
        target,
        sql: typeof v.sql === 'string' ? v.sql : '',
        ...(typeof v.modelItemId === 'string' && v.modelItemId ? { modelItemId: v.modelItemId } : {}),
        ...transform,
      };
    }
    case 'aas':
      return {
        kind: 'aas',
        server: typeof v.server === 'string' ? v.server : '',
        database: typeof v.database === 'string' ? v.database : '',
        ...transform,
      };
    case 'connection':
      return {
        kind: 'connection',
        connectionId: asStr(v.connectionId),
        connType: coerceReportConnType(v.connType),
        objectRef: parseObjectRef(v.objectRef),
        ...transform,
      };
    case 'file-upload':
      return {
        kind: 'file-upload',
        fileName: asStr(v.fileName),
        format: asStr(v.format),
        containerPath: asStr(v.containerPath),
        ...transform,
      };
    case 'adls-file':
      return {
        kind: 'adls-file',
        container: asStr(v.container),
        path: asStr(v.path),
        format: asStr(v.format),
        ...transform,
      };
    default:
      return null;
  }
}

/**
 * Resolve the report's data source from its persisted item state, with
 * back-compat:
 *   1. an explicit, valid `state.dataSource` wins;
 *   2. else, when only the legacy `state.aasServer` / `state.aasDatabase`
 *      binding exists, synthesize `{kind:'aas', server, database}` so reports
 *      saved before `state.dataSource` existed keep working unchanged;
 *   3. else null — the report is genuinely unbound (drives the honest gate).
 *
 * Accepts the loose `WorkspaceItem.state` bag (`Record<string, unknown>`).
 */
export function fromLegacyState(state: Record<string, unknown> | null | undefined): ReportDataSource | null {
  if (!state) return null;

  const explicit = parseDataSource(state.dataSource);
  if (explicit) return explicit;

  const server = typeof state.aasServer === 'string' ? state.aasServer.trim() : '';
  const database = typeof state.aasDatabase === 'string' ? state.aasDatabase.trim() : '';
  if (server || database) {
    return { kind: 'aas', server, database };
  }

  return null;
}
