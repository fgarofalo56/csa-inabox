/**
 * Shared server helpers for the ai-enrichment routes (preview + run).
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */
import { callAiFn, callCustomPrompt, type AiFn, type AiFnOptions } from '@/lib/azure/ai-functions-client';
import type { EnrichmentOp, EnrichmentOptions } from '@/lib/azure/ai-enrichment-client';

/** Parse the typed per-op options from a request body (no freeform except the
 *  custom prompt, which IS the content). */
export function parseEnrichmentOptions(o: unknown): EnrichmentOptions {
  const opts: EnrichmentOptions = {};
  if (o && typeof o === 'object') {
    const obj = o as Record<string, unknown>;
    if (Array.isArray(obj.labels)) opts.labels = obj.labels.map(String).filter(Boolean);
    if (Array.isArray(obj.fields)) opts.fields = obj.fields.map(String).filter(Boolean);
    if (typeof obj.targetLang === 'string' && obj.targetLang.trim()) opts.targetLang = obj.targetLang.trim();
    if (typeof obj.customPrompt === 'string' && obj.customPrompt.trim()) opts.customPrompt = obj.customPrompt.trim();
  }
  return opts;
}

/**
 * Build the per-row AOAI enrich fn used by the batch orchestrator: maps a
 * builtin op → callAiFn, and custom_prompt → callCustomPrompt. Carries the
 * FGC-19 model-tier deployment override + reasoning-effort through `aiOpts`.
 */
export function makeEnrichOne(op: EnrichmentOp, eopts: EnrichmentOptions, aiOpts: AiFnOptions) {
  return async (input: string) => {
    if (op === 'custom_prompt') {
      const r = await callCustomPrompt(eopts.customPrompt || '', input, aiOpts);
      return { result: r.result, model: r.model, usage: r.usage };
    }
    const r = await callAiFn(op as AiFn, input, {
      ...aiOpts,
      labels: eopts.labels,
      fields: eopts.fields,
      targetLang: eopts.targetLang,
    });
    return { result: r.result, model: r.model, usage: r.usage };
  };
}
