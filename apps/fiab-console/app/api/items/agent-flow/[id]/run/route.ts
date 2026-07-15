/**
 * POST /api/items/agent-flow/[id]/run   body { question: string, history?: {role,content}[] }
 *
 * Run the persisted FlowDag (W9) through the Azure-native connected-agents
 * runtime — the same grounded orchestration the AgentFlowCanvas test-run uses,
 * now owner-scoped to a standalone `agent-flow` item:
 *
 *   • The flow's item-bound data-tool nodes (lakehouse / warehouse / KQL /
 *     AI Search) become REAL grounded sources → the AOAI orchestrator queries
 *     them (chatGrounded).
 *   • The flow's connected sub-agent nodes (AIF-4) are each run grounded and
 *     folded into a synthesis pass (orchestrate).
 *   • The flow's capability tools (MCP / OpenAPI / function / …) are serialized
 *     into the runnable Foundry/MAF tool definitions and surfaced on the receipt.
 *
 * Honest gate: no Azure OpenAI deployment configured → 503 + remediation
 * (deploy a model or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). No
 * Microsoft Fabric / Foundry required on the default path (no-fabric-dependency).
 *
 * The response carries `{ answer, tools, run }` so BOTH the canvas run pane
 * (reads answer/hint/tools) and the Runs tab (reads run) work off one call.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { chatGrounded, NoAoaiDeploymentError, type ChatTurn } from '@/lib/azure/data-agent-client';
import { orchestrate, type SubAgentRuntime } from '@/lib/azure/agent-orchestrator';
import { normalizeSubAgents } from '@/lib/copilot/connected-agents';
import { enrichSemanticModelSources } from '../../../semantic-model/_lib/prep-for-ai-store';
import {
  flowStateToConfig, flowFoundryTools, flowGroundedSources, flowTools,
  flowCapabilityToolCount, appendFlowRun, type AgentFlowRun, type AgentFlowState,
} from '@/lib/azure/agent-flow-run';
import { loadOwnedItem, updateOwnedItem, jerr } from '../../../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'agent-flow';
const AOAI_GATE_HINT =
  'Open the AI Foundry hub editor → "Quota + usage" → deploy gpt-4o-mini, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT and grant the Console UAMI "Cognitive Services OpenAI User". The agent-flow run reuses the same Azure OpenAI deployment as the cross-item Copilot.';

/**
 * Resolve each connected sub-agent ref into a runnable SubAgentRuntime by
 * loading the referenced owner-scoped item and building its grounded config —
 * mirrors the data-agent chat route's resolveSubAgents.
 */
async function resolveSubAgents(state: AgentFlowState, oid: string): Promise<SubAgentRuntime[]> {
  const refs = normalizeSubAgents(state.subAgents);
  if (refs.length === 0) return [];
  return Promise.all(refs.map(async (ref): Promise<SubAgentRuntime> => {
    try {
      const sub = await loadOwnedItem(ref.itemId, ref.itemType, oid);
      if (!sub) return { name: ref.name, role: ref.role, config: { instructions: '', sources: [] }, gate: `Connected agent "${ref.name}" not found or not owned by you.` };
      const subState = (sub.state || {}) as AgentFlowState;
      // Both data-agent and operations-agent sub-agents ground via the same
      // flow→config mapping (instructions + item-bound tool sources); an
      // operations-agent's eventhouse source is carried through its own state.
      const config = flowStateToConfig(subState);
      // Fall back to the sub-agent's own `sources` array (data-agent shape) when
      // it has no flow tools — a plain data-agent stores grounded sources there.
      if (config.sources.length === 0 && Array.isArray((subState as any).sources)) {
        const daSources = ((subState as any).sources as any[]).map((sc) => ({
          id: String(sc.id || sc.name || ''), type: sc.type, name: String(sc.name || ''),
          tables: sc.tables ? String(sc.tables) : undefined,
          description: sc.description ? String(sc.description) : undefined,
          instructions: sc.instructions ? String(sc.instructions) : undefined,
        }));
        config.sources = daSources.filter((sc) => sc.id && sc.type);
      }
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
  if (!session) return jerr('unauthenticated', 401);
  const itemId = (await ctx.params).id;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const question = String(body?.question || '').trim();
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });
  const history: ChatTurn[] = Array.isArray(body?.history)
    ? body.history.filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string').slice(-10)
    : [];

  let item;
  try {
    item = await loadOwnedItem(itemId, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return apiServerError(e, 'cosmos error');
  }
  if (!item) return jerr('agent-flow item not found', 404);

  const state = (item.state || {}) as AgentFlowState;
  const cfg = flowStateToConfig(state);
  // Fold each bound semantic-model's Verified Answers + exposed schema into the
  // grounded sources (owner-scoped; a no-op for non-semantic sources).
  cfg.sources = await enrichSemanticModelSources(cfg.sources, session.claims.oid);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const groundedCount = flowGroundedSources(flowTools(state)).length;
  const capabilityCount = flowCapabilityToolCount(state);

  try {
    const subAgents = await resolveSubAgents(state, session.claims.oid);
    const delegated = subAgents.length > 0;
    const answer = delegated
      ? await orchestrate(cfg, subAgents, history, question)
      : await chatGrounded(cfg, history, question);

    const run: AgentFlowRun = {
      id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
      question, answer: String(answer.answer || '').slice(0, 4000), status: 'succeeded',
      groundedSources: cfg.sources.length, capabilityTools: capabilityCount, subAgents: subAgents.length,
      delegated, totalTokens: answer.usage?.totalTokens, model: answer.model,
      durationMs: Date.now() - t0,
      startedBy: session.claims.upn || session.claims.email || session.claims.oid,
    };
    await persistRun(itemId, session.claims.oid, state, run).catch(() => {});
    // `tools` (from the answer) carries the executed grounding/delegation trace;
    // `foundryTools` is the serialized capability-tool + connected-agent definition.
    return NextResponse.json({ ok: true, answer: answer.answer, tools: answer.tools, model: answer.model, usage: answer.usage, foundryTools: flowFoundryTools(state), run });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, notDeployed: true, error: e.message, hint: AOAI_GATE_HINT }, { status: 503 });
    }
    const failed: AgentFlowRun = {
      id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
      question, answer: '', status: 'failed',
      groundedSources: cfg.sources.length, capabilityTools: capabilityCount, subAgents: 0,
      delegated: false, durationMs: Date.now() - t0, error: e?.message || String(e),
      startedBy: session.claims.upn || session.claims.email || session.claims.oid,
    };
    await persistRun(itemId, session.claims.oid, state, failed).catch(() => {});
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/** Persist the run into item.state.runs[]. */
async function persistRun(
  itemId: string,
  tenantId: string,
  prevState: AgentFlowState,
  run: AgentFlowRun,
): Promise<void> {
  const state = { ...(prevState || {}) };
  state.runs = appendFlowRun(Array.isArray(state.runs) ? state.runs : undefined, run);
  await updateOwnedItem(itemId, ITEM_TYPE, tenantId, { state });
}
