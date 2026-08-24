/**
 * Conversation history for a Loom data agent (part of the chat-enrichment ask).
 *
 *   GET  /api/items/data-agent/[id]/conversations
 *        → { ok, conversations: [{ id, title, updatedAt, turns }] }  (this user's)
 *   POST /api/items/data-agent/[id]/conversations
 *        body { conversationId?, title?, messages: ChatMsg[] }
 *        → upsert; returns { ok, conversation }
 *   DELETE /api/items/data-agent/[id]/conversations?conversationId=...
 *
 * Persisted in the shared copilotSessions Cosmos container (partition /sessionId)
 * so the data-agent test chat survives reload and can be resumed — the same
 * store the Copilot uses. Scoped to the caller (userOid) + agent.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { copilotSessionsContainer } from '@/lib/azure/cosmos-client';
import { randomUUID } from 'node:crypto';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KIND = 'data-agent-conversation';
const sid = (agentId: string, convId: string) => `da:${agentId}:${convId}`;

// `withSession` has already established the session, so this takes a non-null
// `SessionPayload` — the `ReturnType<typeof getSession>` + `s!` pair the
// hand-rolled prologue needed is gone with it.
function userOf(s: SessionPayload): string {
  return (s.claims.oid || s.claims.upn || s.claims.email || 'unknown') as string;
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session: s, params }) => {
  const { id: agentId } = params;
  const userOid = userOf(s);
  // ?conversationId= → return the full conversation (messages) so the editor
  // can resume it. Ownership-checked.
  const convId = req.nextUrl.searchParams.get('conversationId');
  if (convId) {
    try {
      const c = await copilotSessionsContainer();
      const { resource } = await c.item(convId, sid(agentId, convId)).read<any>();
      if (!resource) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      // POSITIVE ownership match (#3943): an absent `userOid` is refused, not
      // short-circuited into a pass. The list query below already requires
      // `c.userOid = @u`, so an ownerless conversation was never listable.
      if (!resource.userOid || resource.userOid !== userOid) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
      return NextResponse.json({ ok: true, conversation: { id: resource.id, title: resource.title, messages: resource.messages, updatedAt: resource.updatedAt } });
    } catch (e: any) {
      if (e?.code === 404) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }
  try {
    const c = await copilotSessionsContainer();
    const { resources } = await c.items.query<any>({
      query: 'SELECT c.id, c.title, c.updatedAt, c.createdAt, ARRAY_LENGTH(c.messages) AS turns FROM c WHERE c.kind = @k AND c.agentId = @a AND c.userOid = @u ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@k', value: KIND }, { name: '@a', value: agentId }, { name: '@u', value: userOid }],
    }).fetchAll();
    return NextResponse.json({ ok: true, conversations: resources });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session: s, params }) => {
  const { id: agentId } = params;
  const userOid = userOf(s);
  const body = await req.json().catch(() => ({} as any));
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return NextResponse.json({ ok: false, error: 'messages required' }, { status: 400 });
  const convId: string = (typeof body?.conversationId === 'string' && body.conversationId) || randomUUID();
  const now = new Date().toISOString();
  const firstUser = messages.find((m: any) => m.role === 'user');
  const title = (body?.title || firstUser?.content || 'Conversation').toString().slice(0, 80);
  const doc = {
    id: convId,
    sessionId: sid(agentId, convId),
    kind: KIND,
    userOid,
    agentId,
    title,
    messages,
    createdAt: body?.createdAt || now,
    updatedAt: now,
  };
  try {
    const c = await copilotSessionsContainer();
    const { resource } = await c.items.upsert(doc);
    return NextResponse.json({ ok: true, conversation: { id: convId, title, updatedAt: now, turns: messages.length }, raw: resource ? undefined : undefined });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const DELETE = withSession<{ id: string }>(async (req: NextRequest, { session: s, params }) => {
  const { id: agentId } = params;
  const convId = req.nextUrl.searchParams.get('conversationId');
  if (!convId) return NextResponse.json({ ok: false, error: 'conversationId required' }, { status: 400 });
  try {
    const c = await copilotSessionsContainer();
    // Verify ownership before delete (partition key = sessionId). POSITIVE match
    // (#3943): an existing doc with no `userOid` is refused, not deleted by
    // whoever asks. A MISSING doc stays idempotent — the delete below 404s and
    // the catch returns { ok: true }, which is the pre-existing contract.
    const { resource } = await c.item(convId, sid(agentId, convId)).read<any>();
    if (resource && (!resource.userOid || resource.userOid !== userOf(s))) {
      return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    await c.item(convId, sid(agentId, convId)).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
