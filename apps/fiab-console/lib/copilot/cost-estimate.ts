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
