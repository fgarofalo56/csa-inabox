/**
 * agent-orchestrator — the DEFAULT (Azure-native) multi-agent orchestration
 * path for a Loom data-agent with connected sub-agents (AIF-4).
 *
 * No Microsoft Fabric and no Foundry tenant required (no-fabric-dependency):
 * every step is a REAL grounded AOAI call via `chatGrounded`. Given an
 * orchestrator config + N resolved sub-agent runtimes, it:
 *   1. runs each sub-agent's real grounded chat over the SAME question (bounded,
 *      run in parallel);
 *   2. synthesizes a final grounded answer with the orchestrator's own sources +
 *      instructions, given the sub-agents' findings as context;
 *   3. returns a DataAgentAnswer whose `tools[]` includes a `delegate` marker per
 *      sub-agent (source + the sub-agent's answer) so the thread inspector shows
 *      the orchestrator delegated to each connected agent.
 *
 * The opt-in Foundry connected-agent path (publish → connected_agent tool) is
 * handled separately in the publish route; this is the day-one default.
 */

import {
  chatGrounded, type DataAgentConfig, type DataAgentAnswer, type DataAgentTool, type ChatTurn,
} from './data-agent-client';

/** A resolved sub-agent ready to run (config already loaded from its item). */
export interface SubAgentRuntime {
  /** Display name (thread trace + synthesis context). */
  name: string;
  /** Role the orchestrator plays this agent in. */
  role?: string;
  /** The referenced agent's grounded config. */
  config: DataAgentConfig;
  /** Honest gate when the referenced item could not be resolved / is empty. */
  gate?: string;
}

/** Cap on fan-out per turn (latency + cost guard). */
const MAX_SUB_AGENTS = 4;

/** Truncate a sub-agent answer for the delegation trace. */
function clip(text: string, n = 600): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/**
 * Run the orchestrator over its connected sub-agents. When `subAgents` is empty
 * this is exactly `chatGrounded(orchestrator, history, question)`.
 */
export async function orchestrate(
  orchestrator: DataAgentConfig,
  subAgents: SubAgentRuntime[],
  history: ChatTurn[],
  question: string,
  ctx?: { tenantId?: string },
): Promise<DataAgentAnswer> {
  const active = subAgents.slice(0, MAX_SUB_AGENTS);
  if (active.length === 0) {
    return chatGrounded(orchestrator, history, question, ctx);
  }

  // 1) Run each runnable sub-agent's real grounded chat in parallel.
  const runnable = active.filter((sa) => !sa.gate);
  const gated = active.filter((sa) => sa.gate);
  const settled = await Promise.allSettled(
    runnable.map((sa) => chatGrounded(sa.config, [], question, ctx)),
  );

  const delegateTools: DataAgentTool[] = [];
  const findings: string[] = [];
  runnable.forEach((sa, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      const ans = r.value.answer || '';
      findings.push(`### ${sa.name}${sa.role ? ` (${sa.role})` : ''}\n${ans}`);
      delegateTools.push({
        source: sa.name, type: 'connected-agent', action: 'delegate', query: clip(ans),
      });
    } else {
      const msg = (r.reason as any)?.message || String(r.reason);
      delegateTools.push({ source: sa.name, type: 'connected-agent', action: 'delegate', gate: `Sub-agent run failed: ${msg}` });
    }
  });
  for (const sa of gated) {
    delegateTools.push({ source: sa.name, type: 'connected-agent', action: 'delegate', gate: sa.gate });
  }

  // 2) Synthesize a final grounded answer: the orchestrator's own instructions +
  //    sources, given the sub-agents' findings. When no finding came back, fall
  //    through to a plain orchestrator run so the turn still answers.
  if (findings.length === 0) {
    const plain = await chatGrounded(orchestrator, history, question, ctx);
    return { ...plain, tools: [...(plain.tools || []), ...delegateTools] };
  }

  const synthInstructions =
    `${orchestrator.instructions}\n\n` +
    `You are the ORCHESTRATOR of a multi-agent team. Your connected sub-agents have ` +
    `each answered the user's question from their own grounded data. Synthesize a single, ` +
    `coherent final answer, reconciling and citing each sub-agent by name. Do not fabricate ` +
    `beyond what the sub-agents reported and your own sources.\n\n` +
    `## Sub-agent findings\n${findings.join('\n\n')}`;

  const synthCfg: DataAgentConfig = {
    ...orchestrator,
    instructions: synthInstructions,
  };
  const synth = await chatGrounded(synthCfg, history, question, ctx);
  return {
    ...synth,
    tools: [...(synth.tools || []), ...delegateTools],
  };
}
