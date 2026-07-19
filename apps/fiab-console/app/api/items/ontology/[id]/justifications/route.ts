/**
 * Foundry-parity "checkpoints / justifications" review surface (row 4.7).
 *
 * GET /api/items/ontology/[id]/justifications?top=50
 *   → { ok, justifications: ActionJustification[] }  (newest first)
 *
 * Read-only list of the written reasons recorded when justification-gated
 * write-back actions ran on this ontology (see run-action/route.ts). Owner-scoped
 * via loadOwnedItem. Azure-native (Cosmos audit-log) — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { listActionJustifications } from '@/lib/azure/action-justification-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, justifications: [] });
  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return NextResponse.json({ ok: false, error: 'ontology not found' }, { status: 404 });
  const top = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get('top')) || 50));
  try {
    const justifications = await listActionJustifications(id, top);
    return NextResponse.json({ ok: true, justifications });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
