/**
 * Shared client-side types for the Loom Copilot console components
 * (audit-T121). Kept in their own module so the left rail, right rail, and
 * transcript share one shape without importing the server-only orchestrator
 * (which pulls in the Azure SDK).
 */

import type { PhaseTiming } from '@/lib/copilot/phase-timer';
import type { VerificationSignal } from '@/lib/copilot/answer-receipt';

export interface CopilotUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  aoaiCalls: number;
  toolCalls: number;
}

/**
 * Per-turn transparency metadata carried on the `final` step (CTS-01/02).
 * Additive: every field is optional so older clients (and the persisted step
 * docs written before this wave) render exactly as before.
 */
export interface TurnMeta {
  /** Provider family for the badge, e.g. 'Azure OpenAI'. */
  provider?: string;
  /** Prompt (input) tokens for this turn — split out of `usage.totalTokens`. */
  promptTokens?: number;
  /** Completion (output) tokens for this turn. */
  completionTokens?: number;
  /** Wall-clock latency of the whole turn, ms (first prompt → final answer). */
  turnLatencyMs?: number;
  /** Estimated USD from the rel-T85 list-price table over the real token counts. */
  costUsd?: number;
  /**
   * CTS-16: which tier the AIF-12 model tier router chose for this turn
   * ('mini' | 'standard' | 'strong'). Present only when routing actively swapped
   * the deployment away from the resolved default — surfaced as a chip in the
   * CTS-01 metadata bar so "which tier answered this" is never hidden.
   */
  routedTier?: 'mini' | 'standard' | 'strong';
}

/** A single streamed orchestrator step (superset of both legacy Step shapes). */
export type Step =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args?: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | ({ kind: 'final'; content: string; usage?: CopilotUsage; model?: string; citations?: Citation[]; turnDetail?: TurnDetail; contextUsage?: ContextUsage;
      // CTS-03 per-phase ms + WS-1.1 tier attribution + N10 receipt reference,
      // threaded so the client Receipt panel (N10) assembles from the transcript.
      phaseTimings?: PhaseTiming[]; modelTier?: string; taskClass?: string; receiptId?: string;
      // N9's Verified-Query-Result signal (absent today; lights the Verified ✓ badge when present).
      verification?: VerificationSignal;
    } & TurnMeta)
  | { kind: 'error'; error: string; code?: string }
  | { kind: 'context_usage'; usage: ContextUsage }
  | { kind: 'proposed_change'; target: string; before: string; after: string; lang?: string; callId?: string; summary?: string };

/** One tool call rolled into the per-message detail badge (CTS-02). */
export interface TurnToolDetail {
  name: string;
  /** MCP server that backed the call; absent for always-on native Loom tools. */
  serverName?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

/** Per-message collapsible detail (CTS-02): tool roll-up + routing. */
export interface TurnDetail {
  tools: TurnToolDetail[];
  /** Persona/agent that routed the turn, when a route was involved. */
  routedAgentName?: string;
  /** Why that agent was chosen (model-supplied or derived). */
  routedReason?: string;
}

/**
 * Segmented context-window breakdown (CTS-05), computed server-side by the pure
 * {@link buildContextUsagePayload} with the segment-sum invariant. Emitted once
 * per turn as a `context_usage` step (and mirrored onto the `final` step).
 */
export interface ContextUsage {
  contextWindow: number;
  systemPromptTokens: number;
  personaContextTokens: number;
  skills: { count: number; tokens: number; names: string[] };
  tools: { count: number; tokens: number; names: string[] };
  memory: { tokens: number };
  knowledge: { tokens: number };
  conversationHistory: { messages: number; tokens: number };
  totalInputTokens: number;
  remainingTokens: number;
  utilizationPct: number;
  /** Sum of every segment — equals totalInputTokens when segmentsConsistent. */
  segmentSum: number;
  segmentsConsistent: boolean;
  /** First ~2k chars of the assembled system prompt for the preview modal. */
  systemPromptPreview: string;
}

export interface Citation {
  id: string;
  path: string;
  kind: string;
  heading?: string;
  url?: string;
  preview: string;
}

export interface Tool {
  name: string;
  description: string;
  service: string;
  parameters: any;
  whenToUse?: string;
  readsContext?: boolean;
}

export interface SessionSummary {
  id: string;
  sessionId: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
  title?: string;
  pinned?: boolean;
}

/**
 * A conversation "turn" — one user prompt and the assistant's answer (its
 * intermediate tool steps + the final content). Built from the flat step
 * stream by groupTurns().
 */
export interface Turn extends TurnMeta {
  /** Known user prompt for this turn (the session's first prompt, or live). */
  user?: string;
  /** Intermediate steps (thought / tool_call / tool_result / proposed_change). */
  steps: Step[];
  /** Assistant final answer markdown (undefined while still streaming). */
  final?: string;
  /** Terminal error for the turn, if any. */
  error?: string;
  usage?: CopilotUsage;
  model?: string;
  citations?: Citation[];
  /** Per-message detail badge roll-up (CTS-02). */
  turnDetail?: TurnDetail;
  /** Segmented context-window breakdown (CTS-05). */
  contextUsage?: ContextUsage;
  /** CTS-03 per-phase ms (classify / prompt-build / llm / tools) — for the N10 receipt. */
  phaseTimings?: PhaseTiming[];
  /** WS-1.1 tier attribution + task class — for the N10 receipt. */
  modelTier?: string;
  taskClass?: string;
  /** N10 — the persisted loom-answer-receipts doc id for this answer. */
  receiptId?: string;
  /** N9's Verified-Query-Result signal (absent today; lights the Verified ✓ badge). */
  verification?: VerificationSignal;
  /** True while this turn is still streaming. */
  streaming?: boolean;
  /** Monotonic index of the final answer — the feedback key (matches server). */
  msgIndex?: number;
}

/**
 * Group a flat step stream into conversation turns. Each turn is one assistant
 * answer (closed by a `final` or `error`) plus its intermediate steps. The
 * session doc persists only the first user prompt, but within a live sitting we
 * know every prompt the user sent — pass them as `userPrompts` (turn-index
 * aligned) so each user bubble renders. Feedback msgIndex is assigned per
 * `final` encountered, matching the orchestrator's monotonic message index.
 */
export function groupTurns(
  steps: Step[],
  opts: { userPrompts?: string[]; streaming?: boolean } = {},
): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn = { steps: [] };
  let started = false;
  let finalCount = 0;

  const closeOpen = () => {
    if (started) { turns.push(cur); cur = { steps: [] }; started = false; }
  };

  for (const st of steps) {
    started = true;
    if (st.kind === 'final') {
      cur.final = st.content;
      cur.usage = st.usage;
      cur.model = st.model;
      cur.citations = st.citations;
      // CTS-01/02/05 transparency metadata threaded off the final step.
      cur.provider = st.provider;
      cur.promptTokens = st.promptTokens;
      cur.completionTokens = st.completionTokens;
      cur.turnLatencyMs = st.turnLatencyMs;
      cur.costUsd = st.costUsd;
      cur.routedTier = st.routedTier; // CTS-16
      cur.turnDetail = st.turnDetail;
      if (st.contextUsage) cur.contextUsage = st.contextUsage;
      // N10: thread the receipt-relevant final-step fields so the Receipt panel
      // assembles a complete receipt from the transcript (tier, timings, ref).
      cur.phaseTimings = st.phaseTimings;
      cur.modelTier = st.modelTier;
      cur.taskClass = st.taskClass;
      cur.receiptId = st.receiptId;
      cur.verification = st.verification;
      cur.msgIndex = finalCount++;
      closeOpen();
    } else if (st.kind === 'error') {
      cur.error = st.error;
      closeOpen();
    } else if (st.kind === 'context_usage') {
      // Context meter (CTS-05): emitted once at message-build, before `final`.
      // Attach to the in-flight turn; not a rendered transcript row.
      cur.contextUsage = st.usage;
    } else {
      cur.steps.push(st);
    }
  }
  if (started) turns.push(cur);

  // While streaming, ensure the last turn is the in-flight one.
  if (opts.streaming) {
    const last = turns[turns.length - 1];
    if (!last || last.final !== undefined || last.error !== undefined) {
      turns.push({ steps: [], streaming: true });
    } else {
      last.streaming = true;
    }
  }

  // Attach the known user prompt to each turn by index.
  if (opts.userPrompts) {
    for (let i = 0; i < turns.length; i++) {
      if (opts.userPrompts[i]) turns[i].user = opts.userPrompts[i];
    }
  }
  return turns;
}
