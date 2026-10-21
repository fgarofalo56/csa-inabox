/**
 * inventory-tool - registers the read-only Copilot tool `governance_inventory`
 * (governance-autopilot W1) in the cross-item `LoomToolRegistry`, the same
 * `r.register({ name, service, description, parameters, handler })` shape as
 * `item_list` / `loom_list_gates` in `lib/azure/copilot-orchestrator.ts`.
 *
 * Read-only: no confirm flag is needed. Authorization (caller-scoped by
 * default, tenant admins may pass scope:"tenant") and the `governance.inventory`
 * audit event live in `inventory.ts`. The handler imports it lazily so the
 * orchestrator's static graph does not grow.
 *
 * Honest gates: an unreadable Cosmos returns `{ ok:false, error, remediation }`
 * - never an empty list.
 */

import type { LoomToolRegistry } from '@/lib/azure/copilot-orchestrator';

const S_STRING = { type: 'string' } as const;

export const GOVERNANCE_INVENTORY_TOOL = 'governance_inventory';

/**
 * JSON schema shared by the three list tools: scope + workspaceId + paging, plus
 * tool-specific properties. One definition so the three cannot drift on the
 * pageSize bound or the scope enum.
 */
export function listToolParameters(extra: Record<string, unknown>) {
  return {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['mine', 'tenant'], description: 'mine (default) = workspaces you can access; tenant = whole tenant, tenant admins only (audited).' },
      workspaceId: S_STRING,
      ...extra,
      cursor: { type: 'string', description: 'nextCursor from the previous page.' },
      pageSize: { type: 'integer', minimum: 1, maximum: 500, description: 'Rows per page (default 100); pages also end early at a character budget.' },
    },
    required: [],
    additionalProperties: false,
  };
}

export function registerGovernanceInventoryTool(r: LoomToolRegistry): void {
  r.register({
    name: GOVERNANCE_INVENTORY_TOOL,
    service: 'Loom',
    description:
      'Authoritative, paginated inventory of Loom items for governance: one row per item with its workspace, domain, ' +
      'backing Azure service, the backing resource id read from the item (backingResourceId, backingKeyPath), and ' +
      'resolverStatus (resolved | no-backing-key | not-applicable). governance.registered / governance.scanned are null ' +
      'when not yet measured - null is NOT false. The result is an envelope {items, total, returned, truncated, ' +
      'nextCursor, summary}. If truncated is true (or nextCursor is non-null) MORE ROWS EXIST: call again with ' +
      'cursor=nextCursor until truncated is false, and never report totals or "all" from a partial page. By default it ' +
      'covers the workspaces you can access; a tenant admin may pass scope:"tenant" for the whole tenant (audited). ' +
      'Prefer this over item_list when asked what exists across workspaces or what is registered/governed.',
    whenToUse:
      'Ask “list every asset across all workspaces”, “which items have a backing store”, “what is registered in Purview / scanned?”',
    parameters: listToolParameters({
      itemType: { type: 'string', description: 'Hyphenated item type slug to filter, e.g. lakehouse.' },
      resolverStatus: { type: 'string', enum: ['resolved', 'no-backing-key', 'not-applicable'] },
    }),
    handler: async (args, ctx) => {
      const { governanceInventoryTool } = await import('@/lib/governance/inventory');
      return governanceInventoryTool(ctx, args ?? {});
    },
  });
}
