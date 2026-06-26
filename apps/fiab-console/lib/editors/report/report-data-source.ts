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
 * Weave "Build report" actions without dragging in client/server deps.
 *
 * Rules compliance:
 *  - no-fabric-dependency: the DEFAULT kind is `semantic-model` (a Loom-native
 *    model over Synapse/lakehouse via SQL, or AAS tabular). `aas` is the
 *    advanced XMLA binding; Power BI is reached only via the opt-in publish
 *    path, never from this union. Nothing here references a Fabric workspace.
 *  - no-freeform-config: the union encodes picker choices (kind, target,
 *    item ids); the only free text is the advanced AAS XMLA URI + the
 *    direct-query SQL escape hatch (guarded server-side by `sql-guard`).
 *  - no-vaporware: `isBound()` is honest — a source is only "bound" when it is
 *    fully specified; an unbound source drives the designer's Fluent gate
 *    ("pick a data source") rather than a silent empty render.
 *  - back-compat: `fromLegacyState()` synthesizes `{kind:'aas'}` for reports
 *    saved before `state.dataSource` existed, so they keep working unchanged.
 */

// ── Model ─────────────────────────────────────────────────────────────────────

/** Azure-native SQL targets a direct-query source can compile against. */
export type DirectQueryTarget = 'warehouse' | 'lakehouse';

/** The kinds of data source a report can bind to. */
export type ReportDataSourceKind = 'semantic-model' | 'direct-query' | 'aas';

/**
 * DEFAULT, Azure-native. Points at a Loom `semantic-model` item. That item is
 * itself either Loom-native (SQL over a warehouse/lakehouse — the common case,
 * no AAS) or AAS-bound; the server resolver dispatches on the model's backend.
 */
export interface SemanticModelDataSource {
  kind: 'semantic-model';
  /** Cosmos id of the bound `semantic-model` item ('' until the user picks one). */
  itemId: string;
}

/**
 * Azure-native. Scaffolds an implicit single-table model from a `SELECT`. On
 * first save the designer mints a real `semantic-model` item and rewrites the
 * source to `kind:'semantic-model'`; until then it runs the SQL inline.
 */
export interface DirectQueryDataSource {
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
export interface AasDataSource {
  kind: 'aas';
  /** AAS server name (or XMLA URI, e.g. asazure://eastus2.asazure.windows.net/my-server). */
  server: string;
  /** Tabular database/model name on that server. */
  database: string;
}

/** Discriminated union persisted on report `state.dataSource`. */
export type ReportDataSource =
  | SemanticModelDataSource
  | DirectQueryDataSource
  | AasDataSource;

/** A source that may not be set yet (brand-new / never-bound report). */
export type MaybeReportDataSource = ReportDataSource | null | undefined;

/** Valid direct-query targets, for the picker's target dropdown. */
export const DIRECT_QUERY_TARGETS: readonly DirectQueryTarget[] = ['warehouse', 'lakehouse'];

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    default:
      return false;
  }
}

/**
 * Human label for the ribbon "Data source" badge. Concise + parity-friendly:
 *   • unbound / not set        → "No data source"
 *   • semantic-model (bound)   → "Semantic model"
 *   • direct-query             → "Direct query · Warehouse" | "… · Lakehouse"
 *   • aas                      → "Analysis Services · <database>"
 */
export function describeSource(ds: MaybeReportDataSource): string {
  if (!isBound(ds)) return 'No data source';
  switch (ds.kind) {
    case 'semantic-model':
      return 'Semantic model';
    case 'direct-query':
      return `Direct query · ${ds.target === 'warehouse' ? 'Warehouse' : 'Lakehouse'}`;
    case 'aas':
      return ds.database ? `Analysis Services · ${ds.database}` : 'Analysis Services';
    default:
      return 'No data source';
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
  switch (v.kind) {
    case 'semantic-model':
      return { kind: 'semantic-model', itemId: typeof v.itemId === 'string' ? v.itemId : '' };
    case 'direct-query': {
      const target: DirectQueryTarget = v.target === 'lakehouse' ? 'lakehouse' : 'warehouse';
      return {
        kind: 'direct-query',
        target,
        sql: typeof v.sql === 'string' ? v.sql : '',
        ...(typeof v.modelItemId === 'string' && v.modelItemId ? { modelItemId: v.modelItemId } : {}),
      };
    }
    case 'aas':
      return {
        kind: 'aas',
        server: typeof v.server === 'string' ? v.server : '',
        database: typeof v.database === 'string' ? v.database : '',
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
