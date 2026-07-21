/**
 * POST /api/items/aip-logic/[id]/eval   → run the attached eval suite
 *   → { ok, summary, rows, passed, passThreshold, minPassRate }
 *   → { ok:false, notDeployed, gate } (503) when no AOAI deployment exists
 * GET  /api/items/aip-logic/[id]/eval   → { ok, lastEval } (the last stored run)
 *
 * Runs the Spindle function's authored eval suite (Palantir AIP-Evals parity):
 * each typed test case is executed against the REAL block graph (live Azure
 * OpenAI + Synapse), graded 1–5 by an LLM judge, and summarised into avg-score
 * + pass-rate. The result is persisted to `state.lastEval` so the publish gate
 * and the editor's Evals panel read a consistent verdict. 100% Azure-native —
 * no Fabric. Also the engine that backs the evals-in-CI publish gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { runSpindleEvalSuite, normalizeEvalSuite } from '../_spindle-eval';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const ITEM_TYPE = 'aip-logic';

const NO_AOAI_GATE = {
  reason: 'Spindle evals run each case against the live Azure OpenAI deployment.',
  remediation: 'Open the AI Foundry hub → Quota + usage → deploy a model (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). No Fabric required.',
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the function first', 400, { code: 'no_id' });
  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return apiError('aip-logic function not found', 404, { code: 'not_found' });
  const state = (fn.state || {}) as Record<string, unknown>;
  return NextResponse.json({ ok: true, lastEval: state.lastEval ?? null, suiteSize: normalizeEvalSuite(state.evalSuite).length });
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the function before running evals', 400, { code: 'no_id' });
  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return apiError('aip-logic function not found', 404, { code: 'not_found' });
  const state = (fn.state || {}) as Record<string, unknown>;

  const cases = normalizeEvalSuite(state.evalSuite);
  if (cases.length === 0) {
    return apiError('No eval cases with criteria are attached. Add at least one eval case (inputs + criteria) to grade this function.', 409, { code: 'no_eval_cases' });
  }
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  if (blocks.length === 0) return apiError('add at least one block before running evals', 400, { code: 'no_blocks' });

  const result = await runSpindleEvalSuite(state, s.claims.oid);
  if (result.notDeployed) {
    return NextResponse.json({ ok: false, notDeployed: true, error: 'no Azure OpenAI deployment configured', gate: NO_AOAI_GATE, summary: result.summary, rows: result.rows }, { status: 503 });
  }

  // Persist the verdict so the publish gate + Evals panel stay consistent.
  const lastEval = {
    ranAt: result.ranAt, summary: result.summary, passed: result.passed,
    passThreshold: result.passThreshold, minPassRate: result.minPassRate,
    rows: result.rows.map((r) => ({ id: r.id, name: r.name, criteria: r.criteria, score: r.score, status: r.status, answer: String(r.answer || '').slice(0, 600), rationale: r.rationale, error: r.error })),
  };
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: { ...state, lastEval } });

  return NextResponse.json({ ok: true, ...lastEval });
}
