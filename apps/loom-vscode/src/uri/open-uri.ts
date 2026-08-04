/**
 * PURE deep-link parsing/building for the `vscode://<publisher>.loom-vscode/open`
 * URI handler (N9) — no `vscode` import, so the parse↔build round-trip is
 * unit-testable in isolation.
 *
 * A Console "Open in VS Code" button emits:
 *
 *   vscode://csa-loom.loom-vscode/open?deployment=<id>&type=<itemType>&id=<itemId>
 *
 * `deployment` may be either a configured deployment **id** or the console base
 * **apiUrl** (so the button works before the user has named the deployment); the
 * handler matches on id first, then by apiUrl host. `type` + `id` identify the
 * item. Anything else on the path is ignored (returns undefined) rather than
 * guessed — an unrecognised link never opens the wrong item.
 *
 * NOTE (follow-up): the Console-side button that emits this URI is separate
 * work — this module + the handler are the extension half. See the Phase 6 PR
 * body / report.
 */

/** The publisher-qualified extension id (matches package.json publisher.name). */
export const EXTENSION_ID = 'csa-loom.loom-vscode';

/** A resolved "open this item" request from a deep link. */
export interface OpenTarget {
  itemType: string;
  itemId: string;
  /** A configured deployment id (matched first). */
  deploymentId?: string;
  /** The console base URL (matched by host when no id matches). */
  apiUrl?: string;
}

/**
 * Parse the `/open` deep link. Returns undefined for any other path or when the
 * required `type` + `id` are absent (never a partial/guessed target).
 *
 * @param path  the URI path (e.g. `/open`).
 * @param query the URI query string WITHOUT a leading `?` (e.g. `type=x&id=y`).
 */
export function parseOpenUri(path: string, query: string): OpenTarget | undefined {
  if (normalizePath(path) !== '/open') return undefined;
  const params = new URLSearchParams(query || '');
  const itemType = (params.get('type') || '').trim();
  const itemId = (params.get('id') || '').trim();
  if (!itemType || !itemId) return undefined;
  const dep = (params.get('deployment') || params.get('dep') || '').trim();
  const target: OpenTarget = { itemType, itemId };
  if (dep) {
    if (/^https?:\/\//i.test(dep)) target.apiUrl = stripTrailingSlash(dep);
    else target.deploymentId = dep;
  }
  // An explicit apiUrl param overrides / augments.
  const apiUrl = (params.get('apiUrl') || params.get('url') || '').trim();
  if (apiUrl && /^https?:\/\//i.test(apiUrl)) target.apiUrl = stripTrailingSlash(apiUrl);
  return target;
}

/** Build the canonical `vscode://…/open` deep link (used by the Console button + tests). */
export function buildOpenUri(
  target: OpenTarget,
  publisher = EXTENSION_ID,
): string {
  const params = new URLSearchParams();
  if (target.deploymentId) params.set('deployment', target.deploymentId);
  else if (target.apiUrl) params.set('deployment', stripTrailingSlash(target.apiUrl));
  params.set('type', target.itemType);
  params.set('id', target.itemId);
  return `vscode://${publisher}/open?${params.toString()}`;
}

/** Host of an apiUrl (for matching a link's apiUrl to a configured deployment). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

function normalizePath(path: string): string {
  const p = (path || '').trim();
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

function stripTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return end === url.length ? url : url.slice(0, end);
}
