/**
 * Reference-lakehouse scope for the read-only reference routes
 * (`/api/lakehouse/references/paths`, and `/api/lakehouse/preview?refId=`).
 *
 * A referenced lakehouse is read with the caller's own access to THAT item:
 * `authorizeAndBind` authorizes it (read; 404 when the caller cannot reach it)
 * and resolves its binding, and `scopePathToRoot` confines the caller's
 * container + path to the referenced item's root. The storage account is the
 * host of the resolved binding (`bound.abfss`), so the account and the root
 * always come from the same record.
 *
 * Refusals carry `code` and `remediation` (`authorizeAndBindItem`,
 * `pathScopeRefusal`).
 */
import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { abfssHost } from './item-binding';
import { scopePathToRoot } from './item-scope';
import { authorizeAndBindItem, pathScopeRefusal } from './refusal-envelope';

export interface ScopedReferencePath {
  container: string;
  path: string;
  /** Storage account of the referenced item's binding; undefined when its host does not parse. */
  account: string | undefined;
}

/** The request named a container the referenced item has no storage in. */
export interface OtherReferenceContainer {
  otherContainer: true;
  /** The container the referenced item is bound to. */
  boundContainer: string;
  account: string | undefined;
}

/** `<account>.dfs.<suffix>` → `<account>`, from the binding's abfss URI. */
export function referenceAccountOf(abfss: string): string | undefined {
  const host = abfssHost(abfss);
  const name = host ? host.split('.')[0].toLowerCase() : '';
  return /^[a-z0-9]{3,24}$/.test(name) ? name : undefined;
}

async function scopeReference(
  session: SessionPayload,
  refId: string,
  container: string,
  rawPath: string,
  strict: boolean,
  emptyForOtherContainer: boolean,
): Promise<ScopedReferencePath | OtherReferenceContainer | NextResponse> {
  const scope = await authorizeAndBindItem(session, refId);
  if (scope instanceof NextResponse) return scope;
  const account = referenceAccountOf(scope.bound.abfss);
  if (emptyForOtherContainer && container !== scope.bound.container) {
    return { otherContainer: true, boundContainer: scope.bound.container, account };
  }
  const scoped = scopePathToRoot(scope.bound, container, rawPath, strict);
  if (!scoped.ok) return pathScopeRefusal(scoped);
  return { container: scoped.container, path: scoped.path, account };
}

/** Scope a read of one path in a referenced item (preview). Another container is refused (403). */
export async function scopeReferencePath(
  session: SessionPayload,
  refId: string,
  container: string,
  rawPath: string,
  strict: boolean,
): Promise<ScopedReferencePath | NextResponse> {
  const out = await scopeReference(session, refId, container, rawPath, strict, false);
  // With `emptyForOtherContainer` false, another container reaches `scopePathToRoot` and is refused there.
  if (!(out instanceof NextResponse) && 'otherContainer' in out) {
    return pathScopeRefusal({ reason: 'outside', message: `Container "${container}" is outside this lakehouse storage root.` });
  }
  return out;
}

/**
 * Scope a folder listing in a referenced item. A container the item has no
 * storage in answers `otherContainer` (the route lists nothing for it) rather
 * than a refusal, because the references tree shows one node per container.
 */
export async function scopeReferenceListing(
  session: SessionPayload,
  refId: string,
  container: string,
  rawPath: string,
): Promise<ScopedReferencePath | OtherReferenceContainer | NextResponse> {
  return scopeReference(session, refId, container, rawPath, false, true);
}
