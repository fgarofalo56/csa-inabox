/**
 * loom-token-budgets — doc shapes + PURE attribution/verdict math + MIG1
 * versioned-migration registration (N13, Unified LLMOps).
 *
 * N13's second missing plane: PER-WORKSPACE / PER-AGENT token budgets, ENFORCED
 * in the aoai-chat-client hot path. WS-E's evaluator answers "is the Copilot
 * good?"; the E6 tier-router answers "which model should this turn ride?".
 * Neither answers "has this workspace burned its allowance this month?" — that
 * is this module.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` and the pure
 * `lib/copilot/cost-estimate` price table (itself dependency-free), so
 * `cosmos-client` can import it at module scope for the migrator side effect
 * without a cycle — the copilot-evals-model / semantic-contract-model
 * precedent. The Cosmos-touching store + hot-path enforcement live in
 * `lib/copilot/token-budget.ts`.
 *
 * CURRENT SCHEMA VERSION: 1. A breaking shape change bumps
 * TOKEN_BUDGET_SCHEMA_VERSION and registers its `fromVersion: N` migrator in
 * {@link registerTokenBudgetMigrators} (called at module scope). Per MIG1 there
 * is deliberately NO v1 migrator today.
 *
 * Per-cloud: identical Commercial / GCC-High. IL5/SOVEREIGN MOAT: budgets,
 * attribution rows, and the enforcement decision are all computed IN-PROCESS
 * against the deployment's own Cosmos — no external LLMOps/FinOps SaaS meters
 * the enclave's tokens, and no prompt/completion text ever leaves the VNet
 * (only token COUNTS are persisted; the ledger stores no message content).
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';
import { estCostUsd, tierPriceCoeff, type CostTier } from '@/lib/copilot/cost-estimate';

export const TOKEN_BUDGET_CONTAINER = 'loom-token-budgets';
export const TOKEN_BUDGET_SCHEMA_VERSION = 1;

/**
 * How long a usage row is retained: 400 days (13 months) so a monthly budget
 * always has a full year of history plus the current period. Code default —
 * NO env var (FLAG0/code-default preferred over env per the MASTER conventions).
 */
export const USAGE_TTL_SECONDS = 400 * 24 * 60 * 60;

/** What a budget is scoped to. Both are attributed on every enforced turn. */
export type BudgetScope = 'workspace' | 'agent';

/** Budget reset cadence. */
export type BudgetPeriod = 'daily' | 'monthly';

/** The attribution carried by one AOAI turn (per workspace + per agent). */
export interface TokenAttribution {
  /** The workspace the turn is being spent on (the primary budget scope). */
  workspaceId?: string;
  /** The agent / copilot surface spending it (the secondary budget scope). */
  agentId?: string;
  /** Free-form surface label for the dashboard (e.g. 'copilot-dock'). */
  surface?: string;
  /** Tenant for the audit/ledger partitioning context (not a budget scope). */
  tenantId?: string;
}

/** A configured budget (`docType:'budget'`). PK /scopeKey. */
export interface TokenBudgetDoc {
  /** Cosmos id — `budget:<scope>:<scopeId>`. */
  id: string;
  /** PK — `<scope>:<scopeId>`; the budget and its usage rows share a partition. */
  scopeKey: string;
  docType: 'budget';
  schemaVersion: number;
  scope: BudgetScope;
  scopeId: string;
  /** Display label for the dashboard (workspace/agent name). */
  label?: string;
  period: BudgetPeriod;
  /** Hard cap in TOTAL tokens (prompt + completion) per period. 0 = unlimited. */
  limitTokens: number;
  /** Optional advisory USD cap for the dashboard (never enforced — tokens are). */
  limitUsd?: number | null;
  /** Warn threshold as a fraction of the limit (dashboard only). */
  warnAt?: number;
  /** Default-ON semantics: a disabled budget is NEVER enforced. */
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy?: string;
}

/** Per-tier spend within a usage period. */
export interface TierSpend {
  tokens: number;
  usd: number;
  turns: number;
}

/** One period's accumulated real spend (`docType:'usage'`). PK /scopeKey. */
export interface TokenUsageDoc {
  /** Cosmos id — `usage:<scope>:<scopeId>:<periodKey>`. */
  id: string;
  scopeKey: string;
  docType: 'usage';
  schemaVersion: number;
  scope: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  /** `YYYY-MM` (monthly) or `YYYY-MM-DD` (daily). */
  periodKey: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Model-exact estimated USD (estCostUsd over the real AOAI token counts). */
  usd: number;
  /** Tier-coefficient estimated USD (tierPriceCoeff — the E6 blended rate). */
  tierUsd: number;
  turns: number;
  /** Per-routing-tier breakdown (the E6 tiers). */
  byTier: Partial<Record<CostTier, TierSpend>>;
  updatedAt: string;
  ttl?: number;
}

// ── PURE period math ─────────────────────────────────────────────────────────

/** The period key a timestamp falls in (UTC). Pure. */
export function periodKeyFor(period: BudgetPeriod, at: Date = new Date()): string {
  const iso = at.toISOString();
  return period === 'daily' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** ISO timestamp of the next period boundary (when the allowance resets). Pure. */
export function periodResetAt(period: BudgetPeriod, at: Date = new Date()): string {
  if (period === 'daily') {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)).toISOString();
  }
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
}

/** The Cosmos partition key for a scope. Pure. */
export function scopeKeyFor(scope: BudgetScope, scopeId: string): string {
  return `${scope}:${String(scopeId || '').trim()}`;
}

// ── PURE attribution math ────────────────────────────────────────────────────

/** The real token counts one AOAI response reported (the `usage` block). */
export interface AoaiUsage {
  promptTokens: number;
  completionTokens: number;
}

/** One turn's attributed spend. */
export interface AttributedSpend {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Model-exact estimate from the shared PRICE_PER_1K table. */
  usd: number;
  /** Tier-coefficient estimate from TIER_PRICE_COEFF (the E6 blended rate). */
  tierUsd: number;
  tier: CostTier;
}

/**
 * Attribute one turn's REAL token counts to money, using the SAME price tables
 * the usage dashboard + the E6 cost-per-quality view use — never a re-typed
 * number:
 *   • `usd`     — {@link estCostUsd}: the model-exact list price for the
 *                 deployment that actually served the turn;
 *   • `tierUsd` — {@link tierPriceCoeff}: the blended per-tier coefficient, so
 *                 the per-tier breakdown stays comparable with the tier-routing
 *                 cost-per-quality view even across deployment renames.
 *
 * The token COUNTS are always the real AOAI `usage`; only the $ RATE is list
 * price, so every figure here is an ESTIMATE (labeled as such in the UI), never
 * a billed amount. Negative / NaN inputs clamp to 0 — this runs on the hot path
 * and must never throw. Pure.
 */
export function attributeSpend(model: string, tier: CostTier, usage: AoaiUsage): AttributedSpend {
  const pt = Number.isFinite(usage?.promptTokens) && usage.promptTokens > 0 ? Math.floor(usage.promptTokens) : 0;
  const ct = Number.isFinite(usage?.completionTokens) && usage.completionTokens > 0 ? Math.floor(usage.completionTokens) : 0;
  const total = pt + ct;
  return {
    promptTokens: pt,
    completionTokens: ct,
    totalTokens: total,
    usd: estCostUsd(model, pt, ct),
    tierUsd: Number(((total / 1000) * tierPriceCoeff(tier)).toFixed(4)),
    tier,
  };
}

/** Fold one turn's spend into a usage row (returns a NEW row — no mutation). Pure. */
export function applySpend(row: TokenUsageDoc, spend: AttributedSpend, at: Date = new Date()): TokenUsageDoc {
  const prior = row.byTier?.[spend.tier] ?? { tokens: 0, usd: 0, turns: 0 };
  return {
    ...row,
    promptTokens: row.promptTokens + spend.promptTokens,
    completionTokens: row.completionTokens + spend.completionTokens,
    totalTokens: row.totalTokens + spend.totalTokens,
    usd: Number((row.usd + spend.usd).toFixed(4)),
    tierUsd: Number((row.tierUsd + spend.tierUsd).toFixed(4)),
    turns: row.turns + 1,
    byTier: {
      ...row.byTier,
      [spend.tier]: {
        tokens: prior.tokens + spend.totalTokens,
        usd: Number((prior.usd + spend.usd).toFixed(4)),
        turns: prior.turns + 1,
      },
    },
    updatedAt: at.toISOString(),
    ttl: USAGE_TTL_SECONDS,
  };
}

/** An empty usage row for a scope/period. Pure. */
export function emptyUsage(
  scope: BudgetScope,
  scopeId: string,
  period: BudgetPeriod,
  periodKey: string,
): TokenUsageDoc {
  return {
    id: `usage:${scope}:${scopeId}:${periodKey}`,
    scopeKey: scopeKeyFor(scope, scopeId),
    docType: 'usage',
    schemaVersion: TOKEN_BUDGET_SCHEMA_VERSION,
    scope,
    scopeId,
    period,
    periodKey,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    usd: 0,
    tierUsd: 0,
    turns: 0,
    byTier: {},
    updatedAt: new Date(0).toISOString(),
    ttl: USAGE_TTL_SECONDS,
  };
}

// ── PURE verdict ─────────────────────────────────────────────────────────────

/** The enforcement verdict for one scope. */
export interface BudgetVerdict {
  scope: BudgetScope;
  scopeId: string;
  /** True when the scope has burned its allowance and the next turn must refuse. */
  over: boolean;
  /** True when usage crossed the warn threshold but is still under the limit. */
  warning: boolean;
  usedTokens: number;
  limitTokens: number;
  /** Never negative. */
  remainingTokens: number;
  /** 0..>1 — usage as a fraction of the limit (0 when unlimited). */
  pctUsed: number;
  usedUsd: number;
  period: BudgetPeriod;
  periodKey: string;
  /** ISO timestamp when the allowance resets. */
  resetsAt: string;
}

/**
 * Compare a scope's accumulated usage against its budget. DEFAULT-ON / opt-out
 * (loom_default_on_opt_out): a MISSING budget, a `enabled:false` budget, or a
 * `limitTokens <= 0` budget all mean UNLIMITED — a budget subsystem that has not
 * been configured can never gate a workspace. Only an explicitly configured,
 * enabled, positive limit can refuse a turn. Pure.
 */
export function budgetVerdict(
  budget: TokenBudgetDoc | null,
  usage: TokenUsageDoc | null,
  at: Date = new Date(),
): BudgetVerdict | null {
  if (!budget || !budget.enabled || !(budget.limitTokens > 0)) return null;
  const period = budget.period;
  const periodKey = periodKeyFor(period, at);
  // A usage row from a PREVIOUS period never counts against the current one.
  const used = usage && usage.periodKey === periodKey ? usage : null;
  const usedTokens = used?.totalTokens ?? 0;
  const warnAt = typeof budget.warnAt === 'number' && budget.warnAt > 0 && budget.warnAt < 1 ? budget.warnAt : 0.8;
  const pctUsed = usedTokens / budget.limitTokens;
  return {
    scope: budget.scope,
    scopeId: budget.scopeId,
    over: usedTokens >= budget.limitTokens,
    warning: pctUsed >= warnAt && usedTokens < budget.limitTokens,
    usedTokens,
    limitTokens: budget.limitTokens,
    remainingTokens: Math.max(0, budget.limitTokens - usedTokens),
    pctUsed: Number(pctUsed.toFixed(4)),
    usedUsd: used?.usd ?? 0,
    period,
    periodKey,
    resetsAt: periodResetAt(period, at),
  };
}

// ── The honest 429-class refusal payload ─────────────────────────────────────

/**
 * The structured refusal a breached budget produces. Deliberately NOT a silent
 * truncation, NOT a hang, NOT a generic 500: the caller gets a 429-class body
 * naming the exact scope, the exact numbers, when it resets, and an inline
 * Fix-it that lands on the Budgets tab where an admin raises the cap (G2).
 */
export interface TokenBudgetRefusal {
  ok: false;
  code: 'token_budget_exceeded';
  status: 429;
  message: string;
  scope: BudgetScope;
  scopeId: string;
  usedTokens: number;
  limitTokens: number;
  usedUsd: number;
  period: BudgetPeriod;
  periodKey: string;
  resetsAt: string;
  fixit: {
    label: string;
    href: string;
    remediation: string;
  };
}

/** Build the honest refusal payload for a breached verdict. Pure. */
export function buildRefusal(v: BudgetVerdict): TokenBudgetRefusal {
  const noun = v.scope === 'workspace' ? 'workspace' : 'agent';
  return {
    ok: false,
    code: 'token_budget_exceeded',
    status: 429,
    message:
      `This ${noun} has used ${v.usedTokens.toLocaleString()} of its ${v.limitTokens.toLocaleString()} ` +
      `token allowance for the current ${v.period === 'daily' ? 'day' : 'month'} (${v.periodKey}). ` +
      `The request was refused rather than truncated. The allowance resets at ${v.resetsAt}.`,
    scope: v.scope,
    scopeId: v.scopeId,
    usedTokens: v.usedTokens,
    limitTokens: v.limitTokens,
    usedUsd: v.usedUsd,
    period: v.period,
    periodKey: v.periodKey,
    resetsAt: v.resetsAt,
    fixit: {
      label: 'Raise the budget',
      href: '/admin/copilot-quality?tab=budgets',
      remediation:
        `Open Admin → Copilot quality → Budgets and raise (or disable) the ${noun} budget for "${v.scopeId}". ` +
        'Budget changes are audited and take effect on the next turn — no revision roll. ' +
        'The n13-token-budgets runtime flag turns enforcement off entirely if you need an immediate estate-wide release.',
    },
  };
}

// ── MIG1 registration ────────────────────────────────────────────────────────

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(TOKEN_BUDGET_CONTAINER, 1, v1toV2);
 *
 * plus the optional backfill script
 * `scripts/csa-loom/cosmos-backfill-loom-token-budgets.mjs`.
 */
export function registerTokenBudgetMigrators(): void {
  // v1 → (none yet). Keeping the registerMigrator reference live reserves the
  // wiring for the first real migration without claiming the one-owner-per-step
  // v1 slot with an inert migrator (the MIG1 convention).
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerTokenBudgetMigrators();
