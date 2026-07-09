/**
 * ML-model PREDICT — run-history list (FGC-18 "run history persisted").
 *
 *   GET /api/items/ml-model/[id]/predict/history
 *     → { ok, runs: PredictHistoryEntry[] }   // newest submission first
 *
 * Reads the batch-scoring run history persisted on the bound model item
 * (`state.predictHistory`, written by the predict POST + status routes). Owner-
 * scoped via resolveModelBinding(session.claims.oid) — a signed-in caller only
 * ever sees their own item's runs. No mocks; an item with no runs returns [].
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveModelBinding, modelBindingErrorResponse, ML_MODEL_ITEM_TYPE,
} from '@/lib/azure/model-binding';
import { sortHistory } from '@/lib/azure/predict-history';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;

  let binding;
  try {
    binding = await resolveModelBinding(id, ML_MODEL_ITEM_TYPE, session.claims.oid);
  } catch (e) {
    const { status, body } = modelBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }

  const state = (binding.item.state as any) || {};
  const runs = sortHistory(state.predictHistory);
  return NextResponse.json({ ok: true, runs });
}
