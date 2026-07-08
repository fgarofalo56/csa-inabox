/**
 * Unit tests for the reusable embeddings module (AIF-2). Pure helpers only —
 * no AOAI network: batching, retriable-error classification, and the
 * exponential-backoff retry wrapper with a fake failing fn.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  chunkIntoBatches,
  isRetriableEmbedError,
  withEmbedRetry,
  DEFAULT_EMBED_BATCH_SIZE,
} from '../embeddings-client';

describe('chunkIntoBatches', () => {
  it('splits into batches of the given size', () => {
    expect(chunkIntoBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('handles an empty array', () => {
    expect(chunkIntoBatches([], 4)).toEqual([]);
  });
  it('clamps a non-positive size to 1', () => {
    expect(chunkIntoBatches([1, 2], 0)).toEqual([[1], [2]]);
  });
  it('has a sane default batch size', () => {
    expect(DEFAULT_EMBED_BATCH_SIZE).toBeGreaterThan(0);
  });
});

describe('isRetriableEmbedError', () => {
  it('retries throttling + transient 5xx + network timeouts', () => {
    expect(isRetriableEmbedError(new Error('AOAI embeddings 429: rate limit'))).toBe(true);
    expect(isRetriableEmbedError(new Error('AOAI embeddings 503: unavailable'))).toBe(true);
    expect(isRetriableEmbedError(new Error('ETIMEDOUT'))).toBe(true);
  });
  it('does NOT retry config errors (404 / 400)', () => {
    expect(isRetriableEmbedError(new Error('Azure OpenAI embeddings deployment not found (404)'))).toBe(false);
    expect(isRetriableEmbedError(new Error('AOAI embeddings 400: bad input'))).toBe(false);
  });
});

describe('withEmbedRetry', () => {
  it('retries a retriable failure then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('AOAI embeddings 429: throttled');
      return 'ok';
    });
    const out = await withEmbedRetry(fn, { maxRetries: 5, baseDelayMs: 1 });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows immediately on a non-retriable error (no retries)', async () => {
    const fn = vi.fn(async () => { throw new Error('AOAI embeddings 400: bad request'); });
    await expect(withEmbedRetry(fn, { maxRetries: 5, baseDelayMs: 1 })).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const fn = vi.fn(async () => { throw new Error('AOAI embeddings 503: unavailable'); });
    await expect(withEmbedRetry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow(/503/);
    // 1 initial + 2 retries = 3 attempts.
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
