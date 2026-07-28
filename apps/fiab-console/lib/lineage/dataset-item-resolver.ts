/**
 * Physical dataset URI → Loom item resolution, shared by every OpenLineage
 * producer (LU-8).
 *
 * Extracted verbatim from `app/api/lineage/openlineage/route.ts` (L2) so the
 * listener ingest, the Synapse pipeline emitter, and the Synapse Spark emitter
 * all resolve dataset URIs to items THE SAME WAY. Two producers with two copies
 * of "which item owns this path?" is how a merged lineage graph quietly splits
 * into two.
 *
 * ONE behavioural fix rides along with the extraction: both the stored item
 * paths and the incoming dataset URI are now run through
 * `canonicalStorageUri()` before prefix-matching. Before, an item whose state
 * recorded `https://acct.dfs.core.windows.net/bronze/sales` could never be
 * matched by a Spark event naming `abfss://bronze@acct.dfs.core.windows.net/
 * sales` — the same folder, two spellings, silently zero lineage.
 */

import { itemsContainer } from '@/lib/azure/cosmos-client';
import { canonicalStorageUri } from '@/lib/lineage/dataset-naming';

/** A Loom item that carries at least one physical storage path in its state. */
export interface PathItem {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName?: string;
  /** Canonical (`abfss://…`, lowercase, no trailing slash) storage paths. */
  paths: string[];
}

/**
 * Collect the physical storage-path strings on an item's state (top level —
 * e.g. lakehouse `state.adlsRoot`, mirror bronze roots), canonicalized.
 */
export function statePaths(state: Record<string, unknown> | undefined): string[] {
  if (!state || typeof state !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(state)) {
    if (typeof v === 'string' && /^(abfss?|wasbs?|https):\/\//i.test(v.trim())) {
      const c = canonicalStorageUri(v);
      if (c) out.push(c);
    }
  }
  return out;
}

/** True when `uri` is the item path itself or a child of it (`/` boundary). */
export function pathOwns(itemPath: string, uri: string): boolean {
  if (!itemPath) return false;
  if (uri === itemPath) return true;
  return uri.startsWith(`${itemPath}/`);
}

/**
 * Longest-prefix owner of `uri` among the candidates, or null. `uri` is
 * canonicalized here so callers may pass any spelling.
 */
export function resolveOwner(uri: string, candidates: PathItem[]): PathItem | null {
  const target = canonicalStorageUri(uri);
  let best: PathItem | null = null;
  let bestLen = -1;
  for (const c of candidates) {
    for (const p of c.paths) {
      if (pathOwns(p, target) && p.length > bestLen) {
        best = c;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** Path-bearing items of ONE workspace (the authorized scope). */
export async function loadWorkspacePathItems(workspaceId: string): Promise<PathItem[]> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; workspaceId: string; itemType: string; displayName?: string; state?: Record<string, unknown> }>({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE c.workspaceId = @w',
      parameters: [{ name: '@w', value: workspaceId }],
    })
    .fetchAll();
  return (resources || [])
    .map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      itemType: r.itemType,
      displayName: r.displayName,
      paths: statePaths(r.state),
    }))
    .filter((r) => r.paths.length > 0);
}

/**
 * Cross-workspace forgery probe: find an item in a DIFFERENT workspace that
 * owns `uri`. Queries only the path-bearing item classes (bounded), then
 * prefix-matches in process.
 */
export async function findForeignOwner(uri: string, workspaceId: string): Promise<PathItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; workspaceId: string; itemType: string; displayName?: string; state?: Record<string, unknown> }>({
      query:
        'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c ' +
        'WHERE c.workspaceId != @w AND (IS_DEFINED(c.state.adlsRoot) OR IS_DEFINED(c.state.abfssUri) OR IS_DEFINED(c.state.storageLocation))',
      parameters: [{ name: '@w', value: workspaceId }],
    })
    .fetchAll();
  const candidates = (resources || [])
    .map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      itemType: r.itemType,
      displayName: r.displayName,
      paths: statePaths(r.state),
    }))
    .filter((r) => r.paths.length > 0);
  return resolveOwner(uri, candidates);
}
