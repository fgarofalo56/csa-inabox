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
import { getUserOboToken } from './mcp-obo-token-store';
import { defaultOnRemoteMcps } from '../mcp/catalog';
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
 * Synthesize enabled McpServerConfig rows for the default-on remote built-in MCP
 * servers — in practice **Microsoft Learn** (the SOLE default-on entry in
 * REMOTE_BUILTIN_MCP_CATALOG) — so their tools register day-one with ZERO admin
 * action and ZERO Cosmos rows. This is what makes Learn live out of the box
 * (no-fabric-dependency: Learn is public, `auth: 'none'`, and the only server on
 * any default code path; every other remote server is opt-in + gated).
 *
 * Rules:
 *  - Only descriptors whose `configured()` is true are returned (Learn is
 *    configured unless LOOM_MS_LEARN_MCP_ENABLED=false) — `defaultOnRemoteMcps()`
 *    already applies that filter.
 *  - A descriptor with no resolved endpoint is skipped (honest no-vaporware:
 *    nothing to register rather than a speculative host).
 *  - An admin-registered row for the same descriptor (same catalogId or endpoint)
 *    ALWAYS wins — the synthetic row is suppressed so there is never a duplicate.
 *  - `auth: 'none'` maps to `authMethod: 'header'` with NO `authValue`:
 *    resolveAuthHeader (mcp-client) returns '' for that, so NO Authorization
 *    header is sent on the wire — exactly what the no-auth Learn endpoint needs.
 *    (Any future default-on OBO/KV descriptor maps to its own auth method and is
 *    resolved per-user in buildMcpShim below.)
 *  - `catalogId` is set so mcpToolPrefixSlug derives the stable `mcp_<slug>_`
 *    prefix from the descriptor id (e.g. `ms-learn` → `mcp_mslearn_…`).
 */
function syntheticDefaultOnServers(registered: McpServerConfig[]): McpServerConfig[] {
  const norm = (u: string) => (u || '').trim().replace(/\/+$/, '').toLowerCase();
  const taken = new Set<string>();
  for (const s of registered) {
    if (s.catalogId) taken.add(`id:${s.catalogId}`);
    if (s.endpoint) taken.add(`ep:${norm(s.endpoint)}`);
  }
  const out: McpServerConfig[] = [];
  for (const e of defaultOnRemoteMcps()) {
    if (!e.endpoint) continue; // no endpoint resolved → nothing to register (no-vaporware)
    if (taken.has(`id:${e.id}`) || taken.has(`ep:${norm(e.endpoint)}`)) continue; // admin row wins
    out.push({
      name: e.name,
      endpoint: e.endpoint,
      // 'none' → 'header' + empty authValue ⇒ resolveAuthHeader sends no header.
      authMethod: e.auth === 'none' ? 'header' : e.auth,
      oboResource: e.oboResource,
      oboScopes: e.oboScopes,
      enabled: true,
      catalogId: e.id, // stable mcp_<slug>_ prefix via mcpToolPrefixSlug
      source: 'remote-builtin',
    });
  }
  return out;
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
  // as the per-USER lookup key for the per-resource OBO token below.
  const registered = await listMcpServers(tenantId);
  // Day-one: also register the default-on remote built-in MCP servers (Microsoft
  // Learn) even when the tenant has NO Cosmos-registered servers, so Learn tools
  // are live with zero admin action (no-fabric-dependency — Learn is public, no
  // auth, the SOLE default-on server). Admin-registered rows always win.
  const servers = [...registered, ...syntheticDefaultOnServers(registered)];
  if (servers.length === 0) return; // No MCP servers configured and none default-on

  // Fetch tool lists in parallel (with timeout)
  const toolLists = await Promise.allSettled(
    servers.map(async (srv) => {
      try {
        // entra-obo servers (the opt-in remote Microsoft MCP servers — Power BI,
        // Azure Resource Manager, AI Foundry, Microsoft Graph / M365 / Teams /
        // OneDrive-SharePoint, Sentinel, Admin Center, Dataverse) authenticate
        // per-USER, not with a static header/KV secret. Resolve the signed-in
        // user's cached delegated token ONCE — keyed by THIS server's OWN OBO
        // resource (oboResourceKey ?? oboResource) via the generalized per-user
        // token store — and thread it through both tools/list (here) and
        // tools/call (the handler below) so each remote tool runs under the user's
        // own RBAC for the correct audience (ARM / Graph / Foundry / … each get
        // their OWN delegated token, not Power BI's). getUserOboToken delegates the
        // Power BI / ARM / SQL audiences back to their login-cached sibling stores,
        // so Power BI keeps working unchanged; a legacy PBI row persisted before
        // oboResource was carried falls back to getPbiUserToken (back-compat shim).
        // No cached token (never consented / expired) → skip listing this server
        // silently; the honest "sign in again / consent the server's scopes" gate
        // is surfaced in the admin panel, never injected into the chat
        // (no-vaporware), and the Azure-native authoring path stays the default
        // (no-fabric-dependency).
        let userToken: string | undefined;
        if (srv.authMethod === 'entra-obo') {
          const resourceKey = srv.oboResourceKey || srv.oboResource || '';
          userToken = resourceKey
            ? (await getUserOboToken(tenantId, resourceKey)) || undefined
            : (await getPbiUserToken(tenantId)) || undefined; // back-compat: legacy PBI row w/o oboResource
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
