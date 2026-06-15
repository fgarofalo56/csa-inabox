/**
 * GET /api/items/apim-policy?scope=<scope>   — read an APIM policy (XML).
 * PUT /api/items/apim-policy  { scope, value } — set an APIM policy (XML).
 *
 * `scope` is the apim-client PolicyScope: '' / 'service' = global, or
 * 'apis/<id>' / 'products/<id>' for API- / product-scoped policy.
 *
 * The APIM Policies tab (apim-policies-pane) fetched THIS path without an [id]
 * segment, but only `[id]/route.ts` existed — so the request 404'd and returned
 * an HTML error page, which crashed the pane with "Unexpected token '<'". This
 * is the missing non-[id] handler, backed by the real apim-client policy REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPolicy, upsertPolicy, apimConfigGate, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = apimConfigGate();
  if (g) {
    return NextResponse.json({
      ok: false,
      code: 'not_configured',
      missing: g.missing,
      error: `API Management is not configured in this deployment (missing ${g.missing}).`,
      gate: { reason: `Set ${g.missing} on the Console.`, remediation: 'Set LOOM_APIM_NAME + LOOM_APIM_RG + LOOM_SUBSCRIPTION_ID and grant the Console UAMI API Management Service Contributor.' },
    }, { status: 503 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate();
  if (g) return g;
  const scope = (req.nextUrl.searchParams.get('scope') || 'service').trim();
  try {
    const policy = await getPolicy(scope);
    // No policy at this scope yet → honest empty (the editor starts from a blank
    // <policies> document), not an error.
    return NextResponse.json({ ok: true, value: policy?.value || '', format: policy?.format || 'xml', scope });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    if (status === 404) return NextResponse.json({ ok: true, value: '', format: 'xml', scope });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate();
  if (g) return g;
  const body = await req.json().catch(() => ({} as any));
  const scope = (body?.scope || 'service').toString().trim();
  const value = typeof body?.value === 'string' ? body.value : '';
  if (!value.trim()) return NextResponse.json({ ok: false, error: 'policy value (XML) is required' }, { status: 400 });
  try {
    const policy = await upsertPolicy(scope, value);
    return NextResponse.json({ ok: true, value: policy.value, format: policy.format, scope });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
