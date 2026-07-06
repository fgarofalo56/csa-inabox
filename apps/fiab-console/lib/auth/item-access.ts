/**
 * rel-T87 / P4 — per-ITEM access resolver (workspace ACL + item-level grants).
 *
 * Wave-1 (rel-T11) wired the WORKSPACE ACL into the read path via
 * `resolveWorkspaceAccessByOid` (owner → workspace-roles ACL → tid boundary).
 * But the editor's hydrate/save path (`/api/cosmos-items/[type]/[id]`) still
 * resolved access with the legacy `workspace.tenantId === callerOid` owner
 * check ONLY — so a user the item was explicitly SHARED with (a row in the
 * `item-permissions` container, written by the ShareItemDialog / F6 grant
 * route) could not actually open the item: the read returned 404.
 *
 * This module is the single chokepoint the item read/write guards consult. It
 * resolves the caller's access to a specific item by chaining, in order:
 *
 *   1. WORKSPACE access — `resolveWorkspaceAccessByOid` (owner fast-path, then
 *      the workspace-roles ACL, with the tid boundary). If the caller owns or
 *      holds any role on the item's workspace, that governs (a workspace Member
 *      can write; a Viewer/Contributor is read-only). This also, for free,
 *      lets a WORKSPACE-shared user open items — the cosmos-items route never
 *      consulted the workspace ACL before.
 *   2. ITEM-LEVEL grant — when the caller has no workspace role, consult the
 *      `item-permissions` grants for THIS item (system of record for the F6
 *      "Grant people access" dialog). A grant to the caller's `oid` (user) or
 *      to any of their group ids (group) admits them. `Edit` in the grant's
 *      permission set means write; otherwise read-only (Read is always implied).
 *
 * TENANT BOUNDARY: the item-grant path enforces the same cross-tenant guard as
 * workspace-access — when the caller's Entra tenant id (`callerTid`) and the
 * owning workspace's recorded `tid` are both known they MUST match. Legacy
 * workspace docs predate the `tid` field; for those the explicit grant is
 * itself the boundary (a foreign principal can only receive an item-permission
 * row if an owner in the tenant explicitly granted their oid, and the sharing
 * UI's Graph principal search is tenant-scoped).
 *
 * KILL SWITCH: honors `LOOM_MULTIUSER_ACL` — when off, both the workspace ACL
 * and the item-grant path collapse to owner-only (byte-identical legacy
 * behavior); the owner fast-path is unaffected either way.
 */
import { itemsContainer, itemPermissionsContainer } from '@/lib/azure/cosmos-client';
import {
  resolveWorkspaceAccessByOid,
  readWorkspaceById,
  multiUserAclEnabled,
  type AccessRole,
} from '@/lib/auth/workspace-access';
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';
// Type-only import — erased at compile time, so this does NOT pull the
// item-permissions-client's @azure/identity / ADLS runtime graph into the guard.
import type { ItemPermission } from '@/lib/azure/item-permissions-client';

/** How the caller reached the item. */
export type ItemAccessVia = 'owner' | 'workspace-acl' | 'item-grant';

/** Synthetic roles for the item-grant path (no workspace role held). */
export type ItemGrantRole = 'ItemContributor' | 'ItemViewer';

export interface ItemAccess {
  /** The resolved item doc. */
  item: WorkspaceItem;
  /** How the caller is authorized. */
  role: AccessRole | ItemGrantRole;
  via: ItemAccessVia;
  /** True when the caller may MUTATE the item (workspace write role, or an item grant that includes `Edit`). */
  canWrite: boolean;
}

/**
 * Pure decision: does an item-level grant's permission-type set confer WRITE on
 * the item definition? `Edit` is the only write-carrying type (it maps to
 * Storage Blob Data Contributor in the item-permissions model); Read / ReadData
 * / ReadAll* / Reshare / Execute / Build / SubscribeOneLakeEvents are read-only
 * with respect to the item document. Exported for unit testing.
 */
export function itemGrantConfersWrite(permissionTypes: readonly string[] | undefined): boolean {
  return Array.isArray(permissionTypes) && permissionTypes.includes('Edit');
}

/** Cross-partition load of an item by (id, itemType). */
async function readItem(itemId: string, itemType: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: itemId }, { name: '@t', value: itemType }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Fetch the caller's item-level grant for an item, if any. Matches a direct
 * user grant (`user::<oid>`) or any group grant (`group::<gid>`) the caller is
 * a transitive member of. Returns the union write-capability across matches.
 */
async function resolveItemGrant(
  itemId: string,
  oid: string,
  groups: string[] | undefined,
): Promise<{ matched: boolean; canWrite: boolean }> {
  const c = await itemPermissionsContainer();
  const { resources } = await c.items
    .query<ItemPermission>(
      {
        query: 'SELECT * FROM c WHERE c.itemId = @i',
        parameters: [{ name: '@i', value: itemId }],
      },
      { partitionKey: itemId },
    )
    .fetchAll();
  const groupSet = new Set(groups ?? []);
  let matched = false;
  let canWrite = false;
  for (const g of resources) {
    const isMe =
      (g.principalType === 'user' && g.principalId === oid) ||
      (g.principalType === 'group' && groupSet.has(g.principalId));
    if (!isMe) continue;
    matched = true;
    // `Edit` is the only permission type that carries write (maps to Storage
    // Blob Data Contributor in the item-permissions model). Everything else is
    // read-only on the item definition.
    if (itemGrantConfersWrite(g.permissionTypes)) canWrite = true;
  }
  return { matched, canWrite };
}

/**
 * Resolve the caller's access to an item. Returns null when the caller neither
 * owns/holds-a-role-on the item's workspace nor has an item-level grant (or the
 * tid boundary rejects the item-grant path).
 *
 * The single-operator estate takes the workspace OWNER fast-path inside
 * `resolveWorkspaceAccessByOid` and never reaches the item-grant query — zero
 * new work for the common case.
 */
export async function resolveItemAccessByOid(
  session: SessionPayload,
  itemId: string,
  itemType: string,
): Promise<ItemAccess | null> {
  const item = await readItem(itemId, itemType);
  if (!item) return null;
  const { oid, tid, groups } = session.claims;

  // 1) Workspace access (owner → workspace-roles ACL → tid boundary).
  const wsAccess = await resolveWorkspaceAccessByOid(oid, item.workspaceId, {
    groups,
    callerTid: tid,
  });
  if (wsAccess) {
    return {
      item,
      role: wsAccess.role,
      via: wsAccess.via === 'owner' ? 'owner' : 'workspace-acl',
      canWrite: wsAccess.canWrite,
    };
  }

  // Kill switch / legacy: no ACL layer → owner-only, already exhausted above.
  if (!multiUserAclEnabled()) return null;

  // 2) Item-level grant (the F6 "Grant people access" share).
  const grant = await resolveItemGrant(itemId, oid, groups);
  if (!grant.matched) return null;

  // tid boundary for the item-grant path: the owning workspace's recorded tid
  // (when present) must match the caller's tenant. Legacy docs without a tid
  // rely on the explicit grant as the boundary (see module header).
  if (tid) {
    const wsDoc = await readWorkspaceById(item.workspaceId);
    if (wsDoc?.tid && wsDoc.tid !== tid) return null;
  }

  return {
    item,
    role: grant.canWrite ? 'ItemContributor' : 'ItemViewer',
    via: 'item-grant',
    canWrite: grant.canWrite,
  };
}
