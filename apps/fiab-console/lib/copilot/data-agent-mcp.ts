/**
 * DBX-9 — Publish a Loom Data Agent as an MCP server.
 *
 * The SERVER side of the Model Context Protocol (inverse of mcp-client.ts, which
 * CALLS external MCP servers) for a SINGLE data agent: it exposes exactly one
 * tool, `ask_<agent>`, that answers a natural-language question by running the
 * agent's real grounded chat (chatGrounded). An external MCP client (Claude
 * Desktop, Agent 365, Foundry, or Loom's own Copilot) configured with the
 * agent's endpoint + a Loom API token can then call the agent as a tool.
 *
 * This module holds the PURE protocol logic (tool naming, tool descriptor,
 * JSON-RPC method dispatch) so it is unit-tested without a network or Cosmos;
 * the route (`/api/items/data-agent/[id]/mcp`) injects the real `ask` backend.
 */

/** MCP protocol version this server advertises (matches /api/iq/mcp). */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC 2.0 error codes (subset). */
export const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
} as const;

/**
 * Derive the stable `ask_<slug>` tool name from an agent's display name (or id).
 * Lowercased, non-alphanumerics collapsed to `_`, trimmed, capped — a valid MCP
 * tool identifier. Falls back to `ask_agent` when nothing usable remains.
 */
export function agentMcpToolName(nameOrId: string): string {
  const slug = String(nameOrId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    .replace(/^_+|_+$/g, '');
  return `ask_${slug || 'agent'}`;
}

/** An MCP tool descriptor (the shape `tools/list` returns). */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Build the `ask_<agent>` tool descriptor advertised by `tools/list`. */
export function buildAskTool(toolName: string, agentName: string, description?: string): McpToolDescriptor {
  const desc =
    (description && description.trim()) ||
    `Ask the "${agentName}" Loom data agent a natural-language question. It answers grounded on its configured data sources.`;
  return {
    name: toolName,
    description: desc,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The natural-language question to ask the agent.' },
        history: {
          type: 'array',
          description: 'Optional prior turns for multi-turn context.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
      },
      required: ['question'],
    },
  };
}

/** serverInfo block for `initialize`. */
export function agentServerInfo(agentName: string): { name: string; title: string; version: string } {
  return { name: 'csa-loom-data-agent', title: `CSA Loom — ${agentName}`, version: '1.0.0' };
}

export interface ChatTurnLike {
  role: 'user' | 'assistant';
  content: string;
}

/** Context the route injects — the one real backend call the tool makes. */
export interface AgentMcpContext {
  toolName: string;
  agentName: string;
  description?: string;
  /** Run the agent's grounded chat for one question. Returns the answer text. */
  ask: (question: string, history: ChatTurnLike[]) => Promise<string>;
}

function rpc(id: unknown, body: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, ...body };
}

/** Coerce a loosely-typed history array from tool arguments. */
export function coerceHistory(raw: unknown): ChatTurnLike[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h): h is ChatTurnLike =>
      !!h && typeof h === 'object' &&
      ((h as any).role === 'user' || (h as any).role === 'assistant') &&
      typeof (h as any).content === 'string')
    .slice(-10);
}

/**
 * Dispatch a single JSON-RPC request against the agent's MCP surface. Returns
 * the response object, or null for a notification (no response). PURE apart from
 * the injected `ctx.ask` backend — fully unit-tested with a stub `ask`.
 */
export async function handleAgentMcpMethod(
  body: { id?: unknown; method?: unknown; params?: any },
  ctx: AgentMcpContext,
): Promise<Record<string, unknown> | null> {
  const { id, method, params } = body || {};

  switch (method) {
    case 'initialize':
      return rpc(id, {
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: agentServerInfo(ctx.agentName),
          instructions: `Call ${ctx.toolName} with a natural-language "question" to query the "${ctx.agentName}" data agent. It answers grounded on its configured data sources.`,
        },
      });

    case 'ping':
      return rpc(id, { result: {} });

    case 'notifications/initialized':
      return null; // notification — no response

    case 'tools/list':
      return rpc(id, { result: { tools: [buildAskTool(ctx.toolName, ctx.agentName, ctx.description)] } });

    case 'tools/call': {
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!name || typeof name !== 'string') {
        return rpc(id, { error: { code: RPC.INVALID_PARAMS, message: 'params.name (tool) is required' } });
      }
      if (name !== ctx.toolName) {
        return rpc(id, { error: { code: RPC.METHOD_NOT_FOUND, message: `Unknown tool "${name}". This agent exposes "${ctx.toolName}".` } });
      }
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (!question) {
        return rpc(id, { error: { code: RPC.INVALID_PARAMS, message: 'arguments.question (string) is required' } });
      }
      try {
        const answer = await ctx.ask(question, coerceHistory(args.history));
        return rpc(id, { result: { content: [{ type: 'text', text: answer }] } });
      } catch (e: any) {
        // MCP convention: tool execution errors come back as isError content.
        return rpc(id, { result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true } });
      }
    }

    default:
      return rpc(id, { error: { code: RPC.METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
  }
}
