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
// N9 — Verified Semantic Contract + VQR. The reasoning loop retrieves a verified
// query FIRST (before free NL2SQL generation), routes an unmatched-but-metric-
// grounded question through generation, and REFUSES an out-of-contract question
// with a guided message (refuse-not-guess). evaluateContract is FAIL-SAFE: any
// error (or no contract adopted) yields `{ mode:'none' }`, so a tenant with no
// contract behaves EXACTLY as pre-N9 — this wiring never breaks existing agents.
import { evaluateContract, type ContractDecision } from './semantic-contract';

export interface ReasoningRunContext {
  tenantId?: string;
  /** Tenant Copilot config for tier resolution (admin-overridable). Absent → the
   *  env day-one tiers (`LOOM_AOAI_STRONG_DEPLOYMENT` etc.) drive routing. */
  tierCfg?: TierPolicyConfigShape | null;
  /**
   * N9: a pre-evaluated contract decision. When the caller has already run
   * {@link evaluateContract} (e.g. to govern the single-shot path too), it may
   * thread the decision here to avoid a second Cosmos read. Absent → the loop
   * evaluates the contract itself from `tenantId`.
   */
  contractDecision?: ContractDecision;
}

/** N9 — the contract signal N10's receipt renders (VQR hit / metric / refusal). */
export interface ContractSignal {
  mode: 'verified-query' | 'metric-grounded' | 'refused';
  /** Match confidence [0,1] for verified-query / metric-grounded. */
  confidence?: number;
  /** The approved VQR id + its canonical question (verified-query mode). */
  vqrId?: string;
  vqrQuestion?: string;
  /** The governed metric this turn grounded on (metric-grounded mode). */
  metricId?: string;
  metricLabel?: string;
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
  /**
   * N9 — the governed-contract signal for this turn (absent when no contract is
   * in force). N10's receipt renders it: a green "Verified query" badge, a
   * "Metric-grounded" note, or a "Refused (out of contract)" banner.
   */
  contract?: ContractSignal;
  /** N9 — true when the turn was REFUSED as out-of-contract (no answer fabricated). */
  refused?: boolean;
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

// ── N9: Verified-contract paths ──────────────────────────────────────────────

/**
 * VQR HIT — the governed, approved query IS the plan. Rather than let the model
 * free-generate NL2SQL, pin the steward-approved query into the (source-scoped)
 * grounding so {@link chatGrounded} runs it VERBATIM on the real Azure-native
 * backend and answers only from the actual rows. The approved query drives the
 * answer; the receipt records the VQR hit + confidence.
 */
async function answerFromVerifiedQuery(
  cfg: DataAgentConfig,
  history: ChatTurn[],
  question: string,
  vqr: { query: string; queryLang: string; sourceName: string; id: string; question: string },
  confidence: number,
  sel: { tier: ModelTier },
  reasoningConfigured: boolean,
  ctx?: ReasoningRunContext,
): Promise<ReasoningAnswer> {
  const scoped = scopeConfigToSource(cfg, vqr.sourceName);
  const augmented: DataAgentConfig = {
    ...scoped,
    instructions: [
      scoped.instructions || '',
      '## VERIFIED QUERY (approved by a data steward — governed contract)',
      `A steward-approved ${String(vqr.queryLang || '').toUpperCase()} query is the correct, governed way to answer this question.`,
      `Run EXACTLY this query (verbatim, unmodified) against ${vqr.sourceName || 'the attached source'} and answer ONLY from its real results — emit exactly this query in your tools JSON:`,
      '```',
      vqr.query,
      '```',
    ].filter(Boolean).join('\n'),
  };

  const a = await chatGrounded(augmented, history, question, { tenantId: ctx?.tenantId });
  const executed = !!a.tools?.some((t) => t.executed);
  const rowCount = (a.tools || []).reduce((n, t) => n + (t.rowCount ?? 0), 0);
  const gated = !executed && !!a.tools?.some((t) => t.gate);
  const step: ReasoningStepResult = {
    step: 1,
    source: vqr.sourceName || a.tools?.[0]?.source || 'verified source',
    subQuery: question,
    rationale: `Verified query (approved) matched at ${(confidence * 100).toFixed(0)}% confidence.`,
    status: gated ? 'gated' : 'completed',
    answer: a.answer,
    tools: a.tools,
    executed,
    rowCount,
  };
  return {
    ...a,
    mode: 'plan-execute-verify',
    modelTier: sel.tier,
    reasoningConfigured,
    plan: [],
    steps: [step],
    verify: {
      verdict: executed ? 'pass' : 'partial',
      reason: executed
        ? 'Answered by the steward-approved verified query, grounded on the real rows it returned.'
        : 'The verified query matched but its source was not reachable — surfaced the honest gate.',
    },
    contract: {
      mode: 'verified-query',
      confidence,
      vqrId: vqr.id,
      vqrQuestion: vqr.question,
    },
  };
}

/**
 * OUT OF CONTRACT — REFUSE, do not guess. Returns a structured refusal with a
 * guided message (the questions this agent CAN answer + its governed metrics)
 * instead of a fabricated answer. Pure — makes NO model/backend call, so a
 * refusal never depends on an AOAI deployment being present (the compliance
 * posture holds even in a disconnected IL5 enclave).
 */
function buildRefusalAnswer(
  cfg: DataAgentConfig,
  decision: ContractDecision & { mode: 'refuse' },
  sel: { tier: ModelTier },
  reasoningConfigured: boolean,
): ReasoningAnswer {
  const suggestionsText = decision.suggestions.length
    ? `\n\nQuestions this agent can answer with a verified query:\n${decision.suggestions.map((q) => `• ${q}`).join('\n')}`
    : '';
  const metricsText = decision.metricLabels.length
    ? `\n\nGoverned metrics available: ${decision.metricLabels.join(', ')}.`
    : '';
  const answer =
    `I won't guess. ${decision.reason}` +
    suggestionsText +
    metricsText +
    `\n\nRephrase to reference a governed metric above, or ask a data steward to add a verified query for this question in the semantic model's "Verified Queries" tab.`;
  return {
    answer,
    raw: answer,
    tools: [],
    sourcesAvailable: cfg.sources.map((sr) => sr.name).filter(Boolean),
    mode: 'plan-execute-verify',
    modelTier: sel.tier,
    reasoningConfigured,
    plan: [],
    steps: [],
    verify: { verdict: 'fail', reason: 'Refused — the question is outside the governed semantic contract.' },
    contract: { mode: 'refused' },
    refused: true,
  };
}

/** Layer a matched metric's governed definition onto the agent instructions so
 *  unmatched-but-in-contract generation is grounded on the metric (not free). */
function withMetricGrounding(cfg: DataAgentConfig, metricLabel: string, description: string, grain: string): DataAgentConfig {
  const block = [
    '## Governed metric (semantic contract)',
    `The user is asking about the governed metric "${metricLabel}". Ground your answer on its official definition:`,
    description ? `Definition: ${description}` : '',
    grain ? `Grain: ${grain}` : '',
    'Do not redefine or approximate this metric — compute it per the governed definition.',
  ].filter(Boolean).join('\n');
  return { ...cfg, instructions: [cfg.instructions || '', block].filter(Boolean).join('\n\n') };
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
  const reasoningConfigured = reasoningTierConfigured(tierCfg);

  // ── N9: governed-contract evaluation FIRST (before any model/backend call) ──
  // Retrieve a verified query first, ground on a matched metric, or REFUSE an
  // out-of-contract question. Fail-safe: `{ mode:'none' }` (no contract adopted,
  // or any error) falls straight through to the pre-N9 plan→execute→verify loop.
  const decision = ctx?.contractDecision ?? (await evaluateContract(ctx?.tenantId, question));

  // REFUSE path makes NO model/backend call — so it holds even with no AOAI
  // deployment (and in a disconnected IL5 enclave). Resolve the tier without a
  // real target (routeTurnTier is pure).
  if (decision.mode === 'refuse') {
    const selLite = routeTurnTier({
      cfg: tierCfg, prompt: question, hasTools: cfg.sources.length > 0, baseDeployment: '', taskClass: 'reasoning',
    });
    return buildRefusalAnswer(cfg, decision, selLite, reasoningConfigured);
  }

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
  const stepCtx = { tenantId: ctx?.tenantId };

  // VERIFIED-QUERY HIT — run the steward-approved query verbatim (skip NL2SQL).
  if (decision.mode === 'verified') {
    return answerFromVerifiedQuery(cfg, history, question, decision.vqr, decision.confidence, sel, reasoningConfigured, ctx);
  }

  // METRIC-GROUNDED — the question is in-contract; layer the governed metric
  // definition onto generation and tag the receipt (the loop below stays real).
  let plannerCfg = cfg;
  let contractSignal: ContractSignal | undefined;
  if (decision.mode === 'metric') {
    plannerCfg = withMetricGrounding(cfg, decision.metric.label, decision.metric.description, decision.metric.grain);
    contractSignal = {
      mode: 'metric-grounded',
      confidence: decision.confidence,
      metricId: decision.metric.metricId,
      metricLabel: decision.metric.label,
    };
  }

  // ── PLAN ──────────────────────────────────────────────────────────────────
  const planResp = await aoaiChatTurn(
    target,
    [
      { role: 'system', content: buildPlanPrompt(plannerCfg) },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: question },
    ],
    { deployment: planDeployment, maxCompletionTokens: 900 },
  );
  const plan = sequenceSteps(parsePlan(planResp.content).steps);

  // No plan produced → degrade honestly to a single grounded pass (still real).
  if (plan.length === 0) {
    const single = await chatGrounded(plannerCfg, history, question, stepCtx);
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
      contract: contractSignal,
    };
  }

  // ── EXECUTE ─────────────────────────────────────────────────────────────────
  const stepResults: ReasoningStepResult[] = [];
  const priorContext: ChatTurn[] = [...history];
  for (const st of plan) {
    const stepCfg = scopeConfigToSource(plannerCfg, st.source);
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
    contract: contractSignal,
  };
}
