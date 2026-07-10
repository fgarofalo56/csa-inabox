/**
 * cluster-presets — pure catalog + hygiene logic tests (node env, no mocks).
 * Per no-vaporware: proves the tier catalog produces valid clusters/create
 * specs (autotermination always set, loom tags always present, single-node
 * recipe correct) and that the stale-classification logic matches the
 * documented rules.
 */
import { describe, it, expect } from 'vitest';
import type { Cluster } from '@/lib/azure/databricks-client';
import {
  CLUSTER_TIERS,
  DEFAULT_TIER_ID,
  findTier,
  clusterSpecFromTier,
  idleDays,
  isStale,
  toHygieneRow,
  isLoomManaged,
  loomPresetOf,
  clusterSourceLabel,
  STALE_TERMINATED_DAYS,
  STALE_RUNNING_IDLE_DAYS,
} from '../cluster-presets';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 10); // fixed reference for deterministic idle math

describe('CLUSTER_TIERS catalog shape', () => {
  it('has the canonical operator tier ids, ordered small → large', () => {
    expect(CLUSTER_TIERS.map((t) => t.id)).toEqual([
      'std-xs-single-node', 'std-s', 'std-m-photon', 'std-l-photon', 'std-xl-photon',
    ]);
  });

  it('every tier ALWAYS sets a non-zero autotermination (no immortal clusters)', () => {
    for (const t of CLUSTER_TIERS) {
      expect(t.autoterminationMinutes).toBeGreaterThan(0);
    }
  });

  it('every tier carries AQE-on best-practice spark conf', () => {
    for (const t of CLUSTER_TIERS) {
      expect(t.sparkConf['spark.sql.adaptive.enabled']).toBe('true');
      expect(t.sparkConf['spark.sql.adaptive.skewJoin.enabled']).toBe('true');
    }
  });

  it('Photon tiers add Delta write optimizations; non-Photon tiers do not', () => {
    for (const t of CLUSTER_TIERS) {
      const hasDelta = 'spark.databricks.delta.optimizeWrite.enabled' in t.sparkConf;
      expect(hasDelta).toBe(t.photon);
    }
  });

  it('only the XS tier is single-node; the rest autoscale with min ≥ 2', () => {
    for (const t of CLUSTER_TIERS) {
      if (t.id === 'std-xs-single-node') {
        expect(t.singleNode).toBe(true);
      } else {
        expect(t.singleNode).toBe(false);
        expect(t.minWorkers).toBeGreaterThanOrEqual(2);
        expect(t.maxWorkers).toBeGreaterThan(t.minWorkers);
      }
    }
  });

  it('DEFAULT_TIER_ID resolves to a real tier', () => {
    expect(findTier(DEFAULT_TIER_ID)).toBeDefined();
    expect(findTier('nope')).toBeUndefined();
  });
});

describe('clusterSpecFromTier — clusters/create payload', () => {
  it('single-node XS uses num_workers 0 + singleNode profile + ResourceClass tag', () => {
    const spec = clusterSpecFromTier(findTier('std-xs-single-node')!, { sparkVersion: '14.3.x-scala2.12' });
    expect(spec.num_workers).toBe(0);
    expect(spec.autoscale).toBeUndefined();
    expect(spec.spark_conf?.['spark.databricks.cluster.profile']).toBe('singleNode');
    expect(spec.spark_conf?.['spark.master']).toBe('local[*]');
    expect(spec.custom_tags?.ResourceClass).toBe('SingleNode');
    expect(spec.custom_tags?.['loom-managed']).toBe('true');
    expect(spec.custom_tags?.['loom-preset']).toBe('std-xs-single-node');
    expect(spec.autotermination_minutes).toBeGreaterThan(0);
  });

  it('M-Photon autoscales, enables Photon, and tags the preset', () => {
    const spec = clusterSpecFromTier(findTier('std-m-photon')!, { sparkVersion: 'v', clusterName: 'my-etl' });
    expect(spec.cluster_name).toBe('my-etl');
    expect(spec.autoscale).toEqual({ min_workers: 4, max_workers: 8 });
    expect(spec.num_workers).toBeUndefined();
    expect(spec.runtime_engine).toBe('PHOTON');
    expect(spec.node_type_id).toBe('Standard_E8ds_v4');
    expect(spec.custom_tags?.['loom-preset']).toBe('std-m-photon');
    expect(spec.spark_conf?.['spark.databricks.delta.optimizeWrite.enabled']).toBe('true');
  });

  it('jobs flavor tightens autoterminate + adds Spot + workload tag', () => {
    const spec = clusterSpecFromTier(findTier('std-l-photon')!, { sparkVersion: 'v', flavor: 'jobs' });
    expect(spec.autotermination_minutes).toBeLessThanOrEqual(20);
    expect(spec.azure_attributes?.availability).toBe('SPOT_WITH_FALLBACK_AZURE');
    expect(spec.custom_tags?.['loom-workload']).toBe('jobs');
  });

  it('interactive flavor keeps the tier window and stays on-demand', () => {
    const spec = clusterSpecFromTier(findTier('std-l-photon')!, { sparkVersion: 'v' });
    expect(spec.autotermination_minutes).toBe(60);
    expect(spec.azure_attributes).toBeUndefined();
    expect(spec.custom_tags?.['loom-workload']).toBe('interactive');
  });

  it('generates a canonical name when none is supplied', () => {
    const spec = clusterSpecFromTier(findTier('std-s')!, { sparkVersion: 'v' });
    expect(spec.cluster_name).toBe('std-s-interactive');
  });

  it('builder overrides merge over the tier confs + tags', () => {
    const spec = clusterSpecFromTier(findTier('std-s')!, {
      sparkVersion: 'v',
      extraSparkConf: { 'spark.sql.shuffle.partitions': '400' },
      extraTags: { 'cost-center': 'data-eng' },
    });
    expect(spec.spark_conf?.['spark.sql.shuffle.partitions']).toBe('400');
    expect(spec.spark_conf?.['spark.sql.adaptive.enabled']).toBe('true'); // tier base still there
    expect(spec.custom_tags?.['cost-center']).toBe('data-eng');
  });
});

describe('hygiene — idleDays + isStale classification', () => {
  const runningIdle = (days: number): Cluster => ({
    cluster_id: 'c-run', state: 'RUNNING', cluster_source: 'UI',
    last_activity_time: NOW - days * DAY,
  });
  const terminatedAgo = (days: number): Cluster => ({
    cluster_id: 'c-term', state: 'TERMINATED', cluster_source: 'UI',
    terminated_time: NOW - days * DAY,
  });

  it('idleDays floors whole days from the relevant timestamp', () => {
    expect(idleDays(runningIdle(3), NOW)).toBe(3);
    expect(idleDays(terminatedAgo(10), NOW)).toBe(10);
    expect(idleDays({ cluster_id: 'x', state: 'RUNNING' }, NOW)).toBe(0); // no timestamp
  });

  it('flags a RUNNING cluster idle beyond the running threshold', () => {
    expect(isStale(runningIdle(STALE_RUNNING_IDLE_DAYS + 1), NOW)).toBe(true);
    expect(isStale(runningIdle(STALE_RUNNING_IDLE_DAYS - 1), NOW)).toBe(false);
  });

  it('flags a TERMINATED cluster older than the terminated threshold', () => {
    expect(isStale(terminatedAgo(STALE_TERMINATED_DAYS + 1), NOW)).toBe(true);
    expect(isStale(terminatedAgo(STALE_TERMINATED_DAYS - 1), NOW)).toBe(false);
  });

  it('never flags ephemeral JOB/PIPELINE clusters as stale', () => {
    const jobCluster: Cluster = {
      cluster_id: 'c-job', state: 'TERMINATED', cluster_source: 'JOB',
      terminated_time: NOW - 90 * DAY,
    };
    expect(isStale(jobCluster, NOW)).toBe(false);
  });
});

describe('hygiene — enrichment badges', () => {
  it('reads loom-managed + preset from custom tags', () => {
    const c: Cluster = {
      cluster_id: 'c1', state: 'RUNNING', cluster_source: 'API',
      custom_tags: { 'loom-managed': 'true', 'loom-preset': 'std-m-photon' },
    };
    expect(isLoomManaged(c)).toBe(true);
    expect(loomPresetOf(c)).toBe('std-m-photon');
    expect(clusterSourceLabel(c)).toBe('API');
  });

  it('toHygieneRow marks all-purpose vs ephemeral', () => {
    const ui = toHygieneRow({ cluster_id: 'a', state: 'RUNNING', cluster_source: 'UI' }, NOW);
    const job = toHygieneRow({ cluster_id: 'b', state: 'TERMINATED', cluster_source: 'JOB' }, NOW);
    expect(ui.allPurpose).toBe(true);
    expect(job.allPurpose).toBe(false);
    expect(ui.loomManaged).toBe(false);
  });
});
