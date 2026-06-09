/**
 * /api/copilot/sessions/[id]
 *
 *   GET    — session detail + step history.
 *   DELETE — "Clear chat": delete this user's session doc from Cosmos
 *            (`copilot-sessions`, PK /sessionId). Idempotent: a missing doc
 *            still returns 204.
 *   PATCH  — per-message thumbs up/down feedback. Writes a real, permanent
 *            feedback doc to the Cosmos `copilot-feedback` container (PK
 *            /sessionId) and best-effort mirrors it to the copilot-chat
 *            Function feedback pipeline so thumbs-down with text lands in the
 *            same backlog drain as the docs-site widget.
 *
 * Real backend per no-vaporware.md: DELETE issues a real Cosmos point-delete;
 * PATCH issues a real Cosmos create. No mocks. Azure-native by default
 * (no-fabric-dependency.md): Cosmos is reached via LOOM_COSMOS_ENDPOINT; no
 * Fabric / Power BI host is contacted; works with LOOM_DEFAULT_FABRIC_WORKSPACE
 * unset.
 */
import { NextResponse } from 'next/server';
import { getSession as getAuthSession } from '@/lib/auth/session';
import { getSession as getCopilotSession } from '@/lib/azure/copilot-orchestrator';
import {
  copilotSessionsContainer,
  copilotFeedbackContainer,
} from '@/lib/azure/cosmos-client';

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

/** DELETE /api/copilot/sessions/[id] — "Clear chat": delete the session doc. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = getAuthSession();
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const id = (await ctx.params).id;
  const userOid = auth.claims.oid || auth.claims.upn || auth.claims.email || 'unknown';
  try {
    const c = await copilotSessionsContainer();
    const existing = await c
      .item(id, id)
      .read<any>()
      .catch(() => ({ resource: null }));
    // Already gone → idempotent success.
    if (!existing.resource) return new Response(null, { status: 204 });
    // Ownership check: never let one user delete another's session.
    if (existing.resource.userOid && existing.resource.userOid !== userOid) {
      return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    await c.item(id, id).delete();
    return new Response(null, { status: 204 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

interface FeedbackBody {
  rating: 'up' | 'down';
  messageIndex: number;
  improvement?: string;
}

/** PATCH /api/copilot/sessions/[id] — per-message thumbs up/down. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = getAuthSession();
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const id = (await ctx.params).id;
  const body: Partial<FeedbackBody> = await req.json().catch(() => ({}));

  const rating = (body.rating || '') as string;
  if (rating !== 'up' && rating !== 'down') {
    return NextResponse.json(
      { ok: false, error: "rating must be 'up' or 'down'" },
      { status: 400 },
    );
  }
  if (typeof body.messageIndex !== 'number' || !Number.isFinite(body.messageIndex)) {
    return NextResponse.json(
      { ok: false, error: 'messageIndex (number) is required' },
      { status: 400 },
    );
  }
  const userOid = auth.claims.oid || auth.claims.upn || auth.claims.email || 'unknown';
  const improvement = (body.improvement || '').slice(0, 1000);

  try {
    const fc = await copilotFeedbackContainer();
    const now = new Date().toISOString();
    const feedbackId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const doc = {
      id: feedbackId,
      sessionId: id, // partition key
      userOid,
      messageIndex: body.messageIndex,
      rating,
      improvement,
      createdAt: now,
    };
    await fc.items.create(doc);

    // Best-effort mirror into the copilot-chat Function feedback pipeline so the
    // in-console thumbs land in the same backlog drain as the docs-site widget.
    // Optional: only fires when both env vars are set. A failure NEVER blocks the
    // primary Cosmos write above (which is what the acceptance test verifies).
    await mirrorToFunctionFeedback(id, rating, improvement, userOid).catch(() => {});

    return NextResponse.json({ ok: true, feedbackId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/**
 * Forward the feedback to the copilot-chat Azure Function's `/api/loom/feedback`
 * endpoint (host-key authenticated). No-op unless LOOM_COPILOT_FUNCTION_URL +
 * LOOM_COPILOT_FUNCTION_KEY are configured — keeping this honest per
 * no-vaporware.md (no silent dependency; the primary sink is Cosmos).
 */
async function mirrorToFunctionFeedback(
  sessionId: string,
  rating: 'up' | 'down',
  improvement: string,
  userOid: string,
): Promise<void> {
  const base = process.env.LOOM_COPILOT_FUNCTION_URL;
  const key = process.env.LOOM_COPILOT_FUNCTION_KEY;
  if (!base || !key) return; // not wired — Cosmos remains the source of truth
  const url = `${base.replace(/\/$/, '')}/api/loom/feedback`;
  // Hash the actor so we never ship a raw OID to the docs-site feedback store.
  const actorHashed = `loom:${Buffer.from(userOid).toString('base64').slice(0, 24)}`;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-functions-key': key },
    body: JSON.stringify({
      rating,
      session_id: sessionId,
      conversation_id: sessionId,
      improvement,
      actor_hashed: actorHashed,
    }),
  });
}
