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

import { kqlEscapeSingle } from '@/lib/azure/kql-escape';
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
  const typeLit = kqlEscapeSingle(resourceType);
  const nameLit = kqlEscapeSingle(name);
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

/** A discovered resource: where it lives AND what it is called. */
export interface DiscoveredResource extends ResourceCoords {
  name: string;
}

// Per-process cache for by-TYPE discovery, keyed by the lower-cased type. Null
// is not cached, for the same reason as above.
const firstOfTypeCache = new Map<string, DiscoveredResource>();

/**
 * Discover the FIRST resource of a given ARM type anywhere the Console identity
 * can read, via Azure Resource Graph. The sibling of
 * {@link discoverResourceCoordsByName} for the case where we do not yet know a
 * name to look for.
 *
 * Why this exists (auto-bind-by-default §5, "Infra prerequisites are DEPLOYED,
 * not requested"): `adfConfigGate()` fails closed when `LOOM_ADF_NAME` is unset,
 * and the terminal user-facing state used to be "set LOOM_ADF_NAME". But bicep
 * (`platform/fiab/bicep/modules/landing-zone/adf.bicep`) DEPLOYS a factory in
 * every real estate — the value was simply never plumbed into the Console's env.
 * Asking the user for a value the deploy already produced is precisely the
 * violation the rule names. So instead of gating, we FIND it.
 *
 * Ordering is `name asc` so the choice is STABLE across calls and processes —
 * an unordered `limit 1` could hand two replicas different factories and bind
 * two Loom items to different estates. Determinism matters more than which
 * particular resource wins.
 *
 * Returns null when the identity can see none of that type (a genuine estate
 * gate the caller should surface as a Fix-it).
 */
export async function discoverFirstResourceOfType(opts: {
  resourceType: string;
  armBase?: string;
  credential?: TokenCredential;
}): Promise<DiscoveredResource | null> {
  const { resourceType } = opts;
  if (!resourceType) return null;

  const key = resourceType.toLowerCase();
  const cached = firstOfTypeCache.get(key);
  if (cached) return cached;

  const base = (opts.armBase || armBase()).replace(/\/+$/, '');
  const credential = opts.credential || loomServerCredential;
  const typeLit = kqlEscapeSingle(resourceType);
  const query = [
    'Resources',
    `| where type =~ '${typeLit}'`,
    '| project name, subscriptionId, resourceGroup',
    '| order by name asc',
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
    const name = row?.name ? String(row.name) : '';
    const subscriptionId = row?.subscriptionId ? String(row.subscriptionId) : '';
    const resourceGroup = row?.resourceGroup ? String(row.resourceGroup) : '';
    if (name && subscriptionId && resourceGroup) {
      const found: DiscoveredResource = { name, subscriptionId, resourceGroup };
      firstOfTypeCache.set(key, found);
      return found;
    }
  } catch {
    /* fall through to null — the caller surfaces the honest gate */
  }
  return null;
}

/** Test-only: clear the per-process discovery cache. */
export function __clearResourceCoordsCache(): void {
  firstOfTypeCache.clear();
  cache.clear();
}
