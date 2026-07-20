/**
 * Unit tests for the pure leaver / bulk helpers (access-governance W4).
 */
import { describe, it, expect } from 'vitest';
import { selectRevocable, hasLiveGrant, normalizeIds } from '../leaver';

describe('selectRevocable', () => {
  it('keeps active + eligible, drops expired + revoked', () => {
    const rows = [{ state: 'active' }, { state: 'eligible' }, { state: 'expired' }, { state: 'revoked' }] as any[];
    expect(selectRevocable(rows).map((r) => r.state)).toEqual(['active', 'eligible']);
  });
});

describe('hasLiveGrant', () => {
  it('only active rows have a live backend grant', () => {
    expect(hasLiveGrant({ state: 'active' })).toBe(true);
    expect(hasLiveGrant({ state: 'eligible' })).toBe(false);
  });
});

describe('normalizeIds', () => {
  it('de-dupes, drops blanks, and caps', () => {
    expect(normalizeIds(['a', 'a', '', ' b ', 1 as any])).toEqual(['a', 'b', '1']);
    expect(normalizeIds('nope' as any)).toEqual([]);
    expect(normalizeIds(Array.from({ length: 10 }, (_, i) => `id${i}`), 3)).toHaveLength(3);
  });
});
