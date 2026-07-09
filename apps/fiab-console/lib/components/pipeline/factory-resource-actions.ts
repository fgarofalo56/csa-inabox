/**
 * factory-resource-actions — the PURE, DOM-free action model behind the ADF
 * Factory Resources right-click context menus.
 *
 * The `FactoryResourcesTree` component (factory-resources-tree.tsx) renders one
 * Fluent `Menu openOnContext` per tree row (and per group node); the ordered
 * list of menu items for a given resource type comes from `rowActionsFor()`
 * here, and the group menu from `groupActionsFor()`. Keeping the per-type action
 * map as a pure function lets us unit-test ADF-Studio parity + the delete-confirm
 * gating without mounting the tree.
 *
 * Every action key maps 1:1 to a REAL backend call in the component:
 *   open/bind   → onOpenPipeline / onOpenManage / onOpenCdc (existing flows)
 *   start/stop  → POST /api/adf/{triggers,cdc}          (lifecycle)
 *   viewJson    → GET  /api/adf/resource-json           (read-only definition)
 *   clone       → GET resource-json → POST /api/adf/<type>            (create)
 *   rename      → GET resource-json → POST create → DELETE old        (move)
 *   delete      → DELETE /api/adf/<type>?name=…         (typed-confirm gated)
 *   edit        → the Global parameters editor dialog
 * No action is exposed for a type whose backend can't perform it (per
 * no-vaporware.md) — e.g. CDC/MPE offer no clone/rename because ADF has no
 * safe move for them.
 */

export type RowKind =
  | 'pipeline'
  | 'dataset'
  | 'dataflow'
  | 'trigger'
  | 'linkedService'
  | 'integrationRuntime'
  | 'cdc'
  | 'globalParam'
  | 'managedPrivateEndpoint';

export type GroupKind =
  | 'pipelines'
  | 'datasets'
  | 'dataflows'
  | 'triggers'
  | 'linkedServices'
  | 'integrationRuntimes'
  | 'cdc'
  | 'globalParams'
  | 'managedPrivateEndpoints'
  | 'notWired';

export type RowActionKey =
  | 'open'
  | 'bind'
  | 'start'
  | 'stop'
  | 'viewJson'
  | 'clone'
  | 'rename'
  | 'edit'
  | 'delete';

export type GroupActionKey = 'new' | 'refresh' | 'expandAll' | 'collapseAll';

export interface RowActionDescriptor {
  key: RowActionKey;
  label: string;
  /** Destructive actions require a typed-name confirm before executing. */
  destructive?: boolean;
}

export interface GroupActionDescriptor {
  key: GroupActionKey;
  label: string;
}

export interface RowActionContext {
  /** trigger / cdc: whether the resource is currently running / started. */
  running?: boolean;
}

/** Types whose full definition can be fetched read-only (GET resource-json). */
export const VIEW_JSON_KINDS: readonly RowKind[] = [
  'pipeline', 'dataset', 'dataflow', 'trigger',
  'linkedService', 'integrationRuntime', 'cdc',
  'globalParam', 'managedPrivateEndpoint',
];

/**
 * Types we can Clone (create a copy from the fetched definition). Excludes CDC
 * (source→target mapping isn't safely duplicable), integration runtimes
 * (singleton infra), MPE (approval-bound), and global params (edited as a set).
 */
export const CLONE_KINDS: readonly RowKind[] = [
  'pipeline', 'dataset', 'dataflow', 'trigger', 'linkedService',
];

/**
 * Types we can Rename (create-new + delete-old). Excludes linked services and
 * integration runtimes: other resources reference them BY NAME, so a rename
 * would silently break those references — ADF Studio disallows it too. CDC/MPE
 * have no safe move.
 */
export const RENAME_KINDS: readonly RowKind[] = [
  'pipeline', 'dataset', 'dataflow', 'trigger',
];

/** The factory-scoped BFF route that creates/deletes a resource of this kind. */
export const KIND_ROUTE: Record<RowKind, string> = {
  pipeline: '/api/adf/pipelines',
  dataset: '/api/adf/datasets',
  dataflow: '/api/adf/dataflows',
  trigger: '/api/adf/triggers',
  linkedService: '/api/adf/linked-services',
  integrationRuntime: '/api/adf/integration-runtimes',
  cdc: '/api/adf/cdc',
  globalParam: '/api/adf/global-parameters',
  managedPrivateEndpoint: '/api/adf/managed-private-endpoints',
};

/** The `?type=` token GET /api/adf/resource-json accepts for this kind. */
export const RESOURCE_JSON_TYPE: Partial<Record<RowKind, string>> = {
  pipeline: 'pipeline',
  dataset: 'dataset',
  dataflow: 'dataflow',
  trigger: 'trigger',
  linkedService: 'linkedService',
  integrationRuntime: 'integrationRuntime',
  cdc: 'cdc',
};

const clone = (k: RowKind): RowActionDescriptor[] => (CLONE_KINDS.includes(k) ? [{ key: 'clone', label: 'Clone' }] : []);
const rename = (k: RowKind): RowActionDescriptor[] => (RENAME_KINDS.includes(k) ? [{ key: 'rename', label: 'Rename…' }] : []);
const viewJson = (k: RowKind): RowActionDescriptor[] => (VIEW_JSON_KINDS.includes(k) ? [{ key: 'viewJson', label: 'View JSON' }] : []);
const del: RowActionDescriptor = { key: 'delete', label: 'Delete', destructive: true };

/**
 * The ordered right-click action list for one Factory Resources row, matching
 * the ADF Studio per-item context menu (pruned to actions we can back for real).
 */
export function rowActionsFor(kind: RowKind, ctx: RowActionContext = {}): RowActionDescriptor[] {
  const startStop: RowActionDescriptor = ctx.running
    ? { key: 'stop', label: 'Stop' }
    : { key: 'start', label: 'Start' };

  switch (kind) {
    case 'pipeline':
      return [
        { key: 'open', label: 'Open' },
        { key: 'bind', label: 'Bind to this item' },
        ...rename(kind), ...clone(kind), ...viewJson(kind), del,
      ];
    case 'dataset':
    case 'dataflow':
      return [
        { key: 'open', label: 'Open in Manage hub' },
        ...rename(kind), ...clone(kind), ...viewJson(kind), del,
      ];
    case 'trigger':
      return [startStop, ...rename(kind), ...clone(kind), ...viewJson(kind), del];
    case 'linkedService':
      return [
        { key: 'open', label: 'Open in Manage hub' },
        ...clone(kind), ...viewJson(kind), del,
      ];
    case 'integrationRuntime':
      return [
        { key: 'open', label: 'Open in Manage hub' },
        ...viewJson(kind), del,
      ];
    case 'cdc':
      return [
        { key: 'open', label: 'Open' },
        startStop, ...viewJson(kind), del,
      ];
    case 'globalParam':
      return [
        { key: 'edit', label: 'Edit…' },
        ...viewJson(kind), del,
      ];
    case 'managedPrivateEndpoint':
      return [...viewJson(kind), del];
    default:
      return [];
  }
}

/** Singular label used for the group's "New <type>" item. */
export const GROUP_NEW_LABEL: Partial<Record<GroupKind, string>> = {
  pipelines: 'New pipeline',
  datasets: 'New dataset',
  dataflows: 'New data flow',
  triggers: 'New trigger',
  linkedServices: 'New linked service…',
  integrationRuntimes: 'New integration runtime…',
  globalParams: 'Edit global parameters…',
  managedPrivateEndpoints: 'New managed private endpoint',
};

/**
 * The right-click action list for a group (parent) node. Always exposes
 * Refresh + Expand all + Collapse all; prepends "New <type>" when the group
 * can create (and, for MPE, only when a managed VNet exists).
 */
export function groupActionsFor(kind: GroupKind, opts: { canCreate?: boolean } = {}): GroupActionDescriptor[] {
  const out: GroupActionDescriptor[] = [];
  const newLabel = GROUP_NEW_LABEL[kind];
  if (newLabel && opts.canCreate) out.push({ key: 'new', label: newLabel });
  out.push({ key: 'refresh', label: 'Refresh' });
  out.push({ key: 'expandAll', label: 'Expand all' });
  out.push({ key: 'collapseAll', label: 'Collapse all' });
  return out;
}

/** True when an action must route through the typed-confirm dialog. */
export function isDestructiveAction(key: RowActionKey): boolean {
  return key === 'delete';
}

/**
 * DELETE CONFIRM GATING. The confirm button is enabled ONLY when the operator
 * has typed the target resource's name EXACTLY (trimmed). An empty target can
 * never be confirmed. This is the gate the delete dialog binds its primary
 * button's `disabled` to.
 */
export function canConfirmDelete(typed: string, targetName: string): boolean {
  if (!targetName) return false;
  return typed.trim() === targetName;
}

/** All group node values (the controlled Tree's full open-set for Expand all). */
export const ALL_GROUP_VALUES: readonly string[] = [
  'g-pipelines', 'g-datasets', 'g-dataflows', 'g-triggers', 'g-linked',
  'g-runtimes', 'g-cdc', 'g-globalparams', 'g-mpe', 'g-not-wired',
];
