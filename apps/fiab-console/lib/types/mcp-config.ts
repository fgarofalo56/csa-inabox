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
  /**
   * Auth method the runtime uses to mint the Authorization header for this server:
   *  - "header"     — send `authValue` verbatim as the Authorization header.
   *  - "key-vault"  — resolve a Bearer credential from a Key Vault secret ref in `authValue`.
   *  - "entra-obo"  — mint a per-USER Microsoft Entra OAuth On-Behalf-Of bearer at call
   *    time (delegated, under the signed-in user's RBAC). Used by the opt-in remote
   *    built-in Power BI MCP server (api.fabric.microsoft.com/v1/mcp/powerbi). The user
   *    token is minted/cached per-user in the Cosmos pbi-user-token-store (mirroring
   *    sql-user-token-store) and threaded into the MCP client as `userToken` — it is
   *    NEVER stored on this doc. There is no static secret for entra-obo at all, which
   *    keeps the secrets-via-Key-Vault / no-literal-credential invariant intact.
   */
  authMethod: 'header' | 'key-vault' | 'entra-obo';
  /**
   * Raw header value (for authMethod: "header") or Key Vault secret ref (for
   * authMethod: "key-vault"). UNUSED for authMethod "entra-obo" — that path carries no
   * static secret (the per-user OBO token is resolved from pbi-user-token-store at call
   * time, never persisted here).
   */
  authValue?: string;
  /**
   * Entra OBO resource (audience) the delegated token targets. Used ONLY when
   * authMethod === "entra-obo". For the Power BI remote MCP this is
   * 'https://analysis.windows.net/powerbi/api'.
   */
  oboResource?: string;
  /**
   * Delegated scopes requested on `oboResource` when minting the per-user OBO token.
   * Used ONLY when authMethod === "entra-obo". For the Power BI remote MCP these are
   * the three read-only delegated scopes: Dataset.Read.All, MLModel.Execute.All,
   * Workspace.Read.All (resolved to `${oboResource}/<scope>` at acquisition time).
   */
  oboScopes?: string[];
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
   * Origin of this server.
   *  - 'external' (default) = an endpoint a tenant admin registered manually.
   *  - 'catalog' = a vetted server Loom deployed as an Azure Container App
   *    (see McpDeployment below).
   *  - 'remote-builtin' = an already-hosted remote HTTPS Streamable-HTTP endpoint
   *    Loom connects to (not deployed by Loom), authenticated per-user via Entra OBO.
   *    The opt-in Power BI remote MCP (REMOTE_BUILTIN_MCP in lib/mcp/catalog.ts) is the
   *    sole entry today — it is OPT-IN and config-gated (LOOM_POWERBI_MCP_CLIENT_ID +
   *    the Power BI tenant setting), never on a default code path. Loom's Azure-native
   *    semantic-model / report authoring stays the default (no-fabric-dependency).
   */
  source?: 'external' | 'catalog' | 'remote-builtin';
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
