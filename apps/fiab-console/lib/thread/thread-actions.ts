/**
 * Loom Thread — declarative integration-edge registry.
 *
 * Thread is the fabric that weaves Loom services together. Each ThreadAction is a
 * one-click "Weave" integration that appears on the editors of its `fromTypes`
 * and wires the current item into another Loom service. Every field is populated
 * from a REAL discovery route (dropdowns/pickers) — never freeform connection
 * strings or paths (per .claude/rules/loom-no-freeform-config.md). Each action
 * POSTs to a real BFF route (real backend or honest gate — no-vaporware).
 *
 * Only WIRED actions are listed here. Adding an edge = add a ThreadAction + its
 * BFF route. The menu groups actions by `group`.
 */

import {
  dataAgentSourceableTypes,
  daxAnalyzableTypes,
  lakehouseKqlMaterializableTypes,
  medallionPromotableTypes,
  notebookAttachableTypes,
  pbiSourceableTypes,
  powerBiModelableTypes,
} from '@/lib/items/manifest/registry';

export type ThreadGroup = 'Explore' | 'Analyze with AI' | 'Publish' | 'Visualize' | 'Promote';

export interface ThreadField {
  name: string;
  label: string;
  /** dropdown of the caller's Loom items of `itemTypes` (via /api/items/by-type). */
  kind: 'loom-item' | 'select' | 'text' | 'textarea' | 'toggle';
  required?: boolean;
  hint?: string;
  /** loom-item: which item types to list. */
  itemTypes?: string[];
  /** loom-item: also offer "+ Create new …" which sends value `__new__`. */
  allowCreate?: boolean;
  createLabel?: string;
  /** select: static options. */
  options?: { value: string; label: string }[];
  /**
   * select: load options from a real discovery route (GET → { value,label } adapter).
   * Supports `{fromId}` / `{fromType}` tokens, substituted from the source item.
   */
  optionsRoute?: string;
  /** how to map the optionsRoute response into {value,label}[]. */
  optionsMap?: 'powerbi-workspaces';
  /** default value. */
  default?: string | boolean;
  /** show this field only when another field equals a value. */
  showWhen?: { field: string; equals: string | boolean };
}

export interface ThreadAction {
  id: string;
  label: string;
  description: string;
  group: ThreadGroup;
  /** Source item-type slugs this action appears on ('*' = all). */
  fromTypes: string[] | '*';
  /** Lucide/Fluent icon name hint (the menu maps it). */
  icon?: string;
  /** Wizard fields, all dropdown/picker/toggle. */
  fields: ThreadField[];
  /** BFF route the wizard POSTs {from:{id,type,name}, values} to. */
  route: string;
  /** Primary button label in the drawer. */
  submitLabel?: string;
}

/**
 * EH-P1-MANIFEST (#1801): these three capability gates are now READ from the
 * item-type manifest registry — `capabilities.dataAgentSourceable` /
 * `notebookAttachable` / `powerBiModelable` in lib/items/manifest — instead of
 * hard-coded slug lists here. The manifest is the single source of truth; the
 * consumer keeps no parallel list. Same members, same order (the manifest suite
 * asserts each equals the prior hard-coded list, so the swap is provably
 * behavior-preserving).
 */

/** Item types that can ground a data agent (manifest `dataAgentSourceable`). */
const DATA_AGENT_SOURCEABLE = dataAgentSourceableTypes();

/** Item types that can be attached to a notebook session (manifest `notebookAttachable`). */
const NOTEBOOK_ATTACHABLE = notebookAttachableTypes();

/**
 * Warehouse sources whose Azure-native backend (Synapse dedicated SQL) can be
 * read table-by-table to build a Power BI push model / publish as an API
 * (manifest `powerBiModelable`). Lakehouse/KQL/Azure-SQL are deferred until
 * their schema adapter lands (only WIRED edges ship).
 */
const POWERBI_MODELABLE = powerBiModelableTypes();

/**
 * Every Loom item type that can be a Power BI SOURCE (Weave → “Analyze in Power
 * BI”). Each resolves to an Azure-native backend (Synapse serverless / dedicated
 * or ADX) via `lib/azure/pbi-source-resolver.ts` — no Fabric / Power BI workspace
 * required (no-fabric-dependency.md).
 *
 * EH-P1-MANIFEST (#1801): now READ from the item-type manifest registry —
 * `capabilities.pbiSourceable` in lib/items/manifest — instead of a hard-coded
 * list here. Same members, same order (the manifest suite asserts equality with
 * the prior list AND with `PBI_RESOLVABLE_TYPES` in the resolver, so this swap
 * is provably behavior-preserving).
 */
export const PBI_SOURCEABLE = pbiSourceableTypes();

/**
 * Item types the Weave "Analyze with DAX" edge can source (manifest
 * `daxAnalyzable`) — a Loom-native semantic model whose tabular layer runs DAX
 * via `evalDax`. A warehouse-backed model IS a semantic-model item, so this
 * single slug covers the "or warehouse-backed model" case.
 */
const DAX_ANALYZABLE = daxAnalyzableTypes();

/** Item types the Weave "Materialize to KQL (ADX)" edge can source (manifest `lakehouseKqlMaterializable`). */
const LAKEHOUSE_KQL_MATERIALIZABLE = lakehouseKqlMaterializableTypes();

/** Item types the Weave "Promote (medallion)" edge can source (manifest `medallionPromotable`). */
const MEDALLION_PROMOTABLE = medallionPromotableTypes();

export const THREAD_ACTIONS: ThreadAction[] = [
  {
    id: 'analyze-in-notebook',
    label: 'Analyze in a Notebook',
    description:
      'Create a Loom Notebook with this item attached as a data source and a starter cell, ' +
      'so you can explore it in Spark/SQL right away — no paths to type.',
    group: 'Explore',
    fromTypes: NOTEBOOK_ATTACHABLE,
    icon: 'notebook',
    fields: [
      { name: 'notebookName', label: 'Notebook name', kind: 'text', required: true, hint: 'A name for the new notebook.' },
    ],
    route: '/api/thread/analyze-in-notebook',
    submitLabel: 'Weave',
  },
  {
    id: 'add-data-agent-source',
    label: 'Add as a Data Agent source',
    description:
      'Ground a Loom Data Agent on this item so users can ask natural-language questions about it. ' +
      'Pick an existing agent or create a new one — no connection strings.',
    group: 'Analyze with AI',
    fromTypes: DATA_AGENT_SOURCEABLE,
    icon: 'bot',
    fields: [
      {
        name: 'agentId',
        label: 'Data Agent',
        kind: 'loom-item',
        itemTypes: ['data-agent'],
        allowCreate: true,
        createLabel: '+ Create a new Data Agent',
        required: true,
        hint: 'The agent to add this source to. Choose one you own or create a new one.',
      },
      {
        name: 'newAgentName',
        label: 'New agent name',
        kind: 'text',
        showWhen: { field: 'agentId', equals: '__new__' },
        hint: 'A friendly name for the new Data Agent.',
      },
    ],
    route: '/api/thread/add-data-agent-source',
    submitLabel: 'Weave',
  },
  {
    // Azure-native DEFAULT report builder (no Fabric/Power BI). Appears on a
    // Loom semantic-model item and opens a new `report` pre-bound to it. The
    // shared route infers `sourceMode:'model'` from `from.type === 'semantic-model'`.
    id: 'build-report-from-model',
    label: 'Build a report',
    description:
      'Create a Loom report bound to this semantic model and open it in the report designer, ' +
      'pre-bound — drag fields onto visuals and they render real SUM/AVG/COUNT GROUP BY rows ' +
      'from the model’s Azure-native backend (Synapse warehouse / serverless-over-lakehouse, ' +
      'or AAS tabular). No Power BI workspace required.',
    group: 'Visualize',
    fromTypes: ['semantic-model'],
    icon: 'chart',
    fields: [
      {
        name: 'reportName',
        label: 'Report name',
        kind: 'text',
        required: true,
        hint: 'A name for the new report. It opens pre-bound to this semantic model.',
      },
    ],
    route: '/api/thread/build-loom-report',
    submitLabel: 'Weave',
  },
  {
    // Azure-native DEFAULT path from a data source: mints a Loom-native
    // semantic-model from a table/SELECT (NOT a Power BI push dataset) and opens
    // a report pre-bound to it. The shared route reads `from.type` (warehouse /
    // synapse-dedicated-sql-pool / lakehouse / notebook) + `values.sourceMode`.
    id: 'build-loom-report',
    label: 'Build a report',
    description:
      'Create a Loom report from this source: Loom mints an Azure-native semantic model from a ' +
      'table or a SQL query (over the Synapse warehouse / serverless-over-lakehouse), then opens ' +
      'a report pre-bound to it. Visuals compile to real SUM/AVG/COUNT GROUP BY — no Power BI ' +
      'workspace and no DAX to type.',
    group: 'Visualize',
    fromTypes: ['warehouse', 'synapse-dedicated-sql-pool', 'lakehouse', 'notebook'],
    icon: 'chart',
    fields: [
      {
        name: 'sourceMode',
        label: 'Report source',
        kind: 'select',
        options: [
          { value: 'table', label: 'A table' },
          { value: 'query', label: 'A SQL query' },
        ],
        default: 'table',
        required: true,
        hint:
          'Build the report’s semantic model from a table, or from the result of a SQL query. ' +
          'For a notebook, choose “A SQL query”, pick the attached data source, and provide the query.',
      },
      {
        name: 'table',
        label: 'Table',
        kind: 'select',
        optionsRoute: '/api/thread/warehouse-tables?fromType={fromType}&fromId={fromId}',
        required: true,
        showWhen: { field: 'sourceMode', equals: 'table' },
        hint: 'The Azure-native warehouse table to model and visualize.',
      },
      {
        // Drives `sqlKindFor` in /api/thread/build-loom-report: for a notebook
        // source the route reads the LITERAL backend kind ('warehouse' |
        // 'lakehouse') from `values.attachedSource` to choose the Synapse target
        // (dedicated pool vs serverless). This was previously a `loom-item` picker
        // named `attachedSourceId` returning an item GUID, so the value never
        // reached the route's `values.attachedSource` and every notebook→report
        // wrongly resolved to the dedicated warehouse pool. A structured kind
        // select keeps it dropdown-only (loom-no-freeform-config) and lets the
        // existing route work unchanged.
        name: 'attachedSource',
        label: 'Notebook’s attached backend',
        kind: 'select',
        options: [
          { value: 'warehouse', label: 'Warehouse / dedicated SQL pool (Synapse dedicated)' },
          { value: 'lakehouse', label: 'Lakehouse (Synapse serverless)' },
        ],
        default: 'warehouse',
        showWhen: { field: 'sourceMode', equals: 'query' },
        hint:
          'For a report from a notebook, pick which Azure-native backend the SQL query runs against — ' +
          'the warehouse / dedicated SQL pool, or the lakehouse (Synapse serverless). This selects how the ' +
          'query is introspected and executed. Ignored when the source is itself a warehouse or lakehouse.',
      },
      {
        name: 'query',
        label: 'SQL query',
        kind: 'textarea',
        required: true,
        showWhen: { field: 'sourceMode', equals: 'query' },
        hint:
          'A SELECT against the Azure-native backend. Its result columns become the report’s ' +
          'semantic-model table; the report’s visuals compile to SUM/AVG/COUNT GROUP BY over it.',
      },
      {
        name: 'reportName',
        label: 'Report name',
        kind: 'text',
        required: true,
        hint: 'A name for the new report. It opens pre-bound to a Loom-native semantic model — no Power BI workspace required.',
      },
    ],
    route: '/api/thread/build-loom-report',
    submitLabel: 'Weave',
  },
  {
    // Weave → Power BI (W1 — Loom-native branch). Appears on ANY PBI-sourceable
    // Loom item and opens the Power BI item type the user picks (report /
    // paginated report / dashboard / semantic model), pre-wired to this item as
    // the source via lib/azure/pbi-source-resolver.ts — Azure-native by DEFAULT
    // (no Fabric / Power BI workspace). The user never touches a data-source,
    // connection string, or Azure coordinate.
    id: 'analyze-in-powerbi',
    label: 'Analyze in Power BI',
    description:
      'Create a Power BI item pre-wired to this item as its data source — pick the item type (report, ' +
      'paginated report, dashboard, or semantic model). Loom resolves the Azure-native backend (Synapse ' +
      'serverless / dedicated, or Azure Data Explorer) automatically; no data source, connection, or ' +
      'coordinates to enter. No Power BI / Fabric workspace required.',
    group: 'Visualize',
    fromTypes: PBI_SOURCEABLE,
    icon: 'chart',
    fields: [
      {
        name: 'targetType',
        label: 'Power BI item type',
        kind: 'select',
        options: [
          { value: 'report', label: 'Report (interactive)' },
          { value: 'paginated-report', label: 'Paginated report (RDL — pixel-perfect)' },
          { value: 'dashboard', label: 'Dashboard (tiles)' },
          { value: 'semantic-model', label: 'Semantic model (reusable dataset)' },
        ],
        default: 'report',
        required: true,
        hint: 'The Power BI item to create, pre-wired to this source. All open Azure-native — no Power BI workspace needed.',
      },
      {
        // D1 — the user picks WHERE the item lands, per click. Loom-native is the
        // zero-dependency default (Azure-native backend, no Power BI workspace).
        // "Real Power BI Service" publishes into the operator's bound workspace
        // (LOOM_PBI_WORKSPACE_ID + LOOM_PBI_CAPACITY_ID) authenticated as the
        // signed-in user (OBO). When those aren't configured the route returns an
        // honest gate naming exactly what to set (no-vaporware) — the option is
        // always visible so the requirement is discoverable.
        name: 'destination',
        label: 'Where to build it',
        kind: 'select',
        options: [
          { value: 'loom-native', label: 'Loom-native (Azure-native, no Power BI workspace)' },
          { value: 'power-bi-service', label: 'Real Power BI Service (bound workspace — when configured)' },
        ],
        default: 'loom-native',
        required: true,
        hint:
          'Loom-native builds the item over the Azure-native backend — the default, zero Power BI ' +
          'dependency. “Real Power BI Service” publishes a real Power BI item into the bound workspace ' +
          '(needs LOOM_PBI_WORKSPACE_ID + LOOM_PBI_CAPACITY_ID, your Power BI delegated consent, and — ' +
          'for private-endpoint sources — a registered data gateway); if any is missing you’ll get an ' +
          'honest message naming exactly what to set.',
      },
      {
        name: 'sourceShape',
        label: 'Source shape',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Auto (use the source’s default table)' },
          { value: 'table', label: 'A specific table' },
          { value: 'query', label: 'A SQL query' },
        ],
        default: 'auto',
        required: true,
        hint:
          'Auto uses the table Loom detected on this source. Choose “A specific table” or “A SQL query” to shape ' +
          'the data the new Power BI item is wired to.',
      },
      {
        name: 'table',
        label: 'Table',
        kind: 'text',
        showWhen: { field: 'sourceShape', equals: 'table' },
        hint: 'schema.table (or just table) to wire the Power BI item to. Overrides the detected default table.',
      },
      {
        name: 'query',
        label: 'SQL query',
        kind: 'textarea',
        showWhen: { field: 'sourceShape', equals: 'query' },
        hint:
          'A read-only SELECT against the Azure-native backend. Its result columns become the Power BI item’s ' +
          'source. Ignored for an eventhouse / KQL source (which is wired via its default table).',
      },
      {
        name: 'name',
        label: 'Name',
        kind: 'text',
        required: true,
        hint: 'A name for the new Power BI item. It opens pre-wired to this source.',
      },
    ],
    route: '/api/thread/analyze-in-powerbi',
    submitLabel: 'Weave',
  },
  {
    // Opt-in Power BI path (strictly additive to the Azure-native default above).
    id: 'build-powerbi-model',
    label: 'Build a Power BI model',
    description:
      'Opt-in Power BI path: publish a warehouse table to Power BI as a real semantic model — ' +
      'columns are read from the catalog and a sample of real rows is pushed so the model is ' +
      'queryable immediately, then build the report in Power BI. Requires the Power BI backend ' +
      'enabled in Admin → Runtime configuration and a Power BI workspace (the Console identity ' +
      'must be a Member/Contributor). ' +
      'For the Azure-native default that needs no Power BI workspace, use “Build a report” instead. ' +
      'No connection strings to type.',
    group: 'Visualize',
    fromTypes: POWERBI_MODELABLE,
    icon: 'chart',
    fields: [
      {
        name: 'workspaceId',
        label: 'Power BI workspace',
        kind: 'select',
        optionsRoute: '/api/powerbi/workspaces',
        optionsMap: 'powerbi-workspaces',
        required: true,
        hint: 'The Power BI workspace to create the model in. The Console identity must be a Member/Contributor.',
      },
      {
        name: 'sourceMode',
        label: 'Model source',
        kind: 'select',
        options: [
          { value: 'table', label: 'An existing table' },
          { value: 'query', label: 'A custom SQL query' },
        ],
        default: 'table',
        required: true,
        hint: 'Build the model from a warehouse table, or from the result of a SQL query you write.',
      },
      {
        name: 'table',
        label: 'Table',
        kind: 'select',
        optionsRoute: '/api/thread/warehouse-tables?fromType={fromType}&fromId={fromId}',
        required: true,
        showWhen: { field: 'sourceMode', equals: 'table' },
        hint: 'The warehouse table to publish as a model.',
      },
      {
        name: 'query',
        label: 'SQL query',
        kind: 'textarea',
        required: true,
        showWhen: { field: 'sourceMode', equals: 'query' },
        hint: 'A SELECT against the Azure-native warehouse. Its result columns become the model table; a sample of rows is pushed.',
      },
      { name: 'modelName', label: 'Model name', kind: 'text', required: true, hint: 'A name for the new Power BI semantic model.' },
      { name: 'includeRows', label: 'Push a sample of rows now', kind: 'toggle', default: true, hint: 'Push up to 500 rows so the model is immediately queryable. Refresh in Power BI to load all rows.' },
    ],
    route: '/api/thread/build-powerbi-model',
    submitLabel: 'Weave',
  },
  {
    id: 'publish-as-api',
    label: 'Publish as an API',
    description:
      'Expose a warehouse table as a real REST + GraphQL API (Data API Builder). The entity is ' +
      'built from the table’s catalog schema (columns + primary key) and points at the ' +
      'Azure-native warehouse. Open it to review permissions, then Deploy. No connection strings.',
    group: 'Publish',
    fromTypes: POWERBI_MODELABLE,
    icon: 'api',
    fields: [
      {
        name: 'sourceMode',
        label: 'API source',
        kind: 'select',
        options: [
          { value: 'table', label: 'An existing table' },
          { value: 'query', label: 'A custom SQL query (exposed as a view)' },
        ],
        default: 'table',
        required: true,
        hint: 'Expose a warehouse table, or wrap a SQL query as a view and expose that.',
      },
      {
        name: 'table',
        label: 'Table',
        kind: 'select',
        optionsRoute: '/api/thread/warehouse-tables?fromType={fromType}&fromId={fromId}',
        required: true,
        showWhen: { field: 'sourceMode', equals: 'table' },
        hint: 'The warehouse table to expose as an API entity.',
      },
      {
        name: 'query',
        label: 'SQL query',
        kind: 'textarea',
        required: true,
        showWhen: { field: 'sourceMode', equals: 'query' },
        hint: 'A SELECT against the Azure-native warehouse. Loom creates a view from it and exposes that view as the API entity.',
      },
      { name: 'apiName', label: 'API name', kind: 'text', required: true, hint: 'A name for the new Data API Builder item.' },
      { name: 'requireAuth', label: 'Require authentication', kind: 'toggle', default: true, hint: 'On: only authenticated callers (Entra ID). Off: anonymous read. You can refine roles/actions in the editor.' },
    ],
    route: '/api/thread/publish-as-api',
    submitLabel: 'Weave',
  },
  {
    id: 'mirror-explore-notebook',
    label: 'Explore mirrored data in a Notebook',
    description:
      'Create a Loom Notebook that reads this mirror’s replicated tables from ADLS Bronze with Spark — ' +
      'one read per table, no paths to type. Start the mirror first so there is data to read.',
    group: 'Explore',
    fromTypes: ['mirrored-database'],
    icon: 'notebook',
    fields: [
      { name: 'notebookName', label: 'Notebook name', kind: 'text', required: true, hint: 'A name for the new notebook.' },
    ],
    route: '/api/thread/mirror-to-notebook',
    submitLabel: 'Weave',
  },
  {
    id: 'mirror-to-lakehouse',
    label: 'Add mirrored tables to a Lakehouse',
    description:
      'Create file shortcuts in a Lakehouse pointing at this mirror’s replicated tables in ADLS Bronze, ' +
      'so you can work with the mirrored data inside the lakehouse. Start the mirror first.',
    group: 'Explore',
    fromTypes: ['mirrored-database'],
    icon: 'api',
    fields: [
      {
        name: 'lakehouseId',
        label: 'Lakehouse',
        kind: 'loom-item',
        itemTypes: ['lakehouse'],
        required: true,
        hint: 'The lakehouse to add the shortcuts to (one shortcut per replicated table).',
      },
    ],
    route: '/api/thread/mirror-to-lakehouse',
    submitLabel: 'Weave',
  },
  {
    // Analyze with DAX — from a Loom-native semantic model (incl. a
    // warehouse-backed model), generate a structured DAX EVALUATE over one of
    // the model's tables, execute it against the Azure-native tabular layer
    // (Synapse serverless SQL by default; AAS XMLA when opted in — no Power BI /
    // Fabric on the default path per no-fabric-dependency.md) and open the
    // model's DAX query view pre-loaded with the generated query + a real
    // execution receipt. Fields are dropdowns (table + query kind) — the DAX
    // itself is synthesized server-side (never freeform, no-freeform-config.md).
    id: 'analyze-with-dax',
    label: 'Analyze with DAX',
    description:
      'Generate and run a DAX query over one of this semantic model’s tables — pick a table and a ' +
      'query kind and Loom synthesizes a real EVALUATE, executes it against the Azure-native tabular ' +
      'layer (Synapse serverless SQL by default), and opens the model’s DAX query view pre-loaded with ' +
      'the query and its real result rows. No Power BI / Fabric workspace required.',
    group: 'Analyze with AI',
    fromTypes: DAX_ANALYZABLE,
    icon: 'chart',
    fields: [
      {
        name: 'table',
        label: 'Table',
        kind: 'select',
        optionsRoute: '/api/thread/model-tables?fromId={fromId}',
        required: true,
        hint: 'The model table to analyze. Loom builds the DAX EVALUATE over it.',
      },
      {
        name: 'queryKind',
        label: 'Query',
        kind: 'select',
        options: [
          { value: 'table-preview', label: 'Preview rows (TOPN 100)' },
          { value: 'top-n', label: 'Top 100 rows' },
          { value: 'row-count', label: 'Row count' },
        ],
        default: 'table-preview',
        required: true,
        hint: 'What to compute. Loom synthesizes the DAX — you never type it.',
      },
    ],
    route: '/api/thread/analyze-with-dax',
    submitLabel: 'Weave',
  },
  {
    // Materialize to KQL (ADX) — from a lakehouse, bind one of its ADLS Delta
    // tables to an Azure Data Explorer external table
    // (`.create-or-alter external table … kind=delta`) in a target Loom
    // kql-database / eventhouse, optionally turning on the query-acceleration
    // policy so the Delta data is queryable via KQL within seconds. The
    // Azure-native "lakehouse → KQL" bridge — no Fabric RTI Eventhouse required
    // (no-fabric-dependency.md). Real ADX mgmt command; honest gate naming
    // LOOM_KUSTO_CLUSTER_URI when ADX isn't configured.
    id: 'materialize-to-kql',
    label: 'Materialize to KQL (ADX)',
    description:
      'Expose one of this lakehouse’s Delta tables to Azure Data Explorer as an external table so you ' +
      'can query it with KQL — pick the table and a target KQL database, and Loom binds the Delta path ' +
      '(`kind=delta`) and (optionally) enables query acceleration for sub-second reads. Azure-native — ' +
      'no Fabric Eventhouse required.',
    group: 'Explore',
    fromTypes: LAKEHOUSE_KQL_MATERIALIZABLE,
    icon: 'kql',
    fields: [
      {
        name: 'table',
        label: 'Delta table',
        kind: 'select',
        optionsRoute: '/api/thread/lakehouse-delta-tables?fromId={fromId}',
        required: true,
        hint: 'The lakehouse Delta table to bind as an ADX external table.',
      },
      {
        name: 'kqlDatabaseId',
        label: 'KQL database',
        kind: 'loom-item',
        itemTypes: ['kql-database', 'eventhouse'],
        required: true,
        hint: 'The Azure Data Explorer database (Loom kql-database / eventhouse) to create the external table in.',
      },
      {
        name: 'accelerate',
        label: 'Enable query acceleration',
        kind: 'toggle',
        default: true,
        hint: 'Cache recent Delta data in ADX for sub-second KQL queries. Turn off to query the Delta files directly.',
      },
    ],
    route: '/api/thread/materialize-to-kql',
    submitLabel: 'Weave',
  },
  {
    // Promote (medallion) — from a lakehouse, promote one of its bronze/silver
    // Delta tables to the next layer. Loom scaffolds a real Synapse Spark
    // notebook (read the source Delta table → clean/dedup or aggregate → write
    // the next-layer Delta table + register it) with both lakehouses attached,
    // records the promotion lineage edge, and deep-links the notebook. The
    // promotion runs on real Synapse Spark (Livy) when you hit Run — the
    // medallion spine, Azure-native (no Fabric, no-vaporware.md).
    id: 'promote-medallion',
    label: 'Promote to next layer',
    description:
      'Promote one of this lakehouse’s Delta tables up the medallion (bronze→silver→gold). Loom ' +
      'scaffolds a real Spark notebook that reads the source table, applies the chosen transform ' +
      '(clean + dedup, or aggregate), and writes the promoted table to the target lakehouse — then ' +
      'deep-links it so you Run it on Azure-native Synapse Spark. No Fabric required.',
    group: 'Promote',
    fromTypes: MEDALLION_PROMOTABLE,
    icon: 'notebook',
    fields: [
      {
        name: 'table',
        label: 'Source Delta table',
        kind: 'select',
        optionsRoute: '/api/thread/lakehouse-delta-tables?fromId={fromId}',
        required: true,
        hint: 'The bronze / silver Delta table to promote.',
      },
      {
        name: 'targetLayer',
        label: 'Promote to layer',
        kind: 'select',
        options: [
          { value: 'silver', label: 'Silver (cleaned / conformed)' },
          { value: 'gold', label: 'Gold (aggregated / serving)' },
        ],
        default: 'silver',
        required: true,
        hint: 'The medallion layer to promote into. Silver defaults to clean+dedup; gold to aggregate.',
      },
      {
        name: 'transform',
        label: 'Transform',
        kind: 'select',
        options: [
          { value: 'clean-dedup', label: 'Clean + de-duplicate' },
          { value: 'aggregate', label: 'Aggregate (group + summarize)' },
        ],
        default: 'clean-dedup',
        required: true,
        hint: 'The promotion transform the scaffolded notebook applies to the source table.',
      },
      {
        name: 'targetLakehouseId',
        label: 'Target lakehouse',
        kind: 'loom-item',
        itemTypes: ['lakehouse'],
        allowCreate: true,
        createLabel: '+ Create a new lakehouse',
        required: true,
        hint: 'The lakehouse to write the promoted table into (can be the same lakehouse).',
      },
    ],
    route: '/api/thread/promote-medallion',
    submitLabel: 'Weave',
  },
  // More edges land per the Thread PRP (docs/fiab/thread/PRP-loom-thread.md):
  // PR3 remainder Delta/Databricks-SQL → API · query → UDF REST.
  // Only WIRED edges are listed here so no menu item is ever a dead end.
];

/** Actions available on an editor of `slug`. */
export function actionsFor(slug: string): ThreadAction[] {
  return THREAD_ACTIONS.filter((a) => a.fromTypes === '*' || a.fromTypes.includes(slug));
}

/** Group actions for the menu. */
export function groupedActionsFor(slug: string): { group: ThreadGroup; actions: ThreadAction[] }[] {
  const order: ThreadGroup[] = ['Promote', 'Explore', 'Analyze with AI', 'Visualize', 'Publish'];
  const byGroup = new Map<ThreadGroup, ThreadAction[]>();
  for (const a of actionsFor(slug)) {
    if (!byGroup.has(a.group)) byGroup.set(a.group, []);
    byGroup.get(a.group)!.push(a);
  }
  return order.filter((g) => byGroup.has(g)).map((g) => ({ group: g, actions: byGroup.get(g)! }));
}
