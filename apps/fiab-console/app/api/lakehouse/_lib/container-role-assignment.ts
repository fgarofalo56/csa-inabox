/**
 * Container role-assignment revoke, confined to one container.
 *
 * `DELETE /api/lakehouse/permissions?tab=object` removes an Azure RBAC role
 * assignment. The id it receives must name a role assignment that sits at the
 * named container's scope — never some other ARM path. This helper checks it in
 * two ways before anything is deleted:
 *
 *   1. SHAPE — the id must be `<container scope>/providers/Microsoft.Authorization/roleAssignments/<guid>`
 *      where the container scope ends in `/blobServices/default/containers/<container>`,
 *      with no `..`, query, or fragment.
 *   2. MEMBERSHIP — the id must be one of the assignments `listContainerRoleAssignments`
 *      reports for that container (an `atScope()` listing, filtered to the blob
 *      data roles this surface grants). So the subscription, resource group and
 *      account in the id are the ones the server resolves for the container, and
 *      only a role this dialog manages can be revoked through it.
 *
 * The id handed to `revokeContainerRoleAssignment` is the one from the listing,
 * not the caller's string.
 */
import {
  listContainerRoleAssignments,
  revokeContainerRoleAssignment,
} from '@/lib/azure/adls-client';

/** Azure blob container names: 3-63 chars, lowercase letters, digits and hyphens. */
export const BLOB_CONTAINER_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * Does `id` have the shape of a role assignment at `container`'s scope? Pure
 * string check; see {@link revokeContainerRoleAssignmentInScope} for the
 * membership half.
 */
export function isContainerRoleAssignmentId(id: string, container: string): boolean {
  if (!BLOB_CONTAINER_NAME_RE.test(container)) return false;
  const re = new RegExp(
    '^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[A-Za-z0-9._()-]{1,90}'
    + '/providers/Microsoft\\.Storage/storageAccounts/[a-z0-9]{3,24}'
    + `/blobServices/default/containers/${container}`
    + `/providers/Microsoft\\.Authorization/roleAssignments/${GUID}$`,
    'i',
  );
  return re.test(id);
}

export type RevokeInScopeResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid' | 'not-found'; message: string };

/**
 * Revoke `id` only when it is a role assignment at `container`'s scope, as
 * listed for that container. Returns `invalid` for a malformed id or container
 * and `not-found` when the listing has no such assignment; deletes nothing in
 * either case.
 */
export async function revokeContainerRoleAssignmentInScope(
  container: string,
  id: string,
): Promise<RevokeInScopeResult> {
  if (!isContainerRoleAssignmentId(id, container)) {
    return {
      ok: false,
      reason: 'invalid',
      message:
        'id must be the ARM id of a role assignment on this container '
        + '(.../blobServices/default/containers/<container>/providers/Microsoft.Authorization/roleAssignments/<guid>).',
    };
  }
  const listed = await listContainerRoleAssignments(container);
  const want = id.toLowerCase();
  const match = listed.find((a) => typeof a.id === 'string' && a.id.toLowerCase() === want);
  if (!match) {
    return {
      ok: false,
      reason: 'not-found',
      message: 'No blob data role assignment with that id exists on this container. Refresh the list and retry.',
    };
  }
  await revokeContainerRoleAssignment(match.id);
  return { ok: true, id: match.id };
}
