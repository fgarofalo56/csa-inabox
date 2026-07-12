/**
 * SQL endpoint data-access mode (F10) — shared resolver.
 *
 * A SQL analytics endpoint item (synapse-dedicated-sql-pool /
 * synapse-serverless-sql-pool) stores its data-access mode at
 * `item.state.accessMode`:
 *   - 'service' (DEFAULT) — queries run as the Loom console service identity
 *     (UAMI / SP). This is the always-works default; no per-user provisioning.
 *   - 'user' — queries run under the signed-in user's own Azure identity via a
 *     cached delegated SQL token (see sql-user-token-store).
 *
 * The mode is set through PATCH /api/items/[type]/[id]/access-mode and read by
 * the query routes via resolveAccessMode(). Default is 'service' so a brand-new
 * endpoint, an endpoint with no state, or any read failure all degrade safely
 * to the service-identity path that always works.
 */
import { itemsContainer } from './cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export type SqlAccessMode = 'service' | 'user';

export const SQL_ACCESS_MODE_ITEM_TYPES = [
  'synapse-dedicated-sql-pool',
  'synapse-serverless-sql-pool',
] as const;

export function isSqlAccessModeItemType(t: string): boolean {
  return (SQL_ACCESS_MODE_ITEM_TYPES as readonly string[]).includes(t);
}

/**
 * EH-P1-OBO (#1800): item types whose data-plane READS honor the per-user
 * data-access mode. Superset of the SQL endpoints (F10): reports execute their
 * Loom-native visuals over Synapse SQL as the user; KQL databases query ADX as
 * the user. Default stays 'service' everywhere — an item only enters the user
 * path after an explicit PATCH /access-mode.
 */
export const USER_ACCESS_MODE_ITEM_TYPES = [
  ...SQL_ACCESS_MODE_ITEM_TYPES,
  'report',
  'kql-database',
] as const;

export function isUserAccessModeItemType(t: string): boolean {
  return (USER_ACCESS_MODE_ITEM_TYPES as readonly string[]).includes(t);
}

export function normalizeAccessMode(v: unknown): SqlAccessMode {
  return v === 'user' ? 'user' : 'service';
}

/**
 * Read the persisted access mode for a SQL endpoint item (cross-partition by
 * id + itemType). Returns 'service' on any miss/error — the always-works
 * default. ~3 RU per call; called once per query request.
 */
export async function resolveAccessMode(itemId: string, itemType: string): Promise<SqlAccessMode> {
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT TOP 1 c.state FROM c WHERE c.id = @id AND c.itemType = @t',
        parameters: [
          { name: '@id', value: itemId },
          { name: '@t', value: itemType },
        ],
      })
      .fetchAll();
    const state = resources[0]?.state as Record<string, unknown> | undefined;
    return normalizeAccessMode(state?.accessMode);
  } catch {
    return 'service';
  }
}
