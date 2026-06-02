/**
 * Data Agent → Run-steps inspector. Runs a question through a PUBLISHED Foundry
 * agent (thread → message → run → poll) and returns the run STEPS so an operator
 * can debug HOW the agent answered (which tools / queries it executed).
 *
 *   POST /api/data-agent/run-steps
 *     body { agent: string, question: string }
 *     → { ok, data: { threadId, runId, status, answer, steps[], usage, lastError } }
 *
 * Real Foundry Agent Service REST (lib/azure/foundry-agent-client). Honest gate
 * (HTTP 501) when LOOM_FOUNDRY_PROJECT_ENDPOINT isn't configured — no mock steps.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  runAgentAndInspect,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
} from '@/lib/azure/foundry-agent-client';
import { resolveWorkspaceFoundry } from '@/lib/azure/copilot-config-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });

  try {
    // Resolve the workspace's Foundry project (workspace cfg → tenant default →
    // env) and its preferred agent. A workspace can target its own Foundry.
    const wf = workspaceId ? await resolveWorkspaceFoundry(workspaceId, session.claims.oid) : { defaultAgent: undefined as string | undefined };
    const agent = (typeof body?.agent === 'string' && body.agent.trim()) || wf.defaultAgent || '';
    if (!agent) return NextResponse.json({ ok: false, error: 'agent (published Foundry agent name) required' }, { status: 400 });
    const override = workspaceId
      ? { projectEndpoint: (wf as any).projectEndpoint, projectId: (wf as any).projectId }
      : undefined;
    const data = await runAgentAndInspect(agent, question, { override });
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
