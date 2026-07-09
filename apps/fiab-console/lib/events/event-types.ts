/**
 * Loom event catalog (BR-WEBHOOK).
 *
 * The canonical, closed set of event types an outbound webhook / event
 * subscription can filter on. Every type here has at least ONE real emitter
 * wired into a live choke point (no-vaporware.md — a subscribable type nothing
 * ever emits would be a stub). The emitter sites:
 *
 *   item.created / item.updated / item.deleted
 *       → app/api/items/_lib/item-crud.ts (createOwnedItem / updateOwnedItem /
 *         softDeleteOwnedItem+deleteOwnedItem) — the SHARED per-type item
 *         lifecycle chokepoint every editor persists through.
 *   workspace.created / workspace.updated / workspace.deleted
 *   permission.granted / permission.revoked
 *   mcp-server.deployed / mcp-server.removed
 *   tenant-settings.updated / config.updated / domain.deleted / platform.updated
 *   admin.mutation (catch-all for any other admin-plane mutation)
 *       → fanned out from lib/admin/audit-stream.ts `emitAuditEvent`, i.e. the
 *         EXACT SAME admin-plane choke points the BR-SIEM audit stream already
 *         instruments. Reuses that pattern with zero new edits to those routes.
 *   pipeline.run.completed / pipeline.run.failed
 *       → app/api/deployment-pipelines/loom/[id]/deploy/route.ts terminal receipt.
 *   marketplace.listing.subscribed / marketplace.sla.breached
 *       → W18: data-product access-request POST + SLA-check route.
 *
 * `webhook.test` is a SYSTEM event delivered by the per-hook "test fire" button
 * regardless of a hook's subscribed filter — it is never listed as a
 * subscribable choice.
 */

/** Subscribable event types (offered in the registration multi-select). */
export const LOOM_EVENT_TYPES = [
  'item.created',
  'item.updated',
  'item.deleted',
  'workspace.created',
  'workspace.updated',
  'workspace.deleted',
  'permission.granted',
  'permission.revoked',
  'mcp-server.deployed',
  'mcp-server.removed',
  'tenant-settings.updated',
  'config.updated',
  'domain.deleted',
  'platform.updated',
  'admin.mutation',
  'pipeline.run.completed',
  'pipeline.run.failed',
  'marketplace.listing.subscribed',
  'marketplace.sla.breached',
] as const;

export type LoomEventType = (typeof LOOM_EVENT_TYPES)[number];

/** The system test event — always deliverable, never a subscribable choice. */
export const WEBHOOK_TEST_EVENT = 'webhook.test' as const;

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(LOOM_EVENT_TYPES);

/** True when `t` is a real subscribable Loom event type. */
export function isLoomEventType(t: unknown): t is LoomEventType {
  return typeof t === 'string' && EVENT_TYPE_SET.has(t);
}

/**
 * UI grouping + human labels for the registration wizard's event-type picker.
 * Grouped so the multi-select reads as categories (per loom_no_freeform_config —
 * the picker is a checkbox list, never a free-text field).
 */
export const LOOM_EVENT_GROUPS: ReadonlyArray<{
  group: string;
  events: ReadonlyArray<{ type: LoomEventType; label: string }>;
}> = [
  {
    group: 'Item lifecycle',
    events: [
      { type: 'item.created', label: 'Item created' },
      { type: 'item.updated', label: 'Item updated' },
      { type: 'item.deleted', label: 'Item deleted' },
    ],
  },
  {
    group: 'Workspace',
    events: [
      { type: 'workspace.created', label: 'Workspace created' },
      { type: 'workspace.updated', label: 'Workspace updated' },
      { type: 'workspace.deleted', label: 'Workspace deleted' },
    ],
  },
  {
    group: 'Pipeline runs',
    events: [
      { type: 'pipeline.run.completed', label: 'Pipeline run completed' },
      { type: 'pipeline.run.failed', label: 'Pipeline run failed' },
    ],
  },
  {
    group: 'Marketplace',
    events: [
      { type: 'marketplace.listing.subscribed', label: 'Listing subscribed' },
      { type: 'marketplace.sla.breached', label: 'SLA breached' },
    ],
  },
  {
    group: 'Admin plane',
    events: [
      { type: 'permission.granted', label: 'Permission granted' },
      { type: 'permission.revoked', label: 'Permission revoked' },
      { type: 'mcp-server.deployed', label: 'MCP server deployed' },
      { type: 'mcp-server.removed', label: 'MCP server removed' },
      { type: 'tenant-settings.updated', label: 'Tenant settings changed' },
      { type: 'config.updated', label: 'Runtime config changed' },
      { type: 'domain.deleted', label: 'Domain deleted' },
      { type: 'platform.updated', label: 'Platform update applied' },
      { type: 'admin.mutation', label: 'Any other admin change' },
    ],
  },
];

/**
 * Map a BR-SIEM audit `action` verb (lib/admin/audit-stream.ts) to the Loom
 * webhook event type it should fan out as. Returns `admin.mutation` for any
 * admin mutation without a more specific mapping — so a subscriber to
 * `admin.mutation` receives every admin-plane change, and a subscriber to a
 * specific type receives only that one. Pure — unit-tested.
 */
export function auditActionToEventType(action: string): LoomEventType {
  const a = (action || '').toLowerCase();
  switch (a) {
    case 'workspace.create':
      return 'workspace.created';
    case 'workspace.delete':
      return 'workspace.deleted';
    case 'feature-grant.upsert':
      return 'permission.granted';
    case 'feature-grant.delete':
      return 'permission.revoked';
    case 'mcp-server.deploy':
    case 'mcp-server.create':
      return 'mcp-server.deployed';
    case 'mcp-server.teardown':
    case 'mcp-server.delete':
      return 'mcp-server.removed';
    case 'tenant-settings.update':
      return 'tenant-settings.updated';
    case 'env-config.update':
      return 'config.updated';
    case 'domain.delete':
      return 'domain.deleted';
    case 'platform.update-apply':
      return 'platform.updated';
    default:
      if (a.startsWith('workspace.')) return 'workspace.updated';
      return 'admin.mutation';
  }
}
