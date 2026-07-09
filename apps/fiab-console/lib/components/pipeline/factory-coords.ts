/**
 * Client-safe helpers for threading the SELECTED Data Factory's coordinates
 * onto factory-scoped BFF calls.
 *
 * The pipeline editor's cross-sub `AzureResourcePicker` yields a
 * `{ id, name, subscriptionId, resourceGroup }` for the factory the operator
 * picked. To make the Factory Resources tree, the "Bind to an existing
 * pipeline" dropdown, and Create-&-bind all target THAT factory (instead of the
 * env-pinned deployment default), the client appends its coords as query params
 * to every `/api/adf/*` call and to the per-item `/bind` call. The server parses
 * them via `lib/azure/adf-factory-context.ts → factoryOverrideFromSearchParams`.
 *
 * When no factory is selected (`factory` is null/undefined) these helpers add
 * nothing, so the server falls back to the env default — the prior behaviour.
 */

/** The minimal selected-factory shape these helpers need (superset of AzureResourcePicker output). */
export interface SelectedFactoryCoords {
  /** ARM resource id (unused for routing; carried for the editor's own state). */
  id?: string;
  /** Factory NAME (Microsoft.DataFactory/factories/<name>). */
  name?: string;
  subscriptionId?: string;
  resourceGroup?: string;
}

/**
 * Build the factory query-param string (WITHOUT a leading `?` or `&`) for a
 * selected factory, or `''` when no factory (or no usable coords) is selected.
 */
export function factoryQueryString(factory?: SelectedFactoryCoords | null): string {
  if (!factory) return '';
  const p = new URLSearchParams();
  if (factory.subscriptionId) p.set('factorySubscriptionId', factory.subscriptionId);
  if (factory.resourceGroup) p.set('factoryResourceGroup', factory.resourceGroup);
  if (factory.name) p.set('factoryName', factory.name);
  return p.toString();
}

/**
 * Append the selected factory's coords to `url` as query params, preserving any
 * existing query string (e.g. `?name=foo`). Returns `url` unchanged when no
 * factory is selected. Kept as a plain string op (not `fetch`-coupled) so the
 * no-bare-client-fetch guard is unaffected — callers still route through
 * `clientFetch`/`fetch` as they do today.
 */
export function appendFactoryCoords(url: string, factory?: SelectedFactoryCoords | null): string {
  const qs = factoryQueryString(factory);
  if (!qs) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}
