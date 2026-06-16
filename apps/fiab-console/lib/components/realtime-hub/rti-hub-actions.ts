/**
 * rti-hub-actions — the per-kind action matrix for the RTI catalog data-streams
 * rows. Pure + framework-free so it can be unit-tested without rendering, and
 * so the UI action menu and the parity doc stay in lock-step.
 *
 * Each capability maps to a real BFF route (per no-vaporware.md):
 *   - previewTestEvents : /api/items/eventstream/{id}/events  (peek + send)
 *   - peekSendEvents    : /api/eventhubs/data-explorer        (peek + send)
 *   - previewData       : /api/realtime-hub/preview           (KQL table read)
 *   - endpoints         : /api/realtime-hub/endpoints
 *   - openEditor        : /items/{type}/{id}
 *   - subscribe         : /api/realtime-hub/connect-source
 *   - createActivator   : /api/items/activator
 */

export type RtiRowKind =
  | 'eventstream' | 'eventhub-entity' | 'eventhub-namespace'
  | 'iothub' | 'adx-cluster' | 'kql-database' | 'eventhouse'
  | 'azure-event' | 'fabric-event';

export interface RtiRowActions {
  /** Loom eventstream: send a test event + peek recent events (AMQP-gated peek). */
  previewTestEvents: boolean;
  /** Event Hub entity: peek + send over the data-plane. */
  peekSendEvents: boolean;
  /** KQL / Eventhouse: preview recent rows from the backing table. */
  previewData: boolean;
  /** ADX cluster (discovered): preview a table against THAT cluster. The
   *  preview drawer carries the row's clusterUri override so the query targets
   *  the discovered cluster, not the env-pinned default. */
  previewClusterData: boolean;
  /** Loom eventstream: show source/destination endpoints from the definition. */
  endpoints: boolean;
  /** Loom item: deep-link to the live editor (query / manage). */
  openEditor: boolean;
  /** Always available — connect this source into a new Loom eventstream. */
  subscribe: boolean;
  /** Always available — create an activator (alert) watching this source. */
  createActivator: boolean;
  /** Loom eventstream only: delete the eventstream item (audit B1). Discovered
   *  Azure sources / KQL tables are not deletable from the catalog. */
  deleteEventstream: boolean;
}

const LOOM_ITEM_KINDS: ReadonlySet<RtiRowKind> = new Set(['eventstream', 'kql-database', 'eventhouse']);

export function isLoomItemKind(kind: string): boolean {
  return LOOM_ITEM_KINDS.has(kind as RtiRowKind);
}

/** Resolve the action set a data-streams row of `kind` supports. */
export function streamRowActions(kind: string): RtiRowActions {
  const k = kind as RtiRowKind;
  const isKqlOrEventhouse = k === 'kql-database' || k === 'eventhouse';
  return {
    previewTestEvents: k === 'eventstream',
    peekSendEvents: k === 'eventhub-entity',
    previewData: isKqlOrEventhouse,
    previewClusterData: k === 'adx-cluster',
    endpoints: k === 'eventstream',
    openEditor: LOOM_ITEM_KINDS.has(k),
    // Subscribe + activator are universal across every discovered/owned source.
    subscribe: true,
    createActivator: true,
    deleteEventstream: k === 'eventstream',
  };
}

/** The human label for the "open editor" action for a Loom item kind. */
export function editorLabel(kind: string): string {
  if (kind === 'eventhouse') return 'eventhouse';
  if (kind === 'kql-database') return 'KQL database';
  return 'eventstream';
}
