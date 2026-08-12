/**
 * #3171 — server-side Spark pool auto-bind resolver.
 *
 * The ARM boundary (`listSparkPools`) is mocked; every decision under test is
 * the resolver's own. The cases that matter and why:
 *   • an ABSENT pool resolves instead of 400'ing (the bug);
 *   • the `loompool` env hint NEVER wins over reality — the live estate moved
 *     to `loompool2` after the 2026-07-14 capacity incident, so a resolver that
 *     trusted the literal would bind to a pool that does not exist;
 *   • "the list is empty" and "the list could not be read" are DIFFERENT
 *     answers (deploy-integrity R7) — the second never claims the first;
 *   • the create path PROVES the pool accepts a Livy session and re-binds once
 *     on an established 404, then fails closed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/synapse-dev-client', () => ({ listSparkPools: vi.fn() }));

import { listSparkPools } from '@/lib/azure/synapse-dev-client';
import {
  resolveSparkPool, resetSparkPoolListCache, rankSparkPools,
  isPoolNotFoundError, createSessionOnResolvedPool,
  type ResolvedSparkPool,
} from '../spark-pool-resolver';

const pool = (name: string, provisioningState = 'Succeeded') =>
  ({ name, id: `/subscriptions/x/.../bigDataPools/${name}`, properties: { provisioningState } }) as any;

const ENV_KEYS = ['LOOM_SYNAPSE_SPARK_POOL', 'LOOM_SPARK_POOL', 'LOOM_DEFAULT_SPARK_POOL'];

beforeEach(() => {
  vi.resetAllMocks();
  resetSparkPoolListCache();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-test';
});

describe('resolveSparkPool — the #3171 bug: no pool supplied', () => {
  it('auto-binds to the workspace pool instead of failing', async () => {
    (listSparkPools as any).mockResolvedValue([pool('loompool2')]);
    const r = await resolveSparkPool();
    expect(r.ok).toBe(true);
    const ok = r as ResolvedSparkPool;
    expect(ok.pool).toBe('loompool2');
    expect(ok.source).toBe('workspace');
    expect(ok.verified).toBe(true);
    expect(ok.note).toContain('auto-bound to "loompool2"');
  });

  it('never emits a literal pool name it did not observe', async () => {
    // The pre-existing defaultSparkPool() would have returned 'loompool' here.
    (listSparkPools as any).mockResolvedValue([pool('anythingelse')]);
    const r = await resolveSparkPool();
    expect((r as ResolvedSparkPool).pool).toBe('anythingelse');
    expect(JSON.stringify(r)).not.toContain('"loompool"');
  });
});

describe('resolveSparkPool — the env hint is a HINT, checked against reality', () => {
  it('uses the hint when the workspace actually has that pool', async () => {
    process.env.LOOM_SYNAPSE_SPARK_POOL = 'loompool2';
    (listSparkPools as any).mockResolvedValue([pool('loompool2'), pool('other')]);
    const r = await resolveSparkPool();
    expect((r as ResolvedSparkPool).pool).toBe('loompool2');
    expect((r as ResolvedSparkPool).source).toBe('env');
    expect((r as ResolvedSparkPool).verified).toBe(true);
  });

  it('the loompool -> loompool2 drift re-binds to the successor and SAYS SO', async () => {
    process.env.LOOM_SYNAPSE_SPARK_POOL = 'loompool';   // stale bicep default
    (listSparkPools as any).mockResolvedValue([pool('zzz-other'), pool('loompool2')]);
    const r = await resolveSparkPool();
    const ok = r as ResolvedSparkPool;
    expect(ok.pool).toBe('loompool2');            // hint-prefix rank wins, not 'zzz-other'
    expect(ok.source).toBe('workspace');
    expect(ok.note).toContain('LOOM_SYNAPSE_SPARK_POOL="loompool" does not match any pool');
    expect(ok.note).toContain('pools present: zzz-other, loompool2');
  });

  it('prefers a Succeeded pool over a Failed one', async () => {
    (listSparkPools as any).mockResolvedValue([pool('aaa', 'Failed'), pool('bbb', 'Succeeded')]);
    const r = await resolveSparkPool();
    expect((r as ResolvedSparkPool).pool).toBe('bbb');
  });

  it('still binds when EVERY pool is unhealthy, and reports the ARM state', async () => {
    (listSparkPools as any).mockResolvedValue([pool('only', 'Failed')]);
    const r = await resolveSparkPool();
    const ok = r as ResolvedSparkPool;
    expect(ok.pool).toBe('only');
    expect(ok.note).toContain('ARM reports its provisioning state as "Failed"');
  });
});

describe('resolveSparkPool — a caller-supplied pool', () => {
  it('is honoured verbatim on a hot path without touching ARM', async () => {
    const r = await resolveSparkPool('bound-pool');
    expect((r as ResolvedSparkPool).pool).toBe('bound-pool');
    expect((r as ResolvedSparkPool).source).toBe('request');
    expect(listSparkPools).not.toHaveBeenCalled();
  });

  it('is confirmed at a BIND point and kept when it exists', async () => {
    (listSparkPools as any).mockResolvedValue([pool('bound-pool'), pool('spare')]);
    const r = await resolveSparkPool('bound-pool', { verifyRequested: true });
    const ok = r as ResolvedSparkPool;
    expect(ok.pool).toBe('bound-pool');
    expect(ok.source).toBe('request');
    expect(ok.verified).toBe(true);
    expect(ok.alternatives).toEqual(['spare']);
  });

  it('self-heals a stale saved binding at a BIND point', async () => {
    (listSparkPools as any).mockResolvedValue([pool('loompool2')]);
    const r = await resolveSparkPool('loompool', { verifyRequested: true });
    const ok = r as ResolvedSparkPool;
    expect(ok.pool).toBe('loompool2');
    expect(ok.source).toBe('workspace');
    expect(ok.note).toContain('Requested Spark pool "loompool" is not in workspace "syn-test"');
  });

  it('matches case-insensitively rather than re-binding needlessly', async () => {
    (listSparkPools as any).mockResolvedValue([pool('LoomPool2')]);
    const r = await resolveSparkPool('loompool2', { verifyRequested: true });
    expect((r as ResolvedSparkPool).pool).toBe('LoomPool2');
    expect((r as ResolvedSparkPool).source).toBe('request');
  });
});

describe('resolveSparkPool — R7: empty list and unreadable list are DIFFERENT answers', () => {
  it('an EMPTY list is reported as empty, with the bicep remediation', async () => {
    (listSparkPools as any).mockResolvedValue([]);
    const r = await resolveSparkPool();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('no_spark_pool');
    expect(r.status).toBe(503);
    expect(r.error).toContain('the list came back empty');
    expect(r.hint).toContain('landing-zone/synapse.bicep');
  });

  it('a FAILED list never claims "no pools exist" — it says it does not know', async () => {
    (listSparkPools as any).mockRejectedValue(new Error('listSparkPools failed 403: Forbidden'));
    const r = await resolveSparkPool();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('pool_unresolved');
    expect(r.status).toBe(502);
    expect(r.error).toContain('Loom does not know whether a pool exists');
    expect(r.error).toContain('403');
    expect(r.error).not.toContain('came back empty');
  });

  it('a FAILED list falls back to the operator hint, marked UNVERIFIED', async () => {
    process.env.LOOM_SPARK_POOL = 'operator-pool';
    (listSparkPools as any).mockRejectedValue(new Error('listSparkPools failed 500: boom'));
    const r = await resolveSparkPool();
    const ok = r as ResolvedSparkPool;
    expect(ok.pool).toBe('operator-pool');
    expect(ok.verified).toBe(false);
    expect(ok.note).toContain('Loom does not know whether it exists');
    expect(ok.note).toContain('LOOM_SPARK_POOL hint');
  });

  it('a failed list is NOT cached — the next call retries ARM', async () => {
    (listSparkPools as any).mockRejectedValueOnce(new Error('x failed 500: boom'));
    await resolveSparkPool();
    (listSparkPools as any).mockResolvedValue([pool('back-up')]);
    const r = await resolveSparkPool();
    expect((r as ResolvedSparkPool).pool).toBe('back-up');
    expect(listSparkPools).toHaveBeenCalledTimes(2);
  });
});

describe('rankSparkPools', () => {
  it('is deterministic: hint-prefix, then health, then name', async () => {
    const ordered = rankSparkPools(
      [pool('zeta'), pool('loompool9', 'Failed'), pool('alpha'), pool('loompool2')],
      'loompool',
    ).map((p) => p.name);
    expect(ordered).toEqual(['loompool2', 'loompool9', 'alpha', 'zeta']);
  });
});

describe('isPoolNotFoundError — R7 classification', () => {
  it('true only for an established 404 naming that pool', () => {
    expect(isPoolNotFoundError(new Error('createLivySession(loompool) failed 404: not found'), 'loompool')).toBe(true);
  });
  it('false for a 403 (permission is NOT non-existence)', () => {
    expect(isPoolNotFoundError(new Error('createLivySession(loompool) failed 403: Forbidden'), 'loompool')).toBe(false);
  });
  it('false for a 404 naming a DIFFERENT pool', () => {
    expect(isPoolNotFoundError(new Error('createLivySession(other) failed 404: nope'), 'loompool')).toBe(false);
  });
  it('false for a timeout with no status', () => {
    expect(isPoolNotFoundError(new Error('fetch timed out after 30000ms'), 'loompool')).toBe(false);
  });
});

describe('createSessionOnResolvedPool — proves the pool accepts a Livy session', () => {
  const resolution = (alts: string[]): ResolvedSparkPool =>
    ({ ok: true, pool: 'loompool', source: 'env', verified: true, alternatives: alts, note: undefined });

  it('returns the session on the first pool when it accepts', async () => {
    const create = vi.fn(async (p: string) => ({ id: 7, on: p }));
    const out = await createSessionOnResolvedPool(resolution(['loompool2']), create);
    expect(out.pool).toBe('loompool');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('re-binds ONCE on an established 404 and records the swap', async () => {
    const create = vi.fn(async (p: string) => {
      if (p === 'loompool') throw new Error('createLivySession(loompool) failed 404: pool not found');
      return { id: 9, on: p };
    });
    const out = await createSessionOnResolvedPool(resolution(['loompool2']), create);
    expect(out.pool).toBe('loompool2');
    expect(out.note).toContain('returned HTTP 404 from the Livy session API; re-bound to "loompool2"');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('FAILS CLOSED — a second failure propagates, it does not loop', async () => {
    const create = vi.fn(async (p: string) => { throw new Error(`createLivySession(${p}) failed 404: gone`); });
    await expect(createSessionOnResolvedPool(resolution(['loompool2']), create)).rejects.toThrow('failed 404');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 403 — an unestablished cause is never treated as absence', async () => {
    const create = vi.fn(async (p: string) => { throw new Error(`createLivySession(${p}) failed 403: Forbidden`); });
    await expect(createSessionOnResolvedPool(resolution(['loompool2']), create)).rejects.toThrow('403');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when there is no alternative pool', async () => {
    const create = vi.fn(async (p: string) => { throw new Error(`createLivySession(${p}) failed 404: gone`); });
    await expect(createSessionOnResolvedPool(resolution([]), create)).rejects.toThrow('404');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
