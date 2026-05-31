/**
 * APIs in the deployment-default APIM service (the APIM navigator → APIs group).
 * Lists / creates / deletes APIs via the real ARM REST so the navigator can
 * render counts, ＋New (name + path + display name + optional OpenAPI link),
 * and inline delete.
 *
 *   GET    /api/apim/apis                 → { ok, apis: [{name, displayName, path, ...}] }
 *   POST   /api/apim/apis                 body { displayName, path, name?, specUrl?, serviceUrl? } → create
 *   DELETE /api/apim/apis?id=NAME         → delete
 *
 * Honest 503 gate when LOOM_SUBSCRIPTION_ID / the APIM service is unset. Real
 * ARM REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apimConfigGate, listApis, upsertApi, deleteApi, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = apimConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `APIM service not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `api-${Date.now()}`;
}

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    return NextResponse.json({ ok: true, apis: await listApis() });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  if (!body?.path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  const id = (body.id && String(body.id)) || slug(body.displayName);
  try {
    const api = await upsertApi(id, {
      displayName: String(body.displayName),
      path: String(body.path),
      serviceUrl: body.serviceUrl || undefined,
      subscriptionRequired: body.subscriptionRequired,
      // Optional OpenAPI import by link — APIM ingests operations from the spec.
      ...(body.specUrl ? { format: 'openapi-link', value: String(body.specUrl) } : {}),
    });
    return NextResponse.json({ ok: true, api });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    await deleteApi(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
}
