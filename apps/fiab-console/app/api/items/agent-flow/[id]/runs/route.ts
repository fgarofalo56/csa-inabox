/**
 * GET /api/items/agent-flow/[id]/runs   → the persisted run history (W9).
 *
 * Returns `item.state.runs[]` (newest first, up to 50). Owner-scoped via
 * loadOwnedItem (route-guard compliant, read-only role allowed).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, jerr } from '../../../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';
import type { AgentFlowState } from '@/lib/azure/agent-flow-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'agent-flow';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
    if (!item) return jerr('not found', 404);
    const state = (item.state || {}) as AgentFlowState;
    return NextResponse.json({ ok: true, runs: Array.isArray(state.runs) ? state.runs : [] });
  } catch (e: any) {
    return apiServerError(e);
  }
}
