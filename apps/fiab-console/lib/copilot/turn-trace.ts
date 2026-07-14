/**
 * CTS-03 — derive per-turn deep traces from a Copilot session's persisted steps.
 *
 * A session doc stores a FLAT `steps[]` array (thought / context_usage /
 * tool_call / tool_result / final / …) across every turn. This pure reducer
 * splits it into per-turn traces — each ending at a `final` step — and pulls out
 * the phase timings (CTS-03), tool roll-up (CTS-02), citations (CTS-04), context
 * meter (CTS-05), and routing so the admin debug panel's tabs render without a
 * second lookup. Pure (no Azure/Next imports) → unit-testable.
 */

import type { PhaseTiming } from './phase-timer';

export interface TraceTool {
  name: string;
  serverName?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface TurnTrace {
  index: number;
  prompt: string;
  model?: string;
  provider?: string;
  usage?: Record<string, number>;
  latencyMs?: number;
  costUsd?: number;
  routedTier?: string;
  routedAgentName?: string;
  routedReason?: string;
  phaseTimings: PhaseTiming[];
  tools: TraceTool[];
  citations: Array<Record<string, unknown>>;
  contextUsage?: Record<string, unknown>;
  /** Every step in this turn, for the raw JSON tab (redaction applied upstream). */
  steps: Array<Record<string, unknown>>;
  error?: string;
}

type Step = Record<string, unknown>;

function promptFromThought(s: Step): string | null {
  if (s.kind !== 'thought') return null;
  const c = typeof s.content === 'string' ? s.content : '';
  const m = c.match(/^User prompt:\s*([\s\S]*)$/);
  return m ? m[1].trim() : null;
}

/** Split flat steps into per-turn traces (each ends at a `final`). Trailing steps
 *  with no closing `final` (an in-flight or errored turn) become a final partial
 *  trace so nothing is dropped. */
export function deriveTurnTraces(steps: unknown): TurnTrace[] {
  if (!Array.isArray(steps)) return [];
  const turns: TurnTrace[] = [];
  let cur: Step[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    turns.push(buildTurn(cur, turns.length));
    cur = [];
  };
  for (const raw of steps) {
    const s = (raw ?? {}) as Step;
    // A new user prompt starts a new turn if the current one already has content.
    if (promptFromThought(s) !== null && cur.some((x) => x.kind === 'final')) flush();
    cur.push(s);
    if (s.kind === 'final') flush();
  }
  flush();
  return turns;
}

function buildTurn(steps: Step[], index: number): TurnTrace {
  const promptStep = steps.find((s) => promptFromThought(s) !== null);
  const prompt = promptStep ? promptFromThought(promptStep) || '' : '';
  const final = steps.find((s) => s.kind === 'final') as Step | undefined;
  const errorStep = steps.find((s) => s.kind === 'error') as Step | undefined;

  // Tool roll-up: prefer the final step's turnDetail (carries serverName), else
  // reconstruct from the tool_result steps.
  const turnDetail = (final?.turnDetail ?? {}) as Record<string, unknown>;
  let tools: TraceTool[] = Array.isArray(turnDetail.tools) ? (turnDetail.tools as TraceTool[]) : [];
  if (tools.length === 0) {
    tools = steps
      .filter((s) => s.kind === 'tool_result')
      .map((s) => ({
        name: String(s.name || ''),
        durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
        ok: !s.error,
        error: typeof s.error === 'string' ? s.error : undefined,
      }));
  }

  return {
    index,
    prompt,
    model: final?.model as string | undefined,
    provider: final?.provider as string | undefined,
    usage: final?.usage as Record<string, number> | undefined,
    latencyMs: final?.turnLatencyMs as number | undefined,
    costUsd: final?.costUsd as number | undefined,
    routedTier: final?.routedTier as string | undefined,
    routedAgentName: turnDetail.routedAgentName as string | undefined,
    routedReason: turnDetail.routedReason as string | undefined,
    phaseTimings: Array.isArray(final?.phaseTimings) ? (final!.phaseTimings as PhaseTiming[]) : [],
    tools,
    citations: Array.isArray(final?.citations) ? (final!.citations as Array<Record<string, unknown>>) : [],
    contextUsage: final?.contextUsage as Record<string, unknown> | undefined,
    steps,
    error: errorStep ? String(errorStep.error || '') : undefined,
  };
}
