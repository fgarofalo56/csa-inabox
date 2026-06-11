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
  /**
   * Catalog entry id this server was deployed from (when provisioned via the
   * MCP browse-catalog + deploy wizard). Empty for manually-registered servers.
   */
  catalogId?: string;
  /**
   * Non-secret config values captured at deploy time, keyed by configSchema key.
   * Secret fields are NEVER stored here — only their Key Vault secret names live
   * in `secretRefs`.
   */
  configValues?: Record<string, string>;
  /**
   * Key Vault secret NAMES (never values) for each secret configSchema field,
   * keyed by configSchema key. Resolved at the container runtime via secretRef.
   */
  secretRefs?: Record<string, string>;
  /**
   * Origin of this server. 'external' (default) = an endpoint a tenant admin
   * registered manually. 'catalog' = a vetted server Loom deployed as an Azure
   * Container App (see McpDeployment below).
   */
  source?: 'external' | 'catalog';
  /** Deployment metadata — present only when source === 'catalog'. */
  deployment?: McpDeployment;
}

/**
 * Provisioning metadata for a catalog-deployed MCP server (an Azure Container
 * App). Persisted alongside the connection so the admin UI can show live state
 * and offer a teardown action.
 */
export interface McpDeployment {
  /** Vetted catalog id the server was deployed from (mcp-catalog.ts). */
  catalogId: string;
  /** Azure Container App resource name. */
  containerAppName: string;
  /** Resolved container image reference. */
  image: string;
  /** Last-observed ARM provisioningState (Succeeded | InProgress | Failed | …). */
  provisioningState?: string;
  /** Last-observed runningStatus of the latest revision. */
  runningStatus?: string;
  /** Internal ingress FQDN of the deployed app. */
  fqdn?: string;
  /** ISO timestamp of the deploy. */
  deployedAt: string;
  /** Who triggered the deploy (upn/email/oid). */
  deployedBy: string;
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
