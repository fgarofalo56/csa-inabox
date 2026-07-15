/**
 * AIF-12 — Loom-native model TIER ROUTER (pure, testable).
 *
 * A typed routing policy that maps a request's *task class* to a *deployment
 * tier*, so cheap/lightweight turns ride a mini deployment while hard/reasoning
 * turns ride a stronger one. It is:
 *
 *   • **Default-ON / opt-out.** `enabled` is true unless an admin explicitly
 *     disables it. Tier deployments resolve DAY-ONE from the env deployments
 *     admin-plane bicep wires (`LOOM_AOAI_MINI_DEPLOYMENT` / `LOOM_AOAI_DEPLOYMENT`
 *     / `LOOM_AOAI_STRONG_DEPLOYMENT`), so best-per-task routing is active out of
 *     the box (see {@link tierPolicyFromConfig}). When NO tier deployments are
 *     configured (env unset AND no tenant cfg) the policy is a safe no-op — every
 *     turn rides the resolved default deployment (no surprise deployment swap, no
 *     vaporware). A missing mini/strong tier degrades gracefully to the standard
 *     deployment rather than failing.
 *   • **Admin-configurable.** The task-class → tier mapping and the per-tier
 *     deployment names come from the tenant Copilot config
 *     (Admin → Copilot & Agents → Model tiers), which OVERRIDES the day-one env
 *     defaults below. `standard` falls back to the tenant's Copilot chat
 *     deployment, then the env chat deployment.
 *   • **Per-call override preserved.** Callers may force a tier (`overrideTier`)
 *     or pass a pre-resolved deployment/target, in which case the router is a
 *     no-op — this is how the Wave-4 model-tier selector (an explicit deployment
 *     override) keeps winning over the auto-router.
 *
 * This module holds NO Azure-SDK / config-store dependency: it operates on a
 * plain {@link TierPolicy} and a structural config shape, so both the unified
 * `aoai-chat-client` and the cross-item `copilot-orchestrator` can consult it
 * without a circular import. The forced-`tool_choice` LLM *learned* router is
 * the CTS-16 P3 deepening on top of this deterministic default.
 *
 * Grounding: Azure OpenAI Model Router / app-layer tiering
 * (https://learn.microsoft.com/azure/foundry/openai/how-to/model-router).
 */

/** Cost/quality tier a turn is dispatched on. */
export type ModelTier = 'mini' | 'standard' | 'strong';

/** Complexity class a request is bucketed into before tier mapping. */
export type TaskClass = 'lightweight' | 'general' | 'reasoning';

export const MODEL_TIERS: readonly ModelTier[] = ['mini', 'standard', 'strong'];
export const TASK_CLASSES: readonly TaskClass[] = ['lightweight', 'general', 'reasoning'];

/** Human labels for the admin "Model tiers" table + the transparency chip. */
export const TIER_LABELS: Record<ModelTier, string> = {
  mini: 'Mini (cheapest)',
  standard: 'Standard (default)',
  strong: 'Strong (reasoning)',
};

export const TASK_CLASS_LABELS: Record<TaskClass, string> = {
  lightweight: 'Lightweight — short lookups / classification / greetings',
  general: 'General — most chat + build requests',
  reasoning: 'Reasoning — design / debug / multi-step / long context',
};

/** Per-tier deployment names. `standard` defaults to the tenant chat deployment. */
export interface TierDeployments {
  mini?: string;
  standard?: string;
  strong?: string;
}

/** The resolved routing policy consulted per turn. */
export interface TierPolicy {
  /** Default-ON. When false the router is a no-op (every turn rides the base). */
  enabled: boolean;
  /** Deployment name for each tier (missing tiers fall back to standard → base). */
  tiers: TierDeployments;
  /** task-class → tier mapping (admin-overridable; defaults below). */
  taskMap: Record<TaskClass, ModelTier>;
}

/** Sensible default mapping: cheap → mini, most → standard, hard → strong. */
export const DEFAULT_TASK_TIER_MAP: Record<TaskClass, ModelTier> = {
  lightweight: 'mini',
  general: 'standard',
  reasoning: 'strong',
};

/** Default-ON policy with no tier deployments wired (a pure no-op until an admin
 *  configures mini / strong — it then rides the resolved default). */
export const DEFAULT_TIER_POLICY: TierPolicy = {
  enabled: true,
  tiers: {},
  taskMap: { ...DEFAULT_TASK_TIER_MAP },
};

// ── Task-class classifier (deterministic heuristic) ──────────────────────────

/** Reasoning signals: design / analysis / multi-step / code-heavy intent. */
const REASONING_RE =
  /\b(?:why|design|architect(?:ure)?|debug|troubleshoot|root[\s-]?cause|optimi[sz]e|refactor|prove|derive|algorithm|strateg(?:y|ize)|trade[\s-]?off|compare|analy[sz]e|plan\b|reason|step[\s-]?by[\s-]?step|complex|migrate|diagnose)\b/i;

/** Code/query signals — a fenced block or a heavy SQL/KQL/DAX keyword. */
const CODE_RE = /```|\b(?:select\s.*\bfrom\b|create\s+table|def\s+\w+|class\s+\w+|summarize\s.*\bby\b|evaluate\s*\(|\| where\b|\| summarize\b)/i;

/** Lightweight signals: short lookups, greetings, yes/no, simple "what is". */
const LIGHTWEIGHT_RE =
  /^\s*(?:hi|hey|hello|thanks|thank you|ok|okay|yes|no|yep|nope|what\s+is\b|what's\b|who\s+is\b|define\b|list\b|show\b|translate\b)/i;

/**
 * Bucket a request into a {@link TaskClass} with a deterministic, explainable
 * heuristic (no LLM round-trip — the learned classifier is CTS-16 P3). Rules,
 * in priority order:
 *   1. Reasoning — reasoning/analysis keyword, a code/query block, tool-driven
 *      build intent, or a long prompt (> 600 chars ≈ multi-paragraph).
 *   2. Lightweight — a short (< 140 char) greeting / lookup with no code.
 *   3. General — everything else.
 */
export function classifyTaskClass(
  prompt: string,
  opts: { hasTools?: boolean } = {},
): TaskClass {
  const p = (prompt || '').trim();
  const len = p.length;
  if (REASONING_RE.test(p) || CODE_RE.test(p) || len > 600 || (opts.hasTools && len > 240)) {
    return 'reasoning';
  }
  if (len > 0 && len < 140 && LIGHTWEIGHT_RE.test(p) && !CODE_RE.test(p)) {
    return 'lightweight';
  }
  return 'general';
}

// ── Tier selection ───────────────────────────────────────────────────────────

/** The outcome of a routing decision (what CTS-16 surfaces). */
export interface TierSelection {
  /** The tier actually ridden (honest: falls back when a tier has no deployment). */
  tier: ModelTier;
  /** The task class the request was bucketed into. */
  taskClass: TaskClass;
  /** The resolved deployment for the chosen tier (the base when none applies). */
  deployment?: string;
  /** True only when routing actively swapped the deployment away from the base. */
  routed: boolean;
  /** PSR-8 — true when a latency-SLO breach shaved a tier off this turn. */
  sloProtected?: boolean;
}

/**
 * PSR-8 — shave ONE cost/quality tier off `from` to protect a breaching latency
 * SLO: strong → standard → mini. Pure. `reasoning`-class turns are never
 * downshifted (the caller guards that); this is the tier arithmetic only.
 */
export function downshiftTier(from: ModelTier): ModelTier {
  return from === 'strong' ? 'standard' : from === 'standard' ? 'mini' : 'mini';
}

export interface TierSelectInput {
  /** Explicit task class (skips classification when supplied). */
  taskClass?: TaskClass;
  /** Prompt to classify when `taskClass` is absent. */
  prompt?: string;
  /** Whether the turn advertises tools (nudges toward reasoning). */
  hasTools?: boolean;
  /** Force a specific tier (per-call override — wins over the task mapping). */
  overrideTier?: ModelTier;
  /** The resolved default deployment this turn would otherwise use. */
  baseDeployment?: string;
  /**
   * PSR-8 — Copilot turn-latency SLO pressure (0..1+). The recent full-turn SLO
   * BURN (see copilot-slo.evaluateSlo): < 1 healthy, > 1 breaching. When the SLO
   * is breaching (burn > 1) the router shaves ONE tier off a `general` turn
   * (standard → mini) to protect the latency SLO — a deterministic, honest
   * downshift. It NEVER downshifts a `reasoning` turn (quality-critical) or an
   * explicit `overrideTier`. Absent/≤1 → no effect (byte-identical to before).
   */
  latencyBurn?: number;
}

/**
 * Choose the tier + deployment for a turn. The returned `tier` reflects what was
 * ACTUALLY ridden: if the desired tier has no configured deployment the selector
 * honestly falls back (desired → standard → base) rather than reporting a tier
 * the turn never used.
 */
export function selectTier(policy: TierPolicy, input: TierSelectInput): TierSelection {
  const taskClass = input.taskClass ?? classifyTaskClass(input.prompt ?? '', { hasTools: input.hasTools });
  const base = input.baseDeployment;

  if (!policy.enabled) {
    return { tier: 'standard', taskClass, deployment: base, routed: false };
  }

  let desired: ModelTier = input.overrideTier ?? policy.taskMap[taskClass] ?? 'standard';

  // PSR-8 latency-SLO protection: when the full-turn SLO is BREACHING (burn > 1)
  // shave one tier off a NON-reasoning, NON-overridden turn so it answers faster.
  // Reasoning turns and explicit overrides are never sacrificed for latency.
  const sloProtected =
    !input.overrideTier &&
    taskClass !== 'reasoning' &&
    typeof input.latencyBurn === 'number' &&
    input.latencyBurn > 1 &&
    desired !== 'mini';
  if (sloProtected) desired = downshiftTier(desired);

  // Resolve the deployment for the desired tier, falling back desired → standard → base.
  let tier: ModelTier = desired;
  let deployment = policy.tiers[desired]?.trim() || undefined;
  if (!deployment && desired !== 'standard') {
    tier = 'standard';
    deployment = policy.tiers.standard?.trim() || undefined;
  }
  if (!deployment) deployment = base; // standard tier defaults to the resolved base

  const routed = !!deployment && !!base && deployment !== base;
  return { tier, taskClass, deployment: deployment || base, routed, ...(sloProtected ? { sloProtected: true } : {}) };
}

// ── Config adapter (structural — no TenantCopilotConfig import → no cycle) ────

/** The subset of the tenant Copilot config the tier router reads. */
export interface TierPolicyConfigShape {
  /** Default-ON: only `false` disables the router. */
  modelTierRoutingEnabled?: boolean;
  /** Per-tier deployment names (admin-picked). */
  modelTiers?: TierDeployments;
  /** Admin override of the task-class → tier mapping. */
  modelTierTaskMap?: Partial<Record<TaskClass, ModelTier>>;
  /** The tenant Copilot chat deployment — the implicit `standard` tier. */
  copilotChatDeployment?: string;
}

/** Trim an env var to a non-empty string, else undefined (day-one tier source). */
function envDeployment(name: string): string | undefined {
  const v = (process.env[name] || '').trim();
  return v || undefined;
}

/**
 * Build a {@link TierPolicy} from the tenant Copilot config, merging admin
 * choices over the day-one env deployments and the defaults.
 *
 * Per-tier resolution precedence (first non-empty wins):
 *   • mini     : tenant cfg `modelTiers.mini`   → `LOOM_AOAI_MINI_DEPLOYMENT`
 *   • standard : tenant cfg `modelTiers.standard` → tenant chat deployment
 *                → `LOOM_AOAI_DEPLOYMENT` → `LOOM_AOAI_CHAT_DEPLOYMENT`
 *   • strong   : tenant cfg `modelTiers.strong` → `LOOM_AOAI_STRONG_DEPLOYMENT`
 *
 * The env fallbacks are the mini / strong deployments admin-plane bicep wires
 * from the Foundry account (model-strategy M2/M3), so best-per-task routing is
 * ACTIVE DAY-ONE with no admin action — a tenant that later configures Model
 * tiers in Admin → Copilot & Agents still overrides. A missing mini/strong tier
 * is safe: {@link selectTier} falls back desired → standard → base, so routing
 * degrades gracefully to the standard deployment rather than hard-failing.
 */
export function tierPolicyFromConfig(cfg: TierPolicyConfigShape | null | undefined): TierPolicy {
  const enabled = cfg?.modelTierRoutingEnabled !== false; // default ON
  const tiers: TierDeployments = {
    mini: cfg?.modelTiers?.mini?.trim() || envDeployment('LOOM_AOAI_MINI_DEPLOYMENT'),
    standard:
      cfg?.modelTiers?.standard?.trim() ||
      cfg?.copilotChatDeployment?.trim() ||
      envDeployment('LOOM_AOAI_DEPLOYMENT') ||
      envDeployment('LOOM_AOAI_CHAT_DEPLOYMENT'),
    strong: cfg?.modelTiers?.strong?.trim() || envDeployment('LOOM_AOAI_STRONG_DEPLOYMENT'),
  };
  const taskMap: Record<TaskClass, ModelTier> = { ...DEFAULT_TASK_TIER_MAP };
  for (const tc of TASK_CLASSES) {
    const v = cfg?.modelTierTaskMap?.[tc];
    if (v && (MODEL_TIERS as readonly string[]).includes(v)) taskMap[tc] = v;
  }
  return { enabled, tiers, taskMap };
}

/** One-shot convenience: resolve the tier for a turn straight from config. */
export function resolveTierForTurn(
  cfg: TierPolicyConfigShape | null | undefined,
  input: TierSelectInput,
): TierSelection {
  return selectTier(tierPolicyFromConfig(cfg), input);
}
