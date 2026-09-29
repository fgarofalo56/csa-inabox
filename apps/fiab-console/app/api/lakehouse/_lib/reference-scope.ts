/**
 * Reference-lakehouse scope for the read-only reference routes
 * (`/api/lakehouse/references/paths`, and `/api/lakehouse/preview?refId=`).
 *
 * A referenced lakehouse is read with the caller's own access to THAT item:
 * `authorizeAndBind` authorizes it (read; 404 when the caller cannot reach it)
 * and resolves its binding, and `scopePathToRoot` confines the caller's
 * container + path to the referenced item's root. An explicit
 * `state.storageAccount` on the referenced item selects its storage account.
 */
import { NextResponse } from 'next/server';
import { apiBadRequest, apiConflict, apiForbidden } from '@/lib/api/respond';
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeAndBind } from './item-binding';
import { scopePathToRoot } from './item-scope';

export interface ScopedReferencePath {
  container: string;
  path: string;
  /** Explicit storage account of the referenced item; undefined → the primary account. */
  account: string | undefined;
}

export async function scopeReferencePath(
  session: SessionPayload,
  refId: string,
  container: string,
  rawPath: string,
  strict: boolean,
): Promise<ScopedReferencePath | NextResponse> {
  const scope = await authorizeAndBind(session, refId);
  if (scope instanceof NextResponse) return scope;
  const scoped = scopePathToRoot(scope.bound, container, rawPath, strict);
  if (!scoped.ok) {
    if (scoped.reason === 'invalid') return apiBadRequest(scoped.message);
    if (scoped.reason === 'root-unusable') return apiConflict(scoped.message);
    return apiForbidden(scoped.message);
  }
  const explicit = (scope.item.state as { storageAccount?: unknown } | undefined)?.storageAccount;
  const account = typeof explicit === 'string' && /^[a-z0-9]{3,24}$/.test(explicit.trim()) ? explicit.trim() : undefined;
  return { container: scoped.container, path: scoped.path, account };
}
