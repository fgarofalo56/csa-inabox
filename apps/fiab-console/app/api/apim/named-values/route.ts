/**
 * Named values in the deployment-default APIM service (the APIM navigator →
 * Named values group). Lists / creates / deletes named values (APIM
 * "properties") via the real ARM REST.
 *
 *   GET    /api/apim/named-values             → { ok, namedValues: [{name, displayName, secret, value?}] }
 *   POST   /api/apim/named-values             body { displayName, value, secret?, name? } → create
 *   DELETE /api/apim/named-values?id=NAME     → delete
 *
 * Secret values are encrypted at rest and never returned on GET. Honest 503
 * gate when the APIM service is unset. Real ARM REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  apimConfigGate, listNamedValues, upsertNamedValue, deleteNamedValue, ApimError,
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

// displayName for a named value must match ^[A-Za-z0-9-._]+$.
function nvId(s: string): string {
  return s.replace(/[^A-Za-z0-9-._]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 256) || `nv-${Date.now()}`;
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
    return NextResponse.json({ ok: true, namedValues: await listNamedValues() });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const displayName = body?.displayName ? String(body.displayName) : '';
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  if (body?.value === undefined || body?.value === null || String(body.value).trim() === '') {
    return NextResponse.json({ ok: false, error: 'value is required and may not be empty' }, { status: 400 });
  }
  const id = (body.id && String(body.id)) || nvId(displayName);
  try {
    const namedValue = await upsertNamedValue(id, {
      displayName: nvId(displayName),
      value: String(body.value),
      secret: !!body.secret,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
    });
    return NextResponse.json({ ok: true, namedValue });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    await deleteNamedValue(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
}
