/**
 * Functions-on-objects registry API (WS-4.2).
 *
 * GET    /api/ontology-functions          → { ok, functions: RegisteredFunction[] }  (tenant-scoped)
 * POST   /api/ontology-functions          body: RegisteredFunction  → { ok, function } (register/replace; tenant admin)
 * DELETE /api/ontology-functions?name=&version=  → { ok, deleted }   (tenant admin)
 *
 * The registry is the tenant-scoped store of versioned functions a `function`-kind
 * derived property and an ontology action's `validationFunction` resolve against
 * (Cosmos `function-registry` doc per tenant). Registering does NOT deploy code —
 * it points at a function already reachable on the Loom UDF runtime
 * (LOOM_UDF_FUNCTION_BASE) or a dedicated Azure Function App. Azure-native, no
 * Microsoft Fabric.
 *
 * AUTHZ: session + tenant scope via `tenantScopeId(session)`; mutations require a
 * tenant-admin tier (`isTenantAdminTier`). Reads are scoped to the caller's tenant.
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import { apiOk, apiError, apiUnauthorized, apiForbidden, apiServerError } from '@/lib/api/respond';
import {
  listRegisteredFunctions, registerFunction, deleteRegisteredFunction,
} from '@/lib/azure/function-registry-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  try {
    const functions = await listRegisteredFunctions(tenantScopeId(s));
    return apiOk({ functions });
  } catch (e) {
    return apiServerError(e, 'could not load the function registry');
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  if (!isTenantAdminTier(s)) return apiForbidden('registering a function requires a tenant-admin role');
  const body = await req.json().catch(() => ({}));
  try {
    const res = await registerFunction(tenantScopeId(s), s.claims.oid, body);
    if (!res.ok) return apiError(res.error, 400, { code: 'invalid_function' });
    return apiOk({ function: res.fn });
  } catch (e) {
    return apiServerError(e, 'could not register the function');
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  if (!isTenantAdminTier(s)) return apiForbidden('deleting a function requires a tenant-admin role');
  const name = String(req.nextUrl.searchParams.get('name') || '').trim();
  const version = String(req.nextUrl.searchParams.get('version') || '').trim();
  if (!name || !version) return apiError('name and version query params are required', 400, { code: 'bad_request' });
  try {
    const deleted = await deleteRegisteredFunction(tenantScopeId(s), name, version);
    return apiOk({ deleted });
  } catch (e) {
    return apiServerError(e, 'could not delete the function');
  }
}
