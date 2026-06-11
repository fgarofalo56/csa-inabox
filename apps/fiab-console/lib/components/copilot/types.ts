/**
 * Shared client-side types for the Loom Copilot console components
 * (audit-T121). Kept in their own module so the left rail, right rail, and
 * transcript share one shape without importing the server-only orchestrator
 * (which pulls in the Azure SDK).
 */

export interface CopilotUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  aoaiCalls: number;
  toolCalls: number;
}

/** A single streamed orchestrator step (superset of both legacy Step shapes). */
export type Step =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args?: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string; usage?: CopilotUsage; model?: string; citations?: Citation[] }
  | { kind: 'error'; error: string; code?: string }
  | { kind: 'proposed_change'; target: string; before: string; after: string; lang?: string; callId?: string; summary?: string };

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
export interface Turn {
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
      cur.msgIndex = finalCount++;
      closeOpen();
    } else if (st.kind === 'error') {
      cur.error = st.error;
      closeOpen();
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
