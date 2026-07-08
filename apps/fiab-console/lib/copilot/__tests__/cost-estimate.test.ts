import { describe, it, expect } from 'vitest';
import { priceFor, estCostUsd, PRICE_PER_1K, DEFAULT_PRICE } from '../cost-estimate';

describe('cost-estimate (CTS-01 / rel-T85 shared price table)', () => {
  it('matches a model by loose substring (dated deployment name)', () => {
    expect(priceFor('gpt-4o-mini-2024-07-18')).toEqual(PRICE_PER_1K['gpt-4o-mini']);
    expect(priceFor('gpt-4.1')).toEqual(PRICE_PER_1K['gpt-4.1']);
  });

  it('falls back to the conservative default for an unknown deployment', () => {
    expect(priceFor('some-custom-llama')).toEqual(DEFAULT_PRICE);
    expect(priceFor('')).toEqual(DEFAULT_PRICE);
  });

  it('estimates USD from real token counts × list price (4-dp)', () => {
    // gpt-4o: in 0.005, out 0.015 per 1K.
    // 1000 prompt + 500 completion = 0.005 + 0.0075 = 0.0125
    expect(estCostUsd('gpt-4o', 1000, 500)).toBe(0.0125);
  });

  it('bills embeddings input-only (out rate 0)', () => {
    expect(estCostUsd('text-embedding-3-large', 10000, 0)).toBe(Number((10 * 0.00013).toFixed(4)));
  });

  it('clamps negative / NaN inputs to 0 and never throws', () => {
    expect(estCostUsd('gpt-4o', -100, Number.NaN)).toBe(0);
    expect(estCostUsd('gpt-4o', 0, 0)).toBe(0);
  });
});
