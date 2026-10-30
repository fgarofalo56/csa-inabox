/**
 * Shared route plumbing for /api/admin/api-gateway/environments/**: session +
 * tenant-admin gate (W1-8 later swaps in the apiplane-admin capability) and the
 * `{ ok, data, error }` envelope.
 */
import { NextResponse } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiError, apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { getEnvironmentDeps } from './deps';
import type { Actor, EnvironmentDeps, ServiceResult } from './service';

export interface AdminContext { tenantId: string; actor: Actor; deps: EnvironmentDeps }

export function adminContext(): AdminContext | NextResponse {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  return {
    tenantId: tenantScopeId(s),
    actor: { who: s.claims.upn || s.claims.email || s.claims.oid, oid: s.claims.oid, capability: 'tenant-admin' },
    deps: getEnvironmentDeps(),
  };
}

export const isResponse = (v: AdminContext | NextResponse): v is NextResponse => v instanceof NextResponse;

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
