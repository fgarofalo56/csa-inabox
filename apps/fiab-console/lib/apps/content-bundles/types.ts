/**
 * Per-app starter-content bundles.
 *
 * Each `BundleItem` declares the workspace item to provision when an app
 * is installed, along with the rich starter content that gets stamped
 * onto the Cosmos `items` doc's `state.content`. Editors read this on
 * first open so the user sees a fully-formed workspace experience instead
 * of an empty editor (Phase 1 of the apps-content initiative).
 *
 * Phase 2 (tracked separately) will additionally trigger real
 * Fabric/ADX/Synapse resource creation + sample data ingestion at install
 * time. Until then the content here is the source-of-truth template until
 * the user clicks Save and pushes it to the live backing service.
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
  shortcuts?: { name: string; target: string; description?: string }[];
}

export interface SemanticModelContent {
  kind: 'semantic-model';
  tables: { name: string; columns: { name: string; dataType: string }[] }[];
  measures: { table: string; name: string; expression: string; formatString?: string }[];
  relationships?: { from: string; to: string; cardinality: '1:1' | '1:many' | 'many:many' }[];
}

export interface ReportContent {
  kind: 'report';
  pages: { name: string; visuals: { type: string; title: string; field?: string; config?: any }[] }[];
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
  source: { kind: 'azure-sql' | 'snowflake' | 'cosmos' | 'bigquery'; server?: string; database?: string; tables: string[] };
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
