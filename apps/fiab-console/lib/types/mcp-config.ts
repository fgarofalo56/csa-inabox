/**
 * MCP server configuration schema (tenant-wide).
 *
 * One doc per MCP server in the Cosmos `mcp-servers` container (PK /serverId, id = serverId).
 * Allows tenant admins to register external MCP servers (HTTP endpoints + auth) that Loom
 * Copilot will fetch tools from and register as Loom tools at orchestrate time.
 *
 * Storage: Cosmos `mcp-servers` container (partitioned by /serverId)
 * Admin UI: Copilot & Agents settings panel → "External MCP Tools" tab
 * Runtime: copilot-orchestrator calls buildMcpShim() which fetches tool lists and registers them
 */

/** MCP server connection definition. */
export interface McpServerConfig {
  /** User-friendly name ("Acme Tools", "Internal APIs"). */
  name: string;
  /** HTTP endpoint of the MCP server (https://...). */
  endpoint: string;
  /** Auth method: "header" (Authorization header) or "key-vault" (resolve from Key Vault). */
  authMethod: 'header' | 'key-vault';
  /** Raw header value (for authMethod: "header") or Key Vault secret ref (for authMethod: "key-vault"). */
  authValue?: string;
  /** Optional description / usage notes. */
  description?: string;
  /** Whether this server is enabled for tool discovery. */
  enabled: boolean;
}

export interface McpServerConfigDoc extends McpServerConfig {
  /** id = serverId (generated on create). */
  id: string;
  serverId: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  /** Last successful test: { at, toolCount } or null. */
  lastTestResult?: { at: string; toolCount: number; error?: string };
}

/** MCP tools/list response (JSON-RPC over HTTPS). */
export interface McpToolsListResponse {
  jsonrpc: '2.0';
  id: string;
  result?: {
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>; // JSON Schema
    }>;
  };
  error?: { code: number; message: string };
}

/** MCP tools/call request (JSON-RPC over HTTPS). */
export interface McpToolsCallRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** MCP tools/call response (JSON-RPC over HTTPS). */
export interface McpToolsCallResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}
