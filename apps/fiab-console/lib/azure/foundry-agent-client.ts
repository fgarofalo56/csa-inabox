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
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const AGENT_SCOPE = 'https://ai.azure.com/.default';
const DEFAULT_API_VERSION = 'v1';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
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

/**
 * Optional config override threaded from a workspace's data-agent config (and,
 * below it, the tenant default). When provided, these win over the env vars so
 * a workspace can target its own Foundry project endpoint. Each field is
 * individually optional — unset fields fall back to env.
 */
export interface FoundryAgentConfigOverride {
  projectEndpoint?: string;
  projectId?: string;
  apiVersion?: string;
}

function requireConfig(override?: FoundryAgentConfigOverride): { endpoint: string; projectId: string; apiVersion: string } {
  const endpoint = override?.projectEndpoint || process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT;
  if (!endpoint) {
    throw new FoundryAgentNotConfiguredError(
      'LOOM_FOUNDRY_PROJECT_ENDPOINT',
      'Set LOOM_FOUNDRY_PROJECT_ENDPOINT to a Microsoft Foundry project endpoint shaped ' +
        '"https://<ai-services-account>.services.ai.azure.com/api/projects/<project>". ' +
        'Provision the project via platform/fiab/bicep/modules/ai/foundry-project.bicep ' +
        'and wire the resulting endpoint into the admin-plane app env list.',
    );
  }
  const projectId = override?.projectId || process.env.LOOM_FOUNDRY_PROJECT_ID;
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
    apiVersion: override?.apiVersion || process.env.LOOM_FOUNDRY_API_VERSION || DEFAULT_API_VERSION,
  };
}

async function agentFetch(
  path: string,
  init: RequestInit = {},
  override?: FoundryAgentConfigOverride,
): Promise<Response> {
  const { endpoint, apiVersion } = requireConfig(override);
  const token = await credential.getToken(AGENT_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire token for Foundry Agent Service');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${endpoint}${path}${sep}api-version=${apiVersion}`;
  return fetchWithTimeout(url, {
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
export function getProjectId(override?: FoundryAgentConfigOverride): string {
  return requireConfig(override).projectId;
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

export async function listAgents(_projectId: string, override?: FoundryAgentConfigOverride): Promise<FoundryAgent[]> {
  const { projectId } = requireConfig(override);
  const res = await agentFetch(`/agents`, {}, override);
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

// ===========================================================================
// Run-steps inspector — run a question through the agent (thread → message →
// run → poll) and surface the run STEPS (tool calls / query executions /
// message creation) so an operator can debug HOW the agent answered. The
// Foundry Agent Service exposes the OpenAI Assistants-style threads/runs/steps
// surface; everything below is real REST against the project endpoint. Gated
// by requireConfig() (LOOM_FOUNDRY_PROJECT_ENDPOINT) like the rest of this file.
// ===========================================================================

export interface RunStepToolCall {
  type: string;           // code_interpreter | function | file_search | ...
  name?: string;          // function/tool name when present
  input?: string;         // arguments / query (e.g. the SQL/KQL the agent ran)
  output?: string;        // truncated result
}

export interface RunStep {
  id: string;
  type: string;           // 'message_creation' | 'tool_calls'
  status: string;         // 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired'
  toolCalls: RunStepToolCall[];
  createdAt?: number;
  completedAt?: number;
  error?: string | null;
}

export interface AgentRunInspection {
  threadId: string;
  runId: string;
  status: string;         // terminal run status
  answer: string;         // assistant's final text
  steps: RunStep[];
  usage?: Record<string, unknown> | null;
  lastError?: string | null;
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired', 'requires_action']);

function normalizeRunStep(s: any): RunStep {
  const details = s?.step_details || {};
  const toolCalls: RunStepToolCall[] = Array.isArray(details.tool_calls)
    ? details.tool_calls.map((tc: any) => {
        const inner = tc?.[tc?.type] || {};
        return {
          type: tc?.type || 'tool',
          name: tc?.function?.name || inner?.name,
          input: typeof tc?.function?.arguments === 'string' ? tc.function.arguments
            : (typeof inner?.input === 'string' ? inner.input : (inner?.query || undefined)),
          output: typeof inner?.output === 'string' ? inner.output.slice(0, 2000) : undefined,
        };
      })
    : [];
  return {
    id: s?.id || '',
    type: s?.type || details?.type || 'step',
    status: s?.status || 'unknown',
    toolCalls,
    createdAt: s?.created_at,
    completedAt: s?.completed_at,
    error: s?.last_error?.message || null,
  };
}

function extractAssistantText(messages: any): string {
  const data: any[] = messages?.data || [];
  // newest-first or oldest-first depending on order param; pick the latest assistant msg
  const assistant = data.filter((m) => m?.role === 'assistant');
  const msg = assistant[0] || data[0];
  if (!msg) return '';
  const parts: any[] = Array.isArray(msg.content) ? msg.content : [];
  return parts
    .map((p) => (p?.type === 'text' ? (p?.text?.value ?? '') : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Run `question` through the named agent and return the run + its steps for the
 * inspector. Polls the run to a terminal status (bounded; defaults to ~45s).
 * Throws FoundryAgentNotConfiguredError when the project endpoint isn't set so
 * the route can render an honest gate.
 */
/**
 * Resolve a Foundry assistant id (`asst_…`) from an agent name. The Assistants
 * runs API requires the assistant *id*, not the display name — passing the name
 * yields "Invalid 'assistant_id': … Expected an ID that begins with 'asst'." If
 * the caller already passed an id we return it unchanged. */
async function resolveAssistantId(agentNameOrId: string, override?: FoundryAgentConfigOverride): Promise<string> {
  if (/^asst/i.test(agentNameOrId)) return agentNameOrId;
  const agents = await listAgents('', override);
  const match = (agents as any[]).find((a) => a?.id === agentNameOrId || a?.name === agentNameOrId);
  const id = (match as any)?.id;
  if (id && /^asst/i.test(id)) return id;
  // The Assistants runs API STRICTLY requires an `asst_…` id. Never pass a
  // non-asst id (e.g. the Loom display name keyed as id) — that yields the
  // confusing "Invalid 'assistant_id'" 400. Fail with a 404 the caller can
  // detect to fall back to the Azure-native grounded-chat path.
  throw new FoundryAgentError(
    404, undefined,
    `No PUBLISHED Foundry assistant (asst_…) named '${agentNameOrId}' was found in the project. ` +
    'Either publish the data agent to Foundry first, or use the Azure-native grounded run (default).',
  );
}

export async function runAgentAndInspect(
  agentName: string,
  question: string,
  opts?: { maxPollMs?: number; intervalMs?: number; override?: FoundryAgentConfigOverride },
): Promise<AgentRunInspection> {
  const override = opts?.override;
  requireConfig(override); // throws FoundryAgentNotConfiguredError when unconfigured
  if (!agentName) throw new FoundryAgentError(400, undefined, 'agent name required');
  if (!question?.trim()) throw new FoundryAgentError(400, undefined, 'question required');

  // The Assistants runs API needs the assistant id, not the display name.
  const assistantId = await resolveAssistantId(agentName, override);

  const thread = await readJson<any>(await agentFetch('/threads', { method: 'POST', body: JSON.stringify({}) }, override));
  const threadId: string = thread?.id;
  if (!threadId) throw new FoundryAgentError(502, thread, 'Foundry Agent Service did not return a thread id');

  await readJson(await agentFetch(`/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: question }),
  }, override));

  let run = await readJson<any>(await agentFetch(`/threads/${encodeURIComponent(threadId)}/runs`, {
    method: 'POST',
    body: JSON.stringify({ assistant_id: assistantId }),
  }, override));
  const runId: string = run?.id;
  if (!runId) throw new FoundryAgentError(502, run, 'Foundry Agent Service did not return a run id');

  const maxPollMs = opts?.maxPollMs ?? 45_000;
  const intervalMs = opts?.intervalMs ?? 1_500;
  const startedAt = Date.now();
  let status: string = run?.status || 'queued';
  while (!TERMINAL_RUN_STATUSES.has(status) && Date.now() - startedAt < maxPollMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    run = await readJson<any>(await agentFetch(`/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`, {}, override));
    status = run?.status || status;
  }

  const stepsRes = await readJson<any>(await agentFetch(`/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/steps?order=asc`, {}, override));
  const steps: RunStep[] = Array.isArray(stepsRes?.data) ? stepsRes.data.map(normalizeRunStep) : [];

  let answer = '';
  if (status === 'completed') {
    const msgs = await readJson<any>(await agentFetch(`/threads/${encodeURIComponent(threadId)}/messages?order=desc&limit=10`, {}, override));
    answer = extractAssistantText(msgs);
  }

  return {
    threadId,
    runId,
    status,
    answer,
    steps,
    usage: run?.usage ?? null,
    lastError: run?.last_error?.message ?? null,
  };
}
