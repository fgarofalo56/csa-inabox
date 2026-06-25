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
   *  - "none"       — anonymous: send NO Authorization header at all. This is the
   *    supported no-auth path for already-hosted public remote MCP endpoints that
   *    require no credential — most importantly the default-on **Microsoft Learn**
   *    remote MCP (https://learn.microsoft.com/api/mcp, Streamable-HTTP, no auth).
   *    It is an explicit, self-documenting alias of `authMethod: "header"` with an
   *    empty `authValue`: `resolveAuthHeader` (lib/azure/mcp-client.ts) returns the
   *    empty string for BOTH — its `if (!authValue) return ''` guard already yields
   *    no header for any non-OBO method when `authValue` is empty — so either form
   *    is correct on the wire and existing servers are unaffected. Prefer "none"
   *    for new no-auth registrations because the intent is explicit; "header" +
   *    empty `authValue` remains fully supported for back-compat.
   *  - "header"     — send `authValue` verbatim as the Authorization header. With an
   *    EMPTY `authValue` this is the legacy no-auth form (see "none" above).
   *  - "key-vault"  — resolve a Bearer credential from a Key Vault secret ref in `authValue`.
   *    Used by the opt-in remote built-in **GitHub** MCP (api.githubcopilot.com/mcp),
   *    whose PAT lives in a Key Vault secret (GitHub OAuth / PAT, NOT Entra) referenced
   *    via `secretRefs` / `authValue` — never a literal in this doc.
   *  - "entra-obo"  — mint a per-USER Microsoft Entra OAuth On-Behalf-Of bearer at call
   *    time (delegated, under the signed-in user's RBAC). Used by the opt-in remote
   *    built-in Power BI MCP server (api.fabric.microsoft.com/v1/mcp/powerbi) and, by
   *    the same plumbing, every other opt-in Microsoft remote MCP that authenticates
   *    with a delegated token (Azure Resource Manager, AI Foundry, Microsoft Graph /
   *    M365 / Teams / OneDrive-SharePoint, Sentinel, Admin Center). The user token is
   *    minted/cached per-user in a Cosmos token store (the Power BI store today;
   *    generalized per-resource via `oboResourceKey`, mirroring sql-user-token-store)
   *    and threaded into the MCP client as `userToken` — it is NEVER stored on this
   *    doc. There is no static secret for entra-obo at all, which keeps the
   *    secrets-via-Key-Vault / no-literal-credential invariant intact.
   */
  authMethod: 'none' | 'header' | 'key-vault' | 'entra-obo';
  /**
   * Raw header value (for authMethod: "header") or Key Vault secret ref (for
   * authMethod: "key-vault"). UNUSED for authMethod "entra-obo" — that path carries no
   * static secret (the per-user OBO token is resolved from a Cosmos token store at call
   * time, never persisted here) — and UNUSED for authMethod "none" (anonymous: no
   * header is sent, so leave this empty/undefined).
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
  /**
   * Stable key the generalized per-user OBO token store uses to look up the right
   * delegated token for THIS server's resource. Used ONLY when authMethod ===
   * "entra-obo".
   *
   * Background: the original Power BI plumbing hard-coded a single per-user token
   * lookup (`getPbiUserToken(oid)` in lib/azure/mcp-shim.ts) because Power BI was the
   * lone entra-obo server. To let multiple Microsoft remote MCP servers (ARM, AI
   * Foundry, Graph/M365/Teams/OneDrive-SharePoint, Sentinel, Admin Center) each obtain
   * the token for their OWN `oboResource`, the per-user token store is keyed by this
   * value so every server gets the correct delegated audience.
   *
   * Defaults to `oboResource` when unset (so a single-resource server needs no extra
   * field). Prefer a short, opaque slug (e.g. 'powerbi', 'arm', 'foundry', 'graph')
   * rather than the full audience URL when several servers might share a resource but
   * need distinct token entries. This carries NO secret — it is only a cache/lookup
   * key; the token itself is minted via the existing confidential client (the OBO
   * exchange REUSES LOOM_MSAL_CLIENT_ID + the loom-msal-client-secret Key Vault
   * secret — no new secret literal) and is never persisted on this doc.
   */
  oboResourceKey?: string;
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
   *    Loom connects to (not deployed by Loom). This family covers the curated
   *    Microsoft remote MCP servers (REMOTE_BUILTIN_MCP + REMOTE_BUILTIN_MCP_CATALOG
   *    in lib/mcp/catalog.ts):
   *      • Microsoft Learn (learn.microsoft.com/api/mcp) — authMethod 'none', the
   *        SOLE default-on entry: public, no auth, no Fabric/Power BI dependency, so
   *        it is live day-one with zero config (no-fabric-dependency).
   *      • Power BI, Azure Resource Manager, AI Foundry, Microsoft Graph / M365 /
   *        Teams / OneDrive-SharePoint, Sentinel, Admin Center — authMethod
   *        'entra-obo', each OPT-IN and config-gated (an endpoint env + an Entra app
   *        + the per-user delegated `oboResource`/`oboScopes`/`oboResourceKey`),
   *        never on a default code path.
   *      • GitHub (api.githubcopilot.com/mcp) — authMethod 'key-vault', OPT-IN, PAT in
   *        a Key Vault secret (GitHub OAuth, not Entra).
   *    Microsoft Fabric / Fabric RTI, if added, are explicit Fabric-family opt-ins
   *    (api.fabric.microsoft.com) — never reached on a default path. Loom's
   *    Azure-native authoring (semantic-model / report / etc.) stays the day-one
   *    default for everything (no-fabric-dependency); unconfigured opt-in servers
   *    render an honest Fluent MessageBar gate naming the exact env/secret/scope
   *    (no-vaporware), never a silent failure.
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
