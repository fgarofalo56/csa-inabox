/**
 * agent-flow-mcp — WS-5.1 REAL execution of a flow's MCP-server tool nodes.
 *
 * The visual agent-builder canvas lets an author drop MCP-server nodes onto a
 * flow. At run time those tools must ACTUALLY be called (no-vaporware.md): this
 * module resolves each configured MCP tool to a live server, lists its tools,
 * calls the selected tool over the Streamable-HTTP JSON-RPC transport, and folds
 * the real result into the orchestrator's grounding.
 *
 * It is dependency-injected (resolveServer / listTools / callTool) so the core
 * orchestration is unit-tested without Cosmos or the network; the run route
 * wires the real `mcp-config-store` + `mcp-client` implementations. Sovereign:
 * the MCP servers are Azure-hosted Container Apps or admin-registered endpoints
 * — no Fabric dependency on the default path (no-fabric-dependency.md).
 */

import type { AgentTool } from '@/lib/copilot/agent-tool-catalog';

/** A resolved, callable MCP server (endpoint + auth), or an honest gate. */
export type ResolvedMcpServer =
  | { ok: true; endpoint: string; authMethod: string; authValue?: string; userToken?: string; label: string }
  | { ok: false; gate: string };

/** Injected side-effect surface (real in the route, stubbed in tests). */
export interface McpFlowDeps {
  /** Resolve a flow MCP tool to a live server config (Cosmos + catalog + OBO). */
  resolveServer: (tool: AgentTool) => Promise<ResolvedMcpServer>;
  /** List the server's tools (mcp-client listMcpTools). */
  listTools: (s: { endpoint: string; authMethod: string; authValue?: string; userToken?: string }) =>
    Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>;
  /** Call one tool (mcp-client callMcpTool). Returns the raw JSON-RPC result. */
  callTool: (
    s: { endpoint: string; authMethod: string; authValue?: string; userToken?: string },
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** One MCP tool-call trace (mirrors the data-agent RunTool trace shape). */
export interface McpToolTrace {
  source: string;
  type: 'mcp';
  action: string;
  executed: boolean;
  gate?: string;
  /** Stringified tool result content (grounding text). */
  resultText?: string;
}

/** The grounded output of running the flow's MCP tools for one question. */
export interface McpFlowResult {
  traces: McpToolTrace[];
  /** Human-readable grounding blocks folded into the orchestrator synthesis. */
  groundingBlocks: string[];
  /** True when ≥1 MCP tool executed and returned content. */
  anyExecuted: boolean;
}

/** Argument-property names an MCP tool commonly uses for a free-text question. */
const QUESTION_ARG_KEYS = ['question', 'query', 'q', 'input', 'prompt', 'text', 'search'];

/**
 * Choose the tool to call on a server: the tool's first allow-listed name if it
 * lists any, else the first tool the server advertises. Returns undefined when
 * the server exposes no (allowed) tools.
 */
export function pickMcpTool(
  allowed: string[] | undefined,
  available: Array<{ name: string; inputSchema?: Record<string, unknown> }>,
): { name: string; inputSchema?: Record<string, unknown> } | undefined {
  if (!available.length) return undefined;
  const allow = (allowed || []).filter(Boolean);
  if (allow.length) {
    const found = available.find((t) => allow.includes(t.name));
    return found || undefined;
  }
  return available[0];
}

/**
 * Build best-effort arguments for a tool from the question: if the tool's input
 * schema declares a string property that looks like a free-text field, pass the
 * question there; otherwise pass no args (a zero-arg tool). Pure.
 */
export function buildMcpArgs(question: string, inputSchema?: Record<string, unknown>): Record<string, unknown> {
  const props = (inputSchema && typeof inputSchema === 'object' ? (inputSchema as any).properties : undefined) as
    | Record<string, { type?: string }>
    | undefined;
  if (!props || typeof props !== 'object') return {};
  const keys = Object.keys(props);
  // Preferred well-known keys first, then any string prop.
  const match =
    QUESTION_ARG_KEYS.find((k) => keys.includes(k) && (props[k]?.type === 'string' || props[k]?.type === undefined)) ||
    keys.find((k) => props[k]?.type === 'string');
  return match ? { [match]: question } : {};
}

/** Extract readable text from an MCP tools/call result (`{content:[{text}]}`). */
export function mcpResultToText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const r = result as any;
  if (Array.isArray(r?.content)) {
    const parts = r.content
      .map((c: any) => (typeof c?.text === 'string' ? c.text : c?.type === 'text' ? String(c?.text ?? '') : ''))
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  try { return JSON.stringify(r).slice(0, 4000); } catch { return String(r); }
}

/**
 * Run every configured MCP tool node in the flow for one question. Each tool:
 * resolve server → list tools → pick + call → capture the real result (or an
 * honest gate). Never throws for an unreachable server; the gate carries why.
 */
export async function executeFlowMcpTools(
  mcpTools: AgentTool[],
  question: string,
  deps: McpFlowDeps,
): Promise<McpFlowResult> {
  const traces: McpToolTrace[] = [];
  const groundingBlocks: string[] = [];

  for (const tool of mcpTools) {
    const label = tool.serverLabel || tool.serverId || 'MCP server';
    if (!tool.serverId) {
      traces.push({ source: label, type: 'mcp', action: 'tools/call', executed: false, gate: 'No MCP server is bound to this tool node — pick a server in the inspector.' });
      continue;
    }
    let server: ResolvedMcpServer;
    try {
      server = await deps.resolveServer(tool);
    } catch (e: any) {
      traces.push({ source: label, type: 'mcp', action: 'resolve', executed: false, gate: `Could not resolve MCP server "${label}": ${e?.message || String(e)}` });
      continue;
    }
    if (!server.ok) {
      traces.push({ source: label, type: 'mcp', action: 'resolve', executed: false, gate: server.gate });
      continue;
    }
    try {
      const available = await deps.listTools(server);
      const chosen = pickMcpTool(tool.allowedTools, available);
      if (!chosen) {
        traces.push({ source: server.label, type: 'mcp', action: 'tools/list', executed: false, gate: (tool.allowedTools || []).length ? `None of the allow-listed tools are exposed by "${server.label}".` : `MCP server "${server.label}" exposes no tools.` });
        continue;
      }
      const args = buildMcpArgs(question, chosen.inputSchema);
      const raw = await deps.callTool(server, chosen.name, args);
      const text = mcpResultToText(raw);
      traces.push({ source: server.label, type: 'mcp', action: chosen.name, executed: true, resultText: text });
      if (text.trim()) groundingBlocks.push(`MCP "${server.label}" · ${chosen.name}:\n${text.slice(0, 2000)}`);
    } catch (e: any) {
      traces.push({ source: server.label, type: 'mcp', action: 'tools/call', executed: false, gate: `MCP call failed on "${server.label}": ${e?.message || String(e)}` });
    }
  }

  return { traces, groundingBlocks, anyExecuted: groundingBlocks.length > 0 };
}
