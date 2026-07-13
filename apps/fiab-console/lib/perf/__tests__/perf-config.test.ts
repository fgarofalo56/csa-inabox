import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveMetricConfig, resolveMetricConfigMap } from '@/lib/perf/perf-config';

const SYNAPSE = 'LOOM_SYNAPSE_WORKSPACE';
const DEDICATED = 'LOOM_SYNAPSE_DEDICATED_POOL';
const KUSTO = 'LOOM_KUSTO_CLUSTER_URI';
const AOAI = 'LOOM_AOAI_ENDPOINT';
const AOAI2 = 'AZURE_OPENAI_ENDPOINT';

const saved: Record<string, string | undefined> = {};
const KEYS = [SYNAPSE, DEDICATED, KUSTO, AOAI, AOAI2];

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

describe('resolveMetricConfig — server truth, not the last-run flag', () => {
  it('serverless warehouse: CONFIGURED once LOOM_SYNAPSE_WORKSPACE is set', () => {
    process.env[SYNAPSE] = 'syn-loom-default-centralus';
    const c = resolveMetricConfig('warehouse-query-serverless');
    expect(c.configured).toBe(true);
    // This is the exact live-failure: env IS set, so NO gate is surfaced.
    expect(c.gateEnv).toBeUndefined();
  });

  it('serverless warehouse: gated with the exact env var when unset', () => {
    const c = resolveMetricConfig('warehouse-query-serverless');
    expect(c.configured).toBe(false);
    expect(c.gateEnv).toBe(SYNAPSE);
    expect(c.gateMessage).toMatch(/LOOM_SYNAPSE_WORKSPACE/);
  });

  it('dedicated warehouse: needs BOTH workspace and pool', () => {
    process.env[SYNAPSE] = 'syn-loom-default-centralus';
    expect(resolveMetricConfig('warehouse-query-dedicated').configured).toBe(false);
    expect(resolveMetricConfig('warehouse-query-dedicated').gateEnv).toBe(DEDICATED);
    process.env[DEDICATED] = 'loompool';
    expect(resolveMetricConfig('warehouse-query-dedicated').configured).toBe(true);
  });

  it('dedicated warehouse: gates on workspace first when neither is set', () => {
    expect(resolveMetricConfig('warehouse-query-dedicated').gateEnv).toBe(SYNAPSE);
  });

  it('spark metrics: configured on workspace alone (opt-in is not an infra gate)', () => {
    expect(resolveMetricConfig('spark-attach').configured).toBe(false);
    process.env[SYNAPSE] = 'syn-loom-default-centralus';
    expect(resolveMetricConfig('spark-attach').configured).toBe(true);
    expect(resolveMetricConfig('notebook-roundtrip').configured).toBe(true);
  });

  it('ADX metrics: configured on the cluster URI', () => {
    expect(resolveMetricConfig('adx-query').configured).toBe(false);
    expect(resolveMetricConfig('adx-query').gateEnv).toBe(KUSTO);
    process.env[KUSTO] = 'https://adx-csa-loom.eastus2.kusto.windows.net';
    expect(resolveMetricConfig('adx-query').configured).toBe(true);
    expect(resolveMetricConfig('dashboard-tile-tti').configured).toBe(true);
  });

  it('copilot: configured on either AOAI endpoint var', () => {
    expect(resolveMetricConfig('copilot-turn').configured).toBe(false);
    process.env[AOAI2] = 'https://aoai.openai.azure.com';
    expect(resolveMetricConfig('copilot-turn').configured).toBe(true);
  });

  it('blank string is treated as UNset', () => {
    process.env[SYNAPSE] = '   ';
    expect(resolveMetricConfig('warehouse-query-serverless').configured).toBe(false);
  });

  it('page-TTI + unknown metrics never invent a false gate', () => {
    expect(resolveMetricConfig('page-tti:home').configured).toBe(true);
    expect(resolveMetricConfig('page-tti:catalog').configured).toBe(true);
    expect(resolveMetricConfig('mystery-metric').configured).toBe(true);
  });

  it('resolveMetricConfigMap resolves each id independently', () => {
    process.env[SYNAPSE] = 'syn-loom-default-centralus';
    const map = resolveMetricConfigMap(['warehouse-query-serverless', 'adx-query']);
    expect(map['warehouse-query-serverless'].configured).toBe(true);
    expect(map['adx-query'].configured).toBe(false);
  });
});
