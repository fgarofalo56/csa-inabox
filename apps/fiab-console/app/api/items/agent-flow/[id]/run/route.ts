/**
 * POST /api/items/agent-flow/[id]/run   body { question: string, history?: {role,content}[] }
 *
 * Run the persisted FlowDag through the Azure-native connected-agents runtime —
 * the same grounded orchestration the AgentFlowCanvas test-run uses, now
 * owner-scoped to a standalone `agent-flow` item. WS-5.1 turns this into the full
 * visual-agent-builder run: it delegates to the shared `runAgentFlowTurn`
 * executor, which:
 *
 *   • grounds on the flow's item-bound data-tool nodes (lakehouse / warehouse /
 *     KQL / AI Search) AND its ontology-object nodes (typed WS-6 instances);
 *   • executes the flow's MCP-server tool nodes for REAL (callMcpTool) and folds
 *     their live output into the grounding;
 *   • hands off to connected sub-agent nodes (orchestrate);
 *   • enforces the inline guardrails/evals (PII redaction / blocked terms /
 *     grounding requirement / length cap).
 *
 * Honest gate: no Azure OpenAI deployment configured → 503 + remediation. No
 * Microsoft Fabric / Foundry required on the default path (no-fabric-dependency).
 *
 * The response carries `{ answer, tools, run }` so BOTH the canvas run pane
 * (reads answer/hint/tools) and the Runs tab (reads run) work off one call.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { NoAoaiDeploymentError, type ChatTurn } from '@/lib/azure/data-agent-client';
import {
  flowFoundryTools, flowGroundedSources, flowTools, flowCapabilityToolCount,
  appendFlowRun, type AgentFlowRun, type AgentFlowState,
} from '@/lib/azure/agent-flow-run';
import { runAgentFlowTurn } from '@/lib/azure/agent-flow-execute';
import { loadOwnedItem, updateOwnedItem, jerr } from '../../../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'agent-flow';
const AOAI_GATE_HINT =
  'Open the AI Foundry hub editor → "Quota + usage" → deploy gpt-4o-mini, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT and grant the Console UAMI "Cognitive Services OpenAI User". The agent-flow run reuses the same Azure OpenAI deployment as the cross-item Copilot.';

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
  const oid = session.claims.oid;
  const startedBy = session.claims.upn || session.claims.email || oid;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const capabilityCount = flowCapabilityToolCount(state);
  const groundedCount = flowGroundedSources(flowTools(state)).length;

  try {
    const turn = await runAgentFlowTurn(state, oid, question, history);

    const run: AgentFlowRun = {
      id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
      question, answer: turn.answer.slice(0, 4000), status: 'succeeded',
      groundedSources: turn.groundedSources, capabilityTools: turn.capabilityTools, subAgents: turn.subAgents,
      delegated: turn.delegated, totalTokens: turn.usage?.totalTokens, model: turn.model,
      durationMs: Date.now() - t0, startedBy,
      mcpCalls: turn.mcpCalls,
      guardrails: turn.guardrails, guardrailViolations: turn.guardrailViolations.length, blocked: turn.blocked,
    };
    await persistRun(itemId, oid, state, run).catch(() => {});
    // `tools` (answer + delegation + MCP trace); `foundryTools` is the serialized
    // capability-tool + connected-agent definition (the runnable agent-definition).
    return NextResponse.json({
      ok: true, answer: turn.answer, tools: turn.tools, model: turn.model, usage: turn.usage,
      foundryTools: flowFoundryTools(state), guardrailViolations: turn.guardrailViolations, blocked: turn.blocked, run,
    });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, notDeployed: true, error: e.message, hint: AOAI_GATE_HINT }, { status: 503 });
    }
    const failed: AgentFlowRun = {
      id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
      question, answer: '', status: 'failed',
      groundedSources: groundedCount, capabilityTools: capabilityCount, subAgents: 0,
      delegated: false, durationMs: Date.now() - t0, error: e?.message || String(e), startedBy,
    };
    await persistRun(itemId, oid, state, failed).catch(() => {});
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
