/**
 * PSR-5 warm-on-first-access — the once-per-model-per-process guard behind the
 * background prime kicked on the first cache MISS in evalDax. We assert the
 * GUARD semantics (fire-and-forget + de-dupe), not the network warm itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { primeOnFirstAccess, _resetWarmGuard } from '../tabular-eval-client';

afterEach(() => {
  _resetWarmGuard();
});

describe('primeOnFirstAccess', () => {
  it('kicks a warm the FIRST time a model is accessed, then de-dupes', () => {
    expect(primeOnFirstAccess('model-1', 'tenant-1', 'db1')).toBe(true);
    // Immediately (before any async warm settles) a repeat access is a no-op.
    expect(primeOnFirstAccess('model-1', 'tenant-1', 'db1')).toBe(false);
  });

  it('scopes the guard by tenant + model + database', () => {
    expect(primeOnFirstAccess('model-1', 'tenant-1', 'db1')).toBe(true);
    // Different tenant → warms again.
    expect(primeOnFirstAccess('model-1', 'tenant-2', 'db1')).toBe(true);
    // Different database → warms again.
    expect(primeOnFirstAccess('model-1', 'tenant-1', 'db2')).toBe(true);
    // Same triple → de-duped.
    expect(primeOnFirstAccess('model-1', 'tenant-1', 'db1')).toBe(false);
  });

  it('re-warms after the guard is reset (replica restart analogue)', () => {
    expect(primeOnFirstAccess('m', 't', undefined)).toBe(true);
    expect(primeOnFirstAccess('m', 't', undefined)).toBe(false);
    _resetWarmGuard();
    expect(primeOnFirstAccess('m', 't', undefined)).toBe(true);
  });
});
