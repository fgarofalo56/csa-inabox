/**
 * #2977 — path binding for the `databricks-notebook` item routes.
 *
 * THE HOLE THIS CLOSES. `GET /api/items/databricks-notebook/[id]?path=…` (and
 * its sibling `PUT` / `DELETE` in the same file) ran NO workspace authorization
 * on the live-Databricks branch: `[id]` was decorative and the caller-supplied
 * `path` went straight to `workspace/export` / `workspace/import` /
 * `workspace/delete` under the Console's own UAMI, which holds workspace-wide
 * access to the ONE shared Databricks workspace every Loom tenant sits on. Any
 * signed-in user could therefore read, overwrite, or delete another tenant's
 * notebook by naming its path. Textbook confused deputy — the same shape #2723
 * fixed for `azure-sql-database`, where the conclusion was that the hole lives
 * in the EXECUTE path regardless of what the bind path allows.
 *
 * It was invisible to `scripts/ci/check-route-guards.mjs` because that checker
 * looks for a guard signal ANYWHERE IN THE FILE: the Cosmos-fallback branch
 * (`?workspaceId=` with no `path`) called `authorizeItemWorkspace`, so the file
 * matched — while the branch that actually reaches Databricks had nothing.
 *
 * THE FIX HAS TWO LAYERS, BOTH REQUIRED (mirroring `api/notebook/_lib/
 * notebook-access.ts`, which solved exactly this for the Jupyter family and
 * whose siblings never adopted it):
 *   1. AUTHORIZE the caller against the notebook ITEM — `authorizeItemWorkspace`
 *      runs the canonical owner → tenant-admin → shared-ACL ladder and resolves
 *      the workspace FROM THE ITEM when the caller omits `?workspaceId=`, so
 *      authorization cannot be skipped by dropping a parameter.
 *   2. BIND the path to that item's own scope — so a caller legitimately
 *      authorized for notebook X cannot pivot to another tenant's notebook by
 *      passing a foreign path together with X's id.
 *
 * Layer 2 alone is not enough (a stranger could still name their OWN item's id
 * and their own path — but they must first be authorized for it), and layer 1
 * alone is not enough (that is precisely the pivot the #2723 write-up calls
 * out). Neither is optional.
 */
import type { WorkspaceItem } from '@/lib/types/workspace';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';

/** The Cosmos `itemType` this module scopes. */
export const DBX_NOTEBOOK_ITEM_TYPE = 'databricks-notebook';

/**
 * Deterministic per-item Databricks folder used when an item declares no path
 * of its own (a hand-created notebook that has never been provisioned). Giving
 * such an item a real, private, predictable home is what lets the editor stay
 * fully functional under the new binding — per `.claude/rules/
 * auto-bind-by-default.md` the platform picks the location, the user does not.
 */
export function defaultNotebookRoot(itemId: string): string {
  return `/Shared/loom-notebooks/${cosmosIdFromLoomId(itemId)}`;
}

/**
 * Load the `databricks-notebook` Cosmos item by route `[id]`, WITHOUT
 * authorizing — this only answers "which item is this, and where does it
 * live". Callers MUST have already run `authorizeItemWorkspace`.
 *
 * Cross-partition by design: the item must be found even when it belongs to a
 * workspace the caller does not own, otherwise a foreign item would resolve to
 * "no item" and fall through unscoped. `cosmosIdFromLoomId` resolves the
 * synthetic `loom:<cosmosItemId>` form the bundle-install list route hands the
 * editor (#2830), so a bundle-installed notebook scopes like every other item.
 */
export async function loadNotebookItemRaw(itemId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: cosmosIdFromLoomId(itemId) },
        { name: '@t', value: DBX_NOTEBOOK_ITEM_TYPE },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Normalize a Databricks workspace path to a canonical absolute POSIX path, or
 * return null when it is not addressable.
 *
 * Normalization happens BEFORE any prefix comparison so a traversal segment can
 * never smuggle a caller out of the allowed root. `..` is REJECTED rather than
 * resolved (the stricter of the two options, and what the Jupyter sibling does):
 * there is no legitimate reason for the editor to send one, and rejecting means
 * we never have to reason about whether resolution and Databricks' own
 * canonicalisation agree.
 */
export function normalizeDbxPath(raw: unknown): string | null {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) return null;
  if (p.includes('\0') || p.includes('\\')) return null; // NUL / Windows separators
  if (!p.startsWith('/')) return null; // Databricks workspace paths are absolute
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null; // '/' alone is not an addressable object
  if (segments.some((s) => s === '..')) return null; // no parent-dir escape
  return `/${segments.join('/')}`;
}

/** A `state` / `provisioning.secondaryIds` string value, trimmed, or undefined. */
function strField(bag: unknown, key: string): string | undefined {
  const v = (bag as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Resolve the Databricks workspace path this item is bound to.
 *
 * Resolution order is deliberately IDENTICAL to `lib/azure/resource-teardown.ts`
 * (`sid('notebookPath') || st('notebookPath') || provisioning.resourceId`) so the
 * path this module authorizes is the same path teardown deletes — a divergence
 * between the two would mean we are gating a location the platform does not
 * actually use. The numeric-`resourceId` exclusion mirrors it too: the notebook
 * provisioner stores the Databricks RUN ID in `resourceId` when a run was
 * submitted, and a run id is not a path.
 */
export function declaredNotebookPath(item: WorkspaceItem): string | null {
  const prov = (item.state as Record<string, unknown> | undefined)?.provisioning as
    | Record<string, unknown>
    | undefined;
  const raw =
    strField(prov?.secondaryIds, 'notebookPath') ??
    strField(item.state, 'notebookPath') ??
    strField(prov, 'resourceId');
  if (!raw || /^\d+$/.test(raw)) return null;
  return normalizeDbxPath(raw);
}

/**
 * The absolute path prefix a caller authorized for `item` may address.
 *
 * When the item declares a path, the scope is that notebook's own FOLDER — for
 * a bundle-installed notebook at `/Shared/loom-installs/<appId>/<name>` that is
 * `/Shared/loom-installs/<appId>`, i.e. exactly the app's own install folder,
 * so the sibling medallion notebooks of the same app stay reachable and another
 * app's folder does not. This matches `scopeNotebookPath`'s "declared file and
 * its directory" semantics for the Jupyter family.
 *
 * A single-segment declared path (`/Foo`) has no folder above it other than the
 * workspace root, so its scope collapses to that one file — widening to `/`
 * would re-open the hole in full.
 */
export function notebookScopeRoot(item: WorkspaceItem, itemId: string): { root: string; exact: boolean } {
  const declared = declaredNotebookPath(item);
  if (!declared) return { root: defaultNotebookRoot(itemId), exact: false };
  const slash = declared.lastIndexOf('/');
  if (slash <= 0) return { root: declared, exact: true }; // '/Foo' → that file only
  return { root: declared.slice(0, slash), exact: false };
}

export type ScopeResult =
  | { ok: true; path: string; root: string }
  | { ok: false; status: number; error: string };

/**
 * Authorize a caller-supplied Databricks `path` against `item`'s own scope.
 * Returns the safe path to hand the Databricks REST API, or a `{ status, error }`
 * the route returns verbatim.
 *
 * `exact` scopes compare by equality; folder scopes compare against
 * `` `${root}/` `` — a PREFIX check at a path-segment boundary, never a
 * substring one, so `/Shared/loom-installs/app1` does not admit
 * `/Shared/loom-installs/app10/steal`.
 */
export function scopeDbxNotebookPath(
  item: WorkspaceItem,
  itemId: string,
  requested: unknown,
): ScopeResult {
  const clean = normalizeDbxPath(requested);
  if (!clean) {
    return {
      ok: false,
      status: 400,
      error: 'path is invalid — absolute Databricks workspace paths only (no "..", relative paths, or backslashes).',
    };
  }
  const { root, exact } = notebookScopeRoot(item, itemId);
  if (clean === root || (!exact && clean.startsWith(`${root}/`))) {
    return { ok: true, path: clean, root };
  }
  return { ok: false, status: 403, error: "path is outside this notebook's workspace scope." };
}
