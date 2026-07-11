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
  const state = { storeMode: 'memory' as 'cosmos' | 'memory', allDocs: [] as any[] };
  return {
    state,
    createLivySessionAsync: vi.fn(async () => ({ id: 42, request: { numExecutors: 2 } })),
    getLivySession: vi.fn(async () => ({ state: 'idle' })),
    synapseConfigGate: vi.fn<() => { missing: string } | undefined>(() => ({ missing: 'LOOM_SYNAPSE_WORKSPACE' })),
    keepaliveLivySession: vi.fn(async () => {}),
    killLivySession: vi.fn(async () => {}),
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

const { createLivySessionAsync, getLivySession, synapseConfigGate, listAllDocs, publishSlot } = h;

import {
  setSparkPoolConfig,
  getPoolStatus,
  refillPool,
  adoptFromStore,
  defaultSynapseSizing,
} from '../spark-session-pool';

/** Reset the globalThis singleton pool between tests (it survives module reload). */
function resetStore(): void {
  const g = globalThis as unknown as {
    __loomSparkPool?: {
      slots: unknown[];
      groups: Map<string, unknown>;
      override: Record<string, unknown>;
      sweeper: ReturnType<typeof setInterval> | null;
      warming: number;
      started: boolean;
      adopted: boolean;
    };
  };
  const s = g.__loomSparkPool;
  if (!s) return;
  s.slots.length = 0;
  s.groups.clear();
  s.override = {};
  if (s.sweeper) { clearInterval(s.sweeper); s.sweeper = null; }
  s.warming = 0;
  s.started = false;
  s.adopted = false;
}

beforeEach(() => {
  resetStore();
  h.state.storeMode = 'memory';
  h.state.allDocs = [];
  createLivySessionAsync.mockClear();
  getLivySession.mockClear();
  listAllDocs.mockClear();
  publishSlot.mockClear();
  synapseConfigGate.mockReturnValue({ missing: 'LOOM_SYNAPSE_WORKSPACE' });
  delete process.env.LOOM_NOTEBOOK_BACKEND;
  delete process.env.LOOM_SPARK_POOL_ENABLED;
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
