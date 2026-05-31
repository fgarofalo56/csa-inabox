/**
 * Backends in the deployment-default APIM service (the APIM navigator →
 * Backends group). Lists / creates / deletes backends via the real ARM REST.
 *
 *   GET    /api/apim/backends             → { ok, backends: [{name, url, protocol, title?}] }
 *   POST   /api/apim/backends             body { name, url, protocol?, title?, description? } → create
 *   DELETE /api/apim/backends?id=NAME     → delete
 *
 * url is required; protocol defaults to 'http'. Honest 503 gate when the APIM
 * service is unset. Real ARM REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  apimConfigGate, listBackends, upsertBackend, deleteBackend, ApimError,
} from '@/lib/azure/apim-client';

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
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `backend-${Date.now()}`;
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
    return NextResponse.json({ ok: true, backends: await listBackends() });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const url = body?.url ? String(body.url) : '';
  if (!url) return NextResponse.json({ ok: false, error: 'url is required' }, { status: 400 });
  const protocol = body?.protocol === 'soap' ? 'soap' : 'http';
  const id = (body.name && slug(String(body.name))) || slug(url);
  try {
    const backend = await upsertBackend(id, {
      url,
      protocol,
      title: body.title || undefined,
      description: body.description || undefined,
    });
    return NextResponse.json({ ok: true, backend });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    await deleteBackend(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
}
