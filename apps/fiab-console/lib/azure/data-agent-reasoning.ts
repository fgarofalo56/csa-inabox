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
// N12's repair sub-loop re-consults the SAME governed metric registry
// (`matchMetric`) on every attempt, so a rewrite stays inside the contract.
import { evaluateContract, matchMetric, type ContractDecision } from './semantic-contract';
// N11 — GraphRAG retrieval over the AUTHORED Weave ontology (Apache AGE on
// in-VNet PostgreSQL). Types only at module scope: the retriever itself is
// LAZY-imported on the graph path so an agent with no ontology source never
// loads the PG/AGE client (and the pre-N11 module graph is unchanged).
import type {
  GraphPathCitation,
  GraphRagContext,
} from './ontology-graphrag';

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
  /**
   * N11 — the authored ontology this agent grounds on. Supplied by the chat
   * route from the agent's `ontology` / `graph` source + that ontology item's
   * declared object types. Absent ⇒ graph grounding is skipped silently (the
   * loop behaves exactly as pre-N11).
   */
  graph?: {
    /** Ontology item id (also the GraphRAG community-index partition key). */
    ontologyId?: string;
    /** Declared object type apiNames from the ontology item state. */
    objectTypes?: readonly string[];
    /** Authored title property per object type (for readable citations). */
    titleKeys?: Record<string, string>;
    /**
     * The editor's "Graph grounding" toggle. DEFAULT-ON (loom_default_on_opt_out)
     * — only an explicit `false` opts out.
     */
    enabled?: boolean;
    /** Force retrieval even when the question does not read as multi-hop. */
    always?: boolean;
    /** Traversal depth override (tests / advanced callers). */
    maxHops?: number;
  };
  /**
   * N12 — bounded repair attempts per step. Absent ⇒
   * {@link nl2sqlRepairMaxAttempts} (LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS, default 2).
   */
  maxRepairAttempts?: number;
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

/**
 * N11 — the graph-grounding signal for this turn. Flows into N10's AnswerReceipt
 * as typed GRAPH-PATH CITATIONS so an auditor sees the exact traversal that
 * grounded the answer.
 */
export interface GraphGroundingSignal {
  /** True when real graph context was retrieved and layered onto the prompt. */
  used: boolean;
  ontologyId?: string;
  /** Traversal depth actually attempted. */
  hops: number;
  /** Seed entities the question resolved to on the REAL graph. */
  seeds: Array<{ id: string; objectType: string; title: string; matchedOn: string[] }>;
  /** The typed graph-path citations (receipt-ready). */
  paths: GraphPathCitation[];
  /** Precomputed community summaries covering the retrieved subgraph. */
  communities: Array<{ communityId: string; summary: string; size: number }>;
  /** Instances scanned while matching seeds (honest retrieval cost). */
  scanned: number;
  durationMs: number;
  /** Honest infra gate when the Weave AGE backend is not wired. */
  gate?: string;
  /** Why nothing was retrieved, when `used` is false but no gate fired. */
  note?: string;
}

/**
 * N12 — one bounded repair attempt on a failing / implausible step. Every
 * attempt is recorded (attempt #, why, the error, the rewritten query, the
 * EXPLAIN guardrail verdict) and surfaced in the receipt.
 */
export interface RepairAttempt {
  /** Plan step this repaired (1-based; 1 for the single-pass path). */
  step: number;
  /** 1-based attempt number within the bounded loop. */
  attempt: number;
  /** Why a repair was triggered (query error / implausible empty result). */
  reason: string;
  /** The backend error / honest gate that triggered it. */
  error?: string;
  /** The query the model rewrote after re-reading the LIVE schema. */
  rewrittenQuery?: string;
  /** EXPLAIN plan summary (Synapse MPP) when the guardrail ran. */
  explainSummary?: string;
  /** EXPLAIN compile error — the rewrite is still invalid, so it is NOT run. */
  explainError?: string;
  /** Characters of live schema re-read for this attempt (0 = none available). */
  schemaChars: number;
  /** The governed metric (N9) consulted for this attempt, when one matched. */
  metricConsulted?: string;
  /** repaired = the re-run succeeded · still-failing · abandoned (bound hit). */
  outcome: 'repaired' | 'still-failing' | 'abandoned';
  /** Rows the repaired run returned. */
  rowCount?: number;
}

/**
 * N12 — does the answer actually FOLLOW from the real rows the backends
 * returned? Computed from the executed tools' real rows, never from the model.
 */
export interface PlausibilityVerdict {
  plausible: boolean;
  reason: string;
  /** Total rows returned across every executed tool. */
  rowsSeen: number;
  /** Figures asserted in the answer that appear nowhere in the returned rows. */
  unsupportedFigures?: string[];
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
  /** N12 — the bounded repair attempts this step needed (absent when none). */
  repairs?: RepairAttempt[];
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
  /**
   * N11 — graph grounding for this turn (absent when the agent has no ontology
   * source / the flag is off / nothing matched). OPTIONAL: every pre-N11 caller
   * (including N9's and N10's) compiles unchanged.
   */
  graph?: GraphGroundingSignal;
  /** N12 — every bounded repair attempt across every step (absent when none). */
  repairs?: RepairAttempt[];
  /** N12 — does the answer follow from the real returned rows? */
  plausibility?: PlausibilityVerdict;
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
    ...(cfg.instructions?.trim()
      // The agent's own instructions carry the routing rules AND (N9/N11) the
      // governed-metric definition + the REAL graph facts retrieved from the
      // authored ontology — the planner must see them to plan a correct
      // multi-hop decomposition.
      ? ['', 'Agent instructions + grounded context:', cfg.instructions.slice(0, 12000)]
      : []),
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
 * N15 — layer the governed metric's NATIVELY-COMPILED SQL onto the agent
 * instructions so the NL2SQL answer computes the metric through the SAME compiler
 * the report designer and the /api/metrics/query endpoint use ("one metric, one
 * number everywhere"). Consumer 2 of the metrics layer. Best-effort + fail-safe:
 * a missing spec, an unmatched metric (metric-view sourceKind not in the imported
 * MetricFlow spec), the FLAG0 kill-switch OFF, or ANY error leaves grounding
 * byte-identical to the pre-N15 path. Lazy-imports keep the module graph light
 * for agents that never take the metric branch.
 */
async function withCompiledMetricGrounding(
  cfg: DataAgentConfig,
  tenantId: string | undefined,
  metricId: string,
): Promise<DataAgentConfig> {
  if (!tenantId || !metricId) return cfg;
  try {
    const { runtimeFlag } = await import('@/lib/admin/runtime-flags');
    if (!(await runtimeFlag('n15-metrics-layer', { default: true }))) return cfg;
    const { getSemanticSpec } = await import('./semantic-contract');
    const raw = await getSemanticSpec(tenantId);
    if (!raw) return cfg;
    const [{ normalizeSpec }, { resolveMetricForNl }] = await Promise.all([
      import('@/lib/metrics/metricflow-spec'),
      import('@/lib/metrics/consumers'),
    ]);
    const compiled = resolveMetricForNl({ spec: normalizeSpec(raw), metric: metricId, engine: 'synapse' });
    const block = [
      '## Governed metric SQL (compiled by the Loom metrics layer)',
      'Compute this metric with EXACTLY this governed SQL — the same query the report ' +
        'designer and the POST /api/metrics/query endpoint run — so your number matches everywhere:',
      '```sql',
      compiled.sql,
      '```',
    ].join('\n');
    return { ...cfg, instructions: [cfg.instructions || '', block].filter(Boolean).join('\n\n') };
  } catch {
    return cfg;
  }
}

// ── N11: GraphRAG grounding over the authored Weave/AGE ontology ─────────────

/** Source types that carry an authored ontology / graph binding. */
const GRAPH_SOURCE_TYPES = new Set(['ontology', 'graph']);

/**
 * Resolve the FLAG0 kill-switch for graph grounding. DEFAULT-ON: a missing flag
 * doc (or an unreadable Cosmos) enables the path. Lazy-imported so the pre-N11
 * module graph is byte-identical for agents that never touch the graph path.
 */
async function graphGroundingFlagOn(): Promise<boolean> {
  try {
    const [{ runtimeFlag }, { GRAPHRAG_FLAG_ID }] = await Promise.all([
      import('@/lib/admin/runtime-flags'),
      import('./ontology-graphrag'),
    ]);
    return await runtimeFlag(GRAPHRAG_FLAG_ID, { default: true });
  } catch {
    return true; // default-ON posture survives a flag-substrate hiccup
  }
}

/**
 * Retrieve GraphRAG context for this turn when the agent is bound to an
 * authored ontology. Returns `undefined` when graph grounding does not apply
 * (no ontology source, toggle off, flag off) so the caller stays on the exact
 * pre-N11 path. FAIL-SAFE: any retrieval error degrades to a note, never an
 * exception — a graph hiccup must never take an agent turn down.
 */
async function retrieveGraphGrounding(
  cfg: DataAgentConfig,
  question: string,
  ctx?: ReasoningRunContext,
): Promise<{ signal: GraphGroundingSignal; block: string } | undefined> {
  const g = ctx?.graph;
  if (!g || g.enabled === false) return undefined;
  const hasGraphSource = cfg.sources.some((s) => GRAPH_SOURCE_TYPES.has(String(s.type)));
  const objectTypes = (g.objectTypes || []).filter(Boolean);
  if (!hasGraphSource && !g.ontologyId) return undefined;
  if (objectTypes.length === 0) return undefined;
  if (!(await graphGroundingFlagOn())) return undefined;

  let mod: typeof import('./ontology-graphrag');
  try {
    mod = await import('./ontology-graphrag');
  } catch {
    return undefined;
  }
  // A single-entity lookup does not need a traversal; a relational question
  // does. `always` (the editor toggle's "always ground" mode) overrides.
  if (!g.always && !mod.isMultiHopQuestion(question)) return undefined;

  let res: GraphRagContext;
  try {
    res = await mod.retrieveGraphContext({
      question,
      objectTypes,
      titleKeys: g.titleKeys,
      ontologyId: g.ontologyId,
      maxHops: g.maxHops,
    });
  } catch (e) {
    return {
      signal: {
        used: false, hops: 0, seeds: [], paths: [], communities: [], scanned: 0, durationMs: 0,
        ontologyId: g.ontologyId,
        note: `Graph grounding could not run: ${(e as Error)?.message || String(e)}`,
      },
      block: '',
    };
  }

  const signal: GraphGroundingSignal = {
    used: res.ok && (res.paths.length > 0 || res.seeds.length > 0),
    ontologyId: res.ontologyId,
    hops: res.hops,
    seeds: res.seeds.map((s) => ({ id: s.id, objectType: s.objectType, title: s.title, matchedOn: s.matchedOn })),
    paths: res.paths,
    communities: res.communities.map((c) => ({ communityId: c.communityId, summary: c.summary, size: c.size })),
    scanned: res.scanned,
    durationMs: res.durationMs,
    gate: res.gate ? `${res.gate.detail} ${res.gate.remediation}` : undefined,
    note: res.note,
  };
  // The retriever already rendered the grounding block from the REAL subgraph.
  return { signal, block: signal.used ? res.contextText : '' };
}

/** Layer the retrieved graph facts onto the agent instructions. Pure. */
function withGraphGrounding(cfg: DataAgentConfig, block: string): DataAgentConfig {
  if (!block.trim()) return cfg;
  return { ...cfg, instructions: [cfg.instructions || '', block].filter(Boolean).join('\n\n') };
}

// ── N12: self-healing / verified NL2SQL repair loop ─────────────────────────

/** Backend errors a schema-grounded rewrite can plausibly fix. */
const REPAIRABLE_ERROR =
  /invalid object name|invalid column name|incorrect syntax|could not be bound|is not a recognized|no such (table|column)|does not exist|unknown (table|column|function)|undefined (table|column)|ambiguous column|syntax error|parse error|semantic error|SEM\d{3,4}|failed to resolve|cannot find (the )?(table|column)/i;

/**
 * Bounded repair attempts per step. Optional tuning knob
 * `LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS` (G2-registered as an optionalDefault gate)
 * — UNSET is the fully-functional default of 2. Clamped to [0,5] so a
 * mis-typed value can never produce an unbounded loop.
 */
export function nl2sqlRepairMaxAttempts(override?: number): number {
  // NOTE: `Number('')` is 0, not NaN — an UNSET var must fall through to the
  // default of 2, never silently disable the repair loop.
  const raw = (process.env.LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS || '').trim();
  const n = override ?? (raw ? Number(raw) : Number.NaN);
  if (!Number.isFinite(n)) return 2;
  return Math.min(Math.max(Math.trunc(n), 0), 5);
}

/** What a step's outcome says about whether a repair is worth attempting. */
export interface StepFailureClass {
  repairable: boolean;
  reason: string;
  error?: string;
  /** The query that failed (fed to the rewriter). */
  query?: string;
  /** The source the failing query ran against. */
  source?: string;
}

/**
 * Classify a step outcome for repair. PURE — reads only the real tool metadata
 * the backend produced (executed / gate / rowCount), never the model's prose.
 */
export function classifyStepFailure(
  a: { tools?: DataAgentTool[] } | null | undefined,
  thrown?: unknown,
): StepFailureClass {
  if (thrown) {
    const msg = (thrown as Error)?.message || String(thrown);
    return { repairable: REPAIRABLE_ERROR.test(msg), reason: 'The step threw while executing.', error: msg };
  }
  const tools = a?.tools || [];
  const failed = tools.find((t) => !t.executed && t.gate && REPAIRABLE_ERROR.test(t.gate));
  if (failed) {
    return {
      repairable: true,
      reason: 'The generated query failed against the live backend (schema drift or a malformed query).',
      error: failed.gate,
      query: failed.query,
      source: failed.source,
    };
  }
  const executed = tools.filter((t) => t.executed);
  if (executed.length > 0 && executed.every((t) => (t.rowCount ?? 0) === 0)) {
    const first = executed[0];
    return {
      repairable: true,
      reason: 'Every executed query returned 0 rows — an implausible result for this sub-question.',
      query: first.query,
      source: first.source,
    };
  }
  return { repairable: false, reason: 'The step executed and returned rows.' };
}

/** Re-read the LIVE warehouse schema for a repair attempt (soft-fails to ''). */
async function readLiveSchema(): Promise<string> {
  try {
    const { fetchSynapseSchemaContext } = await import('@/lib/copilot/sql-tools');
    return await fetchSynapseSchemaContext();
  } catch {
    return '';
  }
}

/**
 * EXPLAIN cost guardrail — compile the rewritten T-SQL on the REAL Synapse
 * dedicated pool (`EXPLAIN WITH_RECOMMENDATIONS`, compiled not executed) and
 * summarize its distributed plan via sql-tools. A compile failure means the
 * rewrite is STILL invalid, so we never spend an execution on it — the compile
 * error feeds the next attempt instead. Returns `null` when EXPLAIN does not
 * apply (non-warehouse source / pool not configured).
 */
async function explainGuardrail(sql: string): Promise<{ ok: boolean; summary?: string; error?: string } | null> {
  const text = String(sql || '').trim();
  if (!text) return null;
  try {
    const [{ dedicatedTarget, explainQuery }, { summarizeExplainXml }] = await Promise.all([
      import('./synapse-sql-client'),
      import('@/lib/copilot/sql-tools'),
    ]);
    let target: ReturnType<typeof dedicatedTarget>;
    try {
      target = dedicatedTarget();
    } catch {
      return null; // no dedicated pool wired → EXPLAIN does not apply
    }
    const xml = await explainQuery(target, text, true);
    return { ok: true, summary: summarizeExplainXml(xml) };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) };
  }
}

/** Pull the first fenced code block out of a model reply (else the whole text). */
export function extractQueryBlock(text: string): string {
  const s = String(text || '');
  const fenced = s.match(/```(?:[a-z0-9_+-]*)\n([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : s).trim();
  return body;
}

/** Pin an exact query into a (source-scoped) config so chatGrounded runs it. */
function withPinnedQuery(cfg: DataAgentConfig, query: string, why: string): DataAgentConfig {
  return {
    ...cfg,
    instructions: [
      cfg.instructions || '',
      '## REPAIRED QUERY (self-healing loop)',
      why,
      'Run EXACTLY this query (verbatim, unmodified) and answer ONLY from its real results — emit exactly this query in your tools JSON:',
      '```',
      query,
      '```',
    ].filter(Boolean).join('\n'),
  };
}

function buildRepairPrompt(): string {
  return [
    'You REPAIR a failed analytical query for a CSA Loom data agent (Azure-native: Synapse / ADX / Databricks / Azure AI Search — never Microsoft Fabric).',
    'You are given the sub-question, the query that failed, the exact backend error, the CURRENT LIVE SCHEMA read from the catalog moments ago, and (when one governs the question) the official metric definition.',
    'Rewrite the query so it is valid against the LIVE schema shown. Use only tables and columns that appear there. Preserve the intent of the sub-question. If a governed metric is given, compute it per its official definition.',
    'Return EXACTLY ONE fenced code block containing ONLY the corrected query, and nothing else.',
  ].join('\n');
}

function buildRepairContext(args: {
  subQuery: string;
  failedQuery?: string;
  error?: string;
  schema: string;
  metric?: { label: string; description: string; grain: string };
  priorExplainError?: string;
}): string {
  const lines: string[] = [`Sub-question: ${args.subQuery}`];
  if (args.failedQuery) lines.push('', 'Query that failed:', '```', args.failedQuery, '```');
  if (args.error) lines.push('', `Backend error: ${args.error}`);
  if (args.priorExplainError) {
    lines.push('', `The previous rewrite ALSO failed to compile: ${args.priorExplainError}`);
  }
  if (args.metric) {
    lines.push('', `Governed metric "${args.metric.label}" applies.`);
    if (args.metric.description) lines.push(`Definition: ${args.metric.description}`);
    if (args.metric.grain) lines.push(`Grain: ${args.metric.grain}`);
  }
  lines.push(
    '',
    args.schema
      ? `CURRENT LIVE SCHEMA (read from the catalog just now):\n${args.schema}`
      : 'CURRENT LIVE SCHEMA: unavailable (the pool did not answer) — rewrite conservatively using only objects named in the sub-question.',
  );
  return lines.join('\n');
}

/** Roll a grounded answer's real execution metadata into step fields. */
function stepExecutionMeta(a: DataAgentAnswer): { executed: boolean; rowCount: number; gated: boolean } {
  const executed = !!a.tools?.some((t) => t.executed);
  const rowCount = (a.tools || []).reduce((n, t) => n + (t.rowCount ?? 0), 0);
  const gated = !executed && !!a.tools?.some((t) => t.gate);
  return { executed, rowCount, gated };
}

// ── N12: plausibility — does the answer follow from the REAL rows? ───────────

/** Normalize a figure for comparison: strip separators, currency, and %. */
function normalizeFigure(s: string): string {
  return String(s).replace(/[,\s$€£%]/g, '');
}

/** Every numeric figure asserted in a prose answer. Pure. */
export function assertedFigures(answer: string): string[] {
  const out: string[] = [];
  for (const m of String(answer || '').matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0];
    const norm = normalizeFigure(raw);
    // Ignore single digits + bare years: they are almost always ordinals /
    // step numbers / dates in narration, not asserted measurements.
    if (norm.replace('-', '').length < 2) continue;
    if (/^(19|20)\d{2}$/.test(norm)) continue;
    out.push(norm);
  }
  return Array.from(new Set(out));
}

/**
 * VERIFY-side plausibility: the answer must follow from the rows the backends
 * ACTUALLY returned. Pure — reads the real `tools[].rows` the executor captured,
 * never the model's own claims.
 */
export function assessPlausibility(
  finalAnswer: string,
  steps: readonly ReasoningStepResult[],
): PlausibilityVerdict {
  const executedTools = steps.flatMap((s) => (s.tools || []).filter((t) => t.executed));
  const rowsSeen = executedTools.reduce((n, t) => n + (t.rowCount ?? 0), 0);

  if (executedTools.length === 0) {
    return {
      plausible: false,
      reason: 'No step executed a query against a real backend — the answer is not grounded in returned rows.',
      rowsSeen: 0,
    };
  }
  if (rowsSeen === 0) {
    const saysEmpty = /\b(no|zero|none|empty|no matching|nothing)\b/i.test(finalAnswer || '');
    return {
      plausible: saysEmpty,
      reason: saysEmpty
        ? 'Every executed query returned 0 rows and the answer honestly reports an empty result.'
        : 'Every executed query returned 0 rows, but the answer asserts findings that cannot follow from an empty result set.',
      rowsSeen: 0,
    };
  }

  // Build the corpus of figures the REAL rows contain (cell values + row counts).
  const corpus = new Set<string>();
  for (const t of executedTools) {
    if (typeof t.rowCount === 'number') corpus.add(normalizeFigure(String(t.rowCount)));
    for (const row of t.rows || []) {
      for (const cell of row as unknown[]) {
        if (cell === null || cell === undefined) continue;
        corpus.add(normalizeFigure(String(cell)));
      }
    }
  }
  const corpusText = [...corpus].join(' ');
  const figures = assertedFigures(finalAnswer);
  const unsupported = figures.filter((f) => !corpus.has(f) && !corpusText.includes(f));

  if (figures.length > 0 && unsupported.length === figures.length) {
    return {
      plausible: false,
      reason: `The answer cites ${figures.length} figure(s) that appear nowhere in the ${rowsSeen} row(s) the backends returned.`,
      rowsSeen,
      unsupportedFigures: unsupported.slice(0, 8),
    };
  }
  return {
    plausible: true,
    reason:
      figures.length > 0
        ? `The answer's figures are traceable to the ${rowsSeen} row(s) the backends actually returned.`
        : `The answer is grounded on ${rowsSeen} real row(s) returned by the executed queries.`,
    rowsSeen,
    unsupportedFigures: unsupported.length ? unsupported.slice(0, 8) : undefined,
  };
}

/**
 * Run ONE plan step with the N12 bounded self-healing repair sub-loop.
 *
 * On a query error or an implausible (all-empty) result the loop REPAIRS:
 *   1. re-reads the LIVE schema from the catalog,
 *   2. consults N9's governed metric contract (`matchMetric`),
 *   3. asks the model for a schema-grounded rewrite,
 *   4. runs the EXPLAIN cost guardrail before spending an execution,
 *   5. pins the rewrite and re-runs it on the REAL backend.
 *
 * Every attempt is recorded for the receipt. STRICTLY BOUNDED by
 * {@link nl2sqlRepairMaxAttempts} — the loop can never run away.
 */
async function executeStepWithRepair(args: {
  stepNo: number;
  source: string;
  subQuery: string;
  rationale?: string;
  cfg: DataAgentConfig;
  history: ChatTurn[];
  stepCtx: { tenantId?: string };
  target: Parameters<typeof aoaiChatTurn>[0];
  deployment: string;
  maxAttempts: number;
  tenantId?: string;
}): Promise<ReasoningStepResult> {
  const repairs: RepairAttempt[] = [];
  let answer: DataAgentAnswer | null = null;
  let thrown: unknown = null;
  try {
    answer = await chatGrounded(args.cfg, args.history, args.subQuery, args.stepCtx);
  } catch (e) {
    thrown = e;
  }

  let cls = classifyStepFailure(answer, thrown);
  let priorExplainError: string | undefined;

  for (let attempt = 1; cls.repairable && attempt <= args.maxAttempts; attempt++) {
    const record: RepairAttempt = {
      step: args.stepNo,
      attempt,
      reason: cls.reason,
      error: cls.error,
      schemaChars: 0,
      outcome: 'still-failing',
    };

    // 1) LIVE schema re-read + 2) governed metric consult (N9).
    const schema = await readLiveSchema();
    record.schemaChars = schema.length;
    let metric: { label: string; description: string; grain: string } | undefined;
    if (args.tenantId) {
      try {
        const hit = await matchMetric(args.tenantId, args.subQuery);
        if (hit) {
          metric = { label: hit.metric.label, description: hit.metric.description, grain: hit.metric.grain };
          record.metricConsulted = hit.metric.metricId;
        }
      } catch {
        /* the contract is advisory here — never blocks a repair */
      }
    }

    // 3) Schema-grounded rewrite.
    let rewritten = '';
    try {
      const resp = await aoaiChatTurn(
        args.target,
        [
          { role: 'system', content: buildRepairPrompt() },
          {
            role: 'user',
            content: buildRepairContext({
              subQuery: args.subQuery,
              failedQuery: cls.query,
              error: cls.error,
              schema,
              metric,
              priorExplainError,
            }),
          },
        ],
        { deployment: args.deployment, maxCompletionTokens: 700 },
      );
      rewritten = extractQueryBlock(resp.content);
    } catch (e) {
      record.outcome = 'still-failing';
      record.error = `${record.error ? `${record.error} · ` : ''}rewrite failed: ${(e as Error)?.message || String(e)}`;
      repairs.push(record);
      break;
    }
    if (!rewritten) {
      record.outcome = 'still-failing';
      repairs.push(record);
      break;
    }
    record.rewrittenQuery = rewritten;

    // 4) EXPLAIN cost guardrail BEFORE spending an execution. Only a Synapse
    //    dedicated-pool (warehouse) rewrite can be compiled by EXPLAIN — every
    //    other source type skips straight to the bounded re-run.
    const explainEligible = args.cfg.sources.some((s) => String(s.type) === 'warehouse');
    const guard = explainEligible ? await explainGuardrail(rewritten) : null;
    if (guard && !guard.ok) {
      record.explainError = guard.error;
      record.outcome = 'still-failing';
      repairs.push(record);
      priorExplainError = guard.error;
      cls = { ...cls, error: guard.error, query: rewritten };
      continue;
    }
    if (guard?.summary) record.explainSummary = guard.summary;

    // 5) Re-run the pinned rewrite on the REAL backend.
    const pinned = withPinnedQuery(
      args.cfg,
      rewritten,
      `A previous attempt failed (${cls.error || cls.reason}). This query was rewritten against the schema read live from the catalog${record.explainSummary ? ' and compiled successfully by EXPLAIN' : ''}.`,
    );
    try {
      const retry = await chatGrounded(pinned, args.history, args.subQuery, args.stepCtx);
      const meta = stepExecutionMeta(retry);
      record.rowCount = meta.rowCount;
      const retryCls = classifyStepFailure(retry, null);
      if (!retryCls.repairable) {
        record.outcome = 'repaired';
        repairs.push(record);
        answer = retry;
        thrown = null;
        cls = retryCls;
        break;
      }
      repairs.push(record);
      answer = retry;
      thrown = null;
      cls = retryCls;
      priorExplainError = undefined;
    } catch (e) {
      record.outcome = 'still-failing';
      repairs.push(record);
      thrown = e;
      cls = classifyStepFailure(null, e);
      priorExplainError = undefined;
    }
  }

  // Bound hit while still failing → record the honest abandonment.
  if (cls.repairable && repairs.length > 0 && repairs[repairs.length - 1].outcome !== 'repaired') {
    repairs[repairs.length - 1].outcome = 'abandoned';
  }

  if (!answer) {
    return {
      step: args.stepNo,
      source: args.source,
      subQuery: args.subQuery,
      rationale: args.rationale,
      status: 'error',
      error: (thrown as Error)?.message || String(thrown || 'step failed'),
      ...(repairs.length ? { repairs } : {}),
    };
  }
  const meta = stepExecutionMeta(answer);
  return {
    step: args.stepNo,
    source: args.source,
    subQuery: args.subQuery,
    rationale: args.rationale,
    status: meta.gated ? 'gated' : 'completed',
    answer: answer.answer,
    tools: answer.tools,
    executed: meta.executed,
    rowCount: meta.rowCount,
    ...(repairs.length ? { repairs } : {}),
  };
}

/**
 * N10 wiring — map a {@link ReasoningAnswer} onto the OPTIONAL receipt-assembler
 * inputs (`assembleAnswerReceipt(trace, opts)`), so N11's graph-path citations,
 * N12's repair attempts, and the plausibility verdict land in the persisted
 * Answer Receipt. Pure; every field is optional, so N10's type is untouched and
 * a turn with none of these assembles exactly as before.
 */
export interface ReasoningReceiptExtras {
  graphPathCitations?: Array<{
    id: string; hops: number; text: string; nodes: string[]; links: string[]; communityId?: string;
  }>;
  repairAttempts?: RepairAttempt[];
  plausibility?: PlausibilityVerdict;
}

export function reasoningReceiptExtras(answer: ReasoningAnswer): ReasoningReceiptExtras {
  const out: ReasoningReceiptExtras = {};
  const paths = answer.graph?.paths || [];
  if (paths.length) {
    out.graphPathCitations = paths.map((p) => ({
      id: p.id,
      hops: p.hops,
      text: p.text,
      nodes: p.nodes.map((n) => `${n.title} (${n.objectType})`),
      links: [...p.links],
      communityId: p.communityId,
    }));
  }
  if (answer.repairs?.length) out.repairAttempts = answer.repairs;
  if (answer.plausibility) out.plausibility = answer.plausibility;
  return out;
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
    // N15: also ground on the metric's NATIVELY-compiled governed SQL when an
    // imported MetricFlow spec defines it (fail-safe — unchanged otherwise).
    plannerCfg = await withCompiledMetricGrounding(plannerCfg, ctx?.tenantId, decision.metric.metricId);
    contractSignal = {
      mode: 'metric-grounded',
      confidence: decision.confidence,
      metricId: decision.metric.metricId,
      metricLabel: decision.metric.label,
    };
  }

  // ── N11: GRAPHRAG RETRIEVAL (a retrieval source alongside N9's grounding) ──
  // A relational, multi-hop question retrieves over the AUTHORED ontology first:
  // seed entities → multi-hop traversal on Apache AGE → subgraph + precomputed
  // community summaries → graph facts layered onto the PLANNER and every EXECUTE
  // step, plus typed graph-path citations for N10's receipt. Fail-safe: absent /
  // gated / unmatched retrieval leaves the pre-N11 path byte-identical.
  const graphGrounding = await retrieveGraphGrounding(cfg, question, ctx);
  const graphSignal = graphGrounding?.signal;
  if (graphGrounding?.block) {
    plannerCfg = withGraphGrounding(plannerCfg, graphGrounding.block);
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
      ...(graphSignal ? { graph: graphSignal } : {}),
    };
  }

  // ── EXECUTE (N12: each step carries the bounded self-healing repair loop) ──
  const stepResults: ReasoningStepResult[] = [];
  const priorContext: ChatTurn[] = [...history];
  const maxRepairAttempts = nl2sqlRepairMaxAttempts(ctx?.maxRepairAttempts);
  for (const st of plan) {
    const stepCfg = scopeConfigToSource(plannerCfg, st.source);
    const result = await executeStepWithRepair({
      stepNo: st.step,
      source: st.source,
      subQuery: st.subQuery,
      rationale: st.rationale,
      cfg: stepCfg,
      history: priorContext,
      stepCtx,
      target,
      deployment: planDeployment,
      maxAttempts: maxRepairAttempts,
      tenantId: ctx?.tenantId,
    });
    stepResults.push(result);
    // Thread this step's answer forward so a dependent step can build on it.
    if (result.answer) {
      priorContext.push({ role: 'user', content: st.subQuery }, { role: 'assistant', content: result.answer });
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

  // ── N12: PLAUSIBILITY — does the final answer follow from the REAL rows? ──
  // Computed from the executor's captured rows (never from the model's prose),
  // so a confidently-worded answer over an empty/unrelated result set is caught.
  const plausibility = assessPlausibility(finalAnswer, stepResults);
  if (!plausibility.plausible && verdict === 'pass') {
    // A verify "pass" that the real rows do not support is downgraded honestly.
    verdict = 'partial';
    reason = `${reason} Plausibility check: ${plausibility.reason}`;
  }

  const allRepairs = stepResults.flatMap((st) => st.repairs || []);
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
    ...(graphSignal ? { graph: graphSignal } : {}),
    ...(allRepairs.length ? { repairs: allRepairs } : {}),
    plausibility,
  };
}
