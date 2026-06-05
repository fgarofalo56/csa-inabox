/**
 * MCP tool registry shim — fetches external MCP server tools and registers them as Loom tools.
 *
 * Called by orchestrate() at chat time. Discovers all enabled MCP servers for the tenant,
 * fetches their tool lists in parallel, and registers each tool as a Loom tool that proxies
 * to tools/call.
 *
 * Designed to be non-blocking: if MCP registration fails, the Copilot still works with
 * the built-in Loom tools. Errors are logged but not surfaced to the user.
 */

import { listMcpServers } from './mcp-config-store';
import { listMcpTools, callMcpTool } from './mcp-client';
import type { LoomToolRegistry, ToolDef } from './copilot-orchestrator';

/**
 * Fetch all enabled MCP servers' tool lists and register them in the Loom registry.
 *
 * Each tool is registered as:
 *   name: "<serverId>/<toolName>" (e.g., "mcp-acme/get_invoice")
 *   service: "MCP Servers" (for grouping in the Copilot status UI)
 *   parameters: echoed from the MCP server's tool definition
 *   handler: proxies to callMcpTool()
 */
export async function buildMcpShim(registry: LoomToolRegistry, tenantId: string): Promise<void> {
  const servers = await listMcpServers(tenantId);
  if (servers.length === 0) return; // No MCP servers configured

  // Fetch tool lists in parallel (with timeout)
  const toolLists = await Promise.allSettled(
    servers.map(async (srv) => {
      try {
        const tools = await listMcpTools(srv.endpoint, srv.authMethod, srv.authValue, 5000);
        return { serverId: srv.name, name: srv.name, endpoint: srv.endpoint, authMethod: srv.authMethod, authValue: srv.authValue, tools };
      } catch (e: any) {
        // Log but don't fail the whole orchestration
        console.warn(`Failed to fetch tools from MCP server ${srv.name}: ${e?.message}`);
        return null;
      }
    }),
  );

  // Register successfully fetched tools
  for (const result of toolLists) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const { serverId, endpoint, authMethod, authValue, tools } = result.value;

    for (const tool of tools) {
      const mcpToolName = `mcp_${serverId.replace(/[^a-z0-9_]/gi, '_')}_${tool.name.replace(/[^a-z0-9_]/gi, '_')}`;
      const toolDef: ToolDef = {
        name: mcpToolName,
        service: 'MCP Servers',
        description: tool.description || `External tool: ${tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {}, required: [] },
        handler: async (args: any) => {
          return callMcpTool(endpoint, tool.name, args, authMethod, authValue);
        },
      };
      registry.register(toolDef);
    }
  }
}
