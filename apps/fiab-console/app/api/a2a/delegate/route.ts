/**
 * POST /api/a2a/delegate — OUTBOUND A2A: a Loom user delegates a task OUT to an
 * external A2A agent (WS-5.2, the outbound half; enables WS-9 Sovereign Mesh).
 *
 *   body: { origin: string, text: string, data?: object }
 *   → { ok, card: <external agent card>, result: <A2A Task|Message> }
 *
 * Every outbound fetch (card discovery + message/send) is gated by the gov-safe
 * egress profile (LOOM_A2A_EGRESS_ALLOW). With no profile set, delegation is
 * refused (the sovereign / air-gapped default — nothing leaves the boundary). The
 * delegation is audited (durable + SIEM). Session-guarded (cookie or PAT).
 * Azure-native egress; no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getApiSession, enforcePatAccess } from '@/lib/auth/api-session';
import { tenantScopeId } from '@/lib/auth/session';
import { delegateToExternalAgent } from '@/lib/copilot/a2a-client';
import { A2aEgressError } from '@/lib/azure/a2a-egress-guard';
import { auditA2aDelegation } from '@/lib/azure/a2a-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getApiSession(req);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const patBlock = enforcePatAccess(session, req.method || 'POST');
  if (patBlock) return patBlock;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const origin = String((body as { origin?: string }).origin || '').trim();
  const text = String((body as { text?: string }).text || '').trim();
  const data = ((body as { data?: unknown }).data && typeof (body as any).data === 'object')
    ? (body as { data: Record<string, unknown> }).data : undefined;
  if (!origin) return NextResponse.json({ ok: false, error: 'origin (the external agent base URL or card URL) is required' }, { status: 400 });
  if (!text && !data) return NextResponse.json({ ok: false, error: 'provide text and/or a data object to delegate' }, { status: 400 });

  const tenantId = tenantScopeId(session);
  const actorUpn = session.claims.upn || session.claims.email || session.claims.oid;
  try {
    const { card, result } = await delegateToExternalAgent({ origin, text, data });
    const taskId = (result as any)?.id || (result as any)?.taskId || 'a2a-remote';
    auditA2aDelegation({
      actorOid: session.claims.oid, actorUpn, tenantId, direction: 'outbound',
      method: 'message/send', taskId, outcome: 'success',
      detail: `delegated to ${card.name} @ ${card.url}`,
    });
    return NextResponse.json({ ok: true, card, result });
  } catch (e: any) {
    const isEgress = e instanceof A2aEgressError;
    auditA2aDelegation({
      actorOid: session.claims.oid, actorUpn, tenantId, direction: 'outbound',
      method: 'message/send', taskId: 'a2a-remote', outcome: 'failure',
      detail: e?.message || String(e),
    });
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: isEgress ? 'egress_blocked' : 'delegation_failed' },
      { status: isEgress ? 403 : 502 },
    );
  }
}
