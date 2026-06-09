/**
 * MAF agent loop. A faithful re-implementation of the Console orchestrator's
 * `orchestrate()` reasoning loop — same SYSTEM prompt, same iterate-call-tools-
 * until-final shape, same usage accounting, same OrchestratorStep emissions —
 * but using Gov AOAI DIRECT (resolveAoaiTargetFromEnv + callAoai) and Console
 * tool dispatch (fetchToolSchemas + invokeTool). No Foundry hub, no
 * services.ai.azure.com Agent Service.
 *
 * Step persistence is intentionally NOT done here: the Console's
 * `orchestrateViaMaf()` re-yields and persists each step into the shared
 * `copilot-sessions` Cosmos container, so persistence stays single-sourced.
 */
import { callAoai, resolveAoaiTargetFromEnv, type AoaiTarget } from './aoai.js';
import { fetchToolSchemas, toAoaiTools, invokeTool } from './tools.js';
import type { ChatMessage, OrchestratorStep, OrchestratorUsage } from './types.js';

// Verbatim copy of the Console orchestrator SYSTEM_PROMPT so MAF-tier answers
// carry the same product voice + tool-use discipline as the Foundry tier.
const SYSTEM_PROMPT = `You are CSA Loom Copilot — the assistant for CSA Loom, a self-contained data + AI platform that runs on Azure (Synapse, Databricks, ADF, APIM, Azure Data Explorer, AI Foundry, ADLS, Event Hubs, Azure Monitor). CSA Loom is its OWN product, NOT Microsoft Fabric. When you describe a feature, describe it as a CSA Loom feature (e.g. "the CSA Loom Real-Time hub", "a CSA Loom Eventstream", "the CSA Loom lakehouse") — never say "in Microsoft Fabric". You may name the underlying Azure services since those are the real backends.

You decompose user requests into concrete tool calls against the registered CSA Loom tools. Always prefer real tool calls over describing what you would do. Chain results: feed output of one call into the next. Be concise in your final summary; the user already sees the step trace.

If a tool errors, surface the error clearly and either retry with corrected inputs or abandon that branch and explain why.`;

export interface OrchestrateMafOptions {
  prompt: string;
  sessionId: string;
  userOid: string;
  maxIterations?: number;
}

export async function* orchestrateMaf(
  opts: OrchestrateMafOptions,
): AsyncIterable<OrchestratorStep> {
  const { prompt, userOid } = opts;
  const maxIter = opts.maxIterations ?? 10;

  let target: AoaiTarget;
  try {
    target = resolveAoaiTargetFromEnv();
  } catch (e: any) {
    yield { kind: 'error', error: e?.message || String(e) };
    return;
  }

  const schemas = await fetchToolSchemas();
  const tools = toAoaiTools(schemas);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const usage: OrchestratorUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    aoaiCalls: 0,
    toolCalls: 0,
  };

  for (let i = 0; i < maxIter; i++) {
    let resp: any;
    try {
      resp = await callAoai(target, messages, tools);
    } catch (e: any) {
      yield { kind: 'error', error: e?.message || String(e) };
      return;
    }
    const u = resp?.usage || {};
    usage.aoaiCalls += 1;
    usage.promptTokens += u.prompt_tokens ?? 0;
    usage.completionTokens += u.completion_tokens ?? 0;
    usage.totalTokens += u.total_tokens ?? 0;

    const choice = resp?.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      yield { kind: 'error', error: 'AOAI returned no choices' };
      return;
    }

    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

    const toolCalls = msg.tool_calls as ChatMessage['tool_calls'];
    if (!toolCalls || toolCalls.length === 0) {
      yield { kind: 'final', content: msg.content || '', usage, model: target.deployment };
      return;
    }
    usage.toolCalls += toolCalls.length;

    for (const tc of toolCalls) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        parsedArgs = {};
      }

      yield { kind: 'tool_call', name: tc.function.name, args: parsedArgs, callId: tc.id };

      const started = Date.now();
      const invoked = await invokeTool(tc.function.name, parsedArgs, userOid);
      const durationMs = Date.now() - started;

      if (invoked.ok) {
        const serialized = JSON.stringify(invoked.result ?? null);
        const truncated =
          serialized.length > 16_000 ? serialized.slice(0, 16_000) + '...[truncated]' : serialized;
        yield {
          kind: 'tool_result',
          name: tc.function.name,
          callId: tc.id,
          durationMs,
          result: invoked.result,
        };
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: truncated,
        });
      } else {
        const errMsg = invoked.error || 'tool failed';
        yield {
          kind: 'tool_result',
          name: tc.function.name,
          callId: tc.id,
          durationMs,
          error: errMsg,
        };
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify({ error: errMsg }),
        });
      }
    }
  }

  yield { kind: 'error', error: `Max iterations (${maxIter}) reached without a final answer.` };
}
