/**
 * GET /api/help-copilot/sessions       — list this user's help sessions
 * GET /api/help-copilot/sessions?id=X  — fetch a specific session (must belong to user)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listHelpSessions, getHelpSession } from '@/lib/azure/help-copilot-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const userId = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const id = req.nextUrl.searchParams.get('id');

  try {
    if (id) {
      const s = await getHelpSession(id, userId);
      if (!s) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
      return NextResponse.json({ ok: true, session: s });
    }
    const sessions = await listHelpSessions(userId);
    return NextResponse.json({ ok: true, sessions });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
