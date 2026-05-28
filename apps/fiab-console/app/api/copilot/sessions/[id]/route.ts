/** GET /api/copilot/sessions/[id] — session detail + step history. */
import { NextResponse } from 'next/server';
import { getSession as getAuthSession } from '@/lib/auth/session';
import { getSession as getCopilotSession } from '@/lib/azure/copilot-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = getAuthSession();
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const id = (await ctx.params).id;
  try {
    const doc = await getCopilotSession(id);
    if (!doc) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const userOid = auth.claims.oid || auth.claims.upn || auth.claims.email || 'unknown';
    if (doc.userOid && doc.userOid !== userOid) {
      return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: true, session: doc });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
