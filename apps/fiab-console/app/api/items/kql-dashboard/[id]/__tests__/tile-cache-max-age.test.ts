/**
 * Test for PSR-6 tileCacheMaxAgeSec — the results-cache / Cache-Control window
 * derived from a dashboard's autoRefreshMs, bounded to [30s, 1h].
 */
import { describe, expect, it } from 'vitest';
import { tileCacheMaxAgeSec } from '../route';

describe('tileCacheMaxAgeSec', () => {
  it('derives seconds from autoRefreshMs', () => {
    expect(tileCacheMaxAgeSec(120_000)).toBe(120);
  });
  it('defaults to 300s when unset or zero', () => {
    expect(tileCacheMaxAgeSec(undefined)).toBe(300);
    expect(tileCacheMaxAgeSec(0)).toBe(300);
  });
  it('clamps to the 30s floor', () => {
    expect(tileCacheMaxAgeSec(5_000)).toBe(30);
  });
  it('clamps to the 1h ceiling', () => {
    expect(tileCacheMaxAgeSec(9_999_999)).toBe(3600);
  });
});
