/**
 * agent-flow-execute — WS-5.1 shared, owner-scoped executor for one agent-flow
 * turn. The standalone `agent-flow` run route AND the published MCP server
 * (`ask_<flow>`) both call `runAgentFlowTurn` so a flow behaves identically
 * whether driven from the canvas run pane or an external MCP client.
 *
 * One turn = REAL, Azure-native, no Fabric (no-fabric-dependency.md):
 *   1. input guardrails (blocked-term denial before any model call);
 *   2. execute the flow's MCP-server tool nodes for real (callMcpTool) and fold
 *      their live output into the orchestrator grounding;
 *   3. resolve connected sub-agents (handoffs) and run the Azure-native
 *      orchestrator (orchestrate) or a single grounded turn (chatGrounded) —
 *      grounded on the flow's data-tool + ontology-object nodes;
 *   4. output guardrails (PII redaction / grounding enforcement / length cap).
 *
 * Throws NoAoaiDeploymentError up to the caller (the route maps it to a 503
 * honest gate). Everything else is caught into an honest per-tool gate.
 */
import { chatGrounded, type ChatTurn } from './data-agent-client';
import { orchestrate, type SubAgentRuntime } from './agent-orchestrator';
import { normalizeSubAgents } from '@/lib/copilot/connected-agents';
import {
  flowStateToConfig, flowGroundedSources, flowTools, flowCapabilityToolCount,
  type AgentFlowState,
} from './agent-flow-run';
import {
  normalizeGuardrails, checkInputGuardrails, applyOutputGuardrails,
  type GuardrailViolation,
} from '@/lib/copilot/agent-flow-guardrails';
import {
  executeFlowMcpTools, type McpFlowDeps, type ResolvedMcpServer,
} from './agent-flow-mcp';
import { listMcpServers } from './mcp-config-store';
import { listMcpTools, callMcpTool } from './mcp-client';
import { getUserOboToken } from './mcp-obo-token-store';
import { getPbiUserToken } from './pbi-user-token-store';
import type { AgentTool } from '@/lib/copilot/agent-tool-catalog';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { enrichSemanticModelSources } from '@/app/api/items/semantic-model/_lib/prep-for-ai-store';

/** The outcome of one flow turn (the route shapes its response + run receipt from this). */
export interface FlowTurnResult {
  answer: string;
  tools: any[];
  usage?: { totalTokens?: number };
  model?: string;
  groundedSources: number;
  capabilityTools: number;
  subAgents: number;
  delegated: boolean;
  mcpCalls: number;
  guardrails: string[];
  guardrailViolations: GuardrailViolation[];
  blocked: boolean;
}

/**
 * Resolve each connected sub-agent ref (a handoff target) into a runnable
 * SubAgentRuntime by loading the referenced owner-scoped item and building its
 * grounded config — the Azure-native connected-agents path (no Foundry tenant).
 */
export async function resolveFlowSubAgents(state: AgentFlowState, oid: string): Promise<SubAgentRuntime[]> {
  const refs = normalizeSubAgents(state.subAgents);
  if (refs.length === 0) return [];
  return Promise.all(refs.map(async (ref): Promise<SubAgentRuntime> => {
    try {
      const sub = await loadOwnedItem(ref.itemId, ref.itemType, oid);
      if (!sub) return { name: ref.name, role: ref.role, config: { instructions: '', sources: [] }, gate: `Connected agent "${ref.name}" not found or not owned by you.` };
      const subState = (sub.state || {}) as AgentFlowState;
      const config = flowStateToConfig(subState);
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

/**
 * Build the injectable MCP execution deps, owner-scoped. `resolveServer` matches
 * a flow MCP tool's bound serverId against the tenant's enabled MCP servers
 * (admin-registered + default-on remote built-ins); entra-obo servers resolve the
 * user's cached delegated token. An unresolved / unconsented server yields an
 * honest gate — never a call to an unwired host.
 */
export function buildFlowMcpDeps(oid: string): McpFlowDeps {
  return {
    resolveServer: async (tool: AgentTool): Promise<ResolvedMcpServer> => {
      const servers = await listMcpServers(oid);
      const srv = servers.find(
        (s) => s.name === tool.serverId || (s as any).catalogId === tool.serverId || (s as any).id === tool.serverId,
      );
      if (!srv) {
        return { ok: false, gate: `MCP server "${tool.serverLabel || tool.serverId}" is not enabled for your tenant. Register or enable it in Admin → MCP servers (or deploy it from the MCP catalog), then re-run.` };
      }
      if (!srv.endpoint) {
        return { ok: false, gate: `MCP server "${srv.name}" has no endpoint wired yet — set its endpoint in Admin → MCP servers.` };
      }
      let userToken: string | undefined;
      if (srv.authMethod === 'entra-obo') {
        const resourceKey = (srv as any).oboResourceKey || (srv as any).oboResource || '';
        userToken = resourceKey ? (await getUserOboToken(oid, resourceKey)) || undefined : (await getPbiUserToken(oid)) || undefined;
        if (!userToken) {
          return { ok: false, gate: `MCP server "${srv.name}" needs your consent — sign in again and consent its scopes in Admin → MCP servers, then re-run.` };
        }
      }
      return { ok: true, endpoint: srv.endpoint, authMethod: srv.authMethod, authValue: srv.authValue, userToken, label: srv.name };
    },
    listTools: (s) => listMcpTools(s.endpoint, s.authMethod, s.authValue, 6000, s.userToken),
    callTool: (s, toolName, args) => callMcpTool(s.endpoint, toolName, args, s.authMethod, s.authValue, 30000, s.userToken),
  };
}

/**
 * Run one agent-flow turn end-to-end. `throws` NoAoaiDeploymentError when no
 * model is deployed (caller maps to a 503 honest gate).
 */
export async function runAgentFlowTurn(
  state: AgentFlowState,
  oid: string,
  question: string,
  history: ChatTurn[] = [],
): Promise<FlowTurnResult> {
  const capabilityCount = flowCapabilityToolCount(state);
  const guardrails = normalizeGuardrails(state.guardrails);

  // 1) input guardrails — block before any model call.
  const inputViolations = checkInputGuardrails(guardrails, question);
  if (inputViolations.length > 0) {
    const msg = 'This request was blocked by the flow guardrails: ' + inputViolations.map((v) => v.message).join(' ');
    return {
      answer: msg, tools: [], groundedSources: flowGroundedSources(flowTools(state)).length,
      capabilityTools: capabilityCount, subAgents: 0, delegated: false, mcpCalls: 0,
      guardrails: ['blocked-term'], guardrailViolations: inputViolations, blocked: true,
    };
  }

  const cfg = flowStateToConfig(state);
  cfg.sources = await enrichSemanticModelSources(cfg.sources, oid);

  // 2) MCP-server tool nodes — real calls, folded into the grounding.
  const mcpTools = flowTools(state).filter((t): t is AgentTool => t.kind === 'mcp' && !!t.serverId);
  const mcp = mcpTools.length
    ? await executeFlowMcpTools(mcpTools, question, buildFlowMcpDeps(oid))
    : { traces: [], groundingBlocks: [], anyExecuted: false };
  if (mcp.groundingBlocks.length) {
    cfg.instructions =
      `${cfg.instructions}\n\n## Live MCP tool results (real output from the flow's MCP servers — use as grounded context, cite the server)\n` +
      mcp.groundingBlocks.join('\n\n');
  }

  // 3) handoffs → connected sub-agents; orchestrate or single grounded turn.
  const subAgents = await resolveFlowSubAgents(state, oid);
  const delegated = subAgents.length > 0;
  const answer = delegated
    ? await orchestrate(cfg, subAgents, history, question, { tenantId: oid })
    : await chatGrounded(cfg, history, question, { tenantId: oid });

  const mergedTools = [...(answer.tools || []), ...mcp.traces];
  const executedRows = mergedTools.some((t: any) => t?.executed && (t?.rowCount ?? 1) >= 0) || mcp.anyExecuted;

  // 4) output guardrails.
  const guard = applyOutputGuardrails(guardrails, String(answer.answer || ''), { executedRows });

  return {
    answer: guard.answer,
    tools: mergedTools,
    usage: answer.usage ? { totalTokens: answer.usage.totalTokens } : undefined,
    model: answer.model,
    groundedSources: cfg.sources.length,
    capabilityTools: capabilityCount,
    subAgents: subAgents.length,
    delegated,
    mcpCalls: mcp.traces.filter((t) => t.executed).length,
    guardrails: guard.applied,
    guardrailViolations: guard.violations,
    blocked: guard.blocked,
  };
}
