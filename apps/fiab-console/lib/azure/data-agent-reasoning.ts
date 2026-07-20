/**
 * WS-5.5 — Reasoning-mode data agents: the RUNTIME planner→execute→verify loop.
 *
 * For a hard, multi-hop question a single grounded turn is not enough. This
 * module runs the agentic loop on the **reasoning tier**:
 *
 *   1. PLAN    — ask the reasoning model (the WS-1.1 strong deployment, resolved
 *                via {@link routeTurnTier}) for an ordered plan: each step names
 *                an attached source + a concrete sub-query. Parsed by the pure
 *                `data-agent-planner` layer.
 *   2. EXECUTE — run each step against the REAL backend by reusing the existing
 *                grounded execution path ({@link chatGrounded} → propose query →
 *                run it read-only → re-ground). No new backends. Earlier step
 *                answers are threaded into later steps (dependent multi-hop).
 *   3. VERIFY  — a final reasoning-tier pass: does a correct answer follow from
 *                the real step RESULTS? Returns a verdict + a grounded final
 *                answer.
 *
 * Honest degradation (per no-vaporware / no-fabric-dependency): when NO reasoning
 * (strong) deployment is configured the router falls back to the standard
 * deployment — the loop still runs and executes for real, just without a
 * dedicated reasoning model, and {@link ReasoningAnswer.reasoningConfigured}
 * reports `false` so the UI can surface the honest Fix-it. All sources are the
 * existing Azure-native data-agent sources (Gov-safe).
 */
import {
  chatGrounded,
  aoaiChatTurn,
  type DataAgentConfig,
  type DataAgentAnswer,
  type DataAgentTool,
  type ChatTurn,
} from './data-agent-client';
import { resolveAoaiTarget } from './copilot-orchestrator';
import {
  routeTurnTier,
  reasoningTierConfigured,
  type ModelTier,
  type TierPolicyConfigShape,
} from '../foundry/model-tier-router';
import {
  parsePlan,
  sequenceSteps,
  parseVerify,
  type PlanStep,
  type VerifyVerdict,
} from './data-agent-planner';

export interface ReasoningRunContext {
  tenantId?: string;
  /** Tenant Copilot config for tier resolution (admin-overridable). Absent → the
   *  env day-one tiers (`LOOM_AOAI_STRONG_DEPLOYMENT` etc.) drive routing. */
  tierCfg?: TierPolicyConfigShape | null;
}

/** The executed outcome of one plan step (real backend execution metadata). */
export interface ReasoningStepResult {
  step: number;
  source: string;
  subQuery: string;
  rationale?: string;
  /** completed = ran (or answered) · gated = an honest source gate · error. */
  status: 'completed' | 'gated' | 'error';
  answer?: string;
  tools?: DataAgentTool[];
  /** True when at least one tool for this step actually executed a query. */
  executed?: boolean;
  /** Total rows returned across this step's tools. */
  rowCount?: number;
  error?: string;
}

/** A data-agent answer produced by the planner→execute→verify loop. Extends the
 *  base {@link DataAgentAnswer} so existing consumers (tools trace, usage) keep
 *  working, and adds the plan / steps / verify + tier transparency. */
export interface ReasoningAnswer extends DataAgentAnswer {
  mode: 'plan-execute-verify';
  /** The tier the plan/verify passes actually rode (honest — falls back). */
  modelTier: ModelTier;
  /** Whether a dedicated reasoning (strong) deployment is configured. */
  reasoningConfigured: boolean;
  /** The ordered plan (empty when the model produced none → single-pass fallback). */
  plan: PlanStep[];
  /** Per-step execution results. */
  steps: ReasoningStepResult[];
  /** The verify verdict over the step results. */
  verify: { verdict: VerifyVerdict; reason: string };
}

// ── Prompt builders (kept local — the reasoning loop's own system prompts) ────

function buildPlanPrompt(cfg: DataAgentConfig): string {
  const sources = cfg.sources.length
    ? cfg.sources
        .map((sr) => `- ${sr.name} (${sr.type})${sr.description ? ` — ${sr.description}` : ''}`)
        .join('\n')
    : '(no sources attached)';
  return [
    'You are the PLANNER for a CSA Loom data agent (an Azure-native data + AI platform, not Microsoft Fabric).',
    'Decompose the user\'s question into an ORDERED, minimal plan of grounded steps. Each step consults exactly ONE attached source with a concrete sub-question that can be answered by querying that source. A later step MAY depend on an earlier step\'s result.',
    '',
    'Attached sources:',
    sources,
    '',
    'Rules:',
    '- Use ONLY the attached source names above (copy the name exactly).',
    `- Keep the plan tight — at most 5 steps. Prefer fewer.`,
    '- Do NOT answer the question here; only plan the steps to gather the evidence.',
    '- Respond with EXACTLY ONE fenced json block and nothing else:',
    '```json',
    '{"plan":[{"step":1,"source":"<attached source name>","subQuery":"<the concrete sub-question to run against that source>","rationale":"<why this step>"}]}',
    '```',
  ].join('\n');
}

function buildVerifyPrompt(): string {
  return [
    'You are the VERIFIER for a CSA Loom data agent. You are given the user\'s question, the executed plan, and the REAL result of each step (rows the platform actually returned).',
    'Decide whether a correct final answer FOLLOWS FROM THE STEP RESULTS ONLY. Do not invent data or use outside knowledge.',
    '- verdict "pass": the step results fully and consistently answer the question.',
    '- verdict "partial": the results partially answer it or some steps were gated/empty.',
    '- verdict "fail": the results are insufficient or contradict a confident answer.',
    'Then write the final answer grounded ONLY in the step results, citing concrete numbers from the rows. If a step was gated/not executed, say so honestly.',
    'Respond with EXACTLY ONE fenced json block and nothing else:',
    '```json',
    '{"verdict":"pass|partial|fail","reason":"<one sentence>","finalAnswer":"<the grounded final answer>"}',
    '```',
  ].join('\n');
}

function buildVerifyContext(question: string, steps: ReasoningStepResult[]): string {
  const lines: string[] = [`User question: ${question}`, '', 'Executed plan + real results:'];
  for (const st of steps) {
    lines.push('');
    lines.push(`Step ${st.step} · source "${st.source}" · status ${st.status}${st.executed ? ` · ${st.rowCount ?? 0} row(s)` : ''}`);
    lines.push(`  Sub-question: ${st.subQuery}`);
    if (st.answer) lines.push(`  Result: ${st.answer}`);
    if (st.error) lines.push(`  Error: ${st.error}`);
  }
  return lines.join('\n');
}

/** Scope a config to the single source a step names (lenient case-insensitive /
 *  substring match). Falls back to the FULL config when nothing matches, so the
 *  grounded turn can still pick a source rather than run ungrounded. Pure. */
function scopeConfigToSource(cfg: DataAgentConfig, sourceName: string): DataAgentConfig {
  const needle = (sourceName || '').trim().toLowerCase();
  if (!needle) return cfg;
  const match = cfg.sources.find((sr) => {
    const n = (sr.name || '').toLowerCase();
    return n === needle || n.includes(needle) || needle.includes(n);
  });
  return match ? { ...cfg, sources: [match] } : cfg;
}

/** Honest fallback answer when the verify pass yields no final answer: stitch
 *  the per-step answers together so the user still sees the real evidence. */
function synthesizeFromSteps(steps: ReasoningStepResult[]): string {
  const parts = steps.filter((st) => st.answer).map((st) => `Step ${st.step} (${st.source}): ${st.answer}`);
  return parts.length ? parts.join('\n\n') : 'No step produced an answer.';
}

/**
 * Run the planner→execute→verify loop for a hard, multi-hop data-agent turn.
 * The caller (route) decides WHEN to invoke this (via `shouldPlan`); this always
 * runs the full loop and reuses {@link chatGrounded} for real per-step
 * execution. Throws `NoAoaiDeploymentError` (from resolveAoaiTarget) when no
 * model is deployed — the route surfaces the same honest gate as single-shot.
 */
export async function runReasoningAgent(
  cfg: DataAgentConfig,
  history: ChatTurn[],
  question: string,
  ctx?: ReasoningRunContext,
): Promise<ReasoningAnswer> {
  const tierCfg = ctx?.tierCfg ?? null;
  const target = await resolveAoaiTarget();
  const sel = routeTurnTier({
    cfg: tierCfg,
    prompt: question,
    hasTools: cfg.sources.length > 0,
    baseDeployment: target.deployment,
    // A planning turn is inherently reasoning — pin the class so the router
    // resolves the strong deployment even if the heuristic under-classifies.
    taskClass: 'reasoning',
  });
  const planDeployment = sel.deployment || target.deployment;
  const reasoningConfigured = reasoningTierConfigured(tierCfg);
  const stepCtx = { tenantId: ctx?.tenantId };

  // ── PLAN ──────────────────────────────────────────────────────────────────
  const planResp = await aoaiChatTurn(
    target,
    [
      { role: 'system', content: buildPlanPrompt(cfg) },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: question },
    ],
    { deployment: planDeployment, maxCompletionTokens: 900 },
  );
  const plan = sequenceSteps(parsePlan(planResp.content).steps);

  // No plan produced → degrade honestly to a single grounded pass (still real).
  if (plan.length === 0) {
    const single = await chatGrounded(cfg, history, question, stepCtx);
    return {
      ...single,
      mode: 'plan-execute-verify',
      modelTier: sel.tier,
      reasoningConfigured,
      plan: [],
      steps: [],
      verify: {
        verdict: 'partial',
        reason: 'No multi-step plan was produced; answered in a single grounded pass.',
      },
    };
  }

  // ── EXECUTE ─────────────────────────────────────────────────────────────────
  const stepResults: ReasoningStepResult[] = [];
  const priorContext: ChatTurn[] = [...history];
  for (const st of plan) {
    const stepCfg = scopeConfigToSource(cfg, st.source);
    try {
      const a = await chatGrounded(stepCfg, priorContext, st.subQuery, stepCtx);
      const executed = !!a.tools?.some((t) => t.executed);
      const rowCount = (a.tools || []).reduce((n, t) => n + (t.rowCount ?? 0), 0);
      const gated = !executed && !!a.tools?.some((t) => t.gate);
      stepResults.push({
        step: st.step,
        source: st.source,
        subQuery: st.subQuery,
        rationale: st.rationale,
        status: gated ? 'gated' : 'completed',
        answer: a.answer,
        tools: a.tools,
        executed,
        rowCount,
      });
      // Thread this step's answer forward so a dependent step can build on it.
      priorContext.push({ role: 'user', content: st.subQuery }, { role: 'assistant', content: a.answer });
    } catch (e: any) {
      stepResults.push({
        step: st.step,
        source: st.source,
        subQuery: st.subQuery,
        rationale: st.rationale,
        status: 'error',
        error: e?.message || String(e),
      });
    }
  }

  // ── VERIFY ──────────────────────────────────────────────────────────────────
  let verdict: VerifyVerdict = 'partial';
  let reason = 'Verification did not run.';
  let finalAnswer = synthesizeFromSteps(stepResults);
  try {
    const vr = await aoaiChatTurn(
      target,
      [
        { role: 'system', content: buildVerifyPrompt() },
        { role: 'user', content: buildVerifyContext(question, stepResults) },
      ],
      { deployment: planDeployment, maxCompletionTokens: 900 },
    );
    const parsed = parseVerify(vr.content);
    verdict = parsed.verdict;
    reason = parsed.reason;
    finalAnswer = parsed.finalAnswer?.trim() || finalAnswer;
  } catch {
    reason = 'Verification pass could not run; returning the synthesized step answers.';
  }

  const allTools = stepResults.flatMap((st) => st.tools || []);
  return {
    answer: finalAnswer,
    raw: finalAnswer,
    tools: allTools,
    query: allTools.find((t) => t.query)?.query,
    sourceUsed: allTools[0]?.source,
    model: target.deployment,
    sourcesAvailable: cfg.sources.map((sr) => sr.name).filter(Boolean),
    mode: 'plan-execute-verify',
    modelTier: sel.tier,
    reasoningConfigured,
    plan,
    steps: stepResults,
    verify: { verdict, reason },
  };
}
