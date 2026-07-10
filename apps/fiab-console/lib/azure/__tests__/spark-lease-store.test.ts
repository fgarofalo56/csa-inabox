/**
 * PSR-3 — cross-replica warm-Spark-session lease-store selection (pure logic).
 *
 * Asserts the honest backend-selection contract per no-vaporware.md /
 * no-fabric-dependency.md: shared (cosmos) mode activates only when a shared
 * substrate is signalled by env AND Cosmos is configured; otherwise it falls
 * back to the per-replica in-memory registry. No Cosmos/network is touched —
 * only env is manipulated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  leaseStoreMode,
  leaseContainerName,
  redisSubstratePresent,
  cosmosConfigured,
  leaseStoreStatus,
} from '../spark-lease-store';

const KEYS = [
  'LOOM_SPARK_POOL_LEASE_CONTAINER',
  'LOOM_SPARK_POOL_REDIS',
  'LOOM_BROKER_REDIS',
  'LOOM_DIRECTLAKE_REDIS',
  'LOOM_COSMOS_ENDPOINT',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('spark-lease-store backend selection', () => {
  it('defaults to per-replica memory mode with no env', () => {
    expect(leaseContainerName()).toBe('');
    expect(redisSubstratePresent()).toBe(false);
    expect(leaseStoreMode()).toBe('memory');
  });

  it('stays memory when a container is named but Cosmos is unconfigured', () => {
    process.env.LOOM_SPARK_POOL_LEASE_CONTAINER = 'spark-warm-leases';
    expect(leaseContainerName()).toBe('spark-warm-leases');
    expect(cosmosConfigured()).toBe(false);
    expect(leaseStoreMode()).toBe('memory');
  });

  it('activates cosmos shared mode with explicit container + Cosmos configured', () => {
    process.env.LOOM_SPARK_POOL_LEASE_CONTAINER = 'my-leases';
    process.env.LOOM_COSMOS_ENDPOINT = 'https://loom.documents.azure.com:443/';
    expect(leaseStoreMode()).toBe('cosmos');
    expect(leaseContainerName()).toBe('my-leases');
  });

  it('the shared-Redis substrate env implies cross-replica intent (default container)', () => {
    process.env.LOOM_SPARK_POOL_REDIS = 'redis-loom-hband.redis.cache.windows.net:6380';
    process.env.LOOM_COSMOS_ENDPOINT = 'https://loom.documents.azure.com:443/';
    expect(redisSubstratePresent()).toBe(true);
    expect(leaseContainerName()).toBe('spark-warm-leases');
    expect(leaseStoreMode()).toBe('cosmos');
  });

  it('also treats the H-band LOOM_BROKER_REDIS as the shared substrate marker', () => {
    process.env.LOOM_BROKER_REDIS = 'redis-loom-hband.redis.cache.windows.net:6380';
    expect(redisSubstratePresent()).toBe(true);
    expect(leaseContainerName()).toBe('spark-warm-leases');
  });

  it('status reports mode + substrate + cosmos honestly with a stable replica id', () => {
    process.env.LOOM_SPARK_POOL_REDIS = 'r:6380';
    process.env.LOOM_COSMOS_ENDPOINT = 'https://loom.documents.azure.com:443/';
    const s = leaseStoreStatus();
    expect(s.mode).toBe('cosmos');
    expect(s.container).toBe('spark-warm-leases');
    expect(s.redisSubstrate).toBe(true);
    expect(s.cosmosConfigured).toBe(true);
    expect(typeof s.replicaId).toBe('string');
    expect(s.replicaId.length).toBeGreaterThan(0);
    // Replica id is stable across calls within a process.
    expect(leaseStoreStatus().replicaId).toBe(s.replicaId);
  });

  it('ignores blank/whitespace env values (no substring host matching)', () => {
    process.env.LOOM_SPARK_POOL_REDIS = '   ';
    expect(redisSubstratePresent()).toBe(false);
    expect(leaseContainerName()).toBe('');
  });
});
