/**
 * rel-T19 — per-user scoping for the notebook file/compute routes.
 *
 * BEFORE this module, `/api/notebook/[id]/contents` ignored `[id]` entirely and
 * was purely path-addressable: any signed-in user could GET or PUT any `.ipynb`
 * on the shared AML Compute-Instance file share by supplying its path. Two users
 * could read/overwrite each other's private notebooks.
 *
 * The fix has two layers, both required:
 *   1. AUTHORIZE the caller against the notebook ITEM — the `[id]` must resolve
 *      to a `notebook` Cosmos item the caller owns OR can reach via a shared
 *      workspace ACL (rel-T11). This is the single ownership chokepoint and it
 *      composes with workspace sharing: a shared-workspace member can edit that
 *      workspace's notebook, a stranger gets a 404.
 *   2. BIND the file path to that notebook's own scope — so a caller authorized
 *      for notebook X cannot pivot to another user's file by passing a foreign
 *      path with X's id. The allowed scope is the item's declared file
 *      (`state.notebookPath`) and its directory, or — when the item declares no
 *      path — the caller's private `Users/<oid>/` prefix. Traversal (`..`),
 *      absolute paths, backslashes and NUL are always rejected.
 */
import type { WorkspaceItem } from '@/lib/types/workspace';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';

/**
 * Resolve a `notebook` item the caller is authorized to touch. `oid` is the
 * caller's Entra object id (session.claims.oid). Read routes pass `write:false`
 * to admit shared read-only ACL members; write routes require write-capable
 * access. Returns null when the id is not a notebook the caller can reach.
 */
export async function loadAccessibleNotebook(
  id: string,
  oid: string,
  opts: { write?: boolean } = {},
): Promise<WorkspaceItem | null> {
  return loadOwnedItem(id, 'notebook', oid, { allowReadRoles: !opts.write });
}

export type PathScopeResult =
  | { ok: true; path: string }
  | { ok: false; status: number; error: string };

/** Reject traversal / absolute / backslash / NUL; return normalized POSIX path. */
function sanitizeRelPath(raw: string): string | null {
  const p = raw.trim();
  if (!p) return null;
  if (p.includes('\0') || p.includes('\\')) return null; // NUL / Windows separators
  if (p.startsWith('/')) return null;                     // no absolute paths
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..')) return null;      // no parent-dir escape
  return segments.join('/');
}

/**
 * Authorize a requested Jupyter file `path` for a resolved notebook `item`,
 * binding it to the notebook's own scope so an authorized caller cannot reach
 * another user's file. Returns the safe path to use against the Jupyter REST
 * API, or a `{ status, error }` the route should return verbatim.
 */
export function scopeNotebookPath(
  item: WorkspaceItem,
  oid: string,
  requested: string,
): PathScopeResult {
  const clean = sanitizeRelPath(requested);
  if (!clean) {
    return { ok: false, status: 400, error: 'path is invalid — relative POSIX paths only (no "..", absolute paths, or backslashes).' };
  }

  // The item's declared file (if any) defines the shared scope: the notebook's
  // own file and any sibling under its directory (checkpoints / sidecar files).
  const declaredRaw = (item.state as Record<string, unknown> | undefined)?.notebookPath;
  const declared = typeof declaredRaw === 'string' ? sanitizeRelPath(declaredRaw) : null;

  if (declared) {
    const slash = declared.lastIndexOf('/');
    // No directory component → the scope is exactly that one file.
    if (slash < 0) {
      if (clean === declared) return { ok: true, path: clean };
    } else {
      const dir = declared.slice(0, slash);
      if (clean === declared || clean.startsWith(`${dir}/`)) return { ok: true, path: clean };
    }
    return { ok: false, status: 403, error: "path is outside this notebook's file scope." };
  }

  // No declared path → confine the caller to their own private prefix so two
  // users can never address each other's files.
  const prefix = `Users/${oid}/`;
  if (clean === `Users/${oid}` || clean.startsWith(prefix)) return { ok: true, path: clean };
  return { ok: false, status: 403, error: "path is outside your private notebook scope (Users/<you>/)." };
}
