/**
 * Data Agent → Run-steps inspector.
 *
 * Default (works out of the box, no Microsoft Fabric / published Foundry agent
 * required, per .claude/rules/no-fabric-dependency.md): runs the question
 * through the Azure-native grounded chat (the same AOAI deployment as
 * cross-item Copilot) over the agent's persisted sources, and returns a single
 * synthesized run step (the grounded answer + the query the agent would run).
 *
 * Upgrade path: when the data agent has been PUBLISHED to a Foundry project as
 * a real assistant (asst_…), the inspector instead runs the published agent
 * (thread → message → run → poll) and returns the real per-tool run STEPS so an
 * operator can debug HOW it answered.
 *
 *   POST /api/data-agent/run-steps
 *     body { question: string, id?: string (data-agent item), agent?: string,
 *            workspaceId?: string }
 *     → { ok, data: { threadId, runId, status, answer, steps[], usage, lastError, backend } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  runAgentAndInspect,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
} from '@/lib/azure/foundry-agent-client';
import { resolveWorkspaceFoundry } from '@/lib/azure/copilot-config-store';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig } from '@/lib/azure/data-agent-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function stateToConfig(state: Record<string, unknown>): DataAgentConfig {
  const sources = Array.isArray(state.sources) ? (state.sources as any[]) : [];
  return {
    instructions: String(state.instructions || state.systemPrompt || ''),
    description: state.description ? String(state.description) : undefined,
    sources: sources.map((s) => ({
      id: String(s.id || s.name || ''),
      type: s.type,
      name: String(s.name || ''),
      tables: s.tables ? String(s.tables) : undefined,
      description: s.description ? String(s.description) : undefined,
      instructions: s.instructions ? String(s.instructions) : undefined,
      examples: Array.isArray(s.examples) ? s.examples : undefined,
    })),
  };
}

/** Run the Azure-native grounded chat and present it as a single run step. */
async function groundedFallback(itemId: string, question: string, userOid: string, note: string) {
  let item: WorkspaceItem | null = null;
  try { item = await loadOwnedItem(itemId, 'data-agent', userOid); } catch { /* fall through */ }
  if (!item) {
    return NextResponse.json({ ok: false, error: 'data-agent item not found (pass the item id to run the Azure-native grounded inspector).' }, { status: 404 });
  }
  const cfg = stateToConfig((item.state || {}) as Record<string, unknown>);
  try {
    const ans = await chatGrounded(cfg, [], question);
    const steps = [
      {
        id: 'grounded-1',
        type: 'message_creation',
        status: 'completed',
        title: ans.sourceUsed ? `Grounded answer (source: ${ans.sourceUsed})` : 'Grounded answer',
        detail: ans.query ? `Query the agent would run:\n${ans.query}` : 'Answered from attached sources.',
      },
    ];
    return NextResponse.json({
      ok: true,
      data: {
        threadId: null,
        runId: null,
        status: 'completed',
        answer: ans.answer,
        steps,
        usage: null,
        lastError: null,
        backend: 'azure-native-grounded',
        note,
      },
    });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: e.message, hint: 'Deploy a model from the AI Foundry hub ("Quota + usage" → Deploy gpt-4o-mini), or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT. No Microsoft Fabric required.', missing: 'LOOM_AOAI_DEPLOYMENT' },
        { status: 501 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const itemId = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });

  // Resolve the workspace's Foundry project (workspace cfg → tenant default →
  // env) and its preferred published agent, if any.
  const wf = workspaceId
    ? await resolveWorkspaceFoundry(workspaceId, session.claims.oid).catch(() => ({ defaultAgent: undefined as string | undefined }))
    : { defaultAgent: undefined as string | undefined };
  const agent = (typeof body?.agent === 'string' && body.agent.trim()) || (wf as any).defaultAgent || '';

  // Try the PUBLISHED Foundry path only when we have an agent name to resolve.
  if (agent) {
    try {
      const override = workspaceId
        ? { projectEndpoint: (wf as any).projectEndpoint, projectId: (wf as any).projectId }
        : undefined;
      const data = await runAgentAndInspect(agent, question, { override });
      return NextResponse.json({ ok: true, data: { ...data, backend: 'foundry-published' } });
    } catch (e: any) {
      // Not configured OR not published (no asst_ id) → fall back to the
      // Azure-native grounded inspector when we have the item id. This is why
      // a brand-new data agent "just works" before anyone publishes it.
      const notPublished = e instanceof FoundryAgentNotConfiguredError || (e instanceof FoundryAgentError && e.status === 404);
      if (notPublished && itemId) {
        return groundedFallback(itemId, question, session.claims.oid,
          'Ran on the Azure-native grounded backend (this data agent is not published to a Foundry project). Publish it to Foundry to inspect real per-tool run steps.');
      }
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

  // No published-agent name → Azure-native grounded inspector (the default).
  if (!itemId) {
    return NextResponse.json({ ok: false, error: 'Provide the data-agent item id (id) to run the grounded inspector, or a published Foundry agent name.' }, { status: 400 });
  }
  return groundedFallback(itemId, question, session.claims.oid, 'Ran on the Azure-native grounded backend (default — no published Foundry agent).');
}
