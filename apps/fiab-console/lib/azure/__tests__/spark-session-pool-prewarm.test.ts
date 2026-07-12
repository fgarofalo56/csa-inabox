/**
 * R3 — warm Spark pool PRE-WARM + scale-to-zero survival (behavioral).
 *
 * Live evidence (rev 0000225, loompool): pool status showed warm:0 with the
 * warm-pool ENABLED, and a fresh cell run cold-started for 7+ min. Two root
 * causes, both asserted here without touching Livy/Cosmos (every backend seam
 * is mocked):
 *
 *   1. LAZY group registration — the sweeper only warms groups already in the
 *      registry, but groups were registered lazily on the first run, so warm
 *      never held for the first user. FIX: the DEFAULT group is pre-registered
 *      the moment config is applied (and at module load), so the sweeper has a
 *      target immediately + an immediate refill is kicked (not the next tick).
 *   2. SCALE-TO-ZERO wipes the in-memory pool — a recycled replica boots with an
 *      empty registry, so warm stays 0 even though a prior replica persisted warm
 *      sessions to the shared store. FIX: a fresh replica ADOPTS persisted warm
 *      slots from the store (and registers their group) so refill counts them and
 *      does NOT re-warm — the standing-by session is handed to the next run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Backend seams (no Livy / no Cosmos) ────────────────────────────────────
// Hoisted so the vi.mock factories (also hoisted) can reference them without a TDZ.
const h = vi.hoisted(() => {
  const state = {
    storeMode: 'memory' as 'cosmos' | 'memory',
    allDocs: [] as any[],
    liveSessions: [] as any[],
  };
  return {
    state,
    createLivySessionAsync: vi.fn(async () => ({ id: 42, request: { numExecutors: 2 } })),
    getLivySession: vi.fn(async () => ({ state: 'idle' })),
    synapseConfigGate: vi.fn<() => { missing: string } | undefined>(() => ({ missing: 'LOOM_SYNAPSE_WORKSPACE' })),
    keepaliveLivySession: vi.fn(async () => {}),
    killLivySession: vi.fn(async () => {}),
    listLivySessions: vi.fn(async () => state.liveSessions),
    listAllDocs: vi.fn(async () => state.allDocs),
    publishSlot: vi.fn(async () => {}),
    removeSlot: vi.fn(async () => {}),
    claimSlot: vi.fn(async () => null),
    releaseInStore: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/azure/synapse-dev-client', () => ({
  createLivySessionAsync: h.createLivySessionAsync,
  getLivySession: h.getLivySession,
  synapseConfigGate: h.synapseConfigGate,
}));

vi.mock('@/lib/azure/synapse-livy-client', () => ({
  keepaliveLivySession: h.keepaliveLivySession,
  killLivySession: h.killLivySession,
  listLivySessions: h.listLivySessions,
  defaultSparkPool: () => 'loompool',
}));

vi.mock('@/lib/azure/spark-lease-store', () => ({
  leaseStoreMode: () => h.state.storeMode,
  leaseStoreStatus: () => ({
    mode: h.state.storeMode,
    container: h.state.storeMode === 'cosmos' ? 'spark-warm-leases' : '',
    redisSubstrate: h.state.storeMode === 'cosmos',
    cosmosConfigured: h.state.storeMode === 'cosmos',
    replicaId: 'replicaB',
  }),
  publishSlot: h.publishSlot,
  removeSlot: h.removeSlot,
  claimSlot: h.claimSlot,
  releaseInStore: h.releaseInStore,
  listAllDocs: h.listAllDocs,
  mintLeaseId: () => `lease-${Math.random().toString(36).slice(2, 8)}`,
  replicaId: () => 'replicaB',
}));

const { createLivySessionAsync, getLivySession, synapseConfigGate, killLivySession, listAllDocs, publishSlot } = h;

import {
  setSparkPoolConfig,
  getPoolStatus,
  refillPool,
  adoptFromStore,
  reconcileWarmingSlots,
  reapStaleSessions,
  markSessionInUse,
  defaultSynapseSizing,
} from '../spark-session-pool';

interface TestPoolStore {
  slots: any[];
  groups: Map<string, any>;
  override: Record<string, unknown>;
  sweeper: ReturnType<typeof setInterval> | null;
  warming: number;
  started: boolean;
  adopted: boolean;
  inUse: Map<string, number>;
  firstSeenUntracked: Map<string, number>;
}

/** Direct handle to the globalThis singleton pool (for seeding + assertions). */
function poolStore(): TestPoolStore | undefined {
  return (globalThis as unknown as { __loomSparkPool?: TestPoolStore }).__loomSparkPool;
}

/** Reset the globalThis singleton pool between tests (it survives module reload). */
function resetStore(): void {
  const s = poolStore();
  if (!s) return;
  s.slots.length = 0;
  s.groups.clear();
  s.override = {};
  if (s.sweeper) { clearInterval(s.sweeper); s.sweeper = null; }
  s.warming = 0;
  s.started = false;
  s.adopted = false;
  s.inUse.clear();
  s.firstSeenUntracked.clear();
}

beforeEach(() => {
  resetStore();
  h.state.storeMode = 'memory';
  h.state.allDocs = [];
  h.state.liveSessions = [];
  createLivySessionAsync.mockClear();
  getLivySession.mockClear();
  killLivySession.mockClear();
  listAllDocs.mockClear();
  publishSlot.mockClear();
  synapseConfigGate.mockReturnValue({ missing: 'LOOM_SYNAPSE_WORKSPACE' });
  delete process.env.LOOM_NOTEBOOK_BACKEND;
  delete process.env.LOOM_SPARK_POOL_ENABLED;
  delete process.env.LOOM_SPARK_POOL_REAP;
  delete process.env.LOOM_SPARK_POOL_REAP_GRACE;
  delete process.env.LOOM_SPARK_POOL_IDLE_TTL;
});

describe('R3 #1 — default group is pre-registered on config apply (no lazy-first-run cold start)', () => {
  it('registers the canonical default synapse group the instant config is applied', () => {
    // Before: nothing registered.
    expect(getPoolStatus().groups).toHaveLength(0);
    // Apply config (default-ON) — arms the pool.
    setSparkPoolConfig({ min: 1 });
    const st = getPoolStatus();
    const def = defaultSynapseSizing();
    const grp = st.groups.find((x) => x.poolName === 'loompool' && x.backend === 'synapse');
    expect(grp).toBeTruthy();
    // Keys on the SAME sizing a default cell run computes (#1850 alignment).
    expect(grp!.sizingKey).toBe(def.sizingKey);
    expect(grp!.kind).toBe('pyspark');
  });

  it('does NOT register a default group when the pool is disabled (opt-out)', () => {
    setSparkPoolConfig({ enabled: false });
    expect(getPoolStatus().groups).toHaveLength(0);
  });
});

describe('R3 #1 — an immediate refill is kicked (not deferred to the 30s sweep)', () => {
  it('warms the default group right after config apply when the backend is configured', async () => {
    synapseConfigGate.mockReturnValue(undefined); // Synapse configured → warmable
    setSparkPoolConfig({ min: 1 });
    // The refill is fire-and-forget; wait for the real backend call to land.
    await vi.waitFor(() => expect(createLivySessionAsync).toHaveBeenCalled());
    expect(createLivySessionAsync).toHaveBeenCalledWith('loompool', 'pyspark', expect.any(String), expect.anything());
    await vi.waitFor(() => expect(getPoolStatus().totals.warm).toBe(1));
  });
});

describe('#12 — reconcileWarmingSlots promotes a frozen warming slot (serverless CPU-throttle fix)', () => {
  it('promotes a warming slot whose Livy session is now idle to warm (and publishes)', async () => {
    // Simulate the live bug: a warming slot exists but the background poll never
    // advanced (ACA CPU-throttled between requests), so it is frozen at 'warming'
    // even though its Livy session reached idle. Seed the store directly.
    synapseConfigGate.mockReturnValue(undefined);
    setSparkPoolConfig({ min: 1 });
    const s = poolStore()!;
    s.slots.length = 0;
    s.groups.clear();
    s.slots.push({
      leaseId: 'lease-stuck', backend: 'synapse', poolName: 'loompool', kind: 'pyspark',
      sizingKey: defaultSynapseSizing().sizingKey, sessionId: 4141, state: 'warming',
      createdAt: Date.now(), lastActivityAt: Date.now(), leases: [], groupKey: 'x',
    });
    getLivySession.mockResolvedValueOnce({ state: 'idle' });
    const r = await reconcileWarmingSlots();
    expect(r.promoted).toBe(1);
    expect(s.slots.find((x: any) => x.leaseId === 'lease-stuck').state).toBe('warm');
  });

  it('demotes a warming slot whose session died to dead (does not leak warming)', async () => {
    synapseConfigGate.mockReturnValue(undefined);
    setSparkPoolConfig({ min: 1 });
    const s = poolStore()!;
    s.slots.length = 0;
    s.groups.clear();
    s.slots.push({
      leaseId: 'lease-dead', backend: 'synapse', poolName: 'loompool', kind: 'pyspark',
      sizingKey: defaultSynapseSizing().sizingKey, sessionId: 9999, state: 'warming',
      createdAt: Date.now(), lastActivityAt: Date.now(), leases: [], groupKey: 'x',
    });
    getLivySession.mockResolvedValueOnce({ state: 'error' });
    const r = await reconcileWarmingSlots();
    expect(r.died).toBe(1);
    expect(s.slots.find((x: any) => x.leaseId === 'lease-dead').state).toBe('dead');
  });
});

describe('R3 #2/#3 — a fresh replica adopts persisted warm slots WITHOUT re-warming', () => {
  it('promotes a store-persisted warm session into the local pool and skips re-warm', async () => {
    synapseConfigGate.mockReturnValue(undefined); // configured → refill WOULD warm if under min
    h.state.storeMode = 'cosmos';
    const def = defaultSynapseSizing();
    // A warm session a PRIOR replica (replicaA) left in the shared store.
    h.state.allDocs = [
      {
        id: 'lease-prior',
        groupKey: `synapse|loompool|pyspark|${def.sizingKey}`,
        backend: 'synapse',
        poolName: 'loompool',
        kind: 'pyspark',
        sizingKey: def.sizingKey,
        sessionId: 99,
        state: 'warm',
        leases: [],
        ownerReplica: 'replicaA',
        warmedAt: Date.now() - 5000,
        lastActivityAt: Date.now() - 5000,
      },
    ];

    // Fresh replica boot: adopt from the store, then refill to min.
    await adoptFromStore();
    await refillPool();

    const st = getPoolStatus();
    expect(st.totals.warm).toBe(1);
    const sess = st.groups.flatMap((gp) => gp.sessions).find((x) => x.sessionId === 99);
    expect(sess).toBeTruthy();
    expect(sess!.state).toBe('warm');
    // Claimed from another replica → marked fromStore (never torn down here).
    expect(sess!.fromStore).toBe(true);
    // The adopted warm slot satisfies min → NO cold-start / re-warm.
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('adoption is idempotent — a second boot pass does not duplicate the slot', async () => {
    synapseConfigGate.mockReturnValue(undefined);
    h.state.storeMode = 'cosmos';
    const def = defaultSynapseSizing();
    h.state.allDocs = [
      {
        id: 'lease-prior',
        groupKey: `synapse|loompool|pyspark|${def.sizingKey}`,
        backend: 'synapse',
        poolName: 'loompool',
        kind: 'pyspark',
        sizingKey: def.sizingKey,
        sessionId: 99,
        state: 'warm',
        leases: [],
        ownerReplica: 'replicaA',
        warmedAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    ];
    await adoptFromStore();
    await adoptFromStore();
    expect(getPoolStatus().totals.warm).toBe(1);
  });
});

describe('#1796 — stale-session reaper unjams the pool (kills leaked, spares live)', () => {
  const GRACE_MS = 1_800_000; // default reap grace (30 min)

  function pushWarmSlot(sessionId: number): void {
    const def = defaultSynapseSizing();
    poolStore()!.slots.push({
      leaseId: `slot-${sessionId}`,
      backend: 'synapse',
      poolName: 'loompool',
      kind: 'pyspark',
      sizingKey: def.sizingKey,
      sessionId,
      state: 'warm',
      createdAt: Date.now(),
      warmedAt: Date.now(),
      lastActivityAt: Date.now(),
      leases: [],
      groupKey: `synapse|loompool|pyspark|${def.sizingKey}`,
    });
  }

  it('kills an untracked, idle, old session and spares tracked / busy / heartbeated / young ones', async () => {
    synapseConfigGate.mockReturnValue(undefined); // backend configured → can enumerate
    h.state.liveSessions = [
      { id: 101, state: 'idle' }, // untracked + idle + OLD → REAP
      { id: 102, state: 'idle' }, // untracked + idle but YOUNG (first sight) → spare
      { id: 103, state: 'busy' }, // untracked but BUSY (running a statement) → spare
      { id: 104, state: 'idle' }, // tracked as a warm pool slot → spare
      { id: 105, state: 'idle' }, // heartbeated (live open notebook) → spare
    ];
    pushWarmSlot(104);
    markSessionInUse('loompool', 105);
    // 101 has been observed idle+untracked for longer than the grace window.
    poolStore()!.firstSeenUntracked.set('loompool#101', Date.now() - GRACE_MS - 60_000);

    const killed = await reapStaleSessions('loompool');

    expect(killed).toBe(1);
    expect(killLivySession).toHaveBeenCalledTimes(1);
    expect(killLivySession).toHaveBeenCalledWith('loompool', 101);
    for (const spared of [102, 103, 104, 105]) {
      expect(killLivySession).not.toHaveBeenCalledWith('loompool', spared);
    }
    // A first-sighting of 102 is recorded but not killed (needs a full grace window).
    expect(poolStore()!.firstSeenUntracked.has('loompool#102')).toBe(true);
  });

  it('never kills on first sight — an untracked idle session survives one pass, dies after grace', async () => {
    synapseConfigGate.mockReturnValue(undefined);
    h.state.liveSessions = [{ id: 201, state: 'idle' }];

    // Pass 1: first time seen → record + spare.
    const killed1 = await reapStaleSessions('loompool');
    expect(killed1).toBe(0);
    expect(killLivySession).not.toHaveBeenCalled();
    expect(poolStore()!.firstSeenUntracked.get('loompool#201')).toBeTypeOf('number');

    // Age the first-seen stamp past the grace window, then pass 2 → reap.
    poolStore()!.firstSeenUntracked.set('loompool#201', Date.now() - GRACE_MS - 1);
    const killed2 = await reapStaleSessions('loompool');
    expect(killed2).toBe(1);
    expect(killLivySession).toHaveBeenCalledWith('loompool', 201);
  });

  it('is a no-op when reaping is disabled (LOOM_SPARK_POOL_REAP=0 opt-out)', async () => {
    synapseConfigGate.mockReturnValue(undefined);
    process.env.LOOM_SPARK_POOL_REAP = '0';
    h.state.liveSessions = [{ id: 301, state: 'idle' }];
    // Even a long-untracked idle session is spared when the reaper is disabled.
    poolStore()!.firstSeenUntracked.set('loompool#301', Date.now() - GRACE_MS - 1);
    expect(await reapStaleSessions('loompool')).toBe(0);
    expect(killLivySession).not.toHaveBeenCalled();
  });

  it('protects a session that is leased on ANOTHER replica (cross-replica store id)', async () => {
    synapseConfigGate.mockReturnValue(undefined);
    h.state.liveSessions = [{ id: 401, state: 'idle' }];
    poolStore()!.firstSeenUntracked.set('loompool#401', Date.now() - GRACE_MS - 1);
    // 401 is present in the shared store (leased by replicaA) → protected here.
    const killed = await reapStaleSessions('loompool', new Set([401]));
    expect(killed).toBe(0);
    expect(killLivySession).not.toHaveBeenCalled();
  });
});
