/**
 * POST /api/foundry/assistants/run — add a message, run the assistant, return its reply.
 *   body: { assistantId, threadId, message, account?, rg? }
 * AOAI Assistants (v2): POST messages → POST runs → poll → list messages
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runAssistantTurn, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromBody } from '../../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const assistantId = String(body?.assistantId || '').trim();
    const threadId = String(body?.threadId || '').trim();
    const message = String(body?.message || '').trim();
    if (!assistantId || !threadId) return NextResponse.json({ ok: false, error: 'assistantId and threadId required' }, { status: 400 });
    if (!message) return NextResponse.json({ ok: false, error: 'message required' }, { status: 400 });
    const { reply, status } = await runAssistantTurn({ assistantId, threadId }, message, selectorFromBody(body));
    return NextResponse.json({ ok: true, reply, status });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
