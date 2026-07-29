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
 *
 * **`{ fold: false }` is a security choice, not a style one.** These strings are
 * OWNERSHIP CLAIMS: `resolveOwner` grants an item every dataset under its
 * longest-matching path. `foldToTableFolder` rewrites `…/warehouses/part-a` to
 * `…/warehouses`, so folding a claim silently widens it to the whole parent
 * folder — the item would then own every unrelated sibling dataset, AND (in the
 * ingest route) a resolved local owner suppresses the `findForeignOwner`
 * forgery probe, converting a would-be 403 into an allow. Observed dataset URIs
 * are still folded (in `resolveOwner`), which is the direction that makes the
 * `_delta_log` join work; claims are taken literally.
 */
export function statePaths(state: Record<string, unknown> | undefined): string[] {
  if (!state || typeof state !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(state)) {
    if (typeof v === 'string' && /^(abfss?|wasbs?|https):\/\//i.test(v.trim())) {
      const c = canonicalStorageUri(v, { fold: false });
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
 * Longest-prefix owner of `uri` among the candidates, or null.
 *
 * `uri` is canonicalized here so callers may pass any spelling — and it is
 * canonicalized BOTH ways, deliberately:
 *
 *   - FOLDED (`…/sales/_delta_log` → `…/sales`) is what makes a Spark
 *     `COMPLETE` event over the Delta log join the pipeline's `…/sales` sink.
 *   - UNFOLDED is what lets an item whose stored root legitimately ENDS in a
 *     folded segment resolve ITSELF. Claims are canonicalized `{ fold: false }`
 *     (see {@link statePaths} — folding a claim widens it), so an item rooted at
 *     `…/sales/part-a` or `…/tbl/_delta_log` was compared against a folded
 *     observation of exactly that folder, `pathOwns` failed, and the item
 *     silently lost its own root: its dataset was written as an `external` node
 *     or probed as foreign instead. Fail-closed, but real lost lineage.
 *
 * This does NOT re-widen anything. The claim is still taken literally; the
 * unfolded target can only match paths genuinely at or under that literal
 * claim, so the S5 attack (a `part-`-prefixed root swallowing its parent's
 * siblings, thereby suppressing the cross-workspace forgery probe) stays shut.
 */
export function resolveOwner(uri: string, candidates: PathItem[]): PathItem | null {
  const folded = canonicalStorageUri(uri);
  const literal = canonicalStorageUri(uri, { fold: false });
  let best: PathItem | null = null;
  let bestLen = -1;
  for (const c of candidates) {
    for (const p of c.paths) {
      if ((pathOwns(p, folded) || pathOwns(p, literal)) && p.length > bestLen) {
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
 * Path-bearing items OUTSIDE one workspace. Bounded to the item classes that
 * actually carry a storage root, then prefix-matched in process.
 */
export async function loadForeignPathItems(workspaceId: string): Promise<PathItem[]> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; workspaceId: string; itemType: string; displayName?: string; state?: Record<string, unknown> }>({
      query:
        'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c ' +
        'WHERE c.workspaceId != @w AND (IS_DEFINED(c.state.adlsRoot) OR IS_DEFINED(c.state.abfssUri) OR IS_DEFINED(c.state.storageLocation))',
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
 * owns `uri`.
 */
export async function findForeignOwner(uri: string, workspaceId: string): Promise<PathItem | null> {
  return resolveOwner(uri, await loadForeignPathItems(workspaceId));
}

/**
 * A findForeignOwner that loads the foreign candidate set at most ONCE, for
 * callers probing many URIs in a single request (the Synapse harvest walks
 * every endpoint of every emitted event). Same decision, one cross-partition
 * query instead of N.
 */
export function foreignOwnerProbe(workspaceId: string): (uri: string) => Promise<PathItem | null> {
  let pending: Promise<PathItem[]> | null = null;
  return async (uri: string) => {
    if (!pending) pending = loadForeignPathItems(workspaceId);
    return resolveOwner(uri, await pending);
  };
}
