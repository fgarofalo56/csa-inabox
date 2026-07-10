/**
 * GET/POST /api/onelake/resolve
 *
 * Thin BFF proxy to the Loom OneLake namespace service (apps/loom-onelake,
 * LOOM_ONELAKE_URL): resolve a logical
 *   loom://<tenant>/<workspace>/<item>/<path>
 * address to the REAL physical ADLS Gen2 pointer (abfss + SAS-less
 * managed-identity passthrough auth) every Loom engine already speaks.
 *
 *   GET  /api/onelake/resolve?uri=loom://acme/ws/sales.lakehouse/Tables/orders
 *   POST /api/onelake/resolve   { "uri": "loom://..." }
 *
 * Honest gate (no-vaporware.md): when LOOM_ONELAKE_URL is unset the route
 * returns 503 { ok:false, code:'not_configured' } naming the env var + the
 * bicep module — the console falls back to the per-item in-process library path
 * (lakehouse-abfss.ts) silently. No Microsoft Fabric dependency: the service
 * resolves onto the customer's own DLZ ADLS Gen2, never a Fabric OneLake host.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiBadRequest, apiServerError } from '@/lib/api/respond';
import { resolveLoomUri, OneLakeServiceError } from '@/lib/azure/loom-onelake-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(uri: string) {
  if (!uri) return apiBadRequest('uri required (loom://<tenant>/<workspace>/<item>/<path>)');
  try {
    const resolved = await resolveLoomUri(uri);
    return apiOk({ resolved });
  } catch (e) {
    if (e instanceof OneLakeServiceError) {
      // Honest, user-actionable gate/upstream message — pass through verbatim
      // with the upstream status (503 not-configured / 400 invalid / 502 up).
      return apiError(e.message, e.status, e.code ? { code: e.code } : undefined);
    }
    return apiServerError(e, 'onelake resolve failed');
  }
}

export async function GET(req: NextRequest) {
  if (!getSession()) return apiUnauthorized();
  return handle(req.nextUrl.searchParams.get('uri') || '');
}

export async function POST(req: NextRequest) {
  if (!getSession()) return apiUnauthorized();
  const body = await req.json().catch(() => ({}));
  return handle(typeof body?.uri === 'string' ? body.uri : '');
}
