/**
 * Foundry-parity "approvals" review surface (row 4.6).
 *
 * GET  /api/items/ontology/[id]/approvals?top=50   → { ok, approvals }  (newest first)
 * POST /api/items/ontology/[id]/approvals
 *   body: { requestId, decision: 'approve'|'reject', note? }  → { ok, approval }
 *
 * Owner-scoped via loadOwnedItem. The owner is the approver here (Foundry allows
 * a configurable approver; the Loom v1 approver is the ontology owner/admin — a
 * separate-approver policy can layer on later). Azure-native (Cosmos) — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { listApprovals, decideApproval } from '@/lib/azure/action-approval-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, approvals: [] });
  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return NextResponse.json({ ok: false, error: 'ontology not found' }, { status: 404 });
  const top = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get('top')) || 50));
  try {
    const approvals = await listApprovals(id, top);
    return NextResponse.json({ ok: true, approvals });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: false, error: 'save the ontology first' }, { status: 400 });
  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return NextResponse.json({ ok: false, error: 'ontology not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { requestId?: string; decision?: string; note?: string };
  const requestId = String(body.requestId || '').trim();
  const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
  if (!requestId || !decision) return NextResponse.json({ ok: false, error: 'requestId and a valid decision (approve|reject) are required' }, { status: 400 });
  try {
    const updated = await decideApproval(requestId, id, s, decision, String(body.note || ''), new Date().toISOString());
    if (!updated) return NextResponse.json({ ok: false, error: 'approval request not found' }, { status: 404 });
    return NextResponse.json({ ok: true, approval: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
