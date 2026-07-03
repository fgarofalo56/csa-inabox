/**
 * rel-T11 / B4 — multi-user workspace access resolver (the single chokepoint).
 *
 * BEFORE this module, "ownership" everywhere was `workspace.tenantId === oid`
 * where `tenantId` is the individual user's Entra `oid`. That made NOTHING
 * shareable: a second user in the SAME Entra tenant could not open a workspace
 * another user shared with them, because the workspace doc lives in the owner's
 * `oid` partition and every read compared against the caller's own `oid`.
 *
 * The `workspace-roles` container (system of record for the "Manage Access"
 * sharing UI, resolved by `resolveEffectiveRole`) already recorded who a
 * workspace is shared with — but no READ guard consulted it. This module wires
 * that ACL into the read path so a shared user resolves.
 *
 * ACCESS-RESOLUTION ALGORITHM (owner → ACL → tid boundary):
 *   1. OWNER fast-path — point-read the workspace on (id, callerOid). A hit
 *      means the caller owns it. This is byte-identical to the legacy check and
 *      runs FIRST, so the single-operator estate does ZERO new work (no ACL
 *      lookup, no Graph call) and behaves exactly as before.
 *   2. If `LOOM_MULTIUSER_ACL` is off, stop here (owner-only — legacy behavior,
 *      a one-env-flip kill switch).
 *   3. Resolve the workspace doc cross-partition (the caller is not its owner,
 *      so it is in a different partition). Missing → no access.
 *   4. tid BOUNDARY — when the caller's Entra tenant id (`callerTid`) is known
 *      AND the workspace doc records its owning `tid` (written going forward),
 *      they MUST match. This blocks any cross-tenant read. Legacy workspace docs
 *      predate the `tid` field; for those the explicit ACL grant below is itself
 *      the tenant boundary (a foreign principal can only get a workspace-role
 *      row if a workspace admin in the owning tenant explicitly added their oid,
 *      and the sharing UI's principal search is tenant-scoped).
 *   5. ACL — `resolveEffectiveRole` returns the caller's highest workspace role
 *      via direct + (nested) group membership. Non-null → access at that role.
 *
 * WRITE vs READ: `canWrite` is true only for Owner/Admin/Member (the roles that
 * map to Azure RBAC Contributor). Contributor/Viewer are read-only. Callers that
 * gate mutations MUST check `canWrite` (see loadOwnedItem + authorizeWorkspace),
 * so sharing can never escalate a read-only member into a writer.
 */
import { workspacesContainer, workspaceRolesContainer } from '@/lib/azure/cosmos-client';
import { resolveEffectiveRole } from '@/lib/azure/workspace-roles-client';
import type { WorkspaceRoleName } from '@/lib/azure/workspace-role-model';
import type { Workspace } from '@/lib/types/workspace';

/**
 * Master switch for the multi-user ACL read path. Default ON. Flip to `off` to
 * revert every read guard to owner-only (byte-identical legacy behavior) — the
 * owner fast-path is unaffected either way, so the single-operator estate is
 * safe regardless of the flag.
 */
export function multiUserAclEnabled(): boolean {
  return (process.env.LOOM_MULTIUSER_ACL ?? 'on').toLowerCase() !== 'off';
}

export type AccessRole = 'Owner' | WorkspaceRoleName;

/** Roles that may MUTATE workspace/item state (map to Azure RBAC Contributor). */
const WRITE_ROLES = new Set<AccessRole>(['Owner', 'Admin', 'Member']);

export function roleCanWrite(role: AccessRole): boolean {
  return WRITE_ROLES.has(role);
}

export interface WorkspaceAccess {
  /** The resolved workspace doc. */
  workspace: Workspace;
  /** How the caller is authorized. */
  role: AccessRole;
  /** 'owner' = direct ownership; 'acl' = shared via a workspace-roles grant. */
  via: 'owner' | 'acl';
  /** True when `role` may write (Owner/Admin/Member). */
  canWrite: boolean;
}

/** Cross-partition point-lookup of a workspace by id (bounded — single id). */
async function readWorkspaceById(workspaceId: string): Promise<Workspace | null> {
  const ws = await workspacesContainer();
  const { resources } = await ws.items
    .query<Workspace>({
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: workspaceId }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Resolve the caller's access to a workspace from their Entra `oid` (the value
 * legacy code calls `tenantId`). Returns null when the caller neither owns the
 * workspace nor holds any ACL role on it (or the tid boundary rejects it).
 *
 * `opts.groups` short-circuits the per-group Graph membership checks when the
 * caller's transitive group set is already known (from the session claims).
 * `opts.callerTid` enables the tid-boundary check (step 4).
 */
export async function resolveWorkspaceAccessByOid(
  oid: string,
  workspaceId: string,
  opts: { groups?: string[]; callerTid?: string } = {},
): Promise<WorkspaceAccess | null> {
  const ws = await workspacesContainer();

  // 1) OWNER fast-path — identical to the legacy owner check; no ACL/Graph work.
  try {
    const { resource } = await ws.item(workspaceId, oid).read<Workspace>();
    if (resource && resource.tenantId === oid) {
      return { workspace: resource, role: 'Owner', via: 'owner', canWrite: true };
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }

  // 2) Flag off → owner-only (legacy). Kill switch for the ACL read path.
  if (!multiUserAclEnabled()) return null;

  // 3) The caller is not the owner — locate the workspace in its own partition.
  const wsDoc = await readWorkspaceById(workspaceId);
  if (!wsDoc) return null;

  // 4) tid boundary — reject a cross-tenant read when both sides record a tid.
  if (opts.callerTid && wsDoc.tid && wsDoc.tid !== opts.callerTid) return null;

  // 5) ACL — highest workspace role via direct + (nested) group membership.
  const role = await resolveEffectiveRole(oid, workspaceId, { userGroupIds: opts.groups });
  if (!role) return null;

  return { workspace: wsDoc, role, via: 'acl', canWrite: WRITE_ROLES.has(role) };
}

/**
 * List the workspaces a user can see: the ones they OWN (partition read) PLUS
 * the ones directly shared with them via a `workspace-roles` grant (rel-T11).
 * Feeds the "my workspaces" list so a shared workspace is discoverable, not just
 * reachable by deep link.
 *
 * Shared discovery uses DIRECT user assignments only (a user added by the
 * sharing UI). Group-shared workspaces still resolve on open (guard /
 * loadOwnedItem run `resolveEffectiveRole` with the caller's groups) but are not
 * enumerated here — surfacing every group-shared workspace in the list would
 * cost a Graph membership probe per group per request. With the ACL flag off
 * this returns owned-only (byte-identical legacy behavior).
 */
export async function listAccessibleWorkspaces(
  oid: string,
  opts: { callerTid?: string } = {},
): Promise<Workspace[]> {
  const ws = await workspacesContainer();
  const { resources: owned } = await ws.items
    .query<Workspace>(
      {
        query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
        parameters: [{ name: '@t', value: oid }],
      },
      { partitionKey: oid },
    )
    .fetchAll();

  if (!multiUserAclEnabled()) return owned;

  // Direct (non-group) workspace-role assignments for this user (cross-partition).
  const roles = await workspaceRolesContainer();
  const { resources: assignments } = await roles.items
    .query<{ workspaceId: string }>({
      query: "SELECT c.workspaceId FROM c WHERE c.principalId = @p AND c.principalType != 'Group'",
      parameters: [{ name: '@p', value: oid }],
    })
    .fetchAll();

  const ownedIds = new Set(owned.map((w) => w.id));
  const sharedIds = [...new Set(assignments.map((a) => a.workspaceId))].filter((id) => !ownedIds.has(id));
  const shared: Workspace[] = [];
  for (const id of sharedIds) {
    const doc = await readWorkspaceById(id);
    if (!doc) continue;
    if (opts.callerTid && doc.tid && doc.tid !== opts.callerTid) continue; // tid boundary
    shared.push(doc);
  }
  return [...owned, ...shared];
}
