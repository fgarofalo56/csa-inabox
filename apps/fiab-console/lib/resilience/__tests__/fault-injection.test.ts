/**
 * fault-injection (CH1) — proves the dependency-fault chaos harness:
 *   - is INERT by default (registry empty; env gate off → no injection),
 *   - injects a realistic failure only when armed AND the env gate is on,
 *   - auto-expires (bounded TTL) and honors the occurrence budget (self-heal),
 *   - classifies fetch hosts to the right dependency family,
 *   - records every injection in the audit ring.
 *
 * No network, no Cosmos — the registry is pure in-process state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  armFault, disarmFault, disarmAllFaults, listArmedFaults, injectCosmosFault,
  fetchFaultForUrl, classifyFetchHost, dependencyChaosEnabled, isFaultPoint,
  CosmosChaosError, _resetFaultRegistryForTest, FAULT_POINTS, MAX_FAULT_TTL_MS,
} from '../fault-injection';

const AOAI_URL = 'https://my-aoai.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-02-01';
const ADX_URL = 'https://mycluster.eastus.kusto.windows.net/v1/rest/query';
const KV_URL = 'https://myvault.vault.azure.net/secrets/foo?api-version=7.4';
const OTHER_URL = 'https://management.azure.com/subscriptions/x';

beforeEach(() => {
  _resetFaultRegistryForTest();
  process.env.LOOM_DEPENDENCY_CHAOS_ENABLED = 'true';
});
afterEach(() => {
  _resetFaultRegistryForTest();
  delete process.env.LOOM_DEPENDENCY_CHAOS_ENABLED;
});

describe('production safety gate', () => {
  it('is inert with the env gate off — nothing arms, nothing injects', async () => {
    delete process.env.LOOM_DEPENDENCY_CHAOS_ENABLED;
    expect(dependencyChaosEnabled()).toBe(false);
    expect(armFault('cosmos-429')).toBeNull();
    expect(listArmedFaults()).toEqual([]);
    await expect(injectCosmosFault()).resolves.toBeUndefined(); // no throw
    expect(fetchFaultForUrl(AOAI_URL)).toBeNull();
  });

  it('registry is empty by default (no fault active out of the box)', () => {
    expect(listArmedFaults()).toEqual([]);
    expect(fetchFaultForUrl(ADX_URL)).toBeNull();
  });
});

describe('host classification', () => {
  it('maps each dependency host to its family', () => {
    expect(classifyFetchHost(AOAI_URL)).toBe('aoai');
    expect(classifyFetchHost(ADX_URL)).toBe('adx');
    expect(classifyFetchHost(KV_URL)).toBe('kv');
    expect(classifyFetchHost(OTHER_URL)).toBeNull();
    expect(classifyFetchHost('not a url')).toBeNull();
  });
  it('classifies Gov endpoints too', () => {
    expect(classifyFetchHost('https://c.kusto.usgovcloudapi.net/v1/rest/query')).toBe('adx');
    expect(classifyFetchHost('https://v.vault.usgovcloudapi.net/secrets/x')).toBe('kv');
  });
});

describe('cosmos-429 injection', () => {
  it('throws a 429-shaped CosmosChaosError only when armed', async () => {
    await expect(injectCosmosFault()).resolves.toBeUndefined();
    armFault('cosmos-429', { occurrences: 2 });
    await expect(injectCosmosFault()).rejects.toBeInstanceOf(CosmosChaosError);
    try {
      await injectCosmosFault();
    } catch (e) {
      expect((e as CosmosChaosError).code).toBe(429);
    }
    // budget of 2 exhausted → self-healed
    await expect(injectCosmosFault()).resolves.toBeUndefined();
    expect(listArmedFaults()).toEqual([]);
  });
});

describe('fetch injections', () => {
  it('AOAI 429 returns a 429 directive; timeout takes precedence', () => {
    armFault('aoai-429');
    const d = fetchFaultForUrl(AOAI_URL);
    expect(d).toMatchObject({ kind: 'status', status: 429, point: 'aoai-429' });

    _resetFaultRegistryForTest();
    armFault('aoai-429');
    armFault('aoai-timeout');
    expect(fetchFaultForUrl(AOAI_URL)).toMatchObject({ kind: 'timeout', point: 'aoai-timeout' });
  });

  it('ADX cold-start returns 503; KV throttle returns 429', () => {
    armFault('adx-cold');
    expect(fetchFaultForUrl(ADX_URL)).toMatchObject({ kind: 'status', status: 503, point: 'adx-cold' });
    armFault('kv-throttle');
    expect(fetchFaultForUrl(KV_URL)).toMatchObject({ kind: 'status', status: 429, point: 'kv-throttle' });
  });

  it('does not inject for an unrelated host', () => {
    armFault('aoai-429');
    expect(fetchFaultForUrl(OTHER_URL)).toBeNull();
  });
});

describe('bounds + audit', () => {
  it('clamps the TTL to the max ceiling', () => {
    const v = armFault('cosmos-429', { ttlMs: 999_999_999 });
    expect(v).not.toBeNull();
    expect(v!.expiresAt - v!.armedAt).toBeLessThanOrEqual(MAX_FAULT_TTL_MS);
  });

  it('records injections in the audit ring', () => {
    armFault('kv-throttle', { occurrences: 3 });
    fetchFaultForUrl(KV_URL);
    fetchFaultForUrl(KV_URL);
    const armed = listArmedFaults().find((a) => a.point === 'kv-throttle');
    expect(armed?.injectedCount).toBe(2);
    expect(armed?.recentInjections.length).toBe(2);
    expect(armed?.remaining).toBe(1);
  });

  it('disarm + disarm-all clear armed faults', () => {
    armFault('cosmos-429');
    armFault('adx-cold');
    expect(listArmedFaults().length).toBe(2);
    expect(disarmFault('cosmos-429')).toBe(true);
    expect(listArmedFaults().length).toBe(1);
    expect(disarmAllFaults()).toBe(1);
    expect(listArmedFaults()).toEqual([]);
  });
});

describe('input validation', () => {
  it('isFaultPoint recognizes only the known points', () => {
    for (const p of FAULT_POINTS) expect(isFaultPoint(p)).toBe(true);
    expect(isFaultPoint('nope')).toBe(false);
    expect(isFaultPoint(42)).toBe(false);
    expect(isFaultPoint(null)).toBe(false);
  });
});
