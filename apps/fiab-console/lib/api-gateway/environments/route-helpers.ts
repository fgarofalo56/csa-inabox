/**
 * Shared route plumbing for /api/admin/api-gateway/environments/**: the audit actor
 * (the gate itself is withCapability('apiplane-admin') on each route, W1-8) and the
 * `{ ok, data, error }` envelope.
 */
import { tenantScopeId, type SessionPayload } from '@/lib/auth/session';
import { planeCapabilityUsed } from '@/lib/api-gateway/admin-gate';
import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import '@/lib/api-gateway/observe/register'; // findings source: gateways x MCP servers
import { getEnvironmentDeps } from './deps';
import type { Actor, EnvironmentDeps, ServiceResult } from './service';

export interface AdminContext { tenantId: string; actor: Actor; deps: EnvironmentDeps }

/** Context for a session that already passed withCapability('apiplane-admin'); records the capability used. */
export function adminContext(s: SessionPayload): AdminContext {
  return {
    tenantId: tenantScopeId(s),
    actor: { who: s.claims.upn || s.claims.email || s.claims.oid, oid: s.claims.oid, capability: planeCapabilityUsed(s) },
    deps: getEnvironmentDeps(),
  };
}

export function respond<T>(r: ServiceResult<T>) {
  return r.ok ? apiOk({ data: r.data }) : apiError(r.error, r.status, r.blocking ? { blocking: r.blocking.map((b) => ({ id: b.publication.id, displayName: b.publication.displayName, reason: b.reason })) } : undefined);
}

export function serverError(e: unknown) {
  return apiServerError(e, 'Could not reach the API Gateway Plane store. Cosmos DB is required; set LOOM_COSMOS_ENDPOINT and grant the Console UAMI "Cosmos DB Built-in Data Contributor".');
}

export async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
