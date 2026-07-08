/**
 * POST /api/items/data-agent/[id]/chat
 *
 * Real grounded test-chat for a Loom data agent. Loads the agent's persisted
 * config (instructions + typed sources + per-source grounding + few-shot
 * pairs) from Cosmos, composes a grounded system prompt, and runs one turn
 * against the LIVE AOAI deployment the cross-item Copilot resolves.
 *
 * Body: { question: string, history?: {role, content}[] }
 *
 * No AOAI deployment → 503 + remediation (deploy a model from the Foundry hub
 * "Quota + usage" tab). See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig, type ChatTurn } from '@/lib/azure/data-agent-client';
import { orchestrate, type SubAgentRuntime } from '@/lib/azure/agent-orchestrator';
import { normalizeSubAgents } from '@/lib/copilot/connected-agents';
import { emitCopilotUsage } from '@/lib/azure/copilot-orchestrator';
import { resolveAgentSourceLabels } from '@/lib/azure/dspm-ai-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

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
      // Typed per-source config (AI Search retrieval options / Graph scope) —
      // honored by the grounding executor.
      aiSearch: s.aiSearch && typeof s.aiSearch === 'object' ? s.aiSearch : undefined,
      graph: s.graph && typeof s.graph === 'object' ? s.graph : undefined,
    })),
  };
}

/** Build a grounded config from an operations-agent item (Eventhouse → kql source). */
function opsStateToConfig(state: Record<string, unknown>, name: string): DataAgentConfig {
  const eventhouse = typeof state.eventhouse === 'string' ? state.eventhouse : '';
  return {
    instructions: String(state.systemPrompt || state.instructions || ''),
    description: state.description ? String(state.description) : undefined,
    sources: eventhouse
      ? [{ id: eventhouse, type: 'kql', name: `${name} · Eventhouse` }]
      : [],
  };
}

/**
 * Resolve each connected sub-agent ref into a runnable SubAgentRuntime by
 * loading the referenced (owner-scoped) item and building its grounded config.
 * A ref whose item can't be loaded becomes an honest gate in the trace.
 */
async function resolveSubAgents(state: Record<string, unknown>, oid: string): Promise<SubAgentRuntime[]> {
  const refs = normalizeSubAgents(state.subAgents);
  if (refs.length === 0) return [];
  return Promise.all(refs.map(async (ref): Promise<SubAgentRuntime> => {
    try {
      const sub = await loadOwnedItem(ref.itemId, ref.itemType, oid);
      if (!sub) return { name: ref.name, role: ref.role, config: { instructions: '', sources: [] }, gate: `Connected agent "${ref.name}" not found or not owned by you.` };
      const subState = (sub.state || {}) as Record<string, unknown>;
      const config = ref.itemType === 'operations-agent'
        ? opsStateToConfig(subState, sub.displayName)
        : stateToConfig(subState);
      if (config.sources.length === 0 && !config.instructions.trim()) {
        return { name: ref.name, role: ref.role, config, gate: `Connected agent "${ref.name}" has no sources/instructions yet.` };
      }
      return { name: ref.name, role: ref.role, config };
    } catch {
      return { name: ref.name, role: ref.role, config: { instructions: '', sources: [] }, gate: `Connected agent "${ref.name}" could not be loaded.` };
    }
  }));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const question = String(body?.question || '').trim();
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });
  const history: ChatTurn[] = Array.isArray(body?.history)
    ? body.history.filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string').slice(-10)
    : [];

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return apiServerError(e, 'cosmos error');
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const itemState = (item.state || {}) as Record<string, unknown>;
  const cfg = stateToConfig(itemState);

  try {
    // AIF-4: when this agent has connected sub-agents, delegate through the
    // Azure-native Loom orchestrator (real grounded run per sub-agent + a
    // synthesis pass); otherwise run the single grounded turn as before.
    const subAgents = await resolveSubAgents(itemState, session.claims.oid);
    const answer = subAgents.length > 0
      ? await orchestrate(cfg, subAgents, history, question)
      : await chatGrounded(cfg, history, question);

    // Fire-and-forget DSPM-for-AI usage receipt: stamp the copilot.usage event
    // with the agent id + the sensitivity labels of the data this agent touched
    // so the admin "DSPM for AI" report can attribute sensitive-data access per
    // agent. Never blocks/breaks the response (telemetry is best-effort).
    if (answer.usage && (answer.usage.totalTokens || 0) > 0) {
      void (async () => {
        try {
          const { labels, maxLabel } = await resolveAgentSourceLabels(
            session.claims.oid,
            cfg.sources.map((src) => ({ id: src.id, name: src.name })),
          );
          await emitCopilotUsage(
            { ...answer.usage!, aoaiCalls: 1, toolCalls: answer.tools?.length || 0 },
            answer.model || 'data-agent',
            `data-agent:${id}`,
            session.claims.oid,
            'data-agent',
            {
              agentId: id,
              agentName: item!.displayName,
              sensitivityLabel: maxLabel || undefined,
              sensitivityLabels: labels,
              dataSources: answer.sourcesAvailable,
            },
          );
        } catch { /* telemetry must never affect the chat response */ }
      })();
    }

    return NextResponse.json({ ok: true, ...answer });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({
        ok: false,
        notDeployed: true,
        error: e.message,
        hint: 'Open the AI Foundry hub editor → "Quota + usage" tab → "Deploy gpt-4o-mini" (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). The data-agent test chat reuses the same AOAI deployment as cross-item Copilot.',
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
