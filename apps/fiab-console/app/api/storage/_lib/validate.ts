/**
 * Shared input validators for the /api/storage/[account]/** routes.
 *
 * They live in `_lib` (the established shape — see app/api/items/_lib/) rather
 * than in one of the route modules, because a route importing another route's
 * module drags that route's `runtime`/`dynamic` config and handler into the
 * importer's module graph for the sake of one regex.
 *
 * These bound what reaches the storage data plane: an account name and a
 * container name are the two path segments of the request URL, and a prefix is
 * appended to it.
 */

/** Azure storage account names: 3-24 chars, lower-case letters and digits. */
export function isValidStorageAccount(a: string): boolean {
  return /^[a-z0-9]{3,24}$/.test(a);
}

/**
 * Blob / ADLS container names: 3-63 chars, lower-case alphanumeric and single
 * hyphens, starting and ending alphanumeric.
 */
export function isValidContainerName(c: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(c) && !c.includes('--');
}

/**
 * A prefix is a path INSIDE the container. Reject anything that could climb out
 * of it or smuggle a query string into the data-plane URL — `..` segments, a
 * URL scheme, control characters, `?` or `#`.
 */
export function isSafePrefix(p: string): boolean {
  if (p === '') return true;
  if (p.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f?#]/.test(p)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..');
}
