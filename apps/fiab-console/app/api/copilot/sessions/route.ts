/** GET /api/copilot/sessions — list this user's Copilot sessions. */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSessions } from '@/lib/azure/copilot-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const userOid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  try {
    const sessions = await listSessions(userOid);
    return NextResponse.json({ ok: true, sessions });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
