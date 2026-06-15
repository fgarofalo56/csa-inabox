/**
 * GET  /api/items/apim-api      — list all APIs in the APIM service
 * POST /api/items/apim-api      — create an API. Body: { id?, displayName, path, protocols?, subscriptionRequired?, serviceUrl?, format?, value? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listApis, upsertApi, apimConfigGate, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `api-${Date.now()}`;
}

/**
 * Honest config-gate. Returns a 503 with `code:'not_configured'` + the exact
 * missing env var so the pane's apimFetchJson helper renders a readable Fluent
 * MessageBar (naming the env var) instead of hard-crashing on a non-JSON body.
 */
function gate(): NextResponse | null {
  const g = apimConfigGate();
  if (!g) return null;
  return NextResponse.json({
    ok: false,
    code: 'not_configured',
    missing: g.missing,
    error: `API Management is not configured in this deployment (set ${g.missing}). Provision APIM (platform/fiab/bicep/modules/admin-plane/apim.bicep) and grant the Console UAMI "API Management Service Contributor".`,
  }, { status: 503 });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate();
  if (g) return g;
  try {
    const apis = await listApis();
    return NextResponse.json({ ok: true, apis });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  if (!body?.path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  const id = (body.id && String(body.id)) || slug(body.displayName);
  try {
    const api = await upsertApi(id, {
      displayName: String(body.displayName),
      path: String(body.path),
      protocols: Array.isArray(body.protocols) ? body.protocols : undefined,
      subscriptionRequired: body.subscriptionRequired,
      serviceUrl: body.serviceUrl,
      format: body.format,
      value: body.value,
    });
    return NextResponse.json({ ok: true, api });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
