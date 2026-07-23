/**
 * Copilot cost estimation — the shared, pure rel-T85 price table (CTS-01).
 *
 * Originally lived inline in `app/api/admin/copilot-usage/route.ts` (the Wave 6
 * Round-1 AI-fn cost stats, live-verified). Lifted into this module so the
 * per-turn transparency status bar (CTS-01) can derive a $ estimate from the SAME
 * list-price table the admin usage dashboard uses — one source of truth, no
 * client-side re-derivation (per the PRP: "reuse the existing AI-fn cost module —
 * do not re-derive prices client-side").
 *
 * The token COUNTS are always real (live AOAI `usage`); only the $ RATE is the
 * published Azure OpenAI list price, so any figure derived here is an ESTIMATE,
 * not a billed amount. Callers label it "estimated" in the UI.
 */

/**
 * Azure OpenAI published list price per 1K tokens (USD), keyed by a model
 * substring. Keyed loosely so `gpt-4o-mini-2024-07-18` matches `gpt-4o-mini`.
 * Embeddings models bill input-only. A conservative default covers unrecognized
 * deployments.
 */
export const PRICE_PER_1K: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4.1-mini': { in: 0.0004, out: 0.0016 },
  'gpt-4.1-nano': { in: 0.0001, out: 0.0004 },
  'gpt-4.1': { in: 0.002, out: 0.008 },
  'gpt-4o': { in: 0.005, out: 0.015 },
  'o4-mini': { in: 0.0011, out: 0.0044 },
  'o3-mini': { in: 0.0011, out: 0.0044 },
  'text-embedding-3-large': { in: 0.00013, out: 0 },
  'text-embedding-3-small': { in: 0.00002, out: 0 },
  'text-embedding-ada-002': { in: 0.0001, out: 0 },
};

export const DEFAULT_PRICE = { in: 0.002, out: 0.008 };

/** Resolve the per-1K price for a deployment/model name (loose substring match). */
export function priceFor(model: string): { in: number; out: number } {
  const m = (model || '').toLowerCase();
  const key = Object.keys(PRICE_PER_1K).find((k) => m.includes(k));
  return key ? PRICE_PER_1K[key] : DEFAULT_PRICE;
}

/**
 * Estimated USD cost of a turn/window from REAL token counts × the model's
 * published list price. Rounded to 4 decimals. Never throws — negative or NaN
 * inputs clamp to 0.
 */
export function estCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model);
  const pt = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const ct = Number.isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0;
  return Number(((pt / 1000) * p.in + (ct / 1000) * p.out).toFixed(4));
}

// ── E6 — per-tier price coefficients (tier-router cost-per-quality) ───────────

/** The tiers the model-tier-router routes turns onto (kept structural — a bare
 *  union here so this pure module needs no import from lib/foundry). */
export type CostTier = 'mini' | 'standard' | 'strong';

/**
 * A representative blended (½·input + ½·output) list price per 1K tokens for
 * each routing tier, derived from the SAME {@link PRICE_PER_1K} table the usage
 * dashboard uses — one source of truth, never a re-typed number. The mapping
 * follows the availability-matrix intent (mini ≈ gpt-4.1-mini, standard ≈
 * gpt-4.1, strong ≈ gpt-4o), so the coefficients are ~0.001 / 0.005 / 0.010 —
 * the ~10× spread that makes routing a lightweight turn to `mini` the economical
 * choice. Used by the E6 tier-routing "cost-per-quality" view; the token COUNTS
 * in production are always the real AOAI `usage`, so any figure derived here is
 * an ESTIMATE (labeled as such in the UI), not a billed amount.
 */
export const TIER_PRICE_COEFF: Record<CostTier, number> = {
  mini: Number((((PRICE_PER_1K['gpt-4.1-mini'].in + PRICE_PER_1K['gpt-4.1-mini'].out) / 2)).toFixed(5)),
  standard: Number((((PRICE_PER_1K['gpt-4.1'].in + PRICE_PER_1K['gpt-4.1'].out) / 2)).toFixed(5)),
  strong: Number((((PRICE_PER_1K['gpt-4o'].in + PRICE_PER_1K['gpt-4o'].out) / 2)).toFixed(5)),
};

/** The blended $/1K coefficient for a routing tier (defaults to `standard`). */
export function tierPriceCoeff(tier: CostTier): number {
  return TIER_PRICE_COEFF[tier] ?? TIER_PRICE_COEFF.standard;
}
