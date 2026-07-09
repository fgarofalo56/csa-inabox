/**
 * AIF-13 — AgentOps: per-run trace metrics + per-agent cost/latency rollup (pure).
 *
 * Turns a Foundry Agent Service run inspection (steps + usage) into:
 *   • per-RUN metrics — token counts, an ESTIMATED USD cost (rel-T85 price
 *     table, CTS usage threading), total latency, and per-step timings; and
 *   • a per-AGENT ROLLUP — aggregate cost / latency (avg + p50/p95) / success
 *     rate over the user's persisted run records.
 *
 * Token COUNTS are always real (live Agent Service `usage`); only the $ RATE is
 * the published Azure OpenAI list price, so cost is an ESTIMATE (labelled as
 * such in the UI). All logic is pure + unit-tested; no Azure calls here.
 */
import { estCostUsd } from '@/lib/copilot/cost-estimate';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Normalize the Agent Service / AOAI `usage` object (which uses either the
 * OpenAI `prompt_tokens`/`completion_tokens` or the GenAI `input_tokens`/
 * `output_tokens` naming) into a stable shape. Missing → 0.
 */
export function normalizeUsage(usage: Record<string, unknown> | null | undefined): NormalizedUsage {
  const u = (usage || {}) as Record<string, unknown>;
  const promptTokens = num(u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.inputTokens);
  const completionTokens = num(u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? u.outputTokens);
  const totalTokens = num(u.total_tokens ?? u.totalTokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

export interface RunStepLike {
  id?: string;
  type?: string;
  status?: string;
  createdAt?: number;   // unix seconds
  completedAt?: number; // unix seconds
}

export interface StepTiming {
  id: string;
  type: string;
  status: string;
  startedAt?: number;   // unix ms
  completedAt?: number; // unix ms
  durationMs?: number;
}

/** Per-step timings (seconds → ms), preserving order. */
export function stepTimings(steps: RunStepLike[] | undefined | null): StepTiming[] {
  return (steps || []).map((s, i) => {
    const startedAt = s.createdAt ? s.createdAt * 1000 : undefined;
    const completedAt = s.completedAt ? s.completedAt * 1000 : undefined;
    const durationMs = startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
      ? completedAt - startedAt
      : undefined;
    return {
      id: s.id || `step-${i}`,
      type: s.type || 'step',
      status: s.status || 'unknown',
      startedAt,
      completedAt,
      durationMs,
    };
  });
}

/**
 * Wall-clock latency of a run = last step completion − first step creation
 * (ms). Falls back to the sum of per-step durations when the span can't be
 * derived, or 0 when there are no timestamps.
 */
export function runLatencyMs(steps: RunStepLike[] | undefined | null): number {
  const timings = stepTimings(steps);
  const starts = timings.map((t) => t.startedAt).filter((v): v is number => v !== undefined);
  const ends = timings.map((t) => t.completedAt).filter((v): v is number => v !== undefined);
  if (starts.length && ends.length) {
    const span = Math.max(...ends) - Math.min(...starts);
    if (span >= 0) return span;
  }
  return timings.reduce((acc, t) => acc + (t.durationMs || 0), 0);
}

export interface RunMetrics {
  model: string;
  usage: NormalizedUsage;
  /** ESTIMATED USD from real token counts × published list price. */
  costUsd: number;
  latencyMs: number;
  stepCount: number;
  stepTimings: StepTiming[];
}

export interface RunInspectionLike {
  model?: string;
  usage?: Record<string, unknown> | null;
  steps?: RunStepLike[];
}

/** Compute per-run metrics from an agent-run inspection + the run's model. */
export function runMetrics(input: RunInspectionLike): RunMetrics {
  const model = input.model || '';
  const usage = normalizeUsage(input.usage);
  return {
    model,
    usage,
    costUsd: estCostUsd(model, usage.promptTokens, usage.completionTokens),
    latencyMs: runLatencyMs(input.steps),
    stepCount: (input.steps || []).length,
    stepTimings: stepTimings(input.steps),
  };
}

/** A persisted run record the rollup aggregates over. */
export interface RunRecordLike {
  status?: string;
  model?: string;
  costUsd?: number;
  latencyMs?: number;
  usage?: NormalizedUsage | null;
}

export interface ModelBreakdown {
  model: string;
  runs: number;
  totalTokens: number;
  costUsd: number;
}

export interface AgentRollup {
  agentId: string;
  runs: number;
  completed: number;
  failed: number;
  /** completed / runs, 0..1 (0 when no runs). */
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  byModel: ModelBreakdown[];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const round4 = (n: number): number => Number(n.toFixed(4));

/**
 * Aggregate cost / latency / success across a user's persisted runs for one
 * agent. A "completed" run is `status === 'completed'`; anything terminal-but-
 * not-completed counts as failed for the success-rate denominator (runs).
 */
export function rollupAgentRuns(agentId: string, records: RunRecordLike[]): AgentRollup {
  const runs = records.length;
  let completed = 0;
  let failed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  const latencies: number[] = [];
  const byModelMap = new Map<string, ModelBreakdown>();

  for (const r of records) {
    if (r.status === 'completed') completed += 1;
    else failed += 1;
    const u = r.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    promptTokens += num(u.promptTokens);
    completionTokens += num(u.completionTokens);
    totalTokens += num(u.totalTokens);
    totalCostUsd += num(r.costUsd);
    const lat = num(r.latencyMs);
    if (lat > 0) latencies.push(lat);

    const model = r.model || '(unknown)';
    const mb = byModelMap.get(model) || { model, runs: 0, totalTokens: 0, costUsd: 0 };
    mb.runs += 1;
    mb.totalTokens += num(u.totalTokens);
    mb.costUsd = round4(mb.costUsd + num(r.costUsd));
    byModelMap.set(model, mb);
  }

  const sortedLat = [...latencies].sort((a, b) => a - b);
  const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  return {
    agentId,
    runs,
    completed,
    failed,
    successRate: runs ? round4(completed / runs) : 0,
    promptTokens,
    completionTokens,
    totalTokens,
    totalCostUsd: round4(totalCostUsd),
    avgCostUsd: runs ? round4(totalCostUsd / runs) : 0,
    avgLatencyMs,
    p50LatencyMs: Math.round(percentile(sortedLat, 50)),
    p95LatencyMs: Math.round(percentile(sortedLat, 95)),
    byModel: [...byModelMap.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}
