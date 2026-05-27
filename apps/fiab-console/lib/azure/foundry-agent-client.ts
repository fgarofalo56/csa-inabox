/**
 * Azure AI Foundry Agent Service (data-plane) client.
 *
 * Targets the Loom Console UAMI via ChainedTokenCredential — same strategy
 * as `foundry-client.ts`:
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — prod path
 *   2. DefaultAzureCredential                                       — local dev / az login
 *
 * Foundry Agent Service is reached via the **project endpoint**:
 *   https://{ai-services-account-name}.services.ai.azure.com/api/projects/{project-name}
 *
 * Per Microsoft Learn (Foundry Agent Service, May 2025+):
 *   POST   {endpoint}/agents?api-version=v1                 — create
 *   PATCH  {endpoint}/agents/{name}?api-version=v1          — update
 *   GET    {endpoint}/agents/{name}?api-version=v1          — get
 *   GET    {endpoint}/agents?api-version=v1                 — list
 *   DELETE {endpoint}/agents/{name}?api-version=v1          — delete
 *
 * Auth scope: https://ai.azure.com/.default
 * UAMI role : Foundry User (formerly Azure AI User) at the project scope.
 *
 * Env vars:
 *   LOOM_FOUNDRY_PROJECT_ENDPOINT  — required (e.g. https://aifoundry-csa-loom.services.ai.azure.com/api/projects/loom)
 *   LOOM_FOUNDRY_PROJECT_ID        — required (the workspace GUID — surfaced back to the editor for paste-into-Foundry connections)
 *   LOOM_FOUNDRY_API_VERSION       — optional (defaults to v1)
 *
 * Missing either env var → throws FoundryAgentNotConfiguredError so the BFF
 * route can return a 501 with an actionable hint instead of pretending to
 * deploy. (See .claude/rules/no-vaporware.md.)
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const AGENT_SCOPE = 'https://ai.azure.com/.default';
const DEFAULT_API_VERSION = 'v1';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/**
 * Typed error thrown when the Foundry Agent Service endpoint isn't configured
 * in this Loom deployment. Routes catch this and return 501 + a hint.
 */
export class FoundryAgentNotConfiguredError extends Error {
  hint: string;
  constructor(missingVar: string, hint: string) {
    super(`Azure AI Foundry Agent Service is not configured: missing ${missingVar}`);
    this.name = 'FoundryAgentNotConfiguredError';
    this.hint = hint;
  }
}

/** Generic error for non-2xx responses from the Agent Service. */
export class FoundryAgentError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Foundry Agent Service call failed (${status})`);
    this.name = 'FoundryAgentError';
    this.status = status;
    this.body = body;
  }
}

function requireConfig(): { endpoint: string; projectId: string; apiVersion: string } {
  const endpoint = process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT;
  if (!endpoint) {
    throw new FoundryAgentNotConfiguredError(
      'LOOM_FOUNDRY_PROJECT_ENDPOINT',
      'Set LOOM_FOUNDRY_PROJECT_ENDPOINT to a Microsoft Foundry project endpoint shaped ' +
        '"https://<ai-services-account>.services.ai.azure.com/api/projects/<project>". ' +
        'Provision the project via platform/fiab/bicep/modules/ai/foundry-project.bicep ' +
        'and wire the resulting endpoint into the admin-plane app env list.',
    );
  }
  const projectId = process.env.LOOM_FOUNDRY_PROJECT_ID;
  if (!projectId) {
    throw new FoundryAgentNotConfiguredError(
      'LOOM_FOUNDRY_PROJECT_ID',
      'Set LOOM_FOUNDRY_PROJECT_ID to the workspace GUID of the Foundry project ' +
        '(visible in the Foundry portal under Library → Overview, or via ' +
        '`az ml workspace show -n <project> -g <rg> --query id -o tsv`). ' +
        'This is the value downstream Foundry / Copilot Studio connections paste in as ' +
        'a secret, so it must be a real GUID, not a free-text alias.',
    );
  }
  return {
    endpoint: endpoint.replace(/\/$/, ''),
    projectId,
    apiVersion: process.env.LOOM_FOUNDRY_API_VERSION || DEFAULT_API_VERSION,
  };
}

async function agentFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { endpoint, apiVersion } = requireConfig();
  const token = await credential.getToken(AGENT_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire token for Foundry Agent Service');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${endpoint}${path}${sep}api-version=${apiVersion}`;
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

async function readJson<T>(res: Response): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' ? parsed : `Foundry Agent Service ${res.status}`);
    throw new FoundryAgentError(res.status, parsed, msg);
  }
  return (parsed as T) ?? ({} as T);
}

/**
 * Project + agent shapes. Kept loose intentionally — the Foundry payload is
 * versioned and adding stricter typing here just creates churn each preview.
 */
export interface FoundryAgent {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
  definition?: Record<string, unknown>;
  latestVersion?: string | number;
  createdAt?: string;
  updatedAt?: string;
  /** Echo of the resolved projectId (not on the wire — added by this client). */
  projectId?: string;
}

export interface FoundryAgentBody {
  /** Required: short alphanumeric name (max 63 chars). Used as the agent identifier. */
  name: string;
  /** Required for prompt-agent kind: model deployment name (e.g. "gpt-4o"). */
  model: string;
  /** Required for prompt-agent kind: system / agent instructions. */
  instructions: string;
  /** Optional: list of tools attached to the agent (free-form per current Foundry schema). */
  tools?: Array<Record<string, unknown>>;
  /** Optional: human-readable description (max 512 chars). */
  description?: string;
  /** Optional: KV metadata bag, max 16 entries. */
  metadata?: Record<string, string>;
  /** Optional: agent kind. Defaults to "prompt" (the only kind Loom Phase 1 uses). */
  kind?: 'prompt' | 'workflow' | 'hosted' | 'container';
}

/** Returns the projectId env value without hitting the Agent Service — useful for editors. */
export function getProjectId(): string {
  return requireConfig().projectId;
}

/**
 * Create-or-update an agent in the Foundry project. The Agent Service does
 * not currently expose a single upsert verb, so we GET first and switch
 * between POST (create) and PATCH (update by name).
 */
export async function createOrUpdateAgent(
  _projectId: string,
  name: string,
  body: FoundryAgentBody,
): Promise<FoundryAgent> {
  const { projectId } = requireConfig();
  // Existence probe.
  const existing = await getAgent(_projectId, name);

  const definition: Record<string, unknown> = {
    kind: body.kind || 'prompt',
    model: body.model,
    instructions: body.instructions,
  };
  if (body.tools && body.tools.length > 0) definition.tools = body.tools;

  const payload: Record<string, unknown> = {
    name,
    definition,
  };
  if (body.description) payload.description = body.description;
  if (body.metadata) payload.metadata = body.metadata;

  if (existing) {
    const res = await agentFetch(`/agents/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const j = await readJson<any>(res);
    return { ...(j || {}), name, projectId };
  }
  const res = await agentFetch(`/agents`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const j = await readJson<any>(res);
  return { ...(j || {}), name, projectId };
}

export async function getAgent(
  _projectId: string,
  name: string,
): Promise<FoundryAgent | null> {
  const { projectId } = requireConfig();
  const res = await agentFetch(`/agents/${encodeURIComponent(name)}`);
  const j = await readJson<any>(res);
  return j ? { ...j, name: j.name || name, projectId } : null;
}

export async function listAgents(_projectId: string): Promise<FoundryAgent[]> {
  const { projectId } = requireConfig();
  const res = await agentFetch(`/agents`);
  const j = await readJson<{ value?: FoundryAgent[]; data?: FoundryAgent[] }>(res);
  const rows = (j?.value || j?.data || []) as FoundryAgent[];
  return rows.map((a) => ({ ...a, projectId }));
}

export async function deleteAgent(
  _projectId: string,
  name: string,
): Promise<void> {
  const res = await agentFetch(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404 && res.status !== 204 && res.status !== 202) {
    const t = await res.text();
    throw new FoundryAgentError(res.status, t, `Delete agent failed: ${t.slice(0, 240)}`);
  }
}
