import { describe, it, expect } from 'vitest';
import {
  ENGINE_METRICS,
  ENGINE_METRIC_IDS,
  TOP_SURFACES,
  pageTtiMetricId,
  isPageTtiMetric,
  surfaceForMetric,
  engineMetric,
  metricDef,
  metricCategory,
} from '../perf-metrics';

describe('perf/perf-metrics registry', () => {
  it('defines every PRP metric with a real Azure-native backend and a Fabric bar', () => {
    const ids = ENGINE_METRIC_IDS;
    for (const required of [
      'spark-attach',
      'notebook-roundtrip',
      'warehouse-query-serverless',
      'warehouse-query-dedicated',
      'adx-query',
      'dashboard-tile-tti',
      'copilot-turn',
    ]) {
      expect(ids).toContain(required);
    }
    for (const m of ENGINE_METRICS) {
      expect(m.fabricBarMs).toBeGreaterThan(0);
      expect(m.learnUrl).toMatch(/^https:\/\/learn\.microsoft\.com\//);
      // No Fabric-family backend — Azure-native only.
      expect(['synapse-livy', 'synapse-serverless', 'synapse-dedicated', 'adx', 'aoai', 'http']).toContain(m.backend);
    }
  });

  it('measures exactly 10 top surfaces for page TTI', () => {
    expect(TOP_SURFACES.length).toBe(10);
    const slugs = new Set(TOP_SURFACES.map((s) => s.slug));
    expect(slugs.size).toBe(10); // unique
  });

  it('round-trips page-tti metric ids', () => {
    const id = pageTtiMetricId('catalog');
    expect(isPageTtiMetric(id)).toBe(true);
    expect(isPageTtiMetric('adx-query')).toBe(false);
    expect(surfaceForMetric(id)?.path).toBe('/catalog');
    expect(surfaceForMetric('adx-query')).toBeUndefined();
  });

  it('resolves a display def for both engine + surface metrics', () => {
    expect(engineMetric('adx-query')?.label).toBe('ADX query');
    const surfaceDef = metricDef(pageTtiMetricId('home'));
    expect(surfaceDef?.backend).toBe('http');
    expect(surfaceDef?.fabricBarMs).toBeGreaterThan(0);
    expect(metricDef('does-not-exist')).toBeUndefined();
  });

  it('categorises metrics', () => {
    expect(metricCategory('adx-query')).toBe('engine');
    expect(metricCategory(pageTtiMetricId('home'))).toBe('surface');
  });

  it('marks the costly Spark probes as opt-in', () => {
    expect(engineMetric('spark-attach')?.costlyOptIn).toBe(true);
    expect(engineMetric('notebook-roundtrip')?.costlyOptIn).toBe(true);
    expect(engineMetric('adx-query')?.costlyOptIn).toBeFalsy();
  });
});
