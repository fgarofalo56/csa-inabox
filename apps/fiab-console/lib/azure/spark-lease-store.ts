/**
 * PSR-3 — cross-replica warm-Spark-session lease store.
 *
 * The warm pool (`spark-session-pool.ts`) keeps N idle Livy/Databricks sessions
 * on standby to kill the 2-4 min Synapse cold start. On a single ACA replica the
 * warm registry lives in-process; but the Console runs at `maxReplicas` and a
 * request routed to replica B cannot see a session replica A warmed — so the
 * console-wide warm ceiling is `replicas × MAX` uncoordinated sessions with no
 * even-hit guarantee (the pool's own "Scope note").
 *
 * This module lifts the warm-session REGISTRY into a shared store so ANY replica
 * can claim a session ANY replica warmed. The Livy session id is global to the
 * Synapse pool (not replica-local), so replica B can drive a session replica A
 * created purely by sharing the id + lease state.
 *
 * ── Backend selection (honest, reported in GET /api/spark/session-pool) ───────
 *   • Shared (cross-replica) mode is a real **Cosmos `spark-warm-leases`
 *     container** (lease doc per warm/leased session, PK /groupKey, per-doc TTL
 *     so a crashed replica's leases self-evict). This is the PRP's prescribed
 *     shared store and is Azure-native + Gov day-one.
 *   • It activates when a shared substrate is signalled by env — either
 *     `LOOM_SPARK_POOL_LEASE_CONTAINER` (explicit container name) OR the presence
 *     of the shared-Redis substrate envs the H-band already sets
 *     (`LOOM_SPARK_POOL_REDIS` / `LOOM_BROKER_REDIS` / `LOOM_DIRECTLAKE_REDIS`,
 *     from compute/hband-shared.bicep) — in which case it uses the default
 *     `spark-warm-leases` container on the existing Loom Cosmos DB. Setting the
 *     shared substrate on the Console therefore turns on cross-replica
 *     coordination with zero extra config.
 *   • When neither is set (or Cosmos is unconfigured) it falls back HONESTLY to
 *     the in-process per-replica registry — status reports `mode:'memory'` so the
 *     operator sees the pool is per-replica.
 *
 * Note on Redis: the shared Azure Cache for Redis Premium (hband-shared.bicep)
 * is consumed as raw RESP by the sibling H-band Go services (Capacity Broker /
 * Direct Lake) and the future Warm-Pool Keepalive service (HYP-14). The Next.js
 * Console has no in-process Redis client, so the console-side coordinator uses
 * the always-present Loom Cosmos DB for the lease registry — the `LOOM_..._REDIS`
 * env simply signals "a shared H-band substrate exists, coordinate cross-replica"
 * and is surfaced honestly (`redisSubstrate:true`) in the status.
 *
 * Every Cosmos call here is best-effort + guarded: a store failure never breaks
 * the pool — the caller degrades to the local registry / a cold start (the pool
 * is a pure accelerator, never a hard dependency; no-vaporware.md).
 */

import type { LivyKind } from '@/lib/azure/synapse-livy-client';

export type LeaseStoreMode = 'cosmos' | 'memory';
export type SlotBackend = 'synapse' | 'databricks';
export type DocState = 'warm' | 'leased' | 'shared';

/** A single sub-lease held against a warm session (1 for exclusive, N for shared read-only). */
export interface LeaseRec {
  id: string;
  oid?: string;
  readOnly: boolean;
  at: number;
}

/** The shared lease doc — the cross-replica projection of one pooled slot. */
export interface WarmLeaseDoc {
  id: string; // slot lease id (Cosmos point id)
  groupKey: string; // partition key
  backend: SlotBackend;
  poolName: string;
  kind: LivyKind;
  sizingKey: string;
  sessionId?: number;
  state: DocState;
  leases: LeaseRec[];
  ownerReplica: string;
  warmedAt: number;
  lastActivityAt: number;
  /** Livy session-create body — carried so a cross-replica claim can build the run receipt. */
  request?: Record<string, unknown>;
  ttl: number; // seconds (Cosmos self-evict)
  _etag?: string;
}

export interface LeaseStoreStatus {
  /** 'cosmos' = cross-replica shared registry active; 'memory' = per-replica. */
  mode: LeaseStoreMode;
  /** Cosmos container backing the shared registry (when mode='cosmos'). */
  container: string;
  /** True when a shared H-band Redis substrate env is present (signals shared infra). */
  redisSubstrate: boolean;
  /** True when the Loom Cosmos DB is configured (LOOM_COSMOS_ENDPOINT set). */
  cosmosConfigured: boolean;
  /** This process's stable replica id — surfaced so cross-replica hand-off is visible. */
  replicaId: string;
}

const DEFAULT_LEASE_CONTAINER = 'spark-warm-leases';
/** How long a published warm/leased doc lives before Cosmos self-evicts it. */
const LEASE_TTL_SECS = 20 * 60; // 20 min — well beyond the 30s sweeper cadence

// ── Env helpers (no substring host matching — exact env presence only) ──

function envSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

/** True when a shared H-band substrate is signalled by env (Redis-style marker). */
export function redisSubstratePresent(): boolean {
  return envSet('LOOM_SPARK_POOL_REDIS') || envSet('LOOM_BROKER_REDIS') || envSet('LOOM_DIRECTLAKE_REDIS');
}

export function cosmosConfigured(): boolean {
  return envSet('LOOM_COSMOS_ENDPOINT');
}

/** The Cosmos container name backing the shared registry (empty ⇒ shared mode off). */
export function leaseContainerName(): string {
  const explicit = process.env.LOOM_SPARK_POOL_LEASE_CONTAINER;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  // The shared-Redis substrate env implies cross-replica intent → default container.
  if (redisSubstratePresent()) return DEFAULT_LEASE_CONTAINER;
  return '';
}

/** Effective store mode: cosmos when a shared container is named AND Cosmos is configured. */
export function leaseStoreMode(): LeaseStoreMode {
  return leaseContainerName() && cosmosConfigured() ? 'cosmos' : 'memory';
}

// Stable per-process replica id (memoized on globalThis so hot-reload keeps one).
const gr = globalThis as unknown as { __loomSparkReplicaId?: string };
export function replicaId(): string {
  if (gr.__loomSparkReplicaId) return gr.__loomSparkReplicaId;
  const host =
    process.env.CONTAINER_APP_REPLICA_NAME ||
    process.env.HOSTNAME ||
    'local';
  gr.__loomSparkReplicaId = `${host}-${Math.random().toString(36).slice(2, 8)}`;
  return gr.__loomSparkReplicaId;
}

export function leaseStoreStatus(): LeaseStoreStatus {
  const container = leaseContainerName();
  const cfg = cosmosConfigured();
  return {
    mode: container && cfg ? 'cosmos' : 'memory',
    container: container && cfg ? container : '',
    redisSubstrate: redisSubstratePresent(),
    cosmosConfigured: cfg,
    replicaId: replicaId(),
  };
}

// ============================================================
// Cosmos I/O (best-effort — every call guarded; never throws to the pool)
// ============================================================

async function container() {
  const { sparkWarmLeasesContainer } = await import('@/lib/azure/cosmos-client');
  return sparkWarmLeasesContainer();
}

/**
 * Publish/refresh a warm slot into the shared registry. NO-DOWNGRADE: if a doc
 * for this session already exists and has been CLAIMED by another replica
 * (state leased/shared), we only refresh its TTL + keepalive timestamp and
 * preserve the claim — the owning replica's keepalive must never resurrect a
 * doc another replica is actively leasing (that would double-lease one session).
 */
export async function publishSlot(doc: Omit<WarmLeaseDoc, 'ttl' | '_etag'>): Promise<void> {
  if (leaseStoreMode() !== 'cosmos') return;
  try {
    const c = await container();
    let existing: WarmLeaseDoc | undefined;
    try {
      const { resource } = await c.item(doc.id, doc.groupKey).read<WarmLeaseDoc>();
      existing = resource || undefined;
    } catch {
      existing = undefined;
    }
    if (existing && existing.state !== 'warm' && existing.leases.length > 0) {
      // Claimed elsewhere — refresh TTL/keepalive only, preserve the claim.
      const refreshed: WarmLeaseDoc = {
        ...existing,
        lastActivityAt: Math.max(existing.lastActivityAt, doc.lastActivityAt),
        ttl: LEASE_TTL_SECS,
      };
      try {
        await c.item(doc.id, doc.groupKey).replace(refreshed, {
          accessCondition: { type: 'IfMatch', condition: existing._etag as string },
        });
      } catch {
        /* raced with a claim/release — leave it, next sweep refreshes */
      }
      return;
    }
    const body: WarmLeaseDoc = { ...doc, ttl: LEASE_TTL_SECS };
    await c.items.upsert(body);
  } catch {
    /* best-effort — local registry still authoritative on this replica */
  }
}

/** Remove a slot's lease doc (on eviction / death). */
export async function removeSlot(id: string, groupKey: string): Promise<void> {
  if (leaseStoreMode() !== 'cosmos') return;
  try {
    const c = await container();
    await c.item(id, groupKey).delete();
  } catch {
    /* already gone / TTL-evicted — fine */
  }
}

export interface ClaimRequest {
  groupKey: string;
  /** When true the run is read-only and may share an already-leased warm session. */
  shared: boolean;
  maxLeasesPerSession: number;
  oid?: string;
}

export interface ClaimResult {
  doc: WarmLeaseDoc;
  /** The sub-lease id minted for this claim (returned to the caller as its lease handle). */
  leaseId: string;
}

/**
 * Atomically claim a warm session another replica may have warmed. Queries the
 * group's docs (single-partition on /groupKey) and, using Cosmos ETag optimistic
 * concurrency, either:
 *   • flips an exclusively-`warm` doc to `leased` (adds the first sub-lease), or
 *   • when `shared` and concurrency is on, adds a read-only sub-lease to an
 *     existing `shared` (or `warm`) doc under the per-session cap.
 * Returns null on a miss (no claimable doc) — the caller then cold-starts.
 */
export async function claimSlot(req: ClaimRequest): Promise<ClaimResult | null> {
  if (leaseStoreMode() !== 'cosmos') return null;
  let c;
  try {
    c = await container();
  } catch {
    return null;
  }
  let docs: WarmLeaseDoc[] = [];
  try {
    const { resources } = await c.items
      .query<WarmLeaseDoc>({
        query:
          'SELECT * FROM c WHERE c.groupKey = @g AND (c.state = "warm" OR c.state = "shared") ORDER BY c.lastActivityAt ASC',
        parameters: [{ name: '@g', value: req.groupKey }],
      })
      .fetchAll();
    docs = resources || [];
  } catch {
    return null;
  }

  const now = Date.now();
  // Prefer sharing an existing shared session (read-only runs), then a warm one.
  const ordered = req.shared
    ? [...docs].sort((a, b) => (a.state === 'shared' ? -1 : 1) - (b.state === 'shared' ? -1 : 1))
    : docs.filter((d) => d.state === 'warm');

  for (const doc of ordered) {
    // Exclusive claim of a warm doc, or shared sub-lease under the cap.
    const canShare = req.shared && (doc.state === 'shared' || doc.state === 'warm');
    if (!canShare && doc.state !== 'warm') continue;
    if (doc.state === 'shared' && !req.shared) continue;
    if (req.shared && doc.leases.length >= req.maxLeasesPerSession) continue;

    const leaseId = mintLeaseId();
    const next: WarmLeaseDoc = {
      ...doc,
      state: req.shared ? 'shared' : 'leased',
      leases: [...(doc.leases || []), { id: leaseId, oid: req.oid, readOnly: req.shared, at: now }],
      lastActivityAt: now,
      ownerReplica: doc.ownerReplica, // warming replica stays the owner of the session lifecycle
      ttl: LEASE_TTL_SECS,
    };
    try {
      await c.item(doc.id, doc.groupKey).replace(next, {
        accessCondition: { type: 'IfMatch', condition: doc._etag as string },
      });
      return { doc: next, leaseId };
    } catch {
      // ETag conflict (another replica claimed it first) → try the next candidate.
      continue;
    }
  }
  return null;
}

/**
 * Release a sub-lease from a shared doc: read-modify-write with a small retry on
 * ETag conflict. When the last sub-lease drops, the doc returns to `warm`.
 * `dead:true` removes the doc entirely (session died / recreated).
 */
export async function releaseInStore(
  id: string,
  groupKey: string,
  leaseId: string,
  opts?: { dead?: boolean },
): Promise<void> {
  if (leaseStoreMode() !== 'cosmos') return;
  if (opts?.dead) {
    await removeSlot(id, groupKey);
    return;
  }
  let c;
  try {
    c = await container();
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let doc: WarmLeaseDoc;
    try {
      const { resource } = await c.item(id, groupKey).read<WarmLeaseDoc>();
      if (!resource) return;
      doc = resource;
    } catch {
      return;
    }
    const leases = (doc.leases || []).filter((l) => l.id !== leaseId);
    const next: WarmLeaseDoc = {
      ...doc,
      leases,
      state: leases.length === 0 ? 'warm' : leases.every((l) => l.readOnly) ? 'shared' : 'leased',
      lastActivityAt: Date.now(),
      ttl: LEASE_TTL_SECS,
    };
    try {
      await c.item(id, groupKey).replace(next, {
        accessCondition: { type: 'IfMatch', condition: doc._etag as string },
      });
      return;
    } catch {
      /* conflict — re-read and retry */
    }
  }
}

/** Snapshot the shared registry for the status endpoint (cross-partition admin read). */
export async function listAllDocs(): Promise<WarmLeaseDoc[]> {
  if (leaseStoreMode() !== 'cosmos') return [];
  try {
    const c = await container();
    const { resources } = await c.items
      .query<WarmLeaseDoc>('SELECT * FROM c')
      .fetchAll();
    return resources || [];
  } catch {
    return [];
  }
}

// ============================================================
// Shared pool-config doc — cross-replica admin override propagation
// ============================================================
//
// setSparkPoolConfig() used to be per-replica in-memory only: the admin kill
// switch (enabled:false) applied on whichever replica served the POST while
// every other replica kept warming (observed live 2026-07-14 during the
// loompool queue-jam incident). The override now also persists here as a
// single well-known doc; every replica's sweep() merges it in each tick, so a
// config change propagates console-wide within one sweep interval (~30s).

const CONFIG_DOC_ID = 'pool-config';
const CONFIG_GROUP_KEY = '#config';

export interface PoolConfigDoc {
  id: string;
  groupKey: string;
  /** Partial<PoolConfig> from spark-session-pool (kept as unknown here to avoid a cycle). */
  override: Record<string, unknown>;
  updatedAt: number;
  updatedBy: string;
}

/** Persist the admin runtime override (best-effort; no TTL — config is durable). */
export async function writePoolConfigDoc(override: Record<string, unknown>): Promise<void> {
  if (leaseStoreMode() !== 'cosmos') return;
  try {
    const c = await container();
    const body: PoolConfigDoc = {
      id: CONFIG_DOC_ID,
      groupKey: CONFIG_GROUP_KEY,
      override,
      updatedAt: Date.now(),
      updatedBy: replicaId(),
    };
    await c.items.upsert(body);
  } catch {
    /* best-effort — this replica still applies the override locally */
  }
}

/** Read the shared admin override (null when absent / store unavailable). */
export async function readPoolConfigDoc(): Promise<PoolConfigDoc | null> {
  if (leaseStoreMode() !== 'cosmos') return null;
  try {
    const c = await container();
    const { resource } = await c.item(CONFIG_DOC_ID, CONFIG_GROUP_KEY).read<PoolConfigDoc>();
    return resource || null;
  } catch {
    return null;
  }
}

let _leaseSeq = 0;
export function mintLeaseId(): string {
  _leaseSeq = (_leaseSeq + 1) % 1_000_000;
  return `lease-${Date.now().toString(36)}-${_leaseSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
