/**
 * Workspace-scoped LIST authorization — the single chokepoint for read/list
 * endpoints that must return ONLY the items of a specific workspace the caller
 * can see (the editor pickers, /api/items, /api/items/by-type, and
 * /api/lakehouse/tables).
 *
 * WHY THIS EXISTS (the leak it closes): the item list endpoints used to run an
 * unscoped, cross-partition query and then owner-filter per item. Within a
 * single tenant that returned EVERY workspace's items — so a picker opened in
 * Workspace A listed lakehouses / warehouses / databases that live in Workspace
 * B. Fabric scopes every picker to the current workspace + the caller's access;
 * Loom must too. This helper resolves the caller's access to ONE workspace so a
 * scoped, partition-keyed query can replace the global scan.
 *
 * It is a thin, read-oriented wrapper over {@link resolveWorkspaceAccessByOid}
 * (the owner → workspace-roles ACL → tid-boundary → admin-open resolver): ANY
 * non-null role authorizes a LIST (listing is read-only, so a Viewer/Contributor
 * counts — no write gate). Returns the resolved {@link WorkspaceAccess} (so the
 * caller can read `workspace.domain` for the card badge) or null when the caller
 * has no access at all, in which case the route returns 404 (we never leak the
 * existence of a workspace the caller can't see).
 */
import type { SessionPayload } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  resolveWorkspaceAccessByOid,
  type WorkspaceAccess,
} from '@/lib/auth/workspace-access';

export async function authorizeWorkspaceList(
  session: SessionPayload,
  workspaceId: string,
): Promise<WorkspaceAccess | null> {
  return resolveWorkspaceAccessByOid(session.claims.oid, workspaceId, {
    groups: session.claims.groups,
    callerTid: session.claims.tid,
    tenantAdmin: isTenantAdmin(session),
  });
}
