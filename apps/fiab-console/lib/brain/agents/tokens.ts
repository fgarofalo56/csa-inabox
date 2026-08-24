/**
 * LOOM BRAIN — token accounting and the run's cost figure.
 *
 * Two numbers leave this module and BOTH are labelled:
 *
 *   • token counts carry `AgentUsage.source` — `'reported'` when a client
 *     supplied real counts, `'estimated'` when they were derived from character
 *     length, `'mixed'` when a run did both.
 *   • the dollar figure is ALWAYS {@link derivedCost}. There is no code path in
 *     this file that can produce a `billed` figure, because there is nothing
 *     here that reads a bill.
 *
 * That is not defensive style, it is the measured situation: the Cost Management
 * API returned **HTTP 429 on 11 consecutive attempts over ~35 minutes** on
 * 2026-08-23 (PRP §1 decision 3), so every dollar figure this program has
 * produced is a measured quantity multiplied by a published list price. Rendering
 * one through {@link formatCostFigure} attaches "DERIVED estimate — not a bill"
 * to it every single time.
 *
 * Pure. No I/O.
 */

import { tierPriceCoeff, type CostTier } from '@/lib/copilot/cost-estimate';
import type { ModelTier } from '@/lib/foundry/model-tier-router';
import { derivedCost, type CostFigure } from '../types';
import type { AgentUsage } from './contracts';

/**
 * Approximate tokens in a string.
 *
 * Four characters per token is the widely used rule of thumb, and it is a RULE
 * OF THUMB — it is wrong for code, wrong for JSON, and wrong for non-Latin
 * scripts, in both directions. It is used here only because the production
 * client cannot return real counts (see {@link BrainModelReply}), and every
 * number it feeds is labelled `'estimated'` all the way to the UI. Nothing in
 * this layer treats its output as a measurement.
 *
 * Empty and whitespace-only strings are 0, not 1: a call that sent nothing
 * should not accrue phantom tokens.
 */
export function estimateTokens(text: string): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  return Math.ceil(t.length / 4);
}

/**
 * The usage record for ONE model call.
 *
 * When `reported` is supplied it is used verbatim and the source is
 * `'reported'`. When it is `null` — the production path — both counts are
 * estimated from the prompt that was sent and the reply that came back, and the
 * source is `'estimated'`.
 *
 * `replyJson` is stringified to size the completion. That is an approximation of
 * an approximation (the model emitted its own whitespace, not `JSON.stringify`'s),
 * which is exactly why the label travels with the number.
 */
export function usageForCall(args: {
  tier: ModelTier;
  system: string;
  user: string;
  replyJson: unknown;
  reported: { promptTokens: number; completionTokens: number } | null;
}): AgentUsage {
  const promptTokens = args.reported
    ? args.reported.promptTokens
    : estimateTokens(args.system) + estimateTokens(args.user);
  const completionTokens = args.reported
    ? args.reported.completionTokens
    : estimateTokens(safeStringify(args.replyJson));
  return {
    calls: 1,
    promptTokens,
    completionTokens,
    source: args.reported ? 'reported' : 'estimated',
    byTier: { [args.tier]: { promptTokens, completionTokens } },
  };
}

/**
 * A usage record for a call that was ATTEMPTED and failed.
 *
 * The prompt tokens were still spent — the request left the process — so they
 * are counted; the completion is zero because nothing usable came back. Dropping
 * a failed call to zero would make a run that failed every call look free, and a
 * cost report that under-reports on failure is worse than none.
 */
export function usageForFailedCall(args: {
  tier: ModelTier;
  system: string;
  user: string;
}): AgentUsage {
  const promptTokens = estimateTokens(args.system) + estimateTokens(args.user);
  return {
    calls: 1,
    promptTokens,
    completionTokens: 0,
    source: 'estimated',
    byTier: { [args.tier]: { promptTokens, completionTokens: 0 } },
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * The run's cost, as a {@link CostFigure} that is always `derived`.
 *
 * Priced with `tierPriceCoeff` from `lib/copilot/cost-estimate` — the SAME
 * blended $/1K-per-tier table the existing usage dashboard uses, itself derived
 * from that module's one `PRICE_PER_1K` map. Re-typing a rate here would create a
 * second source of truth that drifts silently; borrowing theirs means a price
 * correction lands in both places at once.
 *
 * The `basis` names the per-tier token counts, the coefficient applied, and
 * whether the counts were reported or estimated — so a reader can reproduce the
 * number by hand. A basis that cannot be reproduced is not a basis.
 */
export function agentRunCost(usage: AgentUsage, asOf: string): CostFigure {
  const parts: string[] = [];
  let total = 0;
  for (const [tier, v] of Object.entries(usage.byTier)) {
    const coeff = tierPriceCoeff(tier as CostTier);
    const tokens = v.promptTokens + v.completionTokens;
    const amount = (tokens / 1000) * coeff;
    total += amount;
    parts.push(`${tier}: ${v.promptTokens}p+${v.completionTokens}c=${tokens}tok x $${coeff}/1K`);
  }
  const basis =
    `${usage.calls} model call(s); token counts ${usage.source.toUpperCase()}` +
    (usage.source === 'estimated' ? ' (chars/4 — NOT a measurement)' : '') +
    `; ${parts.length ? parts.join('; ') : 'no tiers billed'}` +
    `; blended list rates from lib/copilot/cost-estimate TIER_PRICE_COEFF`;
  return derivedCost(Number(total.toFixed(4)), basis, asOf);
}
