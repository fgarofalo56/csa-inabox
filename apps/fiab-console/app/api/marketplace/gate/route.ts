/**
 * GET /api/marketplace/gate — is Azure API Management provisioned for this
 * deployment? Returns the shared apimGate() result so the API Management admin
 * page + marketplace can render the right state (configured vs honest infra-gate)
 * WITHOUT hanging.
 *
 * Why this route exists: the admin page used to fetch `/api/marketplace/_gate`,
 * but `_gate.ts` is a private helper module (underscore-prefixed) — not a route —
 * so that request 404'd and the page spun forever. This is the real endpoint.
 * It never calls a slow backend (pure env read), so it returns instantly.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apimGate } from '../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...apimGate() });
  } catch (e: any) {
    // Never hang the caller — surface an honest not-configured state on any error.
    return NextResponse.json({ ok: false, configured: false, error: e?.message || String(e) });
  }
}
