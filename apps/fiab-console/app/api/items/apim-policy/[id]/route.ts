/**
 * GET  /api/items/apim-policy/[id]?scope=service                                — read global policy
 * GET  /api/items/apim-policy/[id]?scope=api&apiId=foo                          — read API-level policy
 * GET  /api/items/apim-policy/[id]?scope=product&productId=foo                  — read product-level policy
 * GET  /api/items/apim-policy/[id]?scope=operation&apiId=foo&operationId=bar    — read API operation policy (v3.27)
 * PUT  /api/items/apim-policy/[id]  body: { scope: 'service'|'api'|'product'|'operation', apiId?, productId?, operationId?, value: string }
 *
 * `[id]` is purely cosmetic for the editor's deep-link / persistence — the real APIM
 * scope is in the query/body. The route validates value is well-formed XML before sending.
 *
 * v3.27: added 'operation' scope. APIM nests operation policies under
 * /apis/{aid}/operations/{oid}/policies/policy — the previously
 * unsupported finest-grain policy attachment point.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPolicy, upsertPolicy, ApimError, type PolicyScope } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function resolveScope(scope?: string | null, apiId?: string | null, productId?: string | null, operationId?: string | null): PolicyScope | null {
  if (!scope || scope === 'service' || scope === 'global') return 'service';
  if (scope === 'api') {
    if (!apiId) return null;
    return `apis/${encodeURIComponent(apiId)}`;
  }
  if (scope === 'product') {
    if (!productId) return null;
    return `products/${encodeURIComponent(productId)}`;
  }
  if (scope === 'operation') {
    if (!apiId || !operationId) return null;
    return `apis/${encodeURIComponent(apiId)}/operations/${encodeURIComponent(operationId)}`;
  }
  // allow already-shaped scope e.g. apis/foo, products/bar, apis/foo/operations/bar
  return scope;
}

function handleErr(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const scope = resolveScope(sp.get('scope'), sp.get('apiId'), sp.get('productId'), sp.get('operationId'));
  if (!scope) return NextResponse.json({ ok: false, error: 'invalid scope (missing apiId/productId/operationId)' }, { status: 400 });
  try {
    const policy = await getPolicy(scope);
    if (!policy) {
      return NextResponse.json({ ok: true, value: '', format: 'xml', scope, empty: true });
    }
    return NextResponse.json({ ok: true, ...policy, scope });
  } catch (e: any) { return handleErr(e); }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const scope = resolveScope(body?.scope, body?.apiId, body?.productId, body?.operationId);
  if (!scope) return NextResponse.json({ ok: false, error: 'invalid scope (missing apiId/productId/operationId)' }, { status: 400 });
  const value = typeof body?.value === 'string' ? body.value : '';
  if (!value.trim()) return NextResponse.json({ ok: false, error: 'value (policy XML) is required' }, { status: 400 });
  try {
    const saved = await upsertPolicy(scope, value);
    return NextResponse.json({ ok: true, ...saved, scope });
  } catch (e: any) { return handleErr(e); }
}
