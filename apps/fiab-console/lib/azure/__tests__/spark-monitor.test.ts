import { describe, it, expect } from 'vitest';
import { recommendTuning, sparkNativeDiagLinks, sparkTelemetryConfigured } from '../spark-monitor';

describe('recommendTuning — pure heuristic engine', () => {
  it('flags disk spill (critical when spill dominates shuffle)', () => {
    const recs = recommendTuning({
      appId: 'a', diskSpillBytes: 3_000_000_000, shuffleReadBytes: 4_000_000_000, shuffleWriteBytes: 4_000_000_000,
    });
    const r = recs.find((x) => x.id === 'disk-spill');
    expect(r).toBeTruthy();
    expect(r!.severity).toBe('critical'); // 3GB / 8GB = 0.375 > 0.25
    expect(r!.conf?.some((c) => c.key === 'spark.sql.shuffle.partitions')).toBe(true);
    expect(r!.presetId).toBe('large-shuffle');
  });

  it('flags task skew when max >= 3x median', () => {
    const recs = recommendTuning({ appId: 'a', maxTaskMs: 30_000, medianTaskMs: 5_000 });
    const r = recs.find((x) => x.id === 'task-skew');
    expect(r).toBeTruthy();
    expect(r!.severity).toBe('critical'); // 6x
    expect(r!.conf?.some((c) => c.key === 'spark.sql.adaptive.skewJoin.enabled')).toBe(true);
  });

  it('does NOT flag skew when within 3x', () => {
    const recs = recommendTuning({ appId: 'a', maxTaskMs: 8_000, medianTaskMs: 5_000 });
    expect(recs.find((x) => x.id === 'task-skew')).toBeFalsy();
  });

  it('flags GC pressure above 10% of executor run time', () => {
    const recs = recommendTuning({ appId: 'a', gcTimeMs: 30_000, executorRunTimeMs: 100_000 });
    const r = recs.find((x) => x.id === 'gc-pressure');
    expect(r).toBeTruthy();
    expect(r!.severity).toBe('critical'); // 30% > 20%
  });

  it('flags failed tasks', () => {
    const recs = recommendTuning({ appId: 'a', failedTasks: 4 });
    expect(recs.find((x) => x.id === 'failed-tasks')?.title).toContain('4 failed task');
  });

  it('flags under-utilized executors → cost-optimized', () => {
    const recs = recommendTuning({ appId: 'a', executorAvgUtilization: 0.2, executorCount: 8 });
    expect(recs.find((x) => x.id === 'under-utilized')?.presetId).toBe('cost-optimized');
  });

  it('returns a single healthy rec when nothing fires', () => {
    const recs = recommendTuning({ appId: 'a' });
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('healthy');
    expect(recs[0].severity).toBe('info');
  });

  it('never fabricates recs from absent inputs (no spill rec without spill metric)', () => {
    const recs = recommendTuning({ appId: 'a', shuffleReadBytes: 5_000_000_000 });
    expect(recs.find((x) => x.id === 'disk-spill')).toBeFalsy();
  });
});

describe('sparkNativeDiagLinks — env-gated', () => {
  it('returns no links when nothing configured', () => {
    expect(sparkNativeDiagLinks({} as NodeJS.ProcessEnv)).toEqual([]);
  });
  it('returns the Synapse link when the workspace is set', () => {
    const links = sparkNativeDiagLinks({ LOOM_SYNAPSE_WORKSPACE: 'syn-loom' } as unknown as NodeJS.ProcessEnv);
    expect(links).toHaveLength(1);
    expect(links[0].href).toContain('web.azuresynapse.net');
  });
  it('normalizes a bare Databricks host into https', () => {
    const links = sparkNativeDiagLinks({ LOOM_DATABRICKS_WORKSPACE_URL: 'adb-123.azuredatabricks.net' } as unknown as NodeJS.ProcessEnv);
    expect(links[0].href.startsWith('https://adb-123')).toBe(true);
  });
});

describe('sparkTelemetryConfigured', () => {
  it('true only when LOOM_SPARK_LA_WORKSPACE_ID is set', () => {
    expect(sparkTelemetryConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(sparkTelemetryConfigured({ LOOM_SPARK_LA_WORKSPACE_ID: 'guid' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});
