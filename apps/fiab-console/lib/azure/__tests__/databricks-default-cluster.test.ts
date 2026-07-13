/**
 * Unit tests for the shared Databricks cluster resolver
 * (lib/azure/databricks-default-cluster.ts) — the fix that makes notebooks
 * runnable after an app install / on open by auto-provisioning a cluster.
 *
 * Asserts:
 *   (a) a RUNNING all-purpose cluster is reused (no create).
 *   (b) no clusters at all → createCluster is called with a pool-backed spec
 *       (when a loom-pool exists) and the new id is returned as created+starting.
 *   (c) idempotent reuse of an existing (TERMINATED) all-purpose cluster —
 *       started under autoStart, never duplicated.
 *   (d) listClusters failing (no Databricks / RBAC) → honest gate, no create.
 *   (e) no Loom pool → a standalone spec (node_type_id + loom-managed tag).
 *   (f) pickLatestLtsSparkVersion prefers the newest LTS runtime.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────
const listClusters = vi.fn();
const createCluster = vi.fn();
const startCluster = vi.fn();
const listSparkVersions = vi.fn();

vi.mock('@/lib/azure/databricks-client', () => ({
  listClusters: (...a: any[]) => listClusters(...a),
  createCluster: (...a: any[]) => createCluster(...a),
  startCluster: (...a: any[]) => startCluster(...a),
  listSparkVersions: (...a: any[]) => listSparkVersions(...a),
  // Real logic: UI/API-sourced (or unknown) clusters are all-purpose.
  isAllPurposeCluster: (c: any) => !c.cluster_source || c.cluster_source === 'UI' || c.cluster_source === 'API',
}));

const listInstancePools = vi.fn();
vi.mock('@/lib/azure/databricks-scale-client', () => ({
  listInstancePools: (...a: any[]) => listInstancePools(...a),
}));

vi.mock('@/lib/spark/config-presets', () => ({
  databricksClusterLogConf: () => undefined, // log delivery not configured in tests
}));

import {
  ensureRunnableCluster,
  pickLatestLtsSparkVersion,
  DEFAULT_CLUSTER_NAME,
} from '../databricks-default-cluster';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LOOM_DATABRICKS_CLUSTER_ID;
  startCluster.mockResolvedValue(undefined);
  listSparkVersions.mockResolvedValue([
    { key: '15.4.x-scala2.12', name: '15.4 LTS (includes Apache Spark 3.5.0, Scala 2.12)' },
    { key: '14.3.x-scala2.12', name: '14.3 LTS (includes Apache Spark 3.5.0, Scala 2.12)' },
    { key: '16.1.x-scala2.12', name: '16.1 (includes Apache Spark 3.5.2, Scala 2.12)' }, // not LTS
  ]);
  listInstancePools.mockResolvedValue([]);
});

describe('ensureRunnableCluster', () => {
  it('(a) reuses a RUNNING all-purpose cluster without creating one', async () => {
    listClusters.mockResolvedValue([
      { cluster_id: 'run-1', cluster_name: 'user', state: 'RUNNING', cluster_source: 'UI' },
    ]);
    const res = await ensureRunnableCluster();
    expect(res.clusterId).toBe('run-1');
    expect(res.created).toBeFalsy();
    expect(createCluster).not.toHaveBeenCalled();
  });

  it('ignores JOB clusters (not all-purpose) when picking a runnable one', async () => {
    listClusters.mockResolvedValue([
      { cluster_id: 'job-1', cluster_name: 'job', state: 'RUNNING', cluster_source: 'JOB' },
    ]);
    // The only RUNNING cluster is a JOB cluster → not usable → must create default.
    createCluster.mockResolvedValue({ cluster_id: 'new-1' });
    const res = await ensureRunnableCluster();
    expect(res.clusterId).toBe('new-1');
    expect(res.created).toBe(true);
    expect(createCluster).toHaveBeenCalledTimes(1);
  });

  it('(b) auto-creates a POOL-BACKED default cluster when none exist and a loom pool is present', async () => {
    listClusters.mockResolvedValue([]);
    listInstancePools.mockResolvedValue([
      { instance_pool_id: 'pool-s', instance_pool_name: 'loom-pool-s', state: 'ACTIVE' },
    ]);
    createCluster.mockResolvedValue({ cluster_id: 'new-pooled' });

    const res = await ensureRunnableCluster();
    expect(res).toMatchObject({ clusterId: 'new-pooled', created: true, starting: true });
    expect(createCluster).toHaveBeenCalledTimes(1);
    const spec = createCluster.mock.calls[0][0];
    expect(spec.cluster_name).toBe(DEFAULT_CLUSTER_NAME);
    expect(spec.instance_pool_id).toBe('pool-s');
    expect(spec.node_type_id).toBeUndefined(); // pool supplies the node type
    expect(spec.custom_tags).toBeUndefined();  // avoid pool tag collision
    expect(spec.spark_version).toBe('15.4.x-scala2.12'); // latest LTS
    expect(spec.autotermination_minutes).toBe(30);
  });

  it('(e) auto-creates a STANDALONE default cluster when no loom pool exists', async () => {
    listClusters.mockResolvedValue([]);
    listInstancePools.mockResolvedValue([]);
    createCluster.mockResolvedValue({ cluster_id: 'new-standalone' });

    const res = await ensureRunnableCluster();
    expect(res.clusterId).toBe('new-standalone');
    const spec = createCluster.mock.calls[0][0];
    expect(spec.instance_pool_id).toBeUndefined();
    expect(spec.node_type_id).toBe('Standard_DS3_v2');
    expect(spec.custom_tags).toMatchObject({ 'loom-managed': 'true', 'loom-role': 'notebook-default' });
  });

  it('(c) reuses an existing TERMINATED all-purpose cluster and starts it under autoStart — no duplicate create', async () => {
    listClusters.mockResolvedValue([
      { cluster_id: 'def-1', cluster_name: DEFAULT_CLUSTER_NAME, state: 'TERMINATED', cluster_source: 'API' },
    ]);
    const res = await ensureRunnableCluster({ autoStart: true });
    expect(res.clusterId).toBe('def-1');
    expect(res.starting).toBe(true);
    expect(createCluster).not.toHaveBeenCalled();
    expect(startCluster).toHaveBeenCalledWith('def-1');
  });

  it('does NOT start a terminated cluster when autoStart is false (runs/submit handles it)', async () => {
    listClusters.mockResolvedValue([
      { cluster_id: 'def-1', cluster_name: DEFAULT_CLUSTER_NAME, state: 'TERMINATED', cluster_source: 'API' },
    ]);
    const res = await ensureRunnableCluster();
    expect(res.clusterId).toBe('def-1');
    expect(startCluster).not.toHaveBeenCalled();
    expect(createCluster).not.toHaveBeenCalled();
  });

  it('(d) returns an honest gate when clusters cannot be listed (no Databricks / RBAC)', async () => {
    listClusters.mockRejectedValue(new Error('403 Forbidden'));
    const res = await ensureRunnableCluster();
    expect(res.clusterId).toBeUndefined();
    expect(res.gate?.reason).toMatch(/Could not list Databricks clusters/);
    expect(res.gate?.remediation).toMatch(/SCIM|LOOM_DATABRICKS_CLUSTER_ID/);
    expect(createCluster).not.toHaveBeenCalled();
  });

  it('gates (not throws) when auto-create itself fails', async () => {
    listClusters.mockResolvedValue([]);
    createCluster.mockRejectedValue(new Error('quota exceeded'));
    const res = await ensureRunnableCluster();
    expect(res.clusterId).toBeUndefined();
    expect(res.gate?.reason).toMatch(/Could not auto-create/);
  });

  it('honors an explicit LOOM_DATABRICKS_CLUSTER_ID override', async () => {
    process.env.LOOM_DATABRICKS_CLUSTER_ID = 'explicit-1';
    const res = await ensureRunnableCluster();
    expect(res.clusterId).toBe('explicit-1');
    expect(listClusters).not.toHaveBeenCalled();
  });
});

describe('pickLatestLtsSparkVersion', () => {
  it('(f) prefers the newest LTS runtime over a newer non-LTS one', () => {
    const key = pickLatestLtsSparkVersion([
      { key: '14.3.x-scala2.12', name: '14.3 LTS (Apache Spark 3.5.0)' },
      { key: '16.1.x-scala2.12', name: '16.1 (Apache Spark 3.5.2)' }, // newer but not LTS
      { key: '15.4.x-scala2.12', name: '15.4 LTS (Apache Spark 3.5.0)' },
    ]);
    expect(key).toBe('15.4.x-scala2.12');
  });

  it('excludes ML/GPU channels and falls back to non-LTS when no LTS exists', () => {
    const key = pickLatestLtsSparkVersion([
      { key: '15.4.x-gpu-ml-scala2.12', name: '15.4 LTS ML GPU' },
      { key: '16.1.x-scala2.12', name: '16.1 (Apache Spark 3.5.2)' },
    ]);
    expect(key).toBe('16.1.x-scala2.12');
  });
});
