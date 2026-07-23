/**
 * A11 (FAULTED detect + recreate + thrash guard) + A13 (chaos-drill recovery
 * path) + A12 (session-quota / vCore-budget) unit tests.
 *
 * The Azure boundaries (ARM bigDataPools, the warm-pool status, dispatchAlert,
 * the notification write, sleep) are injected via RecoverDeps, so these exercise
 * the REAL detect/backoff/thrash/alert logic against stubs — no live Azure, per
 * the item's "mocked ARM/session boundaries" test hook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SparkPool } from '@/lib/azure/synapse-dev-client';
import type { PoolStatus } from '@/lib/azure/spark-session-pool';
import {
  detectFaultedPools,
  recreateSparkPool,
  autoRecoverTick,
  thrashGuardTripped,
  recentAttempts,
  __resetRecoverState,
  type RecoverDeps,
} from '@/lib/azure/spark-pool-recovery';
import {
  sparkQuotaConfig,
  vcoresForSizing,
  wouldExceedQuota,
  computeQuotaStatus,
  quotaUnlimited,
  DEFAULT_SESSION_VCORES,
} from '@/lib/azure/spark-vcore-budget';

function mkPool(name: string, provisioningState: string): SparkPool {
  return {
    name,
    id: `/pools/${name}`,
    location: 'eastus2',
    properties: { nodeSize: 'Medium', nodeCount: 3, sparkVersion: '3.4', provisioningState },
  };
}

function makeDeps(over: Partial<RecoverDeps> = {}): RecoverDeps {
  return {
    listSparkPools: vi.fn(async () => []),
    getSparkPool: vi.fn(async (n: string) => mkPool(n, 'Succeeded')),
    deleteSparkPool: vi.fn(async () => {}),
    upsertSparkPool: vi.fn(async (n: string) => mkPool(n, 'Succeeded')),
    getPoolStatus: vi.fn(() => ({ groups: [] }) as unknown as PoolStatus),
    backendStatus: vi.fn(() => ({ backend: 'synapse', configured: true })),
    dispatchAlert: vi.fn(async () => ({ ok: true })),
    notify: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    now: () => Date.now(),
    ...over,
  };
}

/** A stateful getSparkPool: Failed → (after delete) 404 → (after recreate) Succeeded. */
function statefulSeams() {
  let deleted = false;
  let created = false;
  return {
    getSparkPool: vi.fn(async (n: string) => {
      if (!deleted) return mkPool(n, 'Failed');
      if (!created) throw new Error(`getSparkPool(${n}) failed 404: NotFound`);
      return mkPool(n, 'Succeeded');
    }),
    deleteSparkPool: vi.fn(async () => { deleted = true; }),
    upsertSparkPool: vi.fn(async (n: string) => { created = true; return mkPool(n, 'Succeeded'); }),
  };
}

describe('A11 — Spark pool FAULTED detection', () => {
  beforeEach(() => {
    __resetRecoverState();
    delete process.env.LOOM_SPARK_AUTORECOVER_ENABLED;
    delete process.env.LOOM_SPARK_RECOVER_MAX_ATTEMPTS;
  });

  it('detects FAULTED (ARM Failed) + SUSPECT (Succeeded + breaker armed), not healthy', async () => {
    const groups = [
      { poolName: 'suspectpool', consecFails: 2, backoffUntil: 0, lastFailure: 'MAX_QUEUED_JOBS' },
    ] as unknown as PoolStatus['groups'];
    const deps = makeDeps({
      listSparkPools: vi.fn(async () => [
        mkPool('faultedpool', 'Failed'),
        mkPool('suspectpool', 'Succeeded'),
        mkPool('healthypool', 'Succeeded'),
      ]),
      getPoolStatus: vi.fn(() => ({ groups }) as unknown as PoolStatus),
    });
    const r = await detectFaultedPools(deps);
    expect(r.scanned).toBe(3);
    expect(r.pools.map((p) => p.name).sort()).toEqual(['faultedpool', 'suspectpool']);
  });

  it('returns an honest error (not a fabricated empty) when the ARM list fails', async () => {
    const deps = makeDeps({ listSparkPools: vi.fn(async () => { throw new Error('ARM 403'); }) });
    const r = await detectFaultedPools(deps);
    expect(r.error).toMatch(/403/);
    expect(r.pools).toEqual([]);
  });
});

describe('A11 — delete + recreate', () => {
  beforeEach(() => {
    __resetRecoverState();
    delete process.env.LOOM_SPARK_AUTORECOVER_ENABLED;
    delete process.env.LOOM_SPARK_RECOVER_MAX_ATTEMPTS;
  });

  it('deletes then recreates identically, stripping output-only ARM fields', async () => {
    const s = statefulSeams();
    const deps = makeDeps(s);
    const res = await recreateSparkPool('loompool', { deps });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('recreated');
    expect(res.provisioningState).toBe('Succeeded');
    expect(s.deleteSparkPool).toHaveBeenCalledTimes(1);
    expect(s.upsertSparkPool).toHaveBeenCalledTimes(1);
    const spec: any = (s.upsertSparkPool as any).mock.calls[0][1];
    expect(spec.location).toBe('eastus2');
    expect(spec.properties.provisioningState).toBeUndefined();
    expect(spec.properties.creationDate).toBeUndefined();
    expect(spec.properties.nodeSize).toBe('Medium');
  });

  it('thrash guard skips after LOOM_SPARK_RECOVER_MAX_ATTEMPTS (default 3); force overrides', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await recreateSparkPool('loompool', { deps: makeDeps(statefulSeams()) });
      expect(res.action).toBe('recreated');
    }
    expect(thrashGuardTripped('loompool', 3)).toBe(true);
    expect(recentAttempts('loompool').length).toBe(3);

    const skipped = await recreateSparkPool('loompool', { deps: makeDeps(statefulSeams()) });
    expect(skipped.action).toBe('skipped');
    expect(skipped.reason).toMatch(/thrash/i);

    const forced = await recreateSparkPool('loompool', { force: true, deps: makeDeps(statefulSeams()) });
    expect(forced.action).toBe('recreated');
  });

  it('reports an error (never throws) when the recreate PUT keeps failing', async () => {
    const s = statefulSeams();
    const deps = makeDeps({
      ...s,
      upsertSparkPool: vi.fn(async () => { throw new Error('RP transient'); }),
    });
    const res = await recreateSparkPool('loompool', { deps });
    expect(res.action).toBe('error');
    expect(res.reason).toMatch(/RP transient/);
  });
});

describe('A11/A13 — auto-recover tick (the drill path)', () => {
  beforeEach(() => {
    __resetRecoverState();
    delete process.env.LOOM_SPARK_AUTORECOVER_ENABLED;
    delete process.env.LOOM_SPARK_RECOVER_MAX_ATTEMPTS;
  });

  it('detects a faulted pool, recreates it, and fires the operator alert', async () => {
    const s = statefulSeams();
    const dispatchAlert = vi.fn(async () => ({ ok: true }));
    const notify = vi.fn(async () => {});
    const deps = makeDeps({
      ...s,
      dispatchAlert,
      notify,
      listSparkPools: vi.fn(async () => [mkPool('loompool', 'Failed')]),
    });
    const out = await autoRecoverTick(deps);
    expect(out.enabled).toBe(true);
    expect(out.faulted).toContain('loompool');
    expect(out.recovered).toContain('loompool');
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(s.deleteSparkPool).toHaveBeenCalledTimes(1);
    expect(s.upsertSparkPool).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when disabled by env', async () => {
    process.env.LOOM_SPARK_AUTORECOVER_ENABLED = '0';
    const deps = makeDeps({ listSparkPools: vi.fn(async () => [mkPool('p', 'Failed')]) });
    const out = await autoRecoverTick(deps);
    expect(out.enabled).toBe(false);
    expect(out.recovered).toEqual([]);
    delete process.env.LOOM_SPARK_AUTORECOVER_ENABLED;
  });

  it('is a no-op on a non-Synapse backend', async () => {
    const deps = makeDeps({ backendStatus: vi.fn(() => ({ backend: 'databricks', configured: true })) });
    const out = await autoRecoverTick(deps);
    expect(out.note).toMatch(/Synapse-only/);
    expect(out.recovered).toEqual([]);
  });
});

describe('A12 — session quota / vCore budget', () => {
  beforeEach(() => {
    delete process.env.LOOM_SPARK_TENANT_SESSION_MAX;
    delete process.env.LOOM_SPARK_VCORE_BUDGET;
  });

  it('defaults to sessionMax 50 / vcoreBudget 400 when unset', () => {
    expect(sparkQuotaConfig()).toEqual({ sessionMax: 50, vcoreBudget: 400 });
  });

  it('vcoresForSizing = driver + numExecutors × executorCores (default 12)', () => {
    expect(vcoresForSizing()).toBe(DEFAULT_SESSION_VCORES);
    expect(vcoresForSizing()).toBe(12);
    expect(vcoresForSizing({ driverCores: 4, numExecutors: 3, executorCores: 8 })).toBe(28);
  });

  it('wouldExceedQuota trips on the session cap AND the vCore budget', () => {
    const cfg = { sessionMax: 2, vcoreBudget: 100 };
    expect(wouldExceedQuota(cfg, 2, 10, 12).exceeded).toBe(true); // session cap
    expect(wouldExceedQuota(cfg, 1, 95, 12).exceeded).toBe(true); // vCore budget
    expect(wouldExceedQuota(cfg, 1, 50, 12).exceeded).toBe(false); // headroom
  });

  it('computeQuotaStatus flags atCapacity + reports per-dimension headroom', () => {
    const st = computeQuotaStatus({ sessionMax: 5, vcoreBudget: 0 }, 5, 60);
    expect(st.atCapacity).toBe(true);
    expect(st.sessionsExceeded).toBe(true);
    expect(st.sessionsRemaining).toBe(0);
    expect(st.vcoresRemaining).toBeNull(); // unlimited dimension
  });

  it('quotaUnlimited only when BOTH dimensions are 0', () => {
    expect(quotaUnlimited({ sessionMax: 0, vcoreBudget: 0 })).toBe(true);
    expect(quotaUnlimited({ sessionMax: 1, vcoreBudget: 0 })).toBe(false);
    expect(quotaUnlimited({ sessionMax: 0, vcoreBudget: 1 })).toBe(false);
  });
});
