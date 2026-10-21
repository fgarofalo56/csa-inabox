/**
 * read-warmer-lease — only one replica warms; unreadable lease = do not run.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  tryAcquireWarmerLease,
  warmerLeaseTtlMs,
  WARMER_LEASE_ID,
  WARMER_LEASE_PARTITION,
  type WarmerLeaseDoc,
  type WarmerLeaseStore,
} from '../read-warmer-lease';
import { createReadWarmer, type WarmTarget } from '../read-warmer';

const NOW = 1_800_000_000_000;

function memStore(initial: WarmerLeaseDoc | null, etag = 'e1'): WarmerLeaseStore & { doc: WarmerLeaseDoc | null; writes: number } {
  const s = {
    doc: initial,
    writes: 0,
    read: async () => ({ doc: s.doc, etag }),
    create: async (d: WarmerLeaseDoc) => { if (s.doc) return false; s.doc = d; s.writes++; return true; },
    replace: async (d: WarmerLeaseDoc, tag: string | undefined) => { if (tag !== etag) return false; s.doc = d; s.writes++; return true; },
  };
  return s;
}
const held = (owner: string, expiresAt: number): WarmerLeaseDoc => ({
  id: WARMER_LEASE_ID, tenantId: WARMER_LEASE_PARTITION, docType: 'read-warmer-lease',
  owner, acquiredAt: NOW - 1000, renewedAt: NOW - 1000, expiresAt,
});

describe('tryAcquireWarmerLease', () => {
  it('first replica acquires when no lease exists', async () => {
    const store = memStore(null);
    const r = await tryAcquireWarmerLease({ store, owner: 'A', ttlMs: 900_000, now: () => NOW });
    expect(r.held).toBe(true);
    expect(store.doc?.owner).toBe('A');
    expect(store.doc?.expiresAt).toBe(NOW + 900_000);
  });

  it('a second replica does NOT run while another holds an unexpired lease (and writes nothing)', async () => {
    const store = memStore(held('A', NOW + 60_000));
    const r = await tryAcquireWarmerLease({ store, owner: 'B', ttlMs: 900_000, now: () => NOW });
    // Breaks if the owner/expiry check is dropped: B would take over.
    expect(r.held).toBe(false);
    expect(r.reason).toContain('A');
    expect(store.doc?.owner).toBe('A');
    expect(store.writes).toBe(0);
  });

  it('does NOT run when the lease cannot be read (fail closed)', async () => {
    const store: WarmerLeaseStore = {
      read: async () => { throw new Error('cosmos 503'); },
      create: vi.fn(async () => true),
      replace: vi.fn(async () => true),
    };
    const r = await tryAcquireWarmerLease({ store, owner: 'B', ttlMs: 900_000, now: () => NOW });
    // Breaks if a read error is treated as "no lease": held would be true and create called.
    expect(r.held).toBe(false);
    expect(r.reason).toContain('could not be read');
    expect(store.create).not.toHaveBeenCalled();
    expect(store.replace).not.toHaveBeenCalled();
  });

  it('does NOT run when the write fails (fail closed)', async () => {
    const store: WarmerLeaseStore = {
      read: async () => ({ doc: null }),
      create: async () => { throw new Error('cosmos 429'); },
      replace: async () => true,
    };
    const r = await tryAcquireWarmerLease({ store, owner: 'B', ttlMs: 900_000, now: () => NOW });
    expect(r.held).toBe(false);
  });

  it('the holder renews; an expired lease is taken over; a lost race (412) does not run', async () => {
    const mine = memStore(held('A', NOW + 1_000));
    expect((await tryAcquireWarmerLease({ store: mine, owner: 'A', ttlMs: 900_000, now: () => NOW })).held).toBe(true);
    expect(mine.doc?.expiresAt).toBe(NOW + 900_000);

    const expired = memStore(held('A', NOW - 1));
    const took = await tryAcquireWarmerLease({ store: expired, owner: 'B', ttlMs: 900_000, now: () => NOW });
    expect(took.held).toBe(true);
    expect(expired.doc?.owner).toBe('B');

    const raced = memStore(held('A', NOW - 1));
    raced.replace = async () => false; // someone else replaced first -> etag mismatch
    expect((await tryAcquireWarmerLease({ store: raced, owner: 'B', ttlMs: 900_000, now: () => NOW })).held).toBe(false);
  });

  it('lease ttl outlives one warm interval so a live holder never lapses', () => {
    expect(warmerLeaseTtlMs(600_000)).toBeGreaterThan(600_000);
  });
});

describe('warmer cycle honours the lease', () => {
  const target: WarmTarget = { label: 'monitor/alerts metric', key: 'k', modelId: 'm', ttlMs: 1, produce: async () => [] };
  const mk = (acquireLease: () => Promise<{ held: boolean; reason: string }>) => {
    const runTarget = vi.fn(async () => ({ ok: true }));
    const warmer = createReadWarmer({
      loadTargets: async () => [target], runTarget, acquireLease, sleep: async () => {}, warn: () => {},
      budget: { windowMs: 600_000, maxReadsPerWindow: 16, paceMs: 0, minCooldownMs: 1000, maxCooldownMs: 2000 },
    });
    return { warmer, runTarget };
  };

  it('holder runs its targets', async () => {
    const { warmer, runTarget } = mk(async () => ({ held: true, reason: 'ok' }));
    const r = await warmer.runCycle();
    expect(runTarget).toHaveBeenCalledTimes(1);
    expect(r.succeeded).toBe(1);
  });

  it('a replica that is not the holder runs NO target and says why', async () => {
    const { warmer, runTarget } = mk(async () => ({ held: false, reason: 'another replica (A) holds it' }));
    const r = await warmer.runCycle();
    expect(runTarget).not.toHaveBeenCalled(); // breaks if the lease result is ignored
    expect(r.attempted).toBe(0);
    expect(r.skipped[0]!.reason).toContain('another replica (A)');
  });

  it('an unreadable lease (acquirer throws) runs NO target', async () => {
    const { warmer, runTarget } = mk(async () => { throw new Error('boom'); });
    const r = await warmer.runCycle();
    expect(runTarget).not.toHaveBeenCalled();
    expect(r.skipped[0]!.reason).toContain('not running');
  });
});
