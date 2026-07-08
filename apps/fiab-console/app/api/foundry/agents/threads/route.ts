/**
 * AI Foundry Agents — per-agent thread persistence (AIF-14).
 *
 *   GET    /api/foundry/agents/threads?agent=<name>              → list this
 *          user's persisted threads for the agent (newest first, capped).
 *   GET    /api/foundry/agents/threads?agent=<name>&threadId=<id> → one full
 *          transcript (for Resume — rehydrates the run inspector).
 *   DELETE /api/foundry/agents/threads?agent=<name>&threadId=<id> → delete one.
 *
 * Owner-scoped by the signed-in user's oid. Backed by the Cosmos
 * `loom-agent-memory` container — no Fabric/Power BI dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listThreads, getThread, deleteThread } from '@/lib/azure/agent-memory-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const userOid = session.claims.oid;

  const agent = (req.nextUrl.searchParams.get('agent') || '').trim();
  const threadId = (req.nextUrl.searchParams.get('threadId') || '').trim();
  if (!agent) return NextResponse.json({ ok: false, error: 'agent query param required' }, { status: 400 });

  try {
    if (threadId) {
      const thread = await getThread(agent, userOid, threadId);
      if (!thread) return NextResponse.json({ ok: false, error: 'thread not found' }, { status: 404 });
      return NextResponse.json({ ok: true, thread });
    }
    const threads = await listThreads(agent, userOid);
    // Trim the transcript payload in the LIST view; Resume fetches the full one.
    const summaries = threads.map((t) => ({
      threadId: t.threadId,
      runId: t.runId,
      status: t.status,
      tier: t.tier,
      question: t.question,
      answerPreview: (t.answer || '').slice(0, 160),
      createdAt: t.createdAt,
    }));
    return NextResponse.json({ ok: true, threads: summaries });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const userOid = session.claims.oid;

  const agent = (req.nextUrl.searchParams.get('agent') || '').trim();
  const threadId = (req.nextUrl.searchParams.get('threadId') || '').trim();
  if (!agent || !threadId) {
    return NextResponse.json({ ok: false, error: 'agent + threadId query params required' }, { status: 400 });
  }
  try {
    const deleted = await deleteThread(agent, userOid, threadId);
    if (!deleted) return NextResponse.json({ ok: false, error: 'thread not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
