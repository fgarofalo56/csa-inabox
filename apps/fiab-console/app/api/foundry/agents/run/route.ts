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
import {
  runAgentAndInspect,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
} from '@/lib/azure/foundry-agent-client';

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
  if (!agent) return NextResponse.json({ ok: false, error: 'agent (agent name) required' }, { status: 400 });
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });

  try {
    const data = await runAgentAndInspect(agent, question);
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_FOUNDRY_PROJECT_ENDPOINT' },
        { status: 501 },
      );
    }
    const status = e instanceof FoundryAgentError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
