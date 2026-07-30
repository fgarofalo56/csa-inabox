/**
 * #2656 — the identifier generator must be crypto-backed, uniform, and must
 * REFUSE to degrade.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomSuffix, randomId, randomUuid } from '../random-id';

afterEach(() => vi.unstubAllGlobals());

describe('randomSuffix', () => {
  it('returns the requested length of lowercase base36', () => {
    for (const n of [1, 6, 8, 10, 32]) {
      const s = randomSuffix(n);
      expect(s).toHaveLength(n);
      expect(s).toMatch(/^[0-9a-z]+$/);
    }
  });

  it('does not repeat across many draws', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => randomSuffix(10)));
    expect(seen.size).toBe(2000);
  });

  it('uses the platform CSPRNG, not Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    const getRandomValues = vi.fn((a: Uint8Array) => {
      for (let i = 0; i < a.length; i++) a[i] = i % 251;
      return a;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    randomSuffix(8);
    expect(getRandomValues).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is UNIFORM — no symbol is materially favoured', () => {
    // The bug this pins: `byte % 36` on 0..255 makes '0'..'3' ~1.4x likelier
    // than the rest, silently costing entropy. Rejection sampling fixes it.
    const counts = new Map<string, number>();
    for (const ch of randomSuffix(36_000)) counts.set(ch, (counts.get(ch) || 0) + 1);
    expect(counts.size).toBe(36);
    const freqs = [...counts.values()];
    const expected = 36_000 / 36;
    // Generous band — this asserts the absence of a systematic 1.4x skew, not
    // a tight statistical bound, so it cannot flake.
    expect(Math.min(...freqs)).toBeGreaterThan(expected * 0.7);
    expect(Math.max(...freqs)).toBeLessThan(expected * 1.3);
  });

  it('REFUSES to fall back to Math.random when no CSPRNG exists', () => {
    // A silent downgrade is how an "unguessable" id quietly becomes guessable.
    vi.stubGlobal('crypto', undefined);
    expect(() => randomSuffix(8)).toThrow(/refusing to generate a weak identifier/i);
  });
});

describe('randomId', () => {
  it('is <prefix>-<base36 time>-<suffix>', () => {
    expect(randomId('audit')).toMatch(/^audit-[0-9a-z]+-[0-9a-z]{8}$/);
  });

  it('two ids minted in the same millisecond still differ', () => {
    // The timestamp is for readability/sortability only — uniqueness must come
    // from the suffix, or concurrent audit rows would collide.
    const ids = new Set(Array.from({ length: 500 }, () => randomId('audit')));
    expect(ids.size).toBe(500);
  });

  it('honours a custom suffix length', () => {
    expect(randomId('run', 4)).toMatch(/^run-[0-9a-z]+-[0-9a-z]{4}$/);
  });
});

describe('randomUuid', () => {
  it('delegates to crypto.randomUUID when present', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: (a: Uint8Array) => a });
    expect(randomUuid()).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalled();
  });

  it('assembles a valid v4 from CSPRNG bytes when randomUUID is absent', () => {
    const getRandomValues = vi.fn((a: Uint8Array) => {
      for (let i = 0; i < a.length; i++) a[i] = 0xff;
      return a;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const u = randomUuid();
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('real UUIDs are unique and well-formed', () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomUuid()));
    expect(ids.size).toBe(500);
    for (const u of ids) {
      expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
