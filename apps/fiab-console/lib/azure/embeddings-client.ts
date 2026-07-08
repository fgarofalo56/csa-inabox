/**
 * Reusable Azure OpenAI EMBEDDINGS module (AIF-2, part 1).
 *
 * `aoai-chat-client.aoaiEmbed` is the single-request primitive (one POST to the
 * embeddings data-plane). This module wraps it with the two things every real
 * ingestion path needs and the primitive lacks:
 *   1. BATCHING — chunk a large text array into API-sized batches so a 10k-row
 *      column embeds in bounded requests, resolving the AOAI target ONCE.
 *   2. RETRY — exponential backoff on throttling (429) / transient 5xx, so a
 *      burst of embedding calls survives rate limits.
 *
 * It reuses `resolveAoaiTarget()` + `aoaiEmbed()` (Commercial + Gov correct, no
 * literal endpoint) and honors the existing honest gate: when AOAI is
 * unconfigured, `resolveAoaiTarget` throws `NoAoaiDeploymentError`, and a missing
 * embeddings deployment throws an error naming `LOOM_AOAI_EMBED_DEPLOYMENT`.
 *
 * Integrated vectorization (skillset + vectorizer) does embedding SERVER-SIDE in
 * AI Search; this client is for the paths that still embed app-side (e.g. a
 * one-off query vector, or a source without a server-side vectorizer).
 */
import { aoaiEmbed, type AoaiEmbedResult } from './aoai-chat-client';
import { resolveAoaiTarget, type AoaiTarget } from './copilot-orchestrator';
import type { TenantCopilotConfig } from '../types/copilot-config';

/** Max inputs per embeddings request (AOAI accepts up to 2048; we stay conservative). */
export const DEFAULT_EMBED_BATCH_SIZE = 16;
export const DEFAULT_EMBED_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;

export interface EmbedTextsOptions {
  /** Embeddings deployment (defaults to LOOM_AOAI_EMBED_DEPLOYMENT → text-embedding-3-large). */
  deployment?: string;
  /** Inputs per request. Default {@link DEFAULT_EMBED_BATCH_SIZE}. */
  batchSize?: number;
  /** Max retry attempts per batch on 429/5xx. Default {@link DEFAULT_EMBED_MAX_RETRIES}. */
  maxRetries?: number;
  /** Base backoff (ms) — doubles each attempt. Default 500. */
  baseDelayMs?: number;
  /** Tenant Copilot config forwarded to target resolution. */
  cfg?: TenantCopilotConfig | null;
  /** Pre-resolved target (skips a second Foundry lookup). */
  target?: AoaiTarget;
}

export interface EmbedTextsResult {
  /** One vector per input, in input order. */
  vectors: number[][];
  /** Embeddings deployment that served the request. */
  model: string;
  /** Summed token usage across every batch. */
  usage: { promptTokens: number; totalTokens: number };
  /** Number of batches issued. */
  batches: number;
}

/** Split `items` into chunks of at most `size` (>=1). Pure + exported for tests. */
export function chunkIntoBatches<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * True when an embedding error is worth retrying: throttling (429) or a
 * transient upstream 5xx / network timeout. A 404 (deployment not found) or 400
 * is NOT retriable — it's a config error surfaced immediately. Pure + exported.
 */
export function isRetriableEmbedError(e: unknown): boolean {
  const msg = (e as any)?.message ? String((e as any).message) : String(e);
  if (/\b429\b/.test(msg) || /rate.?limit|throttl/i.test(msg)) return true;
  if (/\b(500|502|503|504)\b/.test(msg)) return true;
  if (/timeout|ETIMEDOUT|ECONNRESET|network/i.test(msg)) return true;
  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` with exponential-backoff retry on retriable embedding errors. Pure of
 * AOAI specifics (takes any async fn) so it's unit-testable with a fake. Rethrows
 * the last error once attempts are exhausted or the error is non-retriable.
 */
export async function withEmbedRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_EMBED_MAX_RETRIES;
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= maxRetries || !isRetriableEmbedError(e)) break;
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/**
 * Embed a batch of texts, resolving the AOAI target once and issuing one request
 * per {@link EmbedTextsOptions.batchSize} chunk with per-batch retry. Returns the
 * vectors in input order plus summed usage.
 */
export async function embedTexts(
  texts: readonly string[],
  opts: EmbedTextsOptions = {},
): Promise<EmbedTextsResult> {
  if (!texts.length) return { vectors: [], model: opts.deployment || '', usage: { promptTokens: 0, totalTokens: 0 }, batches: 0 };
  // Resolve the target ONCE so every batch reuses the same endpoint + token host.
  const target = opts.target ?? (await resolveAoaiTarget(opts.cfg ?? null));
  const batches = chunkIntoBatches(texts, opts.batchSize ?? DEFAULT_EMBED_BATCH_SIZE);
  const vectors: number[][] = [];
  let promptTokens = 0;
  let totalTokens = 0;
  let model = opts.deployment || '';
  for (const batch of batches) {
    const res: AoaiEmbedResult = await withEmbedRetry(
      () => aoaiEmbed({ input: batch, deployment: opts.deployment, target, cfg: opts.cfg }),
      { maxRetries: opts.maxRetries, baseDelayMs: opts.baseDelayMs },
    );
    vectors.push(...res.vectors);
    model = res.model || model;
    if (res.usage) { promptTokens += res.usage.promptTokens; totalTokens += res.usage.totalTokens; }
  }
  return { vectors, model, usage: { promptTokens, totalTokens }, batches: batches.length };
}

/** Convenience: embed a single string → one vector. */
export async function embedText(text: string, opts: EmbedTextsOptions = {}): Promise<number[]> {
  const { vectors } = await embedTexts([text], opts);
  return vectors[0] || [];
}
