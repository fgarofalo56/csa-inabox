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
import { getPbiUserToken } from './pbi-user-token-store';
import type { LoomToolRegistry, ToolDef } from './copilot-orchestrator';
import type { McpServerConfig } from '../types/mcp-config';

/**
 * Stable tool-name prefix slug for an MCP server.
 *
 * Loom registers each external tool as `mcp_<slug>_<tool>`. For ordinary
 * admin-registered / catalog-deployed servers the slug is derived from the
 * display name (non-`[a-z0-9_]` → `_`) — unchanged historical behaviour.
 *
 * The opt-in remote-builtin Power BI MCP row, however, is registered with a
 * human display name (`REMOTE_BUILTIN_MCP.name = 'Power BI (remote)'`). Deriving
 * the prefix from that name yields `mcp_Power_BI__remote__<tool>`, which does
 * NOT match the advertised `POWERBI_MCP_TOOL_PREFIX` /
 * `POWERBI_REMOTE_MCP_TOOL_PREFIX` constant (`mcp_powerbiremote_`) that the
 * Copilot skills + personas hint to the model. For remote-builtin rows we
 * therefore derive the slug from the STABLE catalog id
 * (`'powerbi-remote'` → `'powerbiremote'`, non-alphanumerics stripped) so the
 * registered tool names line up exactly with that advertised constant — no
 * parallel naming system, the existing catalog id is the single source of truth.
 *
 * This is naming only: it never reaches a Fabric/Power BI host on its own
 * (no-fabric-dependency — the row only exists once an admin opted in), and the
 * real Streamable-HTTP call + honest gate live unchanged in the Power BI route /
 * MCP client.
 */
function mcpToolPrefixSlug(srv: McpServerConfig): string {
  if (srv.source === 'remote-builtin' && srv.catalogId) {
    return srv.catalogId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  }
  return srv.name.replace(/[^a-z0-9_]/gi, '_');
}

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
  // `tenantId` here is the signed-in user's oid (orchestrate() calls
  // buildMcpShim(reg, userOid)) — used both as the per-tenant server-list key and
  // as the per-USER lookup key for the Power BI OBO token below.
  const servers = await listMcpServers(tenantId);
  if (servers.length === 0) return; // No MCP servers configured

  // Fetch tool lists in parallel (with timeout)
  const toolLists = await Promise.allSettled(
    servers.map(async (srv) => {
      try {
        // entra-obo servers (the opt-in remote Power BI MCP) authenticate
        // per-USER, not with a static header/KV secret. Resolve the signed-in
        // user's cached Power BI delegated token ONCE (pbi-user-token-store, keyed
        // by oid) and thread it through both tools/list (here) and tools/call (the
        // handler below) so the remote tools run under the user's own Power BI
        // RBAC. No cached token (user never consented the Power BI scopes / the
        // token expired) → skip listing this server silently. This is best-effort:
        // the honest "sign in again / consent Power BI scopes" gate is surfaced in
        // the admin panel, never injected into the chat (no-vaporware), and the
        // Azure-native authoring path stays the default (no-fabric-dependency).
        let userToken: string | undefined;
        if (srv.authMethod === 'entra-obo') {
          userToken = (await getPbiUserToken(tenantId)) || undefined;
          if (!userToken) return null; // not consented / expired — skip this opt-in server
        }
        const tools = await listMcpTools(srv.endpoint, srv.authMethod, srv.authValue, 5000, userToken);
        // `prefix` is the stable tool-name slug (catalog id for remote-builtin
        // rows, display name otherwise) — see mcpToolPrefixSlug. This is what
        // makes the registered names match the advertised mcp_powerbiremote_*.
        return { serverId: srv.name, name: srv.name, prefix: mcpToolPrefixSlug(srv), endpoint: srv.endpoint, authMethod: srv.authMethod, authValue: srv.authValue, userToken, tools };
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
    const { prefix, endpoint, authMethod, authValue, userToken, tools } = result.value;

    for (const tool of tools) {
      const mcpToolName = `mcp_${prefix}_${tool.name.replace(/[^a-z0-9_]/gi, '_')}`;
      const toolDef: ToolDef = {
        name: mcpToolName,
        service: 'MCP Servers',
        description: tool.description || `External tool: ${tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {}, required: [] },
        handler: async (args: any) => {
          // Pass the same per-user OBO token captured at discovery so the call
          // executes under the user's RBAC (undefined for header/key-vault servers).
          return callMcpTool(endpoint, tool.name, args, authMethod, authValue, 30_000, userToken);
        },
      };
      registry.register(toolDef);
    }
  }
}
