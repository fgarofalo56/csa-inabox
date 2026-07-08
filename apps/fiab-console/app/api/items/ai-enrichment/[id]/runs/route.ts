/**
 * GET /api/items/ai-enrichment/[id]/runs → { ok, runs } — the persisted run
 * history (item.state.runs[], newest first). Owner-scoped via loadOwnedItem.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import type { EnrichmentRun } from '@/lib/azure/ai-enrichment-client';
import { loadOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ai-enrichment';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
  if (!item) return jerr('not found', 404);
  const runs: EnrichmentRun[] = Array.isArray(item.state?.runs) ? item.state.runs : [];
  return NextResponse.json({ ok: true, runs, config: item.state?.config ?? null });
}
