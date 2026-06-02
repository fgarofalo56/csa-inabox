/**
 * Copilot & Agents configuration schema.
 *
 * Two scopes share these shapes:
 *
 *  • TENANT (admin) — one doc per tenant in the Cosmos `copilot-config`
 *    container (PK /tenantId, id = tenantId). Selected in
 *    /admin/tenant-settings → "Copilot & Agents". Picks the DEFAULT Foundry
 *    model-hosting account (Microsoft.CognitiveServices, kind AIServices/OpenAI),
 *    the Copilot chat-model deployment, the help-agent model deployment, an
 *    embedding-model deployment, and an optional AI Search grounding index.
 *    The Copilot + help-agent backends read this (falling back to env vars).
 *
 *  • WORKSPACE — one doc per workspace in the Cosmos `workspace-agent-config`
 *    container (PK /workspaceId, id = workspaceId). Set by workspace
 *    owners/contributors in the Data Agent pane. Picks which Foundry project
 *    endpoint + (optionally) which published agent + which chat/embed model
 *    this workspace's data agents use. The data-agent run path reads this.
 *
 * No mocks: every selectable value is sourced from a real ARM/Foundry list
 * call. When nothing is resolvable the UI shows an honest Fluent gate naming
 * the env var / role / resource to provision (see .claude/rules/no-vaporware.md).
 */

/** Admin-scoped, tenant-wide Copilot & Agents config. */
export interface TenantCopilotConfig {
  /** Cognitive Services / AIServices account NAME hosting model deployments. */
  foundryAccount?: string;
  /** Resource group of the account above (defaults to LOOM_FOUNDRY_RG when unset). */
  foundryAccountRg?: string;
  /** Foundry project ENDPOINT for the Agent Service (shaped
   *  https://<acct>.services.ai.azure.com/api/projects/<project>). Optional —
   *  only needed when the tenant also wants a default for workspace data agents. */
  foundryProjectEndpoint?: string;
  /** Foundry project GUID (LOOM_FOUNDRY_PROJECT_ID equivalent). */
  foundryProjectId?: string;
  /** AOAI data-plane endpoint (https://<acct>.openai.azure.com). Derived from the
   *  account when unset; persisted so the chat backend needs no extra ARM call. */
  aoaiEndpoint?: string;
  /** Deployment name of the cross-item Copilot chat model (e.g. "gpt-4o"). */
  copilotChatDeployment?: string;
  /** Deployment name of the docs-grounded Help agent chat model. Falls back to
   *  copilotChatDeployment, then env. */
  helpAgentDeployment?: string;
  /** Deployment name of the embedding model (e.g. "text-embedding-3-large"). */
  embeddingDeployment?: string;
  /** Optional AI Search service name used for RAG grounding. */
  groundingSearchService?: string;
  /** Optional AI Search index used for RAG grounding. */
  groundingSearchIndex?: string;
}

export interface TenantCopilotConfigDoc extends TenantCopilotConfig {
  /** id = tenantId (one doc per tenant). */
  id: string;
  tenantId: string;
  updatedAt: string;
  updatedBy: string;
}

/** Workspace-scoped data-agent config. */
export interface WorkspaceAgentConfig {
  /** Foundry project ENDPOINT this workspace's data agents use. */
  foundryProjectEndpoint?: string;
  /** Foundry project GUID. */
  foundryProjectId?: string;
  /** Cognitive Services / AIServices account NAME (for the model picker). */
  foundryAccount?: string;
  foundryAccountRg?: string;
  /** Default published agent for this workspace (optional — the pane can still
   *  list+pick all published agents). */
  defaultAgent?: string;
  /** Recommended chat-model deployment for reasoning. */
  chatDeployment?: string;
  /** Recommended embedding-model deployment. */
  embeddingDeployment?: string;
}

export interface WorkspaceAgentConfigDoc extends WorkspaceAgentConfig {
  /** id = workspaceId (one doc per workspace). */
  id: string;
  workspaceId: string;
  tenantId: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Sensible default model recommendations surfaced in both pickers. Grounded in
 * Microsoft Learn (Azure OpenAI in Azure AI Foundry Models):
 *   - chat/reasoning: a current gpt-4.x / gpt-4o / gpt-5-mini class model
 *   - embeddings: text-embedding-3-large/small (or ada-002 for legacy parity)
 */
export const RECOMMENDED_CHAT_MODELS = ['gpt-4o', 'gpt-4.1', 'gpt-4o-mini', 'gpt-5-mini'];
export const RECOMMENDED_EMBED_MODELS = ['text-embedding-3-large', 'text-embedding-3-small', 'text-embedding-ada-002'];

/** Heuristic: is this deployment's model an embedding model? */
export function looksLikeEmbedding(modelName?: string, deploymentName?: string): boolean {
  const n = `${modelName || ''} ${deploymentName || ''}`.toLowerCase();
  return /embed|ada-002/.test(n);
}
