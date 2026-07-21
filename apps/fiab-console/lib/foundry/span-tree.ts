/**
 * WS-1.5 — OTel span tree (pure, unit-tested).
 *
 * Transforms the flat Agent Service / agentops step list into an OTel-style
 * hierarchical span waterfall with:
 *   • per-span token/latency/error annotations (from the step data)
 *   • parent-child nesting: tool_calls steps become children of a synthetic
 *     "tool execution" parent; message_creation steps are root children
 *   • a rollup summary (total tokens, total latency, error count, span count)
 *
 * The input is the `steps` array persisted in AgentThreadRecord (from the
 * Foundry Agent Service run-steps API), which is already stored by the
 * existing agent-memory-client. No new Azure calls or Cosmos containers.
 *
 * All logic is pure (no Azure calls) — fully unit-testable.
 * See .claude/rules/no-vaporware.md.
 */

import { stepTimings, type RunStepLike, type StepTiming } from './agentops';

// ── Span types ────────────────────────────────────────────────────────────────

export type SpanKind =
  | 'agent-turn'        // root span — the whole multi-tool turn
  | 'tool-call'         // a tool_calls step (or individual tool call)
  | 'message-creation'  // the final message_creation step
  | 'code-interpreter'  // code_interpreter step
  | 'retrieval'         // retrieval / RAG step
  | 'step';             // generic step

/** Map Foundry/Agent Service step types to SpanKind. */
function stepKind(type: string | undefined): SpanKind {
  const t = (type || '').toLowerCase();
  if (t.includes('tool_call') || t.includes('tool-call')) return 'tool-call';
  if (t.includes('message_creation') || t.includes('message-creation')) return 'message-creation';
  if (t.includes('code_interpreter') || t.includes('code-interpreter')) return 'code-interpreter';
  if (t.includes('retrieval')) return 'retrieval';
  return 'step';
}

/** A single node in the span tree. */
export interface SpanNode {
  id: string;
  kind: SpanKind;
  /** Human-readable label for display (tool name, step type, etc.). */
  label: string;
  status: string;
  /** Unix milliseconds or undefined when no timestamp. */
  startedAt?: number;
  endedAt?: number;
  /** Total wall-clock duration in ms (0 when no timestamps). */
  durationMs: number;
  /** Whether this span has a non-success status. */
  isError: boolean;
  /** Token counts when present (tool_calls / message_creation steps carry usage). */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Depth in the tree (0 = root). */
  depth: number;
  /** Child spans (nested tool calls, sub-steps). */
  children: SpanNode[];
  /** Optional raw detail from the step (tool name, function name). */
  detail?: string;
}

/** Rollup across the whole span tree. */
export interface SpanTreeRollup {
  /** Total wall-clock time of the whole agent turn (ms). */
  totalLatencyMs: number;
  /** Total tokens across all spans (summed from leaf steps). */
  totalTokens: number;
  /** Number of error/failed spans. */
  errorCount: number;
  /** Total number of spans (root + all descendants). */
  spanCount: number;
  /** Ordered flat list (depth-first) for the waterfall renderer. */
  flatSpans: SpanNode[];
}

// ── Step detail extraction ────────────────────────────────────────────────────

/** Extract a human-readable label and optional detail from a raw step. */
function stepLabel(step: RunStepLike & Record<string, unknown>): { label: string; detail?: string } {
  const t = (step.type || 'step') as string;
  // tool_calls step: try to extract function name from nested details.
  if (t.includes('tool_call')) {
    const tc = (step as any).step_details?.tool_calls?.[0];
    const fnName = tc?.function?.name || tc?.name || '';
    if (fnName) return { label: `Tool: ${fnName}`, detail: fnName };
  }
  // message_creation: the final synthesised answer step.
  if (t.includes('message_creation')) return { label: 'Message creation' };
  if (t.includes('code_interpreter')) return { label: 'Code interpreter' };
  if (t.includes('retrieval')) return { label: 'Retrieval' };
  // Generic fallback: title-case the type string.
  const label = t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { label };
}

/** Extract token usage from a step if present (Agent Service steps rarely carry it,
 *  but some variants include `usage` in the step detail). */
function stepTokens(step: Record<string, unknown>): { promptTokens?: number; completionTokens?: number; totalTokens?: number } {
  const usage = (step as any).usage || (step as any).step_details?.usage;
  if (!usage) return {};
  const p = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0) || 0;
  const c = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0) || 0;
  const total = Number(usage.total_tokens ?? usage.totalTokens ?? 0) || p + c;
  return { promptTokens: p, completionTokens: c, totalTokens: total };
}

// ── Span tree builder ─────────────────────────────────────────────────────────

const ERR_STATUSES = new Set(['failed', 'error', 'cancelled', 'expired', 'timeout']);

/**
 * Build an OTel-style span tree from a flat Agent Service step list.
 *
 * Structure:
 *   root (agent-turn)
 *     ├─ step 1 (tool-call | message-creation | code-interpreter | …)
 *     ├─ step 2 …
 *     └─ step N …
 *
 * Each step becomes a direct child of the root. The root span stretches from
 * the first step start to the last step completion (the full wall-clock turn).
 *
 * @param steps      The raw steps array from an AgentThreadRecord.
 * @param threadId   Used for the root span id.
 * @param model      Model name annotated on the root span for display.
 * @param totalUsage Optional turn-level token usage (from the thread record).
 */
export function buildSpanTree(
  steps: RunStepLike[] | undefined | null,
  threadId: string,
  model?: string,
  totalUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
): SpanNode {
  const timings: StepTiming[] = stepTimings(steps || []);
  const rawSteps = (steps || []) as Array<RunStepLike & Record<string, unknown>>;

  // Compute root span time bounds.
  const starts = timings.map((t) => t.startedAt).filter((v): v is number => v !== undefined);
  const ends = timings.map((t) => t.completedAt).filter((v): v is number => v !== undefined);
  const rootStart = starts.length ? Math.min(...starts) : undefined;
  const rootEnd = ends.length ? Math.max(...ends) : undefined;
  const rootDuration = rootStart !== undefined && rootEnd !== undefined ? Math.max(0, rootEnd - rootStart) : 0;

  // Build child spans.
  const children: SpanNode[] = rawSteps.map((step, i) => {
    const timing = timings[i];
    const { label, detail } = stepLabel(step);
    const isError = ERR_STATUSES.has((step.status || '').toLowerCase());
    const tokens = stepTokens(step);
    return {
      id: String(step.id || `step-${i}`),
      kind: stepKind(step.type as string | undefined),
      label,
      status: String(step.status || 'unknown'),
      startedAt: timing?.startedAt,
      endedAt: timing?.completedAt,
      durationMs: timing?.durationMs ?? 0,
      isError,
      ...tokens,
      depth: 1,
      children: [],
      detail,
    };
  });

  const rootIsError = children.some((c) => c.isError);
  const root: SpanNode = {
    id: `turn:${threadId}`,
    kind: 'agent-turn',
    label: model ? `Agent turn (${model})` : 'Agent turn',
    status: rootIsError ? 'failed' : (children.length > 0 ? 'completed' : 'unknown'),
    startedAt: rootStart,
    endedAt: rootEnd,
    durationMs: rootDuration,
    isError: rootIsError,
    promptTokens: totalUsage?.promptTokens,
    completionTokens: totalUsage?.completionTokens,
    totalTokens: totalUsage?.totalTokens,
    depth: 0,
    children,
  };

  return root;
}

// ── Span tree rollup ──────────────────────────────────────────────────────────

/** Depth-first flatten of the span tree. */
export function flattenSpanTree(root: SpanNode): SpanNode[] {
  const result: SpanNode[] = [root];
  for (const child of root.children) {
    result.push(...flattenSpanTree(child));
  }
  return result;
}

/**
 * Compute rollup metrics across the whole span tree.
 *
 * Token totals are derived from leaf spans (children only) to avoid
 * double-counting when the root also carries turn-level usage. When no
 * leaf tokens are present, the root's total usage is used as-is.
 */
export function rollupSpanTree(root: SpanNode): SpanTreeRollup {
  const flatSpans = flattenSpanTree(root);

  // Sum tokens from leaf steps (children of root = depth 1) only.
  const leafTokens = root.children.reduce((acc, c) => acc + (c.totalTokens || 0), 0);
  const totalTokens = leafTokens > 0 ? leafTokens : (root.totalTokens || 0);

  const errorCount = flatSpans.filter((s) => s.isError).length;

  return {
    totalLatencyMs: root.durationMs,
    totalTokens,
    errorCount,
    spanCount: flatSpans.length,
    flatSpans,
  };
}
