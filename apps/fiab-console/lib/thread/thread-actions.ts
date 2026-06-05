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

export type ThreadGroup = 'Analyze with AI' | 'Publish' | 'Visualize' | 'Promote';

export interface ThreadField {
  name: string;
  label: string;
  /** dropdown of the caller's Loom items of `itemTypes` (via /api/items/by-type). */
  kind: 'loom-item' | 'select' | 'text' | 'toggle';
  required?: boolean;
  hint?: string;
  /** loom-item: which item types to list. */
  itemTypes?: string[];
  /** loom-item: also offer "+ Create new …" which sends value `__new__`. */
  allowCreate?: boolean;
  createLabel?: string;
  /** select: static options. */
  options?: { value: string; label: string }[];
  /** select: load options from a real discovery route (GET → { value,label } adapter). */
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

export const THREAD_ACTIONS: ThreadAction[] = [
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
  const order: ThreadGroup[] = ['Promote', 'Analyze with AI', 'Visualize', 'Publish'];
  const byGroup = new Map<ThreadGroup, ThreadAction[]>();
  for (const a of actionsFor(slug)) {
    if (!byGroup.has(a.group)) byGroup.set(a.group, []);
    byGroup.get(a.group)!.push(a);
  }
  return order.filter((g) => byGroup.has(g)).map((g) => ({ group: g, actions: byGroup.get(g)! }));
}
