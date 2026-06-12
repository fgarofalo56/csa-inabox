/**
 * POST /api/items/aip-logic/[id]/run-agent
 *   body: { inputs: Record<string, unknown> }
 *   → { ok, status, answer, steps[], usage?, runId, threadId }
 *
 * Runs a PUBLISHED Spindle logic agent on Azure AI Foundry Agent Service and
 * inspects the run (thread → message → run → poll → steps). This is the
 * "Run + inspect steps" debugging view for a deployed Spindle agent. Requires
 * a prior /deploy (state.foundryAgentId).
 *
 *  - Foundry Agent Service unconfigured → 501 honest gate (it is unsupported in
 *    Azure Government; use the Azure-native Invoke path instead).
 *  - Not deployed yet → 400 directing to /deploy.
 *
 * Reuses LOOM_FOUNDRY_* — no new env vars, no bicep change.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  runAgentAndInspect,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
} from '@/lib/azure/foundry-agent-client';
import { loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'aip-logic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: false, error: 'save and deploy the function first' }, { status: 400 });
  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return NextResponse.json({ ok: false, error: 'aip-logic function not found' }, { status: 404 });

  const state = (fn.state || {}) as Record<string, unknown>;
  const agentName = String(state.foundryAgentId || '').trim();
  if (!agentName) {
    return NextResponse.json({ ok: false, error: 'this function is not deployed as a Foundry agent yet — deploy it first', code: 'not_deployed' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({} as any));
  const inputs = body?.inputs && typeof body.inputs === 'object' ? body.inputs : {};
  const question = `Inputs:\n${JSON.stringify(inputs, null, 2)}\n\nExecute the function and return only the typed output.`;

  try {
    const run = await runAgentAndInspect(agentName, question);
    return NextResponse.json({
      ok: run.status === 'completed',
      status: run.status,
      answer: run.answer,
      steps: run.steps,
      usage: run.usage,
      runId: run.runId,
      threadId: run.threadId,
      ...(run.lastError ? { error: run.lastError } : {}),
    });
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json({
        ok: false,
        deferred: true,
        error: e.message,
        hint: e.hint,
        gate: {
          reason: 'Foundry Agent Service is not configured (and is unsupported in Azure Government).',
          remediation: 'Set LOOM_FOUNDRY_PROJECT_ENDPOINT + LOOM_FOUNDRY_PROJECT_ID, or use the Azure-native Invoke path instead.',
        },
      }, { status: 501 });
    }
    if (e instanceof FoundryAgentError) {
      return NextResponse.json({ ok: false, error: e.message, status: e.status, body: e.body }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
