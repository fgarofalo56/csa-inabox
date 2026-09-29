/**
 * Which Synapse workspace notebooks belong to a `synapse-notebook` Loom item.
 *
 * Every Loom Synapse notebook item publishes into ONE deployment-default
 * Synapse workspace (`LOOM_SYNAPSE_WORKSPACE`), so the notebook NAME is the
 * only thing that separates one item's published notebook from another's. The
 * write routes (`/api/synapse/notebooks` and `/api/synapse/notebooks/[name]`)
 * let a caller who can WRITE the item create, save or delete exactly the names
 * bound to that item; any other name is a tenant-admin action (#4619).
 *
 * THE BINDING. A name is bound to an item when it ends in `_<token>`, where
 * `<token>` is the item's Cosmos id with every non-alphanumeric removed and
 * lower-cased (32 hex characters for the `crypto.randomUUID()` ids Loom mints).
 * The part before the token is the item's display name, sanitized to the
 * Synapse artifact alphabet — so the published notebook carries the item's
 * name, and a rename of the item keeps its earlier notebook reachable.
 *
 * The token comes from the server-minted id, never from anything a caller can
 * write into the item document, so one item cannot claim another's name. An
 * id with fewer than {@link MIN_TOKEN_LENGTH} alphanumerics has no binding and
 * its notebooks are tenant-admin only.
 *
 * Pure (no server imports): the editor derives the same name it will send.
 */

/** Synapse notebook artifact names the routes accept. */
export const NOTEBOOK_NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

/** Shortest id token that can bind a name; below this an id is too guessable. */
export const MIN_TOKEN_LENGTH = 16;

const MAX_NAME = 260;

/** The item's binding token, or null when the id cannot carry one. */
export function notebookItemToken(itemId: string | null | undefined): string | null {
  if (typeof itemId !== 'string') return null;
  const token = itemId.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

/**
 * The notebook name an item publishes as: `<sanitized display name>_<token>`,
 * or null when the id carries no token. Always matches NOTEBOOK_NAME_RE.
 */
export function boundNotebookName(displayName: string | null | undefined, itemId: string | null | undefined): string | null {
  const token = notebookItemToken(itemId);
  if (!token) return null;
  const room = MAX_NAME - token.length - 1;
  const base = String(displayName ?? '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, room)
    .replace(/_+$/, '');
  return `${base || 'notebook'}_${token}`;
}

/** True when `name` is a valid notebook name bound to the item `itemId`. */
export function isNameBoundToItem(name: string, itemId: string | null | undefined): boolean {
  const token = notebookItemToken(itemId);
  if (!token || typeof name !== 'string' || !NOTEBOOK_NAME_RE.test(name)) return false;
  const suffix = `_${token}`;
  return name.length > suffix.length && name.toLowerCase().endsWith(suffix);
}

/** `?itemId=<id>` for a notebook write request, or '' when there is no item. */
export function itemIdQuery(itemId: string | null | undefined): string {
  return itemId ? `?itemId=${encodeURIComponent(itemId)}` : '';
}
