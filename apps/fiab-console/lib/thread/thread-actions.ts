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

/** Item types that can ground a data agent (mirrors DA_SOURCE_TYPES). */
const DATA_AGENT_SOURCEABLE = [
  'warehouse', 'lakehouse', 'kql-database', 'semantic-model', 'ai-search-index',
  'synapse-dedicated-sql-pool', 'synapse-serverless-sql-pool', 'azure-sql-database',
];

/** Item types that can be attached to a notebook session for exploration. */
const NOTEBOOK_ATTACHABLE = [
  'lakehouse', 'warehouse', 'kql-database',
  'synapse-dedicated-sql-pool', 'synapse-serverless-sql-pool', 'azure-sql-database',
];

/**
 * Warehouse sources whose Azure-native backend (Synapse dedicated SQL) can be
 * read table-by-table to build a Power BI push model. Lakehouse/KQL/Azure-SQL
 * are deferred until their schema adapter lands (only WIRED edges ship).
 */
const POWERBI_MODELABLE = ['warehouse', 'synapse-dedicated-sql-pool'];

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
    id: 'build-powerbi-model',
    label: 'Build a Power BI model',
    description:
      'Publish a warehouse table to Power BI as a real semantic model — columns are read from ' +
      'the catalog and a sample of real rows is pushed so the model is queryable immediately. ' +
      'Then build a report on it in Power BI. No connection strings to type.',
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
  // More edges land per the Thread PRP (docs/fiab/thread/PRP-loom-thread.md):
  // PR2 notebook/lakehouse → SQL warehouse · PR3 table/query → API ·
  // PR4 medallion promotion + mesh viewer · PR5 gold → Power BI model/report.
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
