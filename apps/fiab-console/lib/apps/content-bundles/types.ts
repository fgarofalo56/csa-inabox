/**
 * Per-app starter-content bundles.
 *
 * Each `BundleItem` declares the workspace item to provision when an app
 * is installed, along with the rich starter content that gets stamped
 * onto the Cosmos `items` doc's `state.content`. Editors read this on
 * first open so the user sees a fully-formed workspace experience instead
 * of an empty editor (Phase 1 of the apps-content initiative).
 *
 * Phase 2 (partially landed) additionally triggers real Fabric/ADX/Synapse
 * resource creation at install time (see lib/install/provisioning-engine.ts),
 * and — for the Supercharge medallion apps — sample-data ingestion: the install
 * worker lands the Bronze SOURCE parquet + pre-creates the lh_bronze/lh_silver/
 * lh_gold Spark databases via lib/apps/supercharge-seed.ts so the notebooks run
 * green end-to-end. For other apps the content here is the source-of-truth
 * template until the user clicks Save and pushes it to the live backing service.
 */
import type { NotebookCell } from '@/lib/types/notebook-cell';

export interface NotebookContent {
  kind: 'notebook';
  defaultLang: 'pyspark' | 'sparksql' | 'spark' | 'sparkr';
  cells: NotebookCell[];
}

export interface KqlDatabaseContent {
  kind: 'kql-database';
  tables: { name: string; columns: { name: string; type: string }[]; sample?: any[][] }[];
  functions?: { name: string; body: string }[];
  ingestionPolicies?: { table: string; policy: string }[];
  starterQueries?: { name: string; kql: string }[];
}

export interface KqlDashboardContent {
  kind: 'kql-dashboard';
  /**
   * ADX/Kusto database the tiles query. Set this to the DB name the sibling
   * `kql-database` item provisions (kql-db.ts derives it from that item's
   * displayName, e.g. 'Real-Time Ops KQL Database' → 'Real_Time_Ops_KQL_Database')
   * so the dashboard resolves the seeded tables. When omitted the dashboard
   * provisioner falls back to LOOM_KUSTO_DEFAULT_DB — which only works when the
   * tiles' tables live in the default database.
   */
  database?: string;
  tiles: { title: string; kql: string; viz: 'card' | 'line' | 'bar' | 'table' | 'pie' }[];
}

export interface EventstreamContent {
  kind: 'eventstream';
  sources: { id: string; type: string; config: Record<string, any> }[];
  destinations: { id: string; type: string; config: Record<string, any> }[];
  transforms?: { id: string; type: string; config: Record<string, any> }[];
}

export interface WarehouseContent {
  kind: 'warehouse';
  ddl: string;
  dbtProject?: string;
  dbtModels?: { layer: 'bronze' | 'silver' | 'gold'; name: string; sql: string }[];
  starterQueries?: { name: string; sql: string }[];
  /**
   * Optional seed data inserted after the DDL runs so warehouse-backed apps
   * (casino-analytics, pipeline-designer, ml-pipeline) land 'seeded' rather
   * than empty. Each entry targets one table created by `ddl`. `rows` is a
   * matrix of literal values; when `columns` is omitted the INSERT lists all
   * columns positionally, otherwise it uses the named column list so the
   * row tuples can be a subset / reordering of the table schema.
   * The warehouse provisioner escapes every value (string/number/bool/null)
   * into a parameterized-style literal INSERT and verifies with a COUNT.
   */
  sampleRows?: { table: string; columns?: string[]; rows: any[][] }[];
}

export interface LakehouseContent {
  kind: 'lakehouse';
  folders: { path: string; description?: string }[];
  /**
   * When true the lakehouse uses multi-schema namespaces
   * (workspace.lakehouse.schema.table) — Azure-native parity with Fabric's
   * schema-enabled lakehouse. `dbo` is always the immutable default schema.
   * Tables then live under `Tables/<schema>/<table>/` in ADLS and register as
   * `<schema>.<view>` in the Synapse serverless user DB. When false/omitted the
   * lakehouse is the classic flat (`Tables/<table>/`) layout.
   */
  schemasEnabled?: boolean;
  /** Declared non-default schemas. `dbo` is implicit and never listed here. */
  schemas?: { name: string; description?: string }[];
  /** `schema` names the schema each Delta table belongs to when schemasEnabled (defaults to 'dbo'). */
  deltaTables?: { name: string; ddl: string; schema?: string; sampleRows?: any[][] }[];
  shortcuts?: LakehouseShortcutDecl[];
}

/**
 * A lakehouse shortcut declared by a bundle. Per .claude/rules/no-vaporware.md
 * a shortcut may NOT point at an external URL that 404s / a workspace that
 * doesn't exist. There are exactly three honest shapes:
 *
 *  - `repoDataset` (PREFERRED, self-contained): a repo-relative path under
 *    `samples/app-data/<app>/<file>`. At install the provisioner reads the
 *    real file, uploads it into the TENANT'S OWN ADLS under the lakehouse's
 *    `Files/_shortcuts/<name>/`, registers a real internal shortcut row, and
 *    (when Synapse is configured) a queryable OPENROWSET view. Nothing external.
 *
 *  - `internal://<container>/<path>`: a pointer to another path on the
 *    tenant's PRIMARY ADLS account. The UAMI already has read on it, so the
 *    provisioner registers it + proves reachability with a live list probe.
 *
 *  - `publicAnonymous: true` with an `https://…`/`abfss://…` target: a
 *    genuinely-public, anonymous-read dataset. The provisioner validates it
 *    with an unauthenticated HEAD/GET (no UAMI RBAC) before registering it
 *    `active`; if the probe fails it persists `pending` with the HTTP status.
 *
 * Anything else (a bare external `target` with neither flag) is registered
 * `pending` with an honest gate explaining it is unverified — never a silent
 * "active" claim over an unreachable URL.
 */
export interface LakehouseShortcutDecl {
  name: string;
  /**
   * The shortcut target. Optional when `repoDataset` is set (the provisioner
   * derives the in-tenant target from the uploaded file). For internal
   * shortcuts use `internal://<container>/<path>`; for public ones an
   * `https://`/`abfss://` URL with `publicAnonymous: true`.
   */
  target?: string;
  description?: string;
  /** Repo-relative sample file (preferred — self-contained, uploaded to the tenant ADLS). */
  repoDataset?: string;
  /** Section the shortcut hangs under (default 'files'). */
  kind?: 'files' | 'tables';
  /** Set true only for a genuinely public, anonymous-read external target. */
  publicAnonymous?: boolean;
  /** File format hint for the queryable view (default inferred from the file ext). */
  format?: 'delta' | 'parquet' | 'csv' | 'json';
}

export interface SemanticModelContent {
  kind: 'semantic-model';
  tables: { name: string; columns: { name: string; dataType: string; description?: string }[] }[];
  measures: { table: string; name: string; expression: string; formatString?: string; description?: string }[];
  relationships?: { from: string; to: string; cardinality: '1:1' | '1:many' | 'many:many' }[];
  /**
   * Calculation groups (TMSL calculationGroup tables). Each item swaps the
   * aggregation of the visual's SELECTEDMEASURE() via a slicer. Emitted in
   * TMSL at provision time; mirror of lib/azure/powerbi-client.ts TmslCalcGroup.
   */
  calculationGroups?: {
    name: string;
    precedence: number;
    items: { name: string; expression: string; formatStringDefinition?: string; ordinal?: number }[];
  }[];
  /**
   * Field parameters (NAMEOF-based calculated tables). A slicer over the
   * parameter swaps which measure/column a visual shows. Mirror of
   * lib/azure/powerbi-client.ts FieldParamDef.
   */
  fieldParameters?: {
    name: string;
    fields: { displayName: string; fieldRef: string; order: number }[];
  }[];
}

/**
 * Report Designer v2 structured-filter operator. Picked from a dropdown in the
 * Filters pane — the user never types DAX/SQL (no-freeform-config.md). Mirror of
 * `FilterOp` in `app/api/items/report/[id]/definition/route.ts` and the report
 * designer; the server compiler (`lib/azure/wells-to-sql.ts`) maps each to a SQL
 * predicate (loom-native) or a DAX `FILTER(...)` (AAS).
 */
export type ReportFilterOperator =
  | 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'contains' | 'between';

/**
 * One structured report/page/visual filter, in the SHAPE PERSISTED on the
 * report item (post-`wireFilters`, no client-only id). A field reference is a
 * `column` or a `measure` (optionally qualified by `table`); the operand is
 * `value` (scalar / `between` lower bound), `value2` (`between` upper bound), or
 * `values` (the `in` set). Mirror of `PersistedFilter` in the definition route
 * so the route's `ReportContentV2` narrows to it cleanly. All operands are
 * bracket-quoted by the compiler — never string-injected.
 */
export interface ReportFilter {
  /** Source table the field belongs to (optional for an unqualified ref). */
  table?: string;
  /** Column the filter targets. */
  column?: string;
  /** Measure the filter targets (when filtering on an aggregate). */
  measure?: string;
  /** Structured comparison operator (dropdown-selected). */
  op: ReportFilterOperator;
  /** Scalar operand for =,≠,>,≥,<,≤ / lower bound for `between`. */
  value?: string;
  /** Upper bound for `between`. */
  value2?: string;
  /** Operand set for `in`. */
  values?: string[];
}

/** Legend placement for the Format pane. Mirror of `LegendPosition`. */
export type ReportLegendPosition = 'top' | 'bottom' | 'left' | 'right';

/** Value number-format preset for the Format pane. Mirror of `NumberFormatPreset`. */
export type ReportNumberFormat =
  | 'general' | 'whole' | 'decimal' | 'percent' | 'currency' | 'thousands';

/**
 * Report Designer v2 Format-pane settings, persisted SPARSE on a visual's
 * `config.format` (only keys the author touched survive; defaults stay implicit
 * via `normalizeFormat`). Every control is structured (no free text beyond the
 * title) — Power BI Format-pane parity. Mirror of `PersistedFormat` in the
 * definition route and `ReportVisualFormat` in `lib/editors/report/format-pane`.
 */
export interface ReportVisualFormat {
  /** Overrides the visual's display title. Empty → fall back to `visual.title`. */
  titleText?: string;
  /** Show the title bar. Default true. */
  showTitle?: boolean;
  /** Ordered data-color palette (lead/series-1 color first). */
  dataColors?: string[];
  /** Cartesian X-axis visibility. Default true. */
  showXAxis?: boolean;
  /** Cartesian Y-axis visibility. Default true. */
  showYAxis?: boolean;
  /** Legend visibility. Default true. */
  showLegend?: boolean;
  /** Legend placement. Default 'bottom'. */
  legendPosition?: ReportLegendPosition;
  /** Value number-format preset. Default 'general'. */
  numberFormat?: ReportNumberFormat;
}

export interface ReportContent {
  kind: 'report';
  pages: {
    name: string;
    visuals: {
      type: string;
      title: string;
      field?: string;
      /**
       * Loosely-typed per-visual config bag (kept `any` for back-compat with the
       * read-only viewer + the PBIR provisioner, which ignore unknown keys). Holds
       * the rendering grounding (`wells` / `layout` / `sql` / `position`) and, in
       * Report Designer v2, two STRUCTURED optional members:
       *   - `format?: ReportVisualFormat` — Format-pane settings for this visual
       *   - `filters?: ReportFilter[]`    — visual-scoped structured filters
       * Both are additive and persisted by `.../report/[id]/definition`.
       */
      config?: any;
    }[];
    /**
     * v2 (additive): page-scoped structured filters that apply to every visual on
     * the page. Optional so existing bundles + the viewer + the PBIR provisioner
     * compile unchanged.
     */
    filters?: ReportFilter[];
  }[];
  /**
   * v2 (additive): report-scoped structured filters that apply across all pages.
   * Persisted under this key by the definition route (`ReportContentV2`) and read
   * back by the designer. Optional — legacy report bundles omit it entirely.
   */
  reportFilters?: ReportFilter[];
}

export interface ActivatorContent {
  kind: 'activator';
  rule: {
    name: string;
    condition: { metric: string; op: string; threshold: number | string };
    window?: string;
    action: { kind: 'email' | 'teams' | 'webhook' | 'flow'; config: Record<string, any> };
  };
}

export interface MirroredDatabaseContent {
  kind: 'mirrored-database';
  source: {
    kind: 'azure-sql' | 'snowflake' | 'cosmos' | 'bigquery';
    server?: string;
    database?: string;
    tables: string[];
    /** Snowflake-only (Fabric Build 2026): also mirror Snowflake-managed Iceberg tables. */
    includeIcebergTables?: boolean;
  };
}

/**
 * Scorecard rollup + status-rule model — Power BI / Fabric Metrics parity.
 *
 * Rollup ("subgoal rollup" in Fabric): a parent goal's value is aggregated
 * from its child goals. SUM / AVERAGE / MIN / MAX. MIN is the "worst-child"
 * aggregation used for compliance scorecards (parent reflects the weakest
 * subgoal). Status rules are ordered per-goal conditions (value or % of
 * target compared to a threshold → a status color), first match wins, with an
 * "Otherwise" fallback. These are authoring-only in Power BI Web (not exposed
 * by the preview Fabric Metrics REST), so Loom stores + applies them
 * server-side in the BFF (Azure-native default — no Fabric dependency).
 */
export type RollupMethod = 'sum' | 'avg' | 'min' | 'max';
export type StatusColor = 'on-track' | 'at-risk' | 'behind' | 'completed' | 'not-started';
export type StatusOperator = '>=' | '<=' | '>' | '<' | '=';
export type StatusMetricKind = 'value' | 'percent-of-target';

export interface StatusRule {
  operator: StatusOperator;
  threshold: number;
  metricKind: StatusMetricKind; // 'value' | 'percent-of-target'
  status: StatusColor;
}

export interface ScorecardOkr {
  id: string;
  name: string;
  description?: string;
  metric: string;
  target: number | string;
  current?: number | string;
  /** Child's pointer to its parent OKR id (defines the rollup hierarchy). */
  parentId?: string;
  /** Parent goal only — how child values aggregate. Ignored on leaves. */
  rollupMethod?: RollupMethod;
  /** Ordered status rules; first match wins. */
  statusRules?: StatusRule[];
  /** Fallback status when no rule fires. */
  otherwiseStatus?: StatusColor;
  /** Optional scorecard status band (onTrack / atRisk / behindGoal / …). */
  status?: string;
  /** Optional goal owner (display name or email). */
  owner?: string;
  /** Optional ISO due date. */
  dueDate?: string;
  /** Optional sub-goal ids (two-level hierarchy). */
  subGoalIds?: string[];
}

export interface ScorecardContent {
  kind: 'scorecard';
  okrs: ScorecardOkr[];
}

export interface DataProductContent {
  kind: 'data-product';
  datasets: { id: string; name: string; description: string; classification: string }[];
  glossaryTerms?: { term: string; definition: string }[];
  owner: { name: string; email?: string };
  endorsement?: 'promoted' | 'certified' | null;
}

export interface AiSearchIndexContent {
  kind: 'ai-search-index';
  schema: {
    fields: {
      name: string;
      type: string;
      searchable?: boolean;
      filterable?: boolean;
      sortable?: boolean;
      retrievable?: boolean;
      key?: boolean;
      /** Vector fields only — embedding length (e.g. 1536 for text-embedding-3-small). */
      dimensions?: number;
      /** Vector fields only — must reference a vectorSearch profile name the provisioner creates. */
      vectorSearchProfile?: string;
    }[];
  };
  scoringProfiles?: { name: string; description: string }[];
  sampleDocs?: any[];
  vectorConfig?: { dimensions: number; algorithm: string };
}

export interface PromptFlowContent {
  kind: 'prompt-flow';
  nodes: { id: string; kind: 'input' | 'llm' | 'tool' | 'python' | 'output'; name: string; config: Record<string, any> }[];
  edges: { from: string; to: string }[];
  systemPrompt?: string;
}

export interface EvaluationContent {
  kind: 'evaluation';
  datasetRef?: string;
  metrics: { name: string; description: string }[];
  baseline?: { runId: string; results: Record<string, number> };
}

export interface MlModelContent {
  kind: 'ml-model';
  algorithm: string;
  framework: 'sklearn' | 'pytorch' | 'tensorflow' | 'xgboost' | 'lightgbm';
  hyperparameters: Record<string, any>;
  trainingCode?: string;
  features?: { name: string; type: string }[];
  target?: string;
}

export interface SynapsePipelineContent {
  kind: 'synapse-pipeline';
  activities: { name: string; type: string; config: any; dependsOn?: string[] }[];
  parameters?: Record<string, { type: string; defaultValue?: any }>;
}

export interface AdfPipelineContent {
  kind: 'adf-pipeline';
  activities: { name: string; type: string; config: any; dependsOn?: string[] }[];
  parameters?: Record<string, { type: string; defaultValue?: any }>;
}

export interface DatabricksJobContent {
  kind: 'databricks-job';
  tasks: { name: string; type: string; notebookPath?: string; config: any }[];
  cluster: { sparkVersion: string; nodeType: string; numWorkers: number };
}

export type AnyContent =
  | NotebookContent
  | KqlDatabaseContent
  | KqlDashboardContent
  | EventstreamContent
  | WarehouseContent
  | LakehouseContent
  | SemanticModelContent
  | ReportContent
  | ActivatorContent
  | MirroredDatabaseContent
  | ScorecardContent
  | DataProductContent
  | AiSearchIndexContent
  | PromptFlowContent
  | EvaluationContent
  | MlModelContent
  | SynapsePipelineContent
  | AdfPipelineContent
  | DatabricksJobContent;

export interface BundleItem {
  /** Editor type — must match an entry in lib/editors/registry.ts. */
  itemType: string;
  /** Human-readable name shown in the workspace + tab strip. */
  displayName: string;
  /** Short description, surfaced in workspace list + tab tooltip. */
  description: string;
  /** Rich starter content stamped into Cosmos item.state.content. */
  content: AnyContent;
  /** Optional learn doc slug (links to docs/learn/...). */
  learnDoc?: string;
}

export interface AppBundle {
  appId: string;
  /** Optional intro markdown shown on the workspace landing card. */
  intro?: string;
  /** Items provisioned at install time, with rich starter content. */
  items: BundleItem[];
  /** Source docs / examples this bundle draws from. */
  sourceDocs?: string[];
}
