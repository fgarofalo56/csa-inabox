/**
 * lib/azure/agent-flow-run.ts — W9 (agent-flow item type) run serialization.
 *
 * The standalone `agent-flow` item owns a FlowDag of MCP-tool / agent nodes
 * (the same AIF-5 typed tools + AIF-4 connected sub-agents the AgentFlowCanvas
 * authors) and RUNS it through the existing Azure-native connected-agents
 * runtime (lib/azure/agent-orchestrator `orchestrate` / data-agent-client
 * `chatGrounded`) — no Microsoft Fabric, no new Azure resource
 * (no-fabric-dependency.md / no-vaporware.md).
 *
 * This module is the PURE, unit-testable core the run route composes:
 *   • `flowStateToConfig` — turns the persisted flow state into a runnable
 *     DataAgentConfig. Item-bound data-tool nodes (warehouse / lakehouse / kql /
 *     search-index / knowledge-base) become REAL grounded sources the AOAI
 *     orchestrator actually queries; the orchestrator instructions carry the
 *     flow's system prompt.
 *   • `flowFoundryTools` — serializes the flow's capability-tool nodes (mcp /
 *     function / openapi / code-interpreter / bing) + connected sub-agents into
 *     the Foundry/MAF wire tool definitions, surfaced on the run receipt (and
 *     dispatched when the Foundry/MAF agent runtime is configured).
 *   • `appendFlowRun` — bounded run-history accumulator (newest first).
 *
 * It imports only client-safe typed models (agent-tool-catalog, connected-agents,
 * data-agent-client types) — never the Azure SDK — so both the route and the
 * canvas/editor can share it.
 */
import {
  migrateLegacyTools, toolsToFoundryTools,
  type AgentTool,
} from '@/lib/copilot/agent-tool-catalog';
import {
  normalizeSubAgents, subAgentsToFoundryTools, foundryAgentNameFor,
  type SubAgentRef,
} from '@/lib/copilot/connected-agents';
import type { DataAgentConfig, DataAgentSource, DataAgentSourceType } from '@/lib/azure/data-agent-client';

/** Persisted shape of an `agent-flow` item's `state`. */
export interface AgentFlowState {
  /** Orchestrator system prompt / instructions. */
  instructions?: string;
  systemPrompt?: string;
  description?: string;
  /** AIF-5 typed tool nodes (AgentTool[]; may be a legacy shape → migrated). */
  tools?: unknown;
  /** AIF-4 connected sub-agent refs. */
  subAgents?: unknown;
  /** Canvas node positions (opaque here). */
  flowLayout?: Record<string, { x: number; y: number }>;
  /** Persisted run history (newest first). */
  runs?: AgentFlowRun[];
}

/** One persisted agent-flow run (mirrors the ai-enrichment run-history shape). */
export interface AgentFlowRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  question: string;
  /** First 4k chars of the orchestrator answer. */
  answer: string;
  status: 'succeeded' | 'failed';
  /** Count of grounded (item-bound) data-tool sources actually wired. */
  groundedSources: number;
  /** Count of capability tools (mcp / function / openapi / code-interpreter / bing). */
  capabilityTools: number;
  /** Count of connected sub-agents delegated to. */
  subAgents: number;
  /** True when the run delegated to ≥1 connected sub-agent (orchestrate path). */
  delegated: boolean;
  totalTokens?: number;
  model?: string;
  durationMs: number;
  startedBy: string;
  error?: string;
}

const MAX_FLOW_RUNS = 50;

/** Tool kinds that bind a real Loom data item → a grounded DataAgentSource. */
const TOOL_KIND_TO_SOURCE_TYPE: Record<string, DataAgentSourceType> = {
  warehouse: 'warehouse',
  lakehouse: 'lakehouse',
  kql: 'kql',
  'search-index': 'ai-search',
  'knowledge-base': 'ai-search',
};

/** Normalize the persisted tools blob into typed AgentTool[]. */
export function flowTools(state: AgentFlowState | undefined): AgentTool[] {
  return migrateLegacyTools(state?.tools);
}

/** Normalize the persisted sub-agent blob into typed SubAgentRef[]. */
export function flowSubAgents(state: AgentFlowState | undefined): SubAgentRef[] {
  return normalizeSubAgents(state?.subAgents);
}

/**
 * The item-bound data-tool nodes of the flow, as grounded DataAgentSource[] —
 * the sources the AOAI orchestrator actually queries. Only tools whose kind
 * binds a Loom data item AND carry a resolved itemId are included; capability
 * tools (mcp/function/openapi/…) are NOT grounding sources (see flowFoundryTools).
 */
export function flowGroundedSources(tools: AgentTool[]): DataAgentSource[] {
  const out: DataAgentSource[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    const sourceType = TOOL_KIND_TO_SOURCE_TYPE[t.kind];
    if (!sourceType || !t.itemId) continue;
    if (seen.has(t.itemId)) continue;
    seen.add(t.itemId);
    out.push({
      id: t.itemId,
      type: sourceType,
      name: t.itemName || t.label || t.itemId,
      description: t.description || undefined,
    });
  }
  return out;
}

/**
 * Build the runnable grounded config from the flow state: the orchestrator's
 * instructions + the item-bound data-tool nodes as grounded sources.
 */
export function flowStateToConfig(state: AgentFlowState | undefined): DataAgentConfig {
  const tools = flowTools(state);
  return {
    instructions: String(state?.instructions || state?.systemPrompt || ''),
    description: state?.description ? String(state.description) : undefined,
    sources: flowGroundedSources(tools),
  };
}

/**
 * Serialize the flow's capability tools + connected sub-agents into Foundry/MAF
 * wire tool definitions (the runnable agent-definition tools), for the run
 * receipt and for dispatch under the Foundry/MAF agent runtime.
 */
export function flowFoundryTools(state: AgentFlowState | undefined): Array<Record<string, unknown>> {
  const tools = flowTools(state);
  const subAgents = flowSubAgents(state);
  // Capability tools only (item-bound data tools become grounded sources, not
  // agent tools) → their Foundry wire form.
  const capabilityTools = tools.filter((t) => !TOOL_KIND_TO_SOURCE_TYPE[t.kind]);
  const toolDefs = toolsToFoundryTools(capabilityTools);
  // Sub-agents → connected-agent tool defs; each connected agent is addressed by
  // its deterministic Foundry agent name (foundryAgentNameFor).
  const subAgentDefs = subAgentsToFoundryTools(subAgents, foundryAgentNameFor);
  return [...toolDefs, ...subAgentDefs];
}

/** Count the flow's capability (non-grounding) tools. */
export function flowCapabilityToolCount(state: AgentFlowState | undefined): number {
  return flowTools(state).filter((t) => !TOOL_KIND_TO_SOURCE_TYPE[t.kind]).length;
}

/** Prepend a run onto the history, keeping newest-first and bounded. */
export function appendFlowRun(prev: AgentFlowRun[] | undefined, run: AgentFlowRun): AgentFlowRun[] {
  const list = Array.isArray(prev) ? prev : [];
  return [run, ...list].slice(0, MAX_FLOW_RUNS);
}
