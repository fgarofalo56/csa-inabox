/**
 * Item binding for lakehouse routes that act on the item as a whole (settings,
 * schemas, table loads) rather than on one caller-named path.
 *
 * `authorizeAndBind` authorizes the item exactly as `authorizeLakehouse` does
 * (404 when the caller cannot reach it, 403 when `write` is asked of a
 * read-only role), then resolves the item's storage binding from its
 * server-recorded state. The container and root a route acts on come from the
 * returned `bound`, never from the request.
 */
import { NextResponse } from 'next/server';
import { apiConflict } from '@/lib/api/respond';
import { resolveLakehouseAbfss, type ResolvedLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { authorizeLakehouse, pathSegments } from './item-scope';

export interface BoundLakehouse {
  item: WorkspaceItem;
  canWrite: boolean;
  /** The item's storage location. `root` has no leading or trailing slash. */
  bound: ResolvedLakehouseAbfss;
  /** `bound.root` split into segments; never empty. */
  rootSegments: string[];
}

export const NO_BINDING_MESSAGE =
  'Loom has no lakehouse storage binding for this item. Either no lakehouse storage is configured for '
  + 'this deployment (set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL, deployed by the DLZ Bicep) or the item has '
  + 'never been provisioned. Re-run the item provision and retry.';

/** Authorize `lakehouseId` and resolve its binding, or return the refusal. */
export async function authorizeAndBind(
  session: SessionPayload,
  lakehouseId: string,
  opts: { write?: boolean; readOnlyMessage?: string } = {},
): Promise<BoundLakehouse | NextResponse> {
  const access = await authorizeLakehouse(session, lakehouseId, opts);
  if (access instanceof NextResponse) return access;
  const bound = await resolveLakehouseAbfss(lakehouseId, access.item.workspaceId);
  if (!bound) return apiConflict(NO_BINDING_MESSAGE);
  const rootSegments = pathSegments(bound.root);
  if (!rootSegments) {
    return apiConflict(
      'Loom found a storage binding for this lakehouse, but its recorded root '
      + `(${JSON.stringify(String(bound.root ?? ''))}) is not a usable path inside the container. `
      + 'Re-run the item provision to rewrite the binding.',
    );
  }
  return { item: access.item, canWrite: access.canWrite, bound, rootSegments };
}

/** `abfss://<container>@<host>/<root>` → `<host>`, or null when it does not parse. */
export function abfssHost(abfss: string): string | null {
  const m = /^abfss:\/\/[^@/]+@([^/]+)(?:\/|$)/i.exec(String(abfss || ''));
  return m ? m[1] : null;
}
