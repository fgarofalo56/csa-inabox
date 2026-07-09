/**
 * Shared helpers for the lakebase-postgres BFF routes (DBX-4).
 *
 * Every route authenticates the session (getSession) then resolves per-ITEM
 * access via resolveItemAccessByOid (workspace ACL + item-level grants). Writes
 * require canWrite. The bound Flexible Server is resolved from the item's
 * persisted state.lakebase.server (never client-supplied), so a route only ever
 * talks to the server the item is bound to.
 */
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { apiUnauthorized, apiError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { LAKEBASE_ITEM_TYPE, readLakebase, type LakebaseState } from '@/lib/lakebase/lakebase-store';
import type { WorkspaceItem } from '@/lib/types/workspace';

export interface AuthedItem {
  session: SessionPayload;
  item: WorkspaceItem;
  canWrite: boolean;
  state: LakebaseState;
}

/**
 * Authenticate + authorize an item request. Returns either an early
 * NextResponse (401/403/404) or the resolved item + persisted lakebase state.
 * Pass `{ write: true }` to require write access.
 */
export async function authItem(
  id: string,
  opts: { write?: boolean } = {},
): Promise<{ error: NextResponse } | AuthedItem> {
  const session = getSession();
  if (!session) return { error: apiUnauthorized() };
  const access = await resolveItemAccessByOid(session, id, LAKEBASE_ITEM_TYPE);
  if (!access) return { error: apiError('Item not found', 404, { code: 'not_found' }) };
  if (opts.write && !access.canWrite) return { error: apiError('Read-only access', 403, { code: 'forbidden' }) };
  return { session, item: access.item, canWrite: access.canWrite, state: readLakebase(access.item) };
}

/** Narrow the union returned by authItem. */
export function isError(r: { error: NextResponse } | AuthedItem): r is { error: NextResponse } {
  return (r as { error: NextResponse }).error !== undefined;
}

/** The bound Flexible Server ref, or an honest 409 if none is bound yet. */
export function requireBoundServer(state: LakebaseState): { server: NonNullable<LakebaseState['server']> } | { error: NextResponse } {
  if (!state.server?.name) {
    return {
      error: apiError(
        'No Flexible Server is bound to this item yet. Provision or bind one first.',
        409,
        { code: 'not_bound' },
      ),
    };
  }
  return { server: state.server };
}
