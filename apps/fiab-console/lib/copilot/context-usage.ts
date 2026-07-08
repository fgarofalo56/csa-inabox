/**
 * Context-window usage builder (CTS-05) — a PURE, unit-tested function with a
 * documented segment-sum invariant, ported from ATLAS's
 * `context_usage.py::build_context_usage_payload`.
 *
 * The orchestrator tokenizes each prompt contributor at message-build time and
 * hands the raw token counts here; this function packs them into the segmented
 * payload the context meter renders, computes utilization, and asserts the
 * invariant:
 *
 *     systemPrompt + personaContext + skills + tools + memory + knowledge
 *       + conversation  ===  totalInputTokens
 *
 * Unlike ATLAS (whose `system_prompt_tokens` bundled memory/knowledge/skills and
 * needed a `sys_base` subtraction to avoid double-counting), Loom assembles each
 * contributor as a DISTINCT message / payload, so the segments are naturally
 * disjoint — the invariant is a direct sum with no overlap correction. Memory
 * (CTS-08) and knowledge (CTS-04 pre-injection) are 0 until those systems land;
 * they are first-class segments now so the meter needs no reshape later.
 *
 * No Azure SDK, no I/O — safe to unit test and to import from the orchestrator.
 */

import type { ContextUsage } from '@/lib/components/copilot/types';
export type { ContextUsage } from '@/lib/components/copilot/types';

/**
 * Cheap, dependency-free token estimate. tiktoken is not vendored in the console
 * bundle; the orchestrator already relies on AOAI's own `usage` for billing, so
 * this ~4-chars-per-token heuristic is used ONLY to size prompt segments for the
 * meter (an estimate the UI labels as such). Whitespace-normalized so trivial
 * formatting differences don't swing the count.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const s = String(text).trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

export interface ContextUsageInput {
  /** Model context window in tokens (e.g. 128000). */
  contextWindow: number;
  /** Base system prompt token count (the persona/pane system message). */
  systemPromptTokens: number;
  /** Per-surface persona-context system message tokens (0 when none). */
  personaContextTokens: number;
  /** Active skills injected this turn. */
  skills: { count: number; tokens: number; names: string[] };
  /** Tool-schema payload advertised to the model. */
  tools: { count: number; tokens: number; names: string[] };
  /** Recalled long-term memory tokens (CTS-08; 0 until it lands). */
  memoryTokens: number;
  /** Pre-injected knowledge/RAG grounding tokens (0 until pre-injection lands). */
  knowledgeTokens: number;
  /** Conversation-history contribution (the user prompt + any prior turns). */
  conversation: { messages: number; tokens: number };
  /** First ~2k chars of the assembled system prompt for the preview modal. */
  systemPromptPreview: string;
}

/**
 * Build the segmented context-usage payload with the segment-sum invariant.
 * Every segment is clamped to a non-negative integer; the total is the direct
 * sum (segments are disjoint by construction), and `segmentsConsistent` is true
 * when the recomputed sum matches (always true here, but emitted so a future
 * overlapping segment can be caught — mirrors ATLAS's telemetry guard).
 */
export function buildContextUsagePayload(input: ContextUsageInput): ContextUsage {
  const nn = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

  const systemPromptTokens = nn(input.systemPromptTokens);
  const personaContextTokens = nn(input.personaContextTokens);
  const skillsTokens = nn(input.skills.tokens);
  const toolsTokens = nn(input.tools.tokens);
  const memoryTokens = nn(input.memoryTokens);
  const knowledgeTokens = nn(input.knowledgeTokens);
  const conversationTokens = nn(input.conversation.tokens);

  const segmentSum =
    systemPromptTokens + personaContextTokens + skillsTokens + toolsTokens +
    memoryTokens + knowledgeTokens + conversationTokens;

  const totalInputTokens = segmentSum;
  const contextWindow = nn(input.contextWindow) || 128000;
  const remainingTokens = Math.max(0, contextWindow - totalInputTokens);
  const utilizationPct = contextWindow > 0
    ? Number(((totalInputTokens / contextWindow) * 100).toFixed(2))
    : 0;

  return {
    contextWindow,
    systemPromptTokens,
    personaContextTokens,
    skills: { count: Math.max(0, Math.round(input.skills.count)), tokens: skillsTokens, names: input.skills.names ?? [] },
    tools: { count: Math.max(0, Math.round(input.tools.count)), tokens: toolsTokens, names: input.tools.names ?? [] },
    memory: { tokens: memoryTokens },
    knowledge: { tokens: knowledgeTokens },
    conversationHistory: { messages: Math.max(0, Math.round(input.conversation.messages)), tokens: conversationTokens },
    totalInputTokens,
    remainingTokens,
    utilizationPct,
    segmentSum,
    segmentsConsistent: segmentSum === totalInputTokens,
    systemPromptPreview: String(input.systemPromptPreview ?? '').slice(0, 2000),
  };
}
