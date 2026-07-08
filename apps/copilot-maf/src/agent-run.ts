/**
 * MAF agent-RUN loop — the Gov backstop for the Foundry Agent Service
 * thread/run/step inspector path.
 *
 * The Console's `foundry-agent-client.runAgentAndInspect()` (used by the
 * Foundry Agents playground + the data-agent run-steps inspector) targets the
 * `services.ai.azure.com` Agent Service, which has no confirmed GCC-High / IL5
 * host. When that endpoint is absent, the Console's tier selector
 * (`agent-runtime-tier.ts`) routes the SAME run here, and this module executes a
 * real agent loop against Gov AOAI DIRECT and returns the SAME
 * `AgentRunInspection` shape the Foundry tier returns — so the playground /
 * inspector work identically in Gov.
 *
 * Reuses the exact AOAI client + tool-dispatch proxy the /orchestrate loop uses
 * (Gov AOAI direct + Console tool callback with OBO), so tool handlers +
 * per-user ownership stay single-sourced in the Console.
 *
 * TODO (advanced tool-parity, tracked in PRP-azure-ai-foundry-integration.md
 * AIF-8): streaming deltas, multi-turn thread reuse (thread ids are synthetic
 * here), connected-agent sub-agent fan-out, and code_interpreter / file_search
 * native tool emulation. The basic tool-using loop below is real and complete.
 */
import { callAoai, resolveAoaiTargetFromEnv, type AoaiTarget } from './aoai.js';
import { fetchToolSchemas, toAoaiTools, invokeTool } from './tools.js';
import type { ChatMessage } from './types.js';

/** Mirrors `RunStepToolCall` in the Console's foundry-agent-client.ts. */
export interface RunStepToolCall {
  type: string;
  name?: string;
  input?: string;
  output?: string;
}

/** Mirrors `RunStep` in the Console's foundry-agent-client.ts. */
export interface RunStep {
  id: string;
  type: string; // 'message_creation' | 'tool_calls'
  status: string;
  toolCalls: RunStepToolCall[];
  createdAt?: number;
  completedAt?: number;
  error?: string | null;
}

/** Byte-identical to `AgentRunInspection` in the Console's foundry-agent-client.ts. */
export interface AgentRunInspection {
  threadId: string;
  runId: string;
  status: string;
  answer: string;
  steps: RunStep[];
  usage?: Record<string, unknown> | null;
  lastError?: string | null;
  /** MAF-tier marker so the UI can badge which runtime served the run. */
  tier?: 'maf';
}

export interface RunAgentInspectOptions {
  /** The agent's system instructions (authored in the Loom Agents editor). */
  instructions: string;
  /** AOAI deployment name to run the agent on. Falls back to LOOM_AOAI_DEPLOYMENT. */
  model?: string;
  /** The user's question / prompt. */
  question: string;
  /** Trusted signed-in user oid (forwarded to the Console tool dispatch for OBO). */
  userOid: string;
  /** Bound on the reasoning loop iterations. */
  maxIterations?: number;
  /**
   * When false, the loop runs WITHOUT tools (a pure prompt agent) — matches a
   * Foundry agent authored with no tools. Defaults to true (advertise the
   * Console tool catalog, same as the orchestrator loop).
   */
  enableTools?: boolean;
}

function synthId(prefix: string): string {
  return `${prefix}_maf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run `question` through an agent defined by `instructions` on Gov AOAI and
 * return the run + its steps in the `AgentRunInspection` shape. Never throws for
 * a normal AOAI/tool failure — those are surfaced via `status:'failed'` +
 * `lastError` so the caller renders them identically to a Foundry-tier failure.
 */
export async function runAgentInspectMaf(
  opts: RunAgentInspectOptions,
): Promise<AgentRunInspection> {
  const threadId = synthId('thread');
  const runId = synthId('run');
  const steps: RunStep[] = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  let target: AoaiTarget;
  try {
    target = resolveAoaiTargetFromEnv();
  } catch (e: any) {
    return {
      threadId, runId, status: 'failed', answer: '', steps,
      usage, lastError: e?.message || String(e), tier: 'maf',
    };
  }
  // Per-agent model override wins over the env default deployment.
  if (opts.model && opts.model.trim()) target = { ...target, deployment: opts.model.trim() };

  const enableTools = opts.enableTools !== false;
  const schemas = enableTools ? await fetchToolSchemas() : [];
  const tools = toAoaiTools(schemas);

  const messages: ChatMessage[] = [
    { role: 'system', content: opts.instructions || 'You are a helpful assistant.' },
    { role: 'user', content: opts.question },
  ];

  const maxIter = opts.maxIterations ?? 10;

  for (let i = 0; i < maxIter; i++) {
    let resp: any;
    try {
      resp = await callAoai(target, messages, tools);
    } catch (e: any) {
      return {
        threadId, runId, status: 'failed', answer: '', steps,
        usage, lastError: e?.message || String(e), tier: 'maf',
      };
    }
    const u = resp?.usage || {};
    usage.prompt_tokens += u.prompt_tokens ?? 0;
    usage.completion_tokens += u.completion_tokens ?? 0;
    usage.total_tokens += u.total_tokens ?? 0;

    const msg = resp?.choices?.[0]?.message;
    if (!msg) {
      return {
        threadId, runId, status: 'failed', answer: '', steps,
        usage, lastError: 'AOAI returned no choices', tier: 'maf',
      };
    }

    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

    const toolCalls = msg.tool_calls as ChatMessage['tool_calls'];
    if (!toolCalls || toolCalls.length === 0) {
      // Final assistant message → one message_creation step, terminal run.
      const now = Date.now();
      steps.push({
        id: synthId('step'), type: 'message_creation', status: 'completed',
        toolCalls: [], createdAt: now, completedAt: now, error: null,
      });
      return {
        threadId, runId, status: 'completed', answer: msg.content || '',
        steps, usage, lastError: null, tier: 'maf',
      };
    }

    // Dispatch each tool call through the Console; capture as a tool_calls step.
    const stepToolCalls: RunStepToolCall[] = [];
    let stepError: string | null = null;
    const startedAt = Date.now();
    for (const tc of toolCalls) {
      let parsedArgs: unknown = {};
      try { parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { parsedArgs = {}; }

      const invoked = await invokeTool(tc.function.name, parsedArgs, opts.userOid);
      if (invoked.ok) {
        const serialized = JSON.stringify(invoked.result ?? null);
        const truncated = serialized.length > 16_000 ? serialized.slice(0, 16_000) + '...[truncated]' : serialized;
        stepToolCalls.push({
          type: 'function', name: tc.function.name,
          input: tc.function.arguments || JSON.stringify(parsedArgs),
          output: truncated.slice(0, 2000),
        });
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: truncated });
      } else {
        const errMsg = invoked.error || 'tool failed';
        stepError = errMsg;
        stepToolCalls.push({
          type: 'function', name: tc.function.name,
          input: tc.function.arguments || JSON.stringify(parsedArgs),
          output: `error: ${errMsg}`,
        });
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ error: errMsg }) });
      }
    }
    steps.push({
      id: synthId('step'), type: 'tool_calls', status: stepError ? 'failed' : 'completed',
      toolCalls: stepToolCalls, createdAt: startedAt, completedAt: Date.now(), error: stepError,
    });
  }

  return {
    threadId, runId, status: 'failed', answer: '', steps,
    usage, lastError: `Max iterations (${maxIter}) reached without a final answer.`, tier: 'maf',
  };
}
