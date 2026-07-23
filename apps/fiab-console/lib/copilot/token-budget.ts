/**
 * token-budget — N13 per-workspace / per-agent token budgets, ENFORCED in the
 * aoai-chat-client hot path (Cosmos-backed, server-only).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE — this EXTENDS WS-E, it does not duplicate it.
 * ─────────────────────────────────────────────────────────────────────────────
 * WS-E's E6 tier-router already decides WHICH model a turn rides (`routeTurnTier`
 * in lib/foundry/model-tier-router, applied inside aoai-chat-client). N13 adds
 * the orthogonal question it never asked: HAS THIS WORKSPACE / AGENT BURNED ITS
 * ALLOWANCE? The two compose cleanly and in a fixed order on the hot path:
 *
 *      resolveAoaiTarget ──► routeTurnTier (E6, unchanged)
 *                              └─► the tier + deployment for this turn
 *                                    └─► enforceTokenBudget (N13, THIS module)
 *                                          └─► the real AOAI fetch
 *                                                └─► recordTurnSpend (N13)
 *
 * The tier is an INPUT to N13 (it selects the price coefficient the spend is
 * attributed at), never an output — nothing here re-routes, re-classifies, or
 * overrides a tier decision.
 *
 * Behaviour on breach: an honest 429-class structured refusal
 * ({@link TokenBudgetExceededError}) carrying the exact numbers, the reset time,
 * and the inline Fix-it (raise the budget). NEVER a silent truncation of the
 * message list, NEVER a hang, NEVER a generic 500.
 *
 * DEFAULT-ON / opt-out (loom_default_on_opt_out): with no budget configured the
 * check is a no-op — a workspace can never be gated by a budget nobody set. The
 * whole plane is behind the FLAG0 kill-switch `n13-token-budgets` (default true)
 * so enforcement can be dropped estate-wide in seconds without a revision roll.
 * Everything fails OPEN: any Cosmos/flag error allows the turn (an accounting
 * subsystem outage must never take the Copilot down with it). ONLY a real,
 * enabled, positive, breached budget refuses.
 *
 * Attribution flows either explicitly (`opts.attribution` on an aoai-chat-client
 * call) or ambiently via {@link withTokenAttribution} (AsyncLocalStorage — the
 * `adf-factory-context` precedent), so a route can attribute EVERY AOAI turn it
 * makes without rewiring the ~18 existing call sites.
 *
 * Per-cloud: identical Commercial / GCC-High. IL5 / SOVEREIGN MOAT: budgets, the
 * usage ledger, and the enforcement decision are computed in-process against the
 * deployment's OWN Cosmos inside the VNet — no external LLMOps/FinOps SaaS
 * meters the enclave, and only token COUNTS are persisted (no prompt or
 * completion text ever enters the ledger).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { tokenBudgetsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  applySpend,
  attributeSpend,
  budgetVerdict,
  buildRefusal,
  emptyUsage,
  periodKeyFor,
  scopeKeyFor,
  TOKEN_BUDGET_SCHEMA_VERSION,
  type AoaiUsage,
  type AttributedSpend,
  type BudgetPeriod,
  type BudgetScope,
  type BudgetVerdict,
  type TokenAttribution,
  type TokenBudgetDoc,
  type TokenBudgetRefusal,
  type TokenUsageDoc,
} from '@/lib/azure/token-budget-model';
import type { CostTier } from '@/lib/copilot/cost-estimate';

export type {
  BudgetScope, BudgetPeriod, BudgetVerdict, TokenAttribution, TokenBudgetDoc,
  TokenBudgetRefusal, TokenUsageDoc,
} from '@/lib/azure/token-budget-model';

/** The FLAG0 kill-switch id for the whole enforcement + attribution plane. */
export const TOKEN_BUDGET_FLAG = 'n13-token-budgets';

// ── Ambient attribution (AsyncLocalStorage) ──────────────────────────────────

const attributionStore = new AsyncLocalStorage<TokenAttribution>();

/** The attribution active for the current request (or undefined outside a scope). */
export function currentTokenAttribution(): TokenAttribution | undefined {
  return attributionStore.getStore();
}

/**
 * Run `fn` with `attribution` active for every aoai-chat-client call it makes.
 * A falsy/empty attribution runs `fn` unchanged (unattributed path), so wrapping
 * is always safe. AsyncLocalStorage propagates it across every `await` inside.
 */
export function withTokenAttribution<T>(attribution: TokenAttribution | undefined, fn: () => T): T {
  if (!attribution || (!attribution.workspaceId && !attribution.agentId)) return fn();
  return attributionStore.run(attribution, fn);
}

/** Merge an explicit per-call attribution over the ambient one. */
export function resolveAttribution(explicit?: TokenAttribution | null): TokenAttribution | undefined {
  const ambient = currentTokenAttribution();
  if (!explicit && !ambient) return undefined;
  const merged: TokenAttribution = { ...(ambient ?? {}), ...(explicit ?? {}) };
  return merged.workspaceId || merged.agentId ? merged : undefined;
}

/** The (scope, scopeId) pairs one attribution is charged against. */
export function scopesOf(attribution: TokenAttribution): { scope: BudgetScope; scopeId: string }[] {
  const out: { scope: BudgetScope; scopeId: string }[] = [];
  const ws = (attribution.workspaceId || '').trim();
  const agent = (attribution.agentId || '').trim();
  if (ws) out.push({ scope: 'workspace', scopeId: ws });
  if (agent) out.push({ scope: 'agent', scopeId: agent });
  return out;
}

// ── The honest 429-class refusal ─────────────────────────────────────────────

/**
 * Thrown by {@link enforceTokenBudget} when a configured, enabled budget is
 * exhausted. Carries the full structured refusal so a BFF route can answer with
 * `apiError(err.message, 429, err.refusal)` — an honest, actionable 429, never a
 * truncated prompt or a hang.
 */
export class TokenBudgetExceededError extends Error {
  readonly name = 'TokenBudgetExceededError';
  readonly status = 429;
  readonly code = 'token_budget_exceeded';
  readonly refusal: TokenBudgetRefusal;

  constructor(refusal: TokenBudgetRefusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

/** True for the N13 budget refusal (so callers can map it to a 429 without importing the class). */
export function isTokenBudgetExceeded(e: unknown): e is TokenBudgetExceededError {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'token_budget_exceeded';
}

// ── Cosmos reads/writes ──────────────────────────────────────────────────────

async function readBudget(scope: BudgetScope, scopeId: string): Promise<TokenBudgetDoc | null> {
  const c = await tokenBudgetsContainer();
  try {
    const { resource } = await c
      .item(`budget:${scope}:${scopeId}`, scopeKeyFor(scope, scopeId))
      .read<TokenBudgetDoc>();
    return resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

async function readUsage(
  scope: BudgetScope,
  scopeId: string,
  periodKey: string,
): Promise<TokenUsageDoc | null> {
  const c = await tokenBudgetsContainer();
  try {
    const { resource } = await c
      .item(`usage:${scope}:${scopeId}:${periodKey}`, scopeKeyFor(scope, scopeId))
      .read<TokenUsageDoc>();
    return resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

/** Every configured budget (cross-partition; the admin dashboard is a cold read). */
export async function listBudgets(): Promise<TokenBudgetDoc[]> {
  const c = await tokenBudgetsContainer();
  const { resources } = await c.items
    .query<TokenBudgetDoc>({ query: "SELECT * FROM c WHERE c.docType = 'budget' OFFSET 0 LIMIT 500" })
    .fetchAll();
  return resources.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
}

/**
 * Every usage row for a period key (cross-partition, bounded). Powers the
 * attribution dashboard: REAL accumulated spend per workspace/agent, including
 * scopes that have no budget configured (spend is always attributed, budgets are
 * opt-in).
 */
export async function listUsage(periodKeys: string[]): Promise<TokenUsageDoc[]> {
  if (periodKeys.length === 0) return [];
  const c = await tokenBudgetsContainer();
  const { resources } = await c.items
    .query<TokenUsageDoc>({
      query:
        "SELECT * FROM c WHERE c.docType = 'usage' AND ARRAY_CONTAINS(@keys, c.periodKey) OFFSET 0 LIMIT 1000",
      parameters: [{ name: '@keys', value: periodKeys }],
    })
    .fetchAll();
  return resources;
}

// ── Hot-path enforcement ─────────────────────────────────────────────────────

/**
 * The HOT-PATH check, called by aoai-chat-client immediately after the E6 tier
 * router has chosen the deployment and immediately before the real AOAI fetch.
 *
 * Throws {@link TokenBudgetExceededError} when a configured, enabled budget for
 * the turn's workspace or agent is exhausted. Returns the (possibly empty) list
 * of live verdicts otherwise, so a caller can surface a "83% of budget used"
 * warning chip.
 *
 * Fails OPEN by design — an unreadable Cosmos, a missing container, or a flag
 * subsystem error all ALLOW the turn. The only path that refuses is an
 * affirmative, freshly-read over-budget verdict.
 */
export async function enforceTokenBudget(
  attribution: TokenAttribution | undefined,
  at: Date = new Date(),
): Promise<BudgetVerdict[]> {
  if (!attribution) return [];
  const scopes = scopesOf(attribution);
  if (scopes.length === 0) return [];
  try {
    if (!(await runtimeFlag(TOKEN_BUDGET_FLAG, { default: true }))) return [];
    const verdicts: BudgetVerdict[] = [];
    for (const { scope, scopeId } of scopes) {
      const budget = await readBudget(scope, scopeId);
      if (!budget || !budget.enabled || !(budget.limitTokens > 0)) continue;
      const usage = await readUsage(scope, scopeId, periodKeyFor(budget.period, at));
      const v = budgetVerdict(budget, usage, at);
      if (v) verdicts.push(v);
    }
    const breach = verdicts.find((v) => v.over);
    if (breach) throw new TokenBudgetExceededError(buildRefusal(breach));
    return verdicts;
  } catch (e) {
    // A REAL breach must propagate; anything else fails open.
    if (isTokenBudgetExceeded(e)) throw e;
    try {
      console.warn(`[token-budget] budget check failed open: ${e instanceof Error ? e.message : String(e)}`);
    } catch { /* trace only */ }
    return [];
  }
}

/**
 * Record one turn's REAL spend against every scope in the attribution.
 *
 * The token COUNTS come straight from the AOAI response `usage` block; the $
 * figures come from the SHARED price tables in lib/copilot/cost-estimate
 * (`estCostUsd` model-exact + `tierPriceCoeff` per-tier blended — the same
 * coefficients the E6 cost-per-quality view uses). Best-effort and never
 * throwing: accounting must never fail a turn that already succeeded.
 *
 * Read-modify-write on the period row. Two concurrent turns on the same scope
 * can lose one increment; that is an accepted, documented bound for a metering
 * ledger whose purpose is a budget guard-rail (the NEXT turn re-reads the merged
 * row and still refuses once the cap is crossed), not an invoice.
 */
export async function recordTurnSpend(
  attribution: TokenAttribution | undefined,
  input: { model: string; tier: CostTier; usage: AoaiUsage },
  at: Date = new Date(),
): Promise<AttributedSpend | null> {
  if (!attribution) return null;
  const scopes = scopesOf(attribution);
  if (scopes.length === 0) return null;
  const spend = attributeSpend(input.model, input.tier, input.usage);
  if (spend.totalTokens <= 0) return spend;
  try {
    if (!(await runtimeFlag(TOKEN_BUDGET_FLAG, { default: true }))) return spend;
    const c = await tokenBudgetsContainer();
    for (const { scope, scopeId } of scopes) {
      // The period of the scope's budget when one exists; monthly otherwise, so
      // unbudgeted scopes still get a real attribution row for the dashboard.
      const budget = await readBudget(scope, scopeId).catch(() => null);
      const period: BudgetPeriod = budget?.period ?? 'monthly';
      const periodKey = periodKeyFor(period, at);
      const existing = (await readUsage(scope, scopeId, periodKey).catch(() => null))
        ?? emptyUsage(scope, scopeId, period, periodKey);
      await c.items.upsert(applySpend({ ...existing, schemaVersion: TOKEN_BUDGET_SCHEMA_VERSION }, spend, at));
    }
  } catch (e) {
    try {
      console.warn(`[token-budget] spend attribution failed: ${e instanceof Error ? e.message : String(e)}`);
    } catch { /* trace only */ }
  }
  return spend;
}

/**
 * Extract the REAL `usage` block from an AOAI chat-completions response body.
 * Returns null when the response carried none (nothing is then attributed —
 * an estimate is never invented, per no-vaporware).
 */
export function usageFromResponse(body: unknown): AoaiUsage | null {
  const u = (body as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
  if (!u) return null;
  const promptTokens = Number(u.prompt_tokens);
  const completionTokens = Number(u.completion_tokens);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return null;
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
  };
}

// ── Admin CRUD (AUDITED) ─────────────────────────────────────────────────────

/** Actor context for the audit trail (from the admin session). */
export interface BudgetActor {
  oid: string;
  who: string;
  tenantId: string;
}

export interface UpsertBudgetInput {
  scope: BudgetScope;
  scopeId: string;
  label?: string;
  period: BudgetPeriod;
  /** Hard cap in TOTAL tokens per period. Must be > 0. */
  limitTokens: number;
  limitUsd?: number | null;
  /** Warn threshold as a fraction of the limit (0<x<1). Defaults to 0.8. */
  warnAt?: number;
  enabled?: boolean;
}

async function auditBudget(
  kind: 'llmops.budget.upsert' | 'llmops.budget.delete',
  actor: BudgetActor,
  scopeKey: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `llmops-budget:${scopeKey}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        at: new Date().toISOString(),
        kind,
        target: scopeKey,
        detail,
      })
      .catch(() => undefined);
  } catch { /* audit failures are non-blocking */ }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: kind,
    targetType: 'llmops-budget',
    targetId: scopeKey,
    tenantId: actor.tenantId,
    detail,
  });
}

/** Create or update a budget. AUDITED (privileged admin mutation). */
export async function upsertBudget(input: UpsertBudgetInput, actor: BudgetActor): Promise<TokenBudgetDoc> {
  const scope: BudgetScope = input.scope === 'agent' ? 'agent' : 'workspace';
  const scopeId = String(input.scopeId || '').trim();
  if (!scopeId) throw new Error('scopeId is required (the workspace or agent id the budget applies to).');
  const limitTokens = Math.floor(Number(input.limitTokens));
  if (!Number.isFinite(limitTokens) || limitTokens <= 0) {
    throw new Error('limitTokens must be a positive whole number of tokens per period.');
  }
  const period: BudgetPeriod = input.period === 'daily' ? 'daily' : 'monthly';
  const warnAt = typeof input.warnAt === 'number' && input.warnAt > 0 && input.warnAt < 1 ? input.warnAt : 0.8;

  const prior = await readBudget(scope, scopeId);
  const now = new Date().toISOString();
  const doc: TokenBudgetDoc = {
    id: `budget:${scope}:${scopeId}`,
    scopeKey: scopeKeyFor(scope, scopeId),
    docType: 'budget',
    schemaVersion: TOKEN_BUDGET_SCHEMA_VERSION,
    scope,
    scopeId,
    label: String(input.label || '').trim() || prior?.label,
    period,
    limitTokens,
    limitUsd: input.limitUsd == null ? (prior?.limitUsd ?? null) : Number(input.limitUsd),
    warnAt,
    enabled: input.enabled !== false,
    createdAt: prior?.createdAt ?? now,
    createdBy: prior?.createdBy ?? actor.who,
    updatedAt: now,
    updatedBy: actor.who,
  };
  const c = await tokenBudgetsContainer();
  await c.items.upsert(doc);
  await auditBudget('llmops.budget.upsert', actor, doc.scopeKey, {
    prior: prior
      ? { limitTokens: prior.limitTokens, period: prior.period, enabled: prior.enabled }
      : null,
    next: { limitTokens: doc.limitTokens, period: doc.period, enabled: doc.enabled },
  });
  return doc;
}

/** Delete a budget (its usage-ledger rows are retained). AUDITED. */
export async function deleteBudget(scope: BudgetScope, scopeId: string, actor: BudgetActor): Promise<void> {
  const key = scopeKeyFor(scope, scopeId);
  const c = await tokenBudgetsContainer();
  try {
    await c.item(`budget:${scope}:${scopeId}`, key).delete();
  } catch (e: unknown) {
    if ((e as { code?: number })?.code !== 404) throw e;
  }
  await auditBudget('llmops.budget.delete', actor, key, { scope, scopeId });
}

// ── Dashboard read ───────────────────────────────────────────────────────────

/** One row of the attribution dashboard: real spend joined with its budget. */
export interface BudgetDashboardRow {
  scope: BudgetScope;
  scopeId: string;
  label?: string;
  budget: TokenBudgetDoc | null;
  usage: TokenUsageDoc | null;
  verdict: BudgetVerdict | null;
}

/**
 * The Budgets tab payload: every configured budget AND every scope with real
 * spend in the current daily + monthly periods, joined into one row set. Scopes
 * that spent without a budget appear too (spend is always attributed; budgets
 * are opt-in) — that is what makes the dashboard usable for setting the first
 * budget from evidence rather than a guess.
 */
export async function budgetDashboard(at: Date = new Date()): Promise<BudgetDashboardRow[]> {
  const monthKey = periodKeyFor('monthly', at);
  const dayKey = periodKeyFor('daily', at);
  const [budgets, usage] = await Promise.all([listBudgets(), listUsage([monthKey, dayKey])]);

  const byKey = new Map<string, BudgetDashboardRow>();
  for (const b of budgets) {
    byKey.set(b.scopeKey, { scope: b.scope, scopeId: b.scopeId, label: b.label, budget: b, usage: null, verdict: null });
  }
  for (const u of usage) {
    const row = byKey.get(u.scopeKey);
    // Match the usage row's period to the budget's; unbudgeted scopes show monthly.
    const wanted = row?.budget?.period ?? 'monthly';
    if (u.period !== wanted) continue;
    if (row) row.usage = u;
    else byKey.set(u.scopeKey, { scope: u.scope, scopeId: u.scopeId, budget: null, usage: u, verdict: null });
  }
  for (const row of byKey.values()) {
    row.verdict = budgetVerdict(row.budget, row.usage, at);
  }
  return [...byKey.values()].sort(
    (a, b) => (b.usage?.totalTokens ?? 0) - (a.usage?.totalTokens ?? 0) || a.scopeId.localeCompare(b.scopeId),
  );
}
