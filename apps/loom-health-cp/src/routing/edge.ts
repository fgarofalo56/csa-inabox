// Reference model of the edge decision implemented by the APIM policy fragment
// platform/fiab/bicep/modules/health/policies/lhds-tenant-routing.fragment.xml.
// The fragment is XML and cannot run under vitest; this model pins the decision
// table, and routing-edge.test.ts pins the fragment to it (status codes, claim
// name, slug pattern, cache TTLs) so the two cannot drift silently. It does NOT
// prove the deployed gateway behaves this way: that needs an edge probe.

import { SLUG } from '../registry/types.js';
import { PAUSED_RETRY_AFTER_SECONDS, ROUTING_CACHE_TTL_SECONDS } from './publisher.js';
import type { RoutingMapDoc } from './types.js';

export const QUOTA_WINDOW_SECONDS = 60;
/** Seconds the edge asks a client to wait when the routing map cannot be read at all. */
export const MAP_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

export interface EdgeRequest {
  /** Original request path, e.g. /acme/fhir/Patient/1. */
  path: string;
  /** Value of the verified token's `tenant` claim values; undefined when the claim is absent. */
  tokenTenant: readonly string[] | undefined;
  /** Requests this tenant has already made in the current window. */
  usedInWindow: number;
  /** Seconds until the current quota window resets. */
  windowResetsInSeconds: number;
}

export interface EdgeDecision {
  status: 200 | 403 | 404 | 429 | 503;
  /** Stamp to forward to (status 200 only). */
  stampBaseUrl?: string;
  retryAfterSeconds?: number;
  code?: string;
}

export function tenantFromPath(path: string): string {
  const segs = path.split('/');
  return segs.length > 1 ? (segs[1] ?? '') : '';
}

export function decideEdge(map: RoutingMapDoc | undefined, req: EdgeRequest): EdgeDecision {
  const tenant = tenantFromPath(req.path);
  if (!SLUG.test(tenant)) return { status: 404, code: 'not_found' };
  // Exactly one tenant claim, equal to the URL tenant. Checked BEFORE the map so a
  // mismatch never reveals whether the URL tenant exists.
  if (!req.tokenTenant || req.tokenTenant.length !== 1 || req.tokenTenant[0] !== tenant) {
    return { status: 403, code: 'tenant_mismatch' };
  }
  if (!map) return { status: 503, code: 'routing_map_unavailable', retryAfterSeconds: MAP_UNAVAILABLE_RETRY_AFTER_SECONDS };
  const entry = map.entries.find((e) => e.tenantSlug === tenant);
  if (!entry) return { status: 404, code: 'not_found' };
  if (entry.status !== 'active') {
    return {
      status: 503,
      code: `tenant_${entry.status}`,
      retryAfterSeconds: entry.retryAfterSeconds ?? PAUSED_RETRY_AFTER_SECONDS,
    };
  }
  // calls = quota: the quota-th request in a window passes, the next is refused.
  if (req.usedInWindow >= entry.maxRequestsPerMinute) {
    return { status: 429, code: 'quota_exceeded', retryAfterSeconds: Math.max(1, req.windowResetsInSeconds) };
  }
  return { status: 200, stampBaseUrl: entry.stampBaseUrl };
}

export { ROUTING_CACHE_TTL_SECONDS };
