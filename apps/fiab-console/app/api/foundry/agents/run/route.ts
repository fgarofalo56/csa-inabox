/**
 * AI Foundry Agents — playground run. Runs a question through a Foundry agent
 * (thread → message → run → poll) and returns the run STEPS so an operator can
 * see HOW the agent answered (tool calls / status) plus the final answer.
 *
 *   POST /api/foundry/agents/run
 *     body { agent: string, question: string }
 *     → { ok, data: { threadId, runId, status, answer, steps[], usage, lastError } }
 *
 * Real Foundry Agent Service REST (lib/azure/foundry-agent-client). Honest gate
 * (HTTP 501, code:'not_configured') when LOOM_FOUNDRY_PROJECT_ENDPOINT isn't set
 * — no mock steps. Mirrors app/api/data-agent/run-steps/route.ts.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { FoundryAgentError } from '@/lib/azure/foundry-agent-client';
import {
  runAgentInspectTiered,
  selectAgentTier,
  FoundryAgentNotConfiguredError,
  MafAgentDefinitionRequiredError,
} from '@/lib/azure/agent-runtime-tier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const agent = typeof body?.agent === 'string' ? body.agent.trim() : '';
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  // Agent definition passed from the editor — REQUIRED only when the MAF Gov
  // tier serves the run (no Foundry project to load the definition from). The
  // Foundry tier loads the agent by name from the project and ignores these.
  const instructions = typeof body?.instructions === 'string' ? body.instructions : undefined;
  const model = typeof body?.model === 'string' ? body.model : undefined;
  if (!agent) return NextResponse.json({ ok: false, error: 'agent (agent name) required' }, { status: 400 });
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });

  try {
    const { tier, inspection } = await runAgentInspectTiered({
      agentName: agent,
      question,
      userOid: session.claims.oid,
      instructions,
      model,
    });
    return NextResponse.json({ ok: true, tier, data: inspection });
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_FOUNDRY_PROJECT_ENDPOINT' },
        { status: 501 },
      );
    }
    if (e instanceof MafAgentDefinitionRequiredError) {
      return NextResponse.json(
        { ok: false, code: 'maf_needs_definition', error: e.message, tier: selectAgentTier().tier },
        { status: 400 },
      );
    }
    const status = e instanceof FoundryAgentError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
