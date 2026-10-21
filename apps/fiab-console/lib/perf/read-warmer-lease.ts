/**
 * read-warmer-lease — only ONE Console replica runs warm cycles.
 *
 * WHY (measured 2026-10-20/21): the Console runs 2 live replicas and each ran
 * its own in-process warmer, so every sweep was issued twice against the one
 * per-principal ARM read bucket (budget, cooldown and cache are per process).
 *
 * MECHANISM: a single lease document in the existing `maintenance-jobs` Cosmos
 * container (the repo has no generic leader-election primitive; `spark-lease-store`
 * is a warm-session registry, not a leader lease). The holder renews it on every
 * cycle; a crashed holder's lease simply expires after `ttlMs`. Acquire/renew is
 * optimistic-concurrency (create -> 409, replace with If-Match -> 412), so two
 * replicas racing cannot both win.
 *
 * FAIL CLOSED (deploy-integrity R6): if the lease cannot be READ, or cannot be
 * written, the replica does NOT run. A warmer that cannot prove it is the only
 * one is exactly the defect this file removes.
 *
 * The one deliberate exception is "Cosmos is not configured at all"
 * (`LOOM_COSMOS_ENDPOINT` unset): there is no shared store to coordinate through,
 * so this is a single-process / dev deployment and the warmer runs, with the
 * reason reported rather than hidden.
 */

export interface WarmerLeaseDoc {
  id: string;
  tenantId: string;
  docType: 'read-warmer-lease';
  owner: string;
  /** epoch ms */
  expiresAt: number;
  acquiredAt: number;
  renewedAt: number;
}

export interface WarmerLeaseStore {
  read: () => Promise<{ doc: WarmerLeaseDoc | null; etag?: string }>;
  /** Resolves false when the doc already exists (409). */
  create: (doc: WarmerLeaseDoc) => Promise<boolean>;
  /** Resolves false on an etag mismatch (412). */
  replace: (doc: WarmerLeaseDoc, etag: string | undefined) => Promise<boolean>;
}

export interface WarmerLeaseResult {
  /** May this replica run a warm cycle now? */
  held: boolean;
  /** Why — only what was established (R7). */
  reason: string;
}

export const WARMER_LEASE_ID = 'read-warmer-lease';
/** Partition key value; a synthetic tenant so no real tenant query returns it. */
export const WARMER_LEASE_PARTITION = 'system:read-warmer-lease';

export async function tryAcquireWarmerLease(opts: {
  store: WarmerLeaseStore;
  owner: string;
  ttlMs: number;
  now?: () => number;
}): Promise<WarmerLeaseResult> {
  const now = opts.now ?? (() => Date.now());
  let existing: { doc: WarmerLeaseDoc | null; etag?: string };
  try {
    existing = await opts.store.read();
  } catch (e) {
    return { held: false, reason: `warmer lease could not be read (${(e as Error)?.message ?? 'unknown error'}); not running without proof this is the only warmer` };
  }

  const t = now();
  const fresh = (acquiredAt: number): WarmerLeaseDoc => ({
    id: WARMER_LEASE_ID,
    tenantId: WARMER_LEASE_PARTITION,
    docType: 'read-warmer-lease',
    owner: opts.owner,
    acquiredAt,
    renewedAt: t,
    expiresAt: t + opts.ttlMs,
  });

  try {
    const cur = existing.doc;
    if (!cur) {
      const won = await opts.store.create(fresh(t));
      return won
        ? { held: true, reason: 'acquired the warmer lease (none existed)' }
        : { held: false, reason: 'another replica created the warmer lease first' };
    }
    if (cur.owner === opts.owner) {
      const ok = await opts.store.replace(fresh(cur.acquiredAt), existing.etag);
      return ok
        ? { held: true, reason: 'renewed the warmer lease' }
        : { held: false, reason: 'the warmer lease changed under this replica while renewing' };
    }
    if (cur.expiresAt > t) {
      return {
        held: false,
        reason: `another replica (${cur.owner}) holds the warmer lease until ${new Date(cur.expiresAt).toISOString()}`,
      };
    }
    const ok = await opts.store.replace(fresh(t), existing.etag);
    return ok
      ? { held: true, reason: `took over an expired warmer lease from ${cur.owner}` }
      : { held: false, reason: 'another replica took over the expired warmer lease first' };
  } catch (e) {
    return { held: false, reason: `warmer lease could not be written (${(e as Error)?.message ?? 'unknown error'}); not running` };
  }
}

/** Lease lifetime: 1.5 warm intervals, so a live holder (renewing each cycle) never lapses. */
export function warmerLeaseTtlMs(intervalMs: number): number {
  return Math.round(intervalMs * 1.5);
}

function statusOf(e: unknown): number | undefined {
  const o = e as { code?: unknown; statusCode?: unknown } | null;
  const c = o?.code ?? o?.statusCode;
  return typeof c === 'number' ? c : undefined;
}

/** The real store, over the `maintenance-jobs` Cosmos container. */
export function cosmosWarmerLeaseStore(): WarmerLeaseStore {
  const container = async () => {
    const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
    return maintenanceJobsContainer();
  };
  return {
    async read() {
      const c = await container();
      const r = await c.item(WARMER_LEASE_ID, WARMER_LEASE_PARTITION).read<WarmerLeaseDoc>();
      // A missing doc is a normal answer (404 -> resource undefined), not a failure.
      return { doc: r.resource ?? null, etag: (r.resource as { _etag?: string } | undefined)?._etag };
    },
    async create(doc) {
      const c = await container();
      try {
        await c.items.create(doc);
        return true;
      } catch (e) {
        if (statusOf(e) === 409) return false;
        throw e;
      }
    },
    async replace(doc, etag) {
      const c = await container();
      try {
        await c.item(WARMER_LEASE_ID, WARMER_LEASE_PARTITION).replace(
          doc,
          etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : undefined,
        );
        return true;
      } catch (e) {
        if (statusOf(e) === 412 || statusOf(e) === 404) return false;
        throw e;
      }
    },
  };
}

/**
 * The default acquire used by the warmer. Distinguishes "no Cosmos configured"
 * (run, single-process deployment) from "Cosmos configured but unreadable"
 * (fail closed).
 */
export function createDefaultLeaseAcquirer(intervalMs: number, owner: string): () => Promise<WarmerLeaseResult> {
  const store = cosmosWarmerLeaseStore();
  return async () => {
    const ep = process.env.LOOM_COSMOS_ENDPOINT;
    if (!ep || ep.trim() === '') {
      return { held: true, reason: 'no Cosmos configured (LOOM_COSMOS_ENDPOINT unset): single-process deployment, no lease to coordinate through' };
    }
    return tryAcquireWarmerLease({ store, owner, ttlMs: warmerLeaseTtlMs(intervalMs) });
  };
}
