/**
 * app-mcp — expose a deployed Loom App as an MCP tool (APP-W5 S5).
 *
 * Scope: `agent-fastapi` apps, whose container ships the known `POST /invoke
 * {input}` → `{output}` contract. The Loom-side `/mcp` endpoint advertises one
 * `invoke_<app>` tool and, on `tools/call`, proxies to the deployed app's
 * `/invoke`. The JSON-RPC dispatch mirrors the data-agent MCP surface
 * (initialize / ping / tools/list / tools/call); the single injected backend is
 * `ctx.invoke` so the handler is pure + unit-testable.
 *
 * A generic OpenAPI→MCP shim for arbitrary (non-agent) apps is the tracked
 * follow-on; those apps honest-gate at publish time.
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const RPC = { INVALID_PARAMS: -32602, METHOD_NOT_FOUND: -32601, INTERNAL: -32603 } as const;

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool name for an app — `invoke_<slug>` (letters/digits/underscore). */
export function appMcpToolName(nameOrId: string): string {
  const slug = (nameOrId || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'app';
  return `invoke_${slug}`;
}

export function buildInvokeTool(toolName: string, appName: string): McpToolDescriptor {
  return {
    name: toolName,
    description: `Invoke the "${appName}" Loom app (agent harness). Pass an "input" string; returns the app's output.`,
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string', description: 'The input to send to the app.' } },
      required: ['input'],
    },
  };
}

export function appServerInfo(appName: string): { name: string; title: string; version: string } {
  return { name: 'csa-loom-app', title: `CSA Loom — ${appName}`, version: '1.0.0' };
}

function rpc(id: unknown, body: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, ...body };
}

export interface AppMcpContext {
  toolName: string;
  appName: string;
  /** The one real backend call: invoke the deployed app with an input, return its text output. */
  invoke: (input: string) => Promise<string>;
}

/**
 * Dispatch a single JSON-RPC request against the app's MCP surface. Returns the
 * response object, or null for a notification. PURE apart from `ctx.invoke`.
 */
export async function handleAppMcpMethod(
  body: { id?: unknown; method?: unknown; params?: any },
  ctx: AppMcpContext,
): Promise<Record<string, unknown> | null> {
  const { id, method, params } = body || {};
  switch (method) {
    case 'initialize':
      return rpc(id, {
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: appServerInfo(ctx.appName),
          instructions: `Call ${ctx.toolName} with an "input" string to invoke the "${ctx.appName}" Loom app.`,
        },
      });
    case 'ping':
      return rpc(id, { result: {} });
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return rpc(id, { result: { tools: [buildInvokeTool(ctx.toolName, ctx.appName)] } });
    case 'tools/call': {
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!name || typeof name !== 'string') return rpc(id, { error: { code: RPC.INVALID_PARAMS, message: 'params.name (tool) is required' } });
      if (name !== ctx.toolName) return rpc(id, { error: { code: RPC.METHOD_NOT_FOUND, message: `Unknown tool "${name}". This app exposes "${ctx.toolName}".` } });
      const input = typeof args.input === 'string' ? args.input.trim() : '';
      if (!input) return rpc(id, { error: { code: RPC.INVALID_PARAMS, message: 'arguments.input (string) is required' } });
      try {
        const out = await ctx.invoke(input);
        return rpc(id, { result: { content: [{ type: 'text', text: out }] } });
      } catch (e: any) {
        return rpc(id, { result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true } });
      }
    }
    default:
      return rpc(id, { error: { code: RPC.METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
  }
}
