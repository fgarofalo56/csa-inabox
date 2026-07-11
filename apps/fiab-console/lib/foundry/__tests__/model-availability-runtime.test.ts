/**
 * Model-strategy M5 — runtime availability fallback (cached, non-blocking).
 *
 * Exercises applyAvailabilityFallback through the cache seam
 * (_resetAvailabilityCache) so no network / credential is touched:
 *   • warm cache + configured-missing → swaps to a supported deployment
 *   • warm cache + configured-present → unchanged
 *   • cold cache → unchanged (first-call safety; background refresh)
 *   • opt-out flag → unchanged
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyAvailabilityFallback,
  availabilityCheckEnabled,
  _resetAvailabilityCache,
  _peekAvailabilityCache,
} from '../model-availability-runtime';
import type { AoaiTarget } from '../../azure/copilot-orchestrator';

const TARGET: AoaiTarget = {
  endpoint: 'https://aoai-loom.openai.azure.us',
  deployment: 'gpt-5.6',
  apiVersion: '2024-10-21',
};

const ORIG = { ...process.env };

beforeEach(() => {
  _resetAvailabilityCache(null);
  delete process.env.LOOM_AOAI_AVAILABILITY_CHECK;
  delete process.env.LOOM_AOAI_SUB;
  delete process.env.LOOM_FOUNDRY_SUB;
  delete process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_CLOUD = 'GCC-High';
});
afterEach(() => {
  _resetAvailabilityCache(null);
  process.env = { ...ORIG };
});

describe('applyAvailabilityFallback', () => {
  it('cold cache → returns the target unchanged (never blocks the first call)', () => {
    // No subscription env → canRefresh() is false, so no background attempt runs.
    const out = applyAvailabilityFallback(TARGET);
    expect(out).toBe(TARGET);
    expect(_peekAvailabilityCache()).toBeNull();
  });

  it('warm cache + configured missing → degrades to a deployed matrix model', () => {
    _resetAvailabilityCache({
      at: Date.now(),
      region: 'usgovvirginia',
      deployments: [{ name: 'gpt-4.1' }, { name: 'text-embedding-ada-002' }],
    });
    const out = applyAvailabilityFallback(TARGET);
    expect(out.deployment).toBe('gpt-4.1'); // gpt-5.6 not deployed in Gov → gpt-4.1
    expect(out.endpoint).toBe(TARGET.endpoint); // only the deployment segment changes
    expect(out.apiVersion).toBe(TARGET.apiVersion);
  });

  it('warm cache + configured present → unchanged', () => {
    _resetAvailabilityCache({
      at: Date.now(),
      region: 'usgovvirginia',
      deployments: [{ name: 'gpt-5.6' }, { name: 'gpt-4.1' }],
    });
    const out = applyAvailabilityFallback(TARGET);
    expect(out).toBe(TARGET);
  });

  it('opt-out flag → unchanged even with a warm cache that would swap', () => {
    process.env.LOOM_AOAI_AVAILABILITY_CHECK = 'false';
    _resetAvailabilityCache({
      at: Date.now(),
      region: 'usgovvirginia',
      deployments: [{ name: 'gpt-4.1' }],
    });
    expect(availabilityCheckEnabled()).toBe(false);
    expect(applyAvailabilityFallback(TARGET)).toBe(TARGET);
  });

  it('warm cache with nothing usable → unchanged (honest 404 gate stays with caller)', () => {
    _resetAvailabilityCache({
      at: Date.now(),
      region: 'usgovvirginia',
      deployments: [{ name: 'some-unrelated-model' }],
    });
    // No chat-chain model deployed → ensureDeploymentAvailable returns available:false,
    // fallback:false → target unchanged.
    expect(applyAvailabilityFallback(TARGET)).toBe(TARGET);
  });

  it('empty target deployment → returned as-is (nothing to resolve)', () => {
    const empty = { ...TARGET, deployment: '' };
    expect(applyAvailabilityFallback(empty)).toBe(empty);
  });
});
