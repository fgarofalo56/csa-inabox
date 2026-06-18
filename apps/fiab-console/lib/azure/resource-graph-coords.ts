/**
 * resource-graph-coords — self-healing discovery of a DLZ resource's REAL ARM
 * coordinates ({subscriptionId, resourceGroup}) BY NAME, via Azure Resource
 * Graph.
 *
 * WHY THIS EXISTS (systemic DLZ-attach bug)
 * -----------------------------------------
 * In the multi-sub `dlz-attach` topology, the console env resolves DLZ resource
 * coordinates to the ADMIN plane:
 *   - subscription: `LOOM_<ITEM>_SUB || LOOM_SUBSCRIPTION_ID` — but
 *     LOOM_SUBSCRIPTION_ID is the HUB/admin sub, while the resource lives in the
 *     DLZ sub.
 *   - resource group: `LOOM_<ITEM>_RG || LOOM_DLZ_RG` — likewise pointed at the
 *     admin plane.
 * The resulting ARM control-plane URL then 404s (resource not found at that
 * sub/rg) — or 403s when the identity can't read the wrong sub — and status
 * probes falsely report "Unknown"/error while lifecycle actions silently fail.
 *
 * THE FIX (generalized from PR #1445's Synapse-pool self-heal)
 * -----------------------------------------------------------
 * On a 404/403 (or a transport error), the caller discovers where the resource
 * ACTUALLY lives by name, via a single Azure Resource Graph query across every
 * subscription the Console identity can read, caches the result for the process,
 * and retries — so the operation reflects the resource's REAL ARM state.
 *
 * Cloud-invariant: the ARM host is derived from `armBase()` (never hardcoded),
 * so this works in Commercial / GCC / GCC-High / IL5 / DoD.
 *
 * ARG ref: POST {arm}/providers/Microsoft.ResourceGraph/resources
 *   https://learn.microsoft.com/rest/api/azureresourcegraph/resourcegraph/resources/resources
 */

import type { TokenCredential } from '@azure/identity';
import { loomServerCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { fetchWithTimeout } from './fetch-with-timeout';

const RESOURCE_GRAPH_API = '2022-10-01';

export interface ResourceCoords {
  subscriptionId: string;
  resourceGroup: string;
}

export interface DiscoverCoordsOptions {
  /** Full ARM resource type, e.g. 'Microsoft.Kusto/clusters' (case-insensitive match). */
  resourceType: string;
  /** Resource name to match (case-insensitive). */
  name: string;
  /** Optional ARM base override (defaults to the cloud-aware armBase()). */
  armBase?: string;
  /** Optional credential override (defaults to the shared loomServerCredential). */
  credential?: TokenCredential;
}

// Per-process cache keyed by `${resourceType}:${name}` (lower-cased). A null
// result is NOT cached — a transient failure shouldn't poison later retries.
const cache = new Map<string, ResourceCoords>();

function cacheKey(resourceType: string, name: string): string {
  return `${resourceType.toLowerCase()}:${name.toLowerCase()}`;
}

/**
 * Discover where an ARM resource ACTUALLY lives (subscription + resource group)
 * by name, via Azure Resource Graph, across every subscription the Console
 * identity can read. Returns the first hit or null.
 *
 * Used as a self-healing fallback when the env-configured ARM scope doesn't
 * resolve a DLZ resource (404/403) — so the operation reflects the real ARM
 * state instead of a false "Unknown".
 */
export async function discoverResourceCoordsByName(
  opts: DiscoverCoordsOptions,
): Promise<ResourceCoords | null> {
  const { resourceType, name } = opts;
  if (!resourceType || !name) return null;

  const key = cacheKey(resourceType, name);
  const cached = cache.get(key);
  if (cached) return cached;

  const base = (opts.armBase || armBase()).replace(/\/+$/, '');
  const credential = opts.credential || loomServerCredential;

  // Single-quote-escape for the KQL string literals.
  const typeLit = resourceType.replace(/'/g, "\\'");
  const nameLit = name.replace(/'/g, "\\'");
  const query = [
    'Resources',
    `| where type =~ '${typeLit}' and name =~ '${nameLit}'`,
    '| project subscriptionId, resourceGroup',
    '| limit 1',
  ].join('\n');

  try {
    const token = await credential.getToken(armScope());
    if (!token?.token) return null;
    const res = await fetchWithTimeout(
      `${base}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, options: { resultFormat: 'objectArray', $top: 1 } }),
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const row = Array.isArray(json?.data) ? json.data[0] : undefined;
    const subscriptionId = row?.subscriptionId ? String(row.subscriptionId) : '';
    const resourceGroup = row?.resourceGroup ? String(row.resourceGroup) : '';
    if (subscriptionId && resourceGroup) {
      const coords: ResourceCoords = { subscriptionId, resourceGroup };
      cache.set(key, coords);
      return coords;
    }
  } catch {
    /* fall through to null — caller surfaces the real ARM error */
  }
  return null;
}

/** Test-only: clear the per-process discovery cache. */
export function __clearResourceCoordsCache(): void {
  cache.clear();
}
