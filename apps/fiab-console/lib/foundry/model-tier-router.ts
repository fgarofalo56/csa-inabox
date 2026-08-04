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

import { bestModelsFor, modelPreferenceChain, type AvailableDeployment } from './model-availability-matrix';
import type { LoomCloud } from '../azure/cloud-endpoints';

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
 * LAST-RESORT tier resolution context: the account's LIVE model deployments.
 *
 * WHY: when neither the tenant config nor the env wires `mini`/`strong`, the
 * router used to collapse EVERY task class onto the single base deployment —
 * silently. In the live console that meant 100% of Copilot traffic funnelling
 * onto a 10K-TPM `gpt-4o-mini` while three 1000-capacity reasoning deployments
 * sat idle on the same account, producing a chronic 429 storm.
 *
 * Rather than invent a deployment name (which would 404 — strictly worse than a
 * 429), the router accepts the deployment list the runtime ALREADY caches for
 * {@link applyAvailabilityFallback} and resolves the missing tier against it via
 * the same Learn-grounded preference chain. Pure: this module still performs no
 * I/O — the caller passes the (already-warmed, non-blocking) list in.
 */
export interface TierResolutionContext {
  /** Live deployments on the AOAI/Foundry account (`{name, modelName}`). */
  liveDeployments?: readonly AvailableDeployment[];
  /** Cloud for the preference chain (Commercial / Gov …). */
  cloud?: LoomCloud;
  /** Account region for the region-override chain. */
  region?: string;
}

/**
 * Tokens that mark a CHEAPER/WEAKER variant of a base model. A deployment whose
 * model is `<chainModel>-<one of these>` must NEVER satisfy that chain entry —
 * otherwise the strong chain's `gpt-4.1` floor would happily bind the reasoning
 * tier to a `gpt-4.1-mini`, and the chat chain's `gpt-4o` to a `gpt-4o-mini`.
 */
const WEAKER_VARIANT_RE = /^(?:mini|nano|small|lite|chat|instruct|embed|embedding)(?:$|[-_.])/i;

/**
 * Does a live deployment satisfy a preference-chain model?
 *
 * Exact match on either the deployment NAME or its underlying model name, PLUS
 * a guarded variant match: real accounts routinely deploy capacity variants
 * whose model name carries a suffix — the live estate reports
 * `properties.model.name = "gpt-5.6-sol"` (three 1000-TPM sibling deployments),
 * not the bare `gpt-5.6` the matrix chain is written in. An exact-only match
 * therefore found NOTHING on the very account this fix exists to unblock.
 *
 * The suffix must not be a {@link WEAKER_VARIANT_RE} token, so widening the
 * match can only ever select an equal-or-stronger model, never a cheaper one.
 */
function deploymentMatchesModel(d: AvailableDeployment, model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  for (const candidate of [d.modelName, d.name]) {
    const c = (candidate ?? '').trim().toLowerCase();
    if (!c) continue;
    if (c === m) return true;
    if (c.startsWith(`${m}-`) && !WEAKER_VARIANT_RE.test(c.slice(m.length + 1))) return true;
  }
  return false;
}

/**
 * Resolve a tier to a REAL deployed deployment name by walking that tier's
 * Learn-grounded preference chain (best → floor) against the account's live
 * deployments. Returns the deployment NAME (what the AOAI URL path needs).
 *
 * Returns undefined when nothing in the chain is deployed — it NEVER invents a
 * name, because an undeployed model 404s, which is strictly worse than riding
 * an over-subscribed base deployment.
 */
function discoverTierDeployment(
  key: 'mini' | 'strong',
  ctx: TierResolutionContext | undefined,
): string | undefined {
  const live = ctx?.liveDeployments;
  if (!live || live.length === 0) return undefined;
  for (const model of modelPreferenceChain(ctx?.cloud ?? 'Commercial', ctx?.region, key)) {
    const hit = live.find((d) => d?.name && deploymentMatchesModel(d, model));
    if (hit) return hit.name;
  }
  return undefined;
}

/**
 * Build a {@link TierPolicy} from the tenant Copilot config, merging admin
 * choices over the day-one env deployments and the defaults.
 *
 * Per-tier resolution precedence (first non-empty wins):
 *   • mini     : tenant cfg `modelTiers.mini`   → `LOOM_AOAI_MINI_DEPLOYMENT`
 *                → a live-deployed model from the `mini` preference chain
 *   • standard : tenant cfg `modelTiers.standard` → tenant chat deployment
 *                → `LOOM_AOAI_DEPLOYMENT` → `LOOM_AOAI_CHAT_DEPLOYMENT`
 *   • strong   : tenant cfg `modelTiers.strong` → `LOOM_AOAI_STRONG_DEPLOYMENT`
 *                → a live-deployed model from the `strong` preference chain
 *
 * The env fallbacks are the mini / strong deployments admin-plane bicep wires
 * from the Foundry account (model-strategy M2/M3), so best-per-task routing is
 * ACTIVE DAY-ONE with no admin action — a tenant that later configures Model
 * tiers in Admin → Copilot & Agents still overrides. A missing mini/strong tier
 * is safe: {@link selectTier} falls back desired → standard → base, so routing
 * degrades gracefully to the standard deployment rather than hard-failing.
 *
 * The FINAL fallback (`ctx.liveDeployments`) exists because "env unset" is not
 * rare — a BYO-Foundry install, or any estate whose bicep has not re-applied
 * since the tier vars were added, has both vars empty. Without it the router
 * silently funnels every task class onto one deployment (the observed 429
 * storm). With it, the tier binds to a model the account demonstrably HAS.
 */
export function tierPolicyFromConfig(
  cfg: TierPolicyConfigShape | null | undefined,
  ctx?: TierResolutionContext,
): TierPolicy {
  // Default-ON / opt-out. Disabled ONLY when the tenant admin explicitly sets
  // modelTierRoutingEnabled:false (Admin → Copilot & Agents → Model tiers) OR
  // the deployment-wide env kill-switch LOOM_MODEL_TIER_ROUTING_ENABLED='false'
  // is present. Either opt-out makes the router a hard no-op (every turn rides
  // the resolved default) — "no-op ONLY when the admin opts out" (WS-1.1).
  const envOff = (process.env.LOOM_MODEL_TIER_ROUTING_ENABLED || '').trim().toLowerCase() === 'false';
  const enabled = cfg?.modelTierRoutingEnabled !== false && !envOff;
  const tiers: TierDeployments = {
    mini:
      cfg?.modelTiers?.mini?.trim() ||
      envDeployment('LOOM_AOAI_MINI_DEPLOYMENT') ||
      discoverTierDeployment('mini', ctx),
    standard:
      cfg?.modelTiers?.standard?.trim() ||
      cfg?.copilotChatDeployment?.trim() ||
      envDeployment('LOOM_AOAI_DEPLOYMENT') ||
      envDeployment('LOOM_AOAI_CHAT_DEPLOYMENT'),
    strong:
      cfg?.modelTiers?.strong?.trim() ||
      envDeployment('LOOM_AOAI_STRONG_DEPLOYMENT') ||
      discoverTierDeployment('strong', ctx),
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
  ctx?: TierResolutionContext,
): TierSelection {
  return selectTier(tierPolicyFromConfig(cfg, ctx), input);
}

// ── WS-1.1: shared call-path wiring (messages classifier + escalate-only auto) ─

/** A structural chat message — only `role` + `content` matter for classification
 *  (kept structural so this pure module never imports the AOAI contract types). */
export interface ClassifiableMessage {
  role?: string;
  content?: unknown;
}

/** Flatten a message `content` (string OR an array of `{type,text}` parts, the
 *  multimodal shape) to plain text for the classifier. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as any).text === 'string' ? (p as any).text : ''))
      .join(' ');
  }
  return '';
}

/**
 * Extract the classifiable prompt from a chat `messages` array: the LAST user
 * message (what the turn is actually asking). Falls back to the concatenation of
 * every user message, then to '' — never throws. Used by the unified
 * aoai-chat-client so a turn passing NO explicit tier still classifies from its
 * messages (WS-1.1).
 */
export function promptFromMessages(messages: readonly ClassifiableMessage[] | undefined | null): string {
  const msgs = Array.isArray(messages) ? messages : [];
  const users = msgs.filter((m) => (m?.role ?? 'user') === 'user');
  const last = users.length ? users[users.length - 1] : undefined;
  const lastText = messageText(last?.content).trim();
  if (lastText) return lastText;
  return users.map((m) => messageText(m.content)).join('\n').trim();
}

export interface TurnRouteInput {
  /** Tenant Copilot config (tier deployments + task map + opt-out). */
  cfg?: TierPolicyConfigShape | null;
  /** Explicit forced tier (per-call override) — always honored (no escalate-only guard). */
  tier?: ModelTier;
  /** Explicit task class — always honored. */
  taskClass?: TaskClass;
  /** Prompt to classify when neither `tier` nor `taskClass` is supplied. */
  prompt?: string;
  /** Messages to classify from when `prompt` is absent (last user message wins). */
  messages?: readonly ClassifiableMessage[];
  /** Whether the turn advertises tools (nudges toward reasoning). */
  hasTools?: boolean;
  /** The resolved default deployment this turn would otherwise ride. */
  baseDeployment?: string;
  /** PSR-8 latency-SLO burn (see {@link TierSelectInput.latencyBurn}). */
  latencyBurn?: number;
  /**
   * ESCALATE-ONLY guard for the AUTO path (default true). When a turn supplies
   * NO explicit `tier`/`taskClass`, an auto-classified route is applied ONLY
   * when it escalates to the STRONG (reasoning) tier — a lightweight turn is
   * NEVER silently downshifted to a mini deployment. This keeps the ~18 shared
   * aoai-chat-client callers byte-identical unless a reasoning deployment is
   * wired AND the turn classifies hard (WS-1.1: "default behavior identical
   * unless a reasoning deployment is configured or a turn classifies as hard").
   * Set false to allow auto mini-downshift (an explicit opt-in by the caller).
   */
  escalateOnly?: boolean;
  /**
   * LAST-RESORT tier resolution against the account's live deployments, for
   * when neither the tenant config nor the env wires mini/strong. Supplied by
   * the unified `aoai-chat-client` from the already-cached, non-blocking
   * deployment list (see {@link TierResolutionContext}).
   */
  resolution?: TierResolutionContext;
}

/**
 * WS-1.1 — resolve the tier + deployment for a turn on the SHARED call path.
 *
 * This is the one entry point the unified aoai-chat-client consults so EVERY
 * copilot / agent / data-agent turn is tier-aware, not just the streaming
 * orchestrator. It classifies the turn (explicit hint → prompt → messages),
 * applies the policy via {@link selectTier}, and — on the auto path — enforces
 * the escalate-only guard so only a hard-turn upshift to the reasoning tier
 * changes the deployment. The returned {@link TierSelection.tier} is always the
 * honestly-ridden tier (the trace attribute), whether or not the deployment
 * swapped.
 */
export function routeTurnTier(input: TurnRouteInput): TierSelection {
  const explicit = input.tier != null || input.taskClass != null;
  const prompt = input.prompt ?? promptFromMessages(input.messages);
  const sel = resolveTierForTurn(
    input.cfg ?? null,
    {
      overrideTier: input.tier,
      taskClass: input.taskClass,
      prompt,
      hasTools: input.hasTools,
      baseDeployment: input.baseDeployment,
      latencyBurn: input.latencyBurn,
    },
    input.resolution,
  );
  // Auto path + escalate-only: suppress a non-strong deployment swap (i.e. a
  // lightweight→mini downshift) so a hint-less caller only ever escalates.
  const escalateOnly = input.escalateOnly !== false;
  if (!explicit && escalateOnly && sel.routed && sel.tier !== 'strong') {
    return { ...sel, tier: sel.tier, deployment: input.baseDeployment, routed: false };
  }
  return sel;
}

/**
 * WS-1.1 — true when a REASONING (strong) tier deployment resolves for this
 * config (tenant cfg `modelTiers.strong` or the `LOOM_AOAI_STRONG_DEPLOYMENT`
 * env). When false the router silently rides the standard deployment for hard
 * turns and the `svc-model-reasoning-tier` gate surfaces the honest Fix-it.
 */
export function reasoningTierConfigured(
  cfg?: TierPolicyConfigShape | null,
  ctx?: TierResolutionContext,
): boolean {
  return !!tierPolicyFromConfig(cfg, ctx).tiers.strong;
}

/**
 * WS-1.1 — the BEST reasoning-capable model per cloud/region, from the
 * Learn-grounded availability matrix (Commercial → gpt-5.6/gpt-5.5; Gov →
 * gpt-5.2/gpt-5.1/gpt-5; floor gpt-4.1). This is what a push-button deploy binds
 * `LOOM_AOAI_STRONG_DEPLOYMENT` to, and what the reasoning-tier gate names as the
 * remediation target — so the 3-tier default is bound to the strongest model the
 * boundary can actually serve (incl. Gov `*.openai.azure.us`), never a Commercial
 * frontier model that 404s in a sovereign cloud.
 */
export function bestReasoningModelFor(cloud: LoomCloud, region?: string): string {
  return bestModelsFor(cloud, region).strong;
}

/** WS-1.1 — the full 3-tier default model binding per cloud/region (mini /
 *  standard / strong), from the availability matrix. The source of truth for the
 *  default tier config bicep seeds per cloud + the admin "Model tiers" defaults. */
export function defaultTierModelsFor(cloud: LoomCloud, region?: string): TierDeployments {
  const best = bestModelsFor(cloud, region);
  return { mini: best.mini, standard: best.chat, strong: best.strong };
}
