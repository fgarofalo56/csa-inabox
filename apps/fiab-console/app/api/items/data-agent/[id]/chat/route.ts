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
import { enrichSemanticModelSources } from '../../../semantic-model/_lib/prep-for-ai-store';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig, type ChatTurn } from '@/lib/azure/data-agent-client';
import {
  runReasoningAgent,
  reasoningReceiptExtras,
  type ReasoningAnswer,
  type ReasoningRunContext,
} from '@/lib/azure/data-agent-reasoning';
import { objectTypeNames, normalizeObjectTypes } from '@/lib/editors/ontology-model';
import { assembleAndPersistReceipt } from '@/lib/azure/answer-receipts-store';
import { evaluateContract } from '@/lib/azure/semantic-contract';
import { shouldPlan } from '@/lib/azure/data-agent-planner';
import { classifyTaskClass } from '@/lib/foundry/model-tier-router';
import { orchestrate, type SubAgentRuntime } from '@/lib/azure/agent-orchestrator';
import { normalizeSubAgents } from '@/lib/copilot/connected-agents';
import { emitCopilotUsage } from '@/lib/azure/copilot-orchestrator';
import { resolveAgentSourceLabels } from '@/lib/azure/dspm-ai-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The reasoning-mode (plan→execute→verify) path fans out several grounded turns,
// so allow more wall-clock than a single-shot chat.
export const maxDuration = 120;

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

/**
 * N11 — resolve the GraphRAG grounding context for this agent: the ontology it
 * is bound to (its `ontology` / `graph` source) plus that ontology's DECLARED
 * object types + authored title properties. Owner-scoped (the ontology must be
 * the caller's). Returns `undefined` when the agent has no ontology binding, so
 * the reasoning loop stays on the exact pre-N11 path.
 *
 * DEFAULT-ON: `state.graphGrounding` is only honoured when explicitly `false`
 * (the editor's "Graph grounding" switch). The deployment-wide kill switch is
 * the FLAG0 runtime flag `n11-graphrag-grounding`.
 */
async function resolveGraphContext(
  state: Record<string, unknown>,
  cfg: DataAgentConfig,
  oid: string,
): Promise<ReasoningRunContext['graph']> {
  if (state.graphGrounding === false) return { enabled: false };
  const src = cfg.sources.find((s) => s.type === 'ontology' || s.type === 'graph');
  const ontologyId = String((state.graphOntologyId as string) || src?.id || '').trim();
  if (!ontologyId) return undefined;
  try {
    const onto = await loadOwnedItem(ontologyId, 'ontology', oid);
    if (!onto) return undefined;
    const st = (onto.state || {}) as Record<string, unknown>;
    const objectTypes = [...objectTypeNames(st)];
    if (objectTypes.length === 0) return undefined;
    const titleKeys: Record<string, string> = {};
    for (const ot of normalizeObjectTypes(st.objectTypes)) {
      if (ot.titleKey) titleKeys[ot.apiName] = ot.titleKey;
    }
    return { ontologyId, objectTypes, titleKeys, enabled: true };
  } catch {
    return undefined; // an unreadable ontology never blocks the turn
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const question = String(body?.question || '').trim();
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });
  // Reasoning mode: 'auto' (default — plan hard multi-hop turns, single-shot the
  // rest), 'plan' (force the planner→execute→verify loop), 'single' (force the
  // cheap single grounded turn). Keeps the simple path for simple questions.
  const mode: 'auto' | 'plan' | 'single' =
    body?.mode === 'plan' || body?.mode === 'single' ? body.mode : 'auto';
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
  // G5 consumption: fold each bound semantic-model's curated Verified Answers +
  // AI instructions + exposed-schema (Prep for AI) into that source's grounding
  // so the agent actually sees the trusted NL→DAX pairs. Owner-scoped; a no-op
  // for non-semantic sources or a model that can't be loaded.
  cfg.sources = await enrichSemanticModelSources(cfg.sources, session.claims.oid);

  try {
    // AIF-4: when this agent has connected sub-agents, delegate through the
    // Azure-native Loom orchestrator (real grounded run per sub-agent + a
    // synthesis pass). Otherwise WS-5.5: a hard, multi-hop question runs the
    // reasoning-tier planner→execute→verify loop; a simple turn stays single-shot.
    const subAgents = await resolveSubAgents(itemState, session.claims.oid);
    // N9 — evaluate the governed semantic contract once. Fail-safe: a tenant
    // with no adopted contract (or any error) yields `{ mode:'none' }`, so the
    // pre-N9 plan/single behavior is byte-identical. When a contract IS in force
    // for THIS question we route through the reasoning loop so verified-query
    // retrieval / metric-grounding / refuse-not-guess governs EVERY turn — not
    // just multi-hop ones (a verified query is often a simple question).
    const contractDecision = await evaluateContract(session.claims.oid, question);
    // N11 — the authored-ontology binding for GraphRAG grounding (undefined when
    // this agent has no ontology source; the loop then behaves exactly as pre-N11).
    const graph = await resolveGraphContext(itemState, cfg, session.claims.oid);
    let answer: import('@/lib/azure/data-agent-client').DataAgentAnswer;
    if (subAgents.length > 0) {
      answer = await orchestrate(cfg, subAgents, history, question, { tenantId: session.claims.oid });
    } else if (contractDecision.mode !== 'none') {
      answer = await runReasoningAgent(cfg, history, question, {
        tenantId: session.claims.oid,
        contractDecision,
        graph,
      });
    } else {
      const wantPlan =
        mode === 'plan' ||
        (mode !== 'single' &&
          shouldPlan(question, {
            taskClass: classifyTaskClass(question, { hasTools: cfg.sources.length > 0 }),
            sourceCount: cfg.sources.length,
          }));
      answer = wantPlan
        ? await runReasoningAgent(cfg, history, question, { tenantId: session.claims.oid, graph })
        : await chatGrounded(cfg, history, question, { tenantId: session.claims.oid });
    }

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

    // N10 + N11/N12 — persist the Answer Receipt for a reasoning-mode turn:
    // the plan, the exact queries + real row counts, the GRAPH-PATH CITATIONS
    // from the ontology traversal, every self-healing repair attempt, and the
    // plausibility verdict. Best-effort + fire-and-forget (a receipt hiccup must
    // never block an answer). In an IL5 / air-gapped boundary this persisted
    // receipt IS the compliance artifact.
    if ((answer as ReasoningAnswer).mode === 'plan-execute-verify') {
      const reasoning = answer as ReasoningAnswer;
      const extras = reasoningReceiptExtras(reasoning);
      void assembleAndPersistReceipt(
        {
          prompt: question,
          model: reasoning.model,
          modelTier: reasoning.modelTier,
          usage: reasoning.usage
            ? {
                promptTokens: reasoning.usage.promptTokens,
                completionTokens: reasoning.usage.completionTokens,
                totalTokens: reasoning.usage.totalTokens,
              }
            : undefined,
          steps: [
            ...reasoning.plan.map((p) => ({
              kind: 'thought',
              content: `Step ${p.step} · ${p.source}: ${p.subQuery}`,
            })),
            ...reasoning.steps.flatMap((st, i) =>
              (st.tools || [])
                .filter((t) => t.query)
                .flatMap((t, ti) => {
                  const callId = `s${i}-${ti}`;
                  return [
                    { kind: 'tool_call', callId, name: `${st.source} · ${t.action}`, args: { query: t.query } },
                    {
                      kind: 'tool_result', callId, name: `${st.source} · ${t.action}`,
                      result: { rowCount: t.rowCount, rows: t.rows },
                      ...(t.gate ? { error: t.gate } : {}),
                    },
                  ];
                }),
            ),
          ],
          ...(reasoning.refused ? { error: `Refused: ${reasoning.verify.reason}` } : {}),
          graphPathCitations: extras.graphPathCitations as unknown as Array<Record<string, unknown>>,
          repairAttempts: extras.repairAttempts as unknown as Array<Record<string, unknown>>,
          plausibility: extras.plausibility as unknown as Record<string, unknown>,
        },
        {
          sessionId: `data-agent:${id}`,
          userOid: session.claims.oid,
          tenantId: session.claims.tid,
          surface: 'data-agent',
        },
      );
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
