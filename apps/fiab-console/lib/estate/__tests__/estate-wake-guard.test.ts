/**
 * #5111 defect 1 - a data-plane wake must not undo an estate pause.
 *
 * Every `it` names the input that breaks it (assertion-design.md). The wiring
 * tests run the REAL verbs (`resumePool`, `resumeDedicatedPool`,
 * `startKustoCluster`, `startCluster`) over a mocked transport, so removing the
 * `assertEstateAllowsWake` call from any of them turns its test RED.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- the persisted estate state (Cosmos) -----------------------------------
let rows: Array<Record<string, unknown>> = [];
let cosmosError: Error | null = null;
const queryCalls: Array<{ query: string; parameters: Array<{ name: string; value: string }> }> = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  maintenanceJobsContainer: async () => ({
    items: {
      query: (q: { query: string; parameters: Array<{ name: string; value: string }> }) => ({
        fetchAll: async () => {
          queryCalls.push(q);
          if (cosmosError) throw cosmosError;
          return { resources: rows };
        },
      }),
    },
  }),
}));

// ---- ARM transports --------------------------------------------------------
const armPost = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock('@/lib/azure/arm-client', () => ({
  armGet: vi.fn(async () => ({})),
  armGetWithRetry: vi.fn(async () => ({})),
  armPost: (...a: unknown[]) => armPost(...a),
  armPatch: vi.fn(async () => ({})),
  armPut: vi.fn(),
  armDelete: vi.fn(),
}));
const armCountedFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 202 }));
vi.mock('@/lib/azure/arm-counted-fetch', () => ({
  armCountedFetch: (u: string, i?: RequestInit) => armCountedFetch(u, i),
}));
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }; } },
}));

import {
  assertEstateAllowsWake,
  EstatePausedError,
  isEstatePausedError,
  ESTATE_RESUME_LOCATION,
} from '../estate-wake-guard';
import { clearStateCache, __setStateCacheClock } from '../estate-state-cache';
import { resumePool } from '@/lib/azure/synapse-pool-arm';
import { resumeDedicatedPool } from '@/lib/azure/synapse-dev-client';
import { startKustoCluster } from '@/lib/azure/kusto-arm-client';
import { startCluster, startWarehouse } from '@/lib/azure/databricks-client';
import { createArmActuator } from '../pause-actuator';
import type { PausedResourceSnapshot } from '../pause-state';

const row = (state: string, extra: Record<string, unknown> = {}) => ({
  state,
  createdBy: 'frank@contoso.com',
  createdAt: '2026-10-23T22:38:00.000Z',
  ...extra,
});

async function refusal(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

beforeEach(() => {
  rows = [];
  cosmosError = null;
  queryCalls.length = 0;
  vi.clearAllMocks();
  clearStateCache();
  __setStateCacheClock(null);
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-dlz';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
});
afterEach(() => {
  vi.restoreAllMocks();
  __setStateCacheClock(null);
});

describe('assertEstateAllowsWake', () => {
  // Breaks if: PAUSING is treated as not-paused (the exact window the live estate sat in for 14 h).
  it.each(['PAUSING', 'PAUSED'])('refuses while the stored state is %s, naming who, when and where to resume', async (state) => {
    rows = [row(state, state === 'PAUSED' ? { pausedAt: '2026-10-23T22:45:00.000Z' } : {})];
    const e = await refusal(() => assertEstateAllowsWake('the Synapse dedicated SQL pool'));
    expect(e).toBeInstanceOf(EstatePausedError);
    expect(isEstatePausedError(e)).toBe(true);
    const msg = (e as EstatePausedError).message;
    expect(msg).toContain(`The estate is ${state}`);
    expect(msg).toContain('frank@contoso.com');
    expect(msg).toContain('waking the Synapse dedicated SQL pool is refused');
    expect(msg).toContain(ESTATE_RESUME_LOCATION);
    // PAUSED carries the confirmed instant; PAUSING falls back to the start of the pause.
    expect(msg).toContain(state === 'PAUSED' ? '2026-10-23T22:45:00.000Z' : '2026-10-23T22:38:00.000Z');
  });

  // Positive pair for the refusal above: breaks if the guard refuses ALWAYS (a guard that is a plain throw).
  it.each(['RUNNING', 'RESUMING', 'RESUME_FAILED'])('allows a wake while the stored state is %s', async (state) => {
    rows = [row(state)];
    await expect(assertEstateAllowsWake('x')).resolves.toBeUndefined();
    expect(queryCalls).toHaveLength(1); // it really read the state; allowing is not the "no read" default
  });

  it('allows a wake when no snapshot exists at all (an estate never paused)', async () => {
    rows = [];
    await expect(assertEstateAllowsWake('x')).resolves.toBeUndefined();
    expect(queryCalls).toHaveLength(1);
  });

  // Breaks if: the read is keyed on a tenant id (wake sites have no session) or drops the kind filter
  // (any other doc with the same id would then hold the estate).
  it('reads by document id AND kind, cross-partition', async () => {
    rows = [];
    await assertEstateAllowsWake('x');
    const [q] = queryCalls;
    expect(q.query).toContain('c.id = @id AND c.kind = @kind');
    expect(q.parameters).toEqual([
      { name: '@id', value: 'estate-pause:current' },
      { name: '@kind', value: 'estate-pause-snapshot' },
    ]);
  });

  // Breaks if: the guard fails CLOSED (throws on a Cosmos fault) - every warehouse would be unusable on a blip.
  it('FAILS OPEN on an unreadable state and logs a warning that names the cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cosmosError = new Error('cosmos 503 ServiceUnavailable');
    await expect(assertEstateAllowsWake('x')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('cosmos 503 ServiceUnavailable');
    expect(String(warn.mock.calls[0][0])).toContain('fail-open');
  });

  // Breaks if: a failed read is CACHED as "not paused" - one blip would then green-light wakes for the whole TTL
  // even after Cosmos recovers and the estate is in fact PAUSED.
  it('does not cache a failed read: the next wake re-reads and now refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cosmosError = new Error('blip');
    await assertEstateAllowsWake('x');
    cosmosError = null;
    rows = [row('PAUSED')];
    await expect(assertEstateAllowsWake('x')).rejects.toBeInstanceOf(EstatePausedError);
    expect(queryCalls).toHaveLength(2);
  });

  // Breaks if: there is no cache (a Cosmos read per wake) or a mutation does not clear it (stale verdict after pause).
  it('caches a good read, and clearStateCache (called by pause/resume) drops it', async () => {
    rows = [row('RUNNING')];
    await assertEstateAllowsWake('x');
    await assertEstateAllowsWake('x');
    expect(queryCalls).toHaveLength(1);
    rows = [row('PAUSING')]; // the pause started; handlers call clearStateCache()
    clearStateCache();
    await expect(assertEstateAllowsWake('x')).rejects.toBeInstanceOf(EstatePausedError);
    expect(queryCalls).toHaveLength(2);
  });

  // Breaks if: the cache never expires (a resume in another replica would be invisible for ever).
  it('re-reads once the TTL has passed', async () => {
    let t = 1_000_000;
    __setStateCacheClock(() => t);
    rows = [row('RUNNING')];
    await assertEstateAllowsWake('x');
    t += 11_000; // default TTL is 10 s
    await assertEstateAllowsWake('x');
    expect(queryCalls).toHaveLength(2);
  });
});

describe('the wake verbs call the guard FIRST (no ARM request is sent while paused)', () => {
  // Breaks if: resumePool() loses its guard - then armCountedFetch is called with .../resume (the live 03:01Z wake).
  it('resumePool refuses while PAUSED and sends NO request; sends the resume POST while RUNNING', async () => {
    rows = [row('PAUSED', { pausedAt: '2026-10-23T22:45:00.000Z' })];
    const e = await refusal(() => resumePool());
    expect(e).toBeInstanceOf(EstatePausedError);
    expect(armCountedFetch).not.toHaveBeenCalled();

    clearStateCache();
    rows = [row('RUNNING')];
    await resumePool();
    const posts = armCountedFetch.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toMatch(/\/sqlPools\/loompool\/resume\?/);
  });

  // Breaks if: the dev-client resume (compute-targets start route) loses its guard.
  it('resumeDedicatedPool refuses while PAUSING, naming the pool', async () => {
    rows = [row('PAUSING')];
    const e = await refusal(() => resumeDedicatedPool('loompool'));
    expect(e).toBeInstanceOf(EstatePausedError);
    expect((e as Error).message).toContain('the Synapse dedicated SQL pool loompool');
    expect(armCountedFetch).not.toHaveBeenCalled();
  });

  // Positive pair: past the guard the verb proceeds (and fails later for its own, non-estate reasons here).
  it('resumeDedicatedPool is NOT an estate refusal while RUNNING', async () => {
    rows = [row('RUNNING')];
    const e = await refusal(() => resumeDedicatedPool('loompool'));
    expect(isEstatePausedError(e)).toBe(false);
    expect(queryCalls).toHaveLength(1); // the guard ran and let it through
  });

  it('startKustoCluster refuses while PAUSED', async () => {
    rows = [row('PAUSED')];
    const e = await refusal(() => startKustoCluster());
    expect(e).toBeInstanceOf(EstatePausedError);
    expect(armCountedFetch).not.toHaveBeenCalled();
  });

  it('startCluster and startWarehouse (Databricks auto-start paths) refuse while PAUSED', async () => {
    rows = [row('PAUSED')];
    expect(await refusal(() => startCluster('c-1'))).toBeInstanceOf(EstatePausedError);
    expect(await refusal(() => startWarehouse('w-1'))).toBeInstanceOf(EstatePausedError);
  });
});

describe("the estate's OWN resume is never blocked by the guard", () => {
  const poolId = '/subscriptions/sub-1/resourceGroups/rg-dlz/providers/Microsoft.Synapse/workspaces/ws/sqlPools/loompool';
  const entry: PausedResourceSnapshot = {
    resourceId: poolId,
    resourceType: 'microsoft.synapse/workspaces/sqlpools',
    name: 'loompool',
    resourceGroup: 'rg-dlz',
    subscriptionId: 'sub-1',
    prePausePowerState: 'Online',
    powerStateSource: 'arm',
    powerStateReadAt: '2026-10-23T22:38:00.000Z',
    powerStateApiVersion: '2021-06-01',
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 'tagged' },
  };

  // Breaks if: the actuator's resume is routed through resumePool() (or any guarded verb): the guard would then refuse
  // the estate's own resume with 'The estate is PAUSED' and the estate could never be brought back.
  it('actuator.resume posts straight to ARM while the stored state is PAUSED', async () => {
    rows = [row('PAUSED')];
    const actuator = await createArmActuator();
    const r = await actuator.resume(entry);
    expect(r.ok).toBe(true);
    expect(armPost).toHaveBeenCalledTimes(1);
    expect(String(armPost.mock.calls[0][0])).toBe(`${poolId}/resume?api-version=2021-06-01`);
    expect(r.detail).not.toContain('The estate is PAUSED');
    // Positive pair: the SAME state refuses the routine wake, so the PAUSED fixture above is really being enforced.
    await expect(resumePool()).rejects.toBeInstanceOf(EstatePausedError);
  });
});
