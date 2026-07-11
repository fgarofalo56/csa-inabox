/**
 * Model-strategy M5 — per-cloud/region availability matrix + graceful fallback.
 *
 * Pure, network-free coverage of:
 *   • bestModelsFor / modelPreferenceChain — the Learn-grounded per-cloud matrix
 *     (Commercial gets GPT-5.6; Gov NEVER pins GPT-5.6; floors terminate chains)
 *   • ensureDeploymentAvailable — configured-present passthrough, degrade to the
 *     best deployed matrix model, honest signal when nothing matches, name vs
 *     modelName matching, empty-list trust.
 */
import { describe, it, expect } from 'vitest';
import {
  bestModelsFor,
  modelPreferenceChain,
  ensureDeploymentAvailable,
  normalizeRegion,
  MODEL_FLOOR,
  MATRIX_TASK_KEYS,
  type AvailableDeployment,
} from '../model-availability-matrix';

describe('bestModelsFor — per-cloud best-supported models', () => {
  it('Commercial gets the frontier GPT-5.6 for strong + gpt-5-chat for chat', () => {
    const best = bestModelsFor('Commercial');
    expect(best.strong).toBe('gpt-5.6');
    expect(best.chat).toBe('gpt-5-chat');
    expect(best.mini).toBe('gpt-4.1-mini');
    expect(best.embed).toBe('text-embedding-3-large');
  });

  it('NEVER pins GPT-5.6 in any Gov boundary (the 404 rule)', () => {
    for (const cloud of ['GCC', 'GCC-High', 'DoD'] as const) {
      const best = bestModelsFor(cloud);
      for (const key of MATRIX_TASK_KEYS) {
        expect(best[key].toLowerCase()).not.toBe('gpt-5.6');
      }
    }
  });

  it('DoD strong resolves to GPT-5.2 (reached US Gov Secret/TS), not a frontier Commercial model', () => {
    expect(bestModelsFor('DoD').strong).toBe('gpt-5.2');
  });

  it('GCC-High best chat is gpt-5-chat with a gpt-4.1 floor in the chain', () => {
    const best = bestModelsFor('GCC-High');
    expect(best.chat).toBe('gpt-5-chat');
    expect(modelPreferenceChain('GCC-High', undefined, 'chat')).toContain('gpt-4.1');
  });

  it('unknown cloud falls back to the Commercial matrix (never crashes)', () => {
    // Cast through unknown to simulate an out-of-enum value at a JS boundary.
    const best = bestModelsFor('Mars' as unknown as 'Commercial');
    expect(best).toEqual(bestModelsFor('Commercial'));
  });
});

describe('modelPreferenceChain — ordering + floor + region overrides', () => {
  it('every chain contains the task floor so a match is always reachable', () => {
    for (const cloud of ['Commercial', 'GCC', 'GCC-High', 'DoD'] as const) {
      for (const key of MATRIX_TASK_KEYS) {
        const chain = modelPreferenceChain(cloud, undefined, key);
        expect(chain).toContain(MODEL_FLOOR[key]);
      }
    }
  });

  it('is de-duplicated and order-preserving (floor already present is not doubled)', () => {
    const chain = modelPreferenceChain('GCC-High', undefined, 'chat'); // [gpt-5-chat, gpt-4.1]
    const lower = chain.map((m) => m.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('usgovarizona region override pins a leaner embed chain (ada-002 first)', () => {
    const az = modelPreferenceChain('GCC-High', 'usgovarizona', 'embed');
    expect(az[0]).toBe('text-embedding-ada-002');
    // usgovvirginia (no override) keeps the richer default (3-large first).
    const va = modelPreferenceChain('GCC-High', 'usgovvirginia', 'embed');
    expect(va[0]).toBe('text-embedding-3-large');
  });

  it('normalizeRegion lower-cases and strips whitespace', () => {
    expect(normalizeRegion('US Gov Virginia')).toBe('usgovvirginia');
    expect(normalizeRegion(undefined)).toBe('');
  });
});

describe('ensureDeploymentAvailable — graceful fallback', () => {
  const deployed = (...names: string[]): AvailableDeployment[] => names.map((n) => ({ name: n }));

  it('returns the configured deployment unchanged when it IS deployed', () => {
    const r = ensureDeploymentAvailable('gpt-5-chat', deployed('gpt-5-chat', 'gpt-4.1-mini'), 'Commercial', 'eastus', 'chat');
    expect(r.available).toBe(true);
    expect(r.fallback).toBe(false);
    expect(r.deployment).toBe('gpt-5-chat');
  });

  it('degrades a configured-but-missing model to the best deployed matrix model', () => {
    // Gov account has only gpt-4.1 deployed; a GPT-5.6 pin degrades to gpt-4.1.
    const r = ensureDeploymentAvailable('gpt-5.6', deployed('gpt-4.1'), 'GCC-High', 'usgovvirginia', 'chat');
    expect(r.available).toBe(true);
    expect(r.fallback).toBe(true);
    expect(r.deployment).toBe('gpt-4.1');
    expect(r.reason).toMatch(/not deployed in GCC-High/);
  });

  it('matches a chain model by the deployment modelName, not just its name', () => {
    // Deployment is NAMED "chat-prod" but backs the gpt-4.1 model.
    const list: AvailableDeployment[] = [{ name: 'chat-prod', modelName: 'gpt-4.1' }];
    const r = ensureDeploymentAvailable('gpt-5.6', list, 'GCC-High', undefined, 'chat');
    expect(r.available).toBe(true);
    expect(r.fallback).toBe(true);
    expect(r.deployment).toBe('chat-prod'); // returns the deployment NAME to call
    expect(r.fallbackModel).toBe('gpt-4.1');
  });

  it('matches the configured deployment by modelName too', () => {
    const list: AvailableDeployment[] = [{ name: 'my-embed', modelName: 'text-embedding-3-large' }];
    const r = ensureDeploymentAvailable('text-embedding-3-large', list, 'Commercial', 'eastus', 'embed');
    expect(r.fallback).toBe(false);
    expect(r.deployment).toBe('my-embed');
  });

  it('emits an honest signal (available:false) when nothing in the chain is deployed', () => {
    const r = ensureDeploymentAvailable('gpt-5.6', deployed('some-random-model'), 'Commercial', 'eastus', 'chat');
    expect(r.available).toBe(false);
    expect(r.fallback).toBe(false);
    expect(r.deployment).toBe('gpt-5.6'); // left unchanged for the caller's 404 gate
    expect(r.reason).toMatch(/No supported chat model/);
  });

  it('trusts the configured value when the deployment list is empty (unknown, not "nothing works")', () => {
    const r = ensureDeploymentAvailable('gpt-5-chat', [], 'Commercial', 'eastus', 'chat');
    expect(r.available).toBe(true);
    expect(r.fallback).toBe(false);
    expect(r.deployment).toBe('gpt-5-chat');
  });

  it('accepts a plain string deployment list', () => {
    const r = ensureDeploymentAvailable('gpt-5.6', ['gpt-4.1'], 'DoD', 'usdodeast', 'strong');
    expect(r.fallback).toBe(true);
    expect(r.deployment).toBe('gpt-4.1');
  });

  it('is case-insensitive on deployment matching', () => {
    const r = ensureDeploymentAvailable('GPT-5-CHAT', deployed('gpt-5-chat'), 'Commercial', 'eastus', 'chat');
    expect(r.available).toBe(true);
    expect(r.fallback).toBe(false);
    expect(r.deployment).toBe('gpt-5-chat');
  });
});
