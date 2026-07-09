import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { perfExportConfig, buildPerfRow, PERF_STREAM } from '../perf-export';
import type { PerfBenchmarkDoc } from '../perf-store';

const ORIG = { ...process.env };

describe('perf/perf-export', () => {
  beforeEach(() => {
    delete process.env.LOOM_PERF_DCR_ENDPOINT;
    delete process.env.LOOM_PERF_DCR_ID;
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('honest-gates to null when the DCR is not provisioned', () => {
    expect(perfExportConfig()).toBeNull();
  });

  it('resolves config when both env vars are set (trailing slash trimmed)', () => {
    process.env.LOOM_PERF_DCR_ENDPOINT = 'https://dce-loom-perf.eastus.ingest.monitor.azure.com/';
    process.env.LOOM_PERF_DCR_ID = 'dcr-abc123';
    const cfg = perfExportConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.endpoint).toBe('https://dce-loom-perf.eastus.ingest.monitor.azure.com');
    expect(cfg?.dcrId).toBe('dcr-abc123');
  });

  it('uses the Custom-LoomPerf_CL stream name', () => {
    expect(PERF_STREAM).toBe('Custom-LoomPerf_CL');
  });

  it('maps a benchmark doc to a LoomPerf_CL row, defaulting nulls to 0', () => {
    const doc: PerfBenchmarkDoc = {
      id: 'r1:adx-query',
      runId: 'r1',
      gitSha: 'abc',
      rev: 'rev-1',
      metric: 'adx-query',
      backend: 'adx',
      p50: 120,
      p95: 240,
      p99: null,
      coldMs: 500,
      warmMs: 110,
      gated: false,
      ts: '2026-07-09T00:00:00.000Z',
      tenantId: 'tenant-1',
    };
    const row = buildPerfRow(doc);
    expect(row.Metric).toBe('adx-query');
    expect(row.Backend).toBe('adx');
    expect(row.P50).toBe(120);
    expect(row.P99).toBe(0); // null → 0
    expect(row.Gated).toBe(false);
    expect(row.TenantId).toBe('tenant-1');
    expect(row.TimeGenerated).toBe('2026-07-09T00:00:00.000Z');
  });
});
