import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the generic diagnostics primitives + deps the reconciler builds on ---
const getDiagnosticsCoverage = vi.fn();
const enableDiagnostics = vi.fn();
const logAnalyticsResourceId = vi.fn();
const clearMonitorCache = vi.fn();

vi.mock('../monitor-client', () => ({
  getDiagnosticsCoverage: (...a: unknown[]) => getDiagnosticsCoverage(...a),
  enableDiagnostics: (...a: unknown[]) => enableDiagnostics(...a),
  logAnalyticsResourceId: (...a: unknown[]) => logAnalyticsResourceId(...a),
  clearMonitorCache: (...a: unknown[]) => clearMonitorCache(...a),
  MonitorError: class MonitorError extends Error { status = 500; },
  MonitorNotConfiguredError: class MonitorNotConfiguredError extends Error {
    constructor(public missing: string[]) { super('not configured'); }
  },
}));

const synapseLogAnalyticsConfigured = vi.fn(() => true);
vi.mock('@/lib/spark/config-presets', () => ({
  synapseLogAnalyticsConfigured: () => synapseLogAnalyticsConfigured(),
}));

// Cosmos is never exercised by the audit/apply paths under test.
vi.mock('../cosmos-client', () => ({ maintenanceJobsContainer: vi.fn() }));

import { auditSparkTelemetry, applySparkTelemetry, MonitorNotConfiguredError } from '../spark-telemetry-audit';

const LAW = '/subscriptions/s/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/law-csa-loom';

function coverage() {
  return [
    { id: '/sub/rg/syn1', name: 'syn1', type: 'Microsoft.Synapse/workspaces', resourceGroup: 'rg', supported: true, routesToLoomLaw: true, settingNames: ['diag-loom-stdz'] },
    { id: '/sub/rg/dbx1', name: 'dbx1', type: 'Microsoft.Databricks/workspaces', resourceGroup: 'rg', supported: true, routesToLoomLaw: false, settingNames: [] },
    { id: '/sub/rg/aml1', name: 'aml1', type: 'Microsoft.MachineLearningServices/workspaces', resourceGroup: 'rg', supported: true, routesToLoomLaw: false, settingNames: [] },
    // Non-Spark resources must be excluded.
    { id: '/sub/rg/kv1', name: 'kv1', type: 'Microsoft.KeyVault/vaults', resourceGroup: 'rg', supported: true, routesToLoomLaw: false, settingNames: [] },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  logAnalyticsResourceId.mockReturnValue(LAW);
  synapseLogAnalyticsConfigured.mockReturnValue(true);
  getDiagnosticsCoverage.mockResolvedValue(coverage());
  enableDiagnostics.mockResolvedValue({ settingName: 'diag-loom-stdz', mode: 'allLogs+AllMetrics' });
});

describe('auditSparkTelemetry', () => {
  it('filters to Spark engines only and computes coverage summary', async () => {
    const audit = await auditSparkTelemetry();
    expect(audit.resources.map((r) => r.name).sort()).toEqual(['aml1', 'dbx1', 'syn1']);
    // KeyVault excluded.
    expect(audit.resources.find((r) => r.name === 'kv1')).toBeUndefined();
    expect(audit.summary).toEqual({ total: 3, covered: 1, missing: 2 });
    expect(audit.lawResourceId).toBe(LAW);
    expect(audit.sessionEmitterConfigured).toBe(true);
  });

  it('maps ARM type → engine + expected LA tables', async () => {
    const audit = await auditSparkTelemetry();
    const aml = audit.resources.find((r) => r.name === 'aml1')!;
    expect(aml.engine).toBe('aml');
    expect(aml.tables).toContain('AmlComputeJobEvent');
    const syn = audit.resources.find((r) => r.name === 'syn1')!;
    expect(syn.engine).toBe('synapse-spark');
    expect(syn.tables).toContain('SynapseBigDataPoolApplicationsEnded');
  });

  it('throws MonitorNotConfiguredError when the LAW resource id is unset', async () => {
    logAnalyticsResourceId.mockReturnValue(null);
    await expect(auditSparkTelemetry()).rejects.toBeInstanceOf(MonitorNotConfiguredError);
  });
});

describe('applySparkTelemetry', () => {
  it('remediates ONLY Spark resources missing coverage when no ids given', async () => {
    const report = await applySparkTelemetry();
    expect(report.attempted).toBe(2); // dbx1 + aml1 (syn1 already routes)
    expect(report.succeeded).toBe(2);
    const applied = enableDiagnostics.mock.calls.map((c) => c[0]).sort();
    expect(applied).toEqual(['/sub/rg/aml1', '/sub/rg/dbx1']);
  });

  it('never enables diagnostics on an already-covered or non-Spark id', async () => {
    // syn1 already routes; kv1 is not a Spark resource → both ignored.
    const report = await applySparkTelemetry(['/sub/rg/syn1', '/sub/rg/kv1']);
    expect(report.attempted).toBe(0);
    expect(enableDiagnostics).not.toHaveBeenCalled();
  });

  it('applies only the requested missing id when ids given', async () => {
    const report = await applySparkTelemetry(['/sub/rg/dbx1']);
    expect(report.attempted).toBe(1);
    expect(enableDiagnostics).toHaveBeenCalledTimes(1);
    expect(enableDiagnostics).toHaveBeenCalledWith('/sub/rg/dbx1');
  });

  it('records per-resource failures without aborting the batch', async () => {
    enableDiagnostics.mockImplementation((id: string) => {
      if (id === '/sub/rg/dbx1') throw new Error('403 forbidden');
      return Promise.resolve({ settingName: 'diag-loom-stdz', mode: 'allLogs+AllMetrics' });
    });
    const report = await applySparkTelemetry();
    expect(report.attempted).toBe(2);
    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results.find((r) => r.name === 'dbx1')!.error).toContain('403');
  });
});
