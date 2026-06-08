/**
 * Unit tests for posture-client.computePosture — the Govern → Admin view (F2)
 * aggregate assembler.
 *
 * The four wrapped data clients are fully mocked (no importActual) so neither
 * the Azure SDK nor Cosmos is loaded — the test is hermetic and runs on node.
 * The mocked NotConfigured error classes ARE the ones posture-client imports
 * (module mocking replaces them), so its `instanceof` gate checks match.
 *
 * Asserts: (1) Cosmos estate + trust/reuse aggregates are computed from the real
 * item state, and (2) every absent metric source degrades to a `gates[...]`
 * entry (honest gate) instead of failing the whole call or fabricating numbers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => {
  class MockMipErr extends Error { hint: any; constructor(h: any) { super('mip'); this.hint = h; } }
  class MockDlpErr extends Error { hint: any; constructor(h: any) { super('dlp'); this.hint = h; } }
  class MockPurviewErr extends Error { hint: any; constructor(h: any) { super('pv'); this.hint = h; } }
  class MockMonitorErr extends Error { missing: string[]; constructor(m: string[]) { super('mon'); this.missing = m; } }
  return { MockMipErr, MockDlpErr, MockPurviewErr, MockMonitorErr };
});

vi.mock('@/lib/azure/cosmos-client', () => {
  const mkQuery = (rows: any[]) => ({ fetchAll: async () => ({ resources: rows }) });
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
  return {
    workspacesContainer: async () => ({ items: { query: () => mkQuery([{ id: 'ws1' }]) } }),
    itemsContainer: async () => ({
      items: {
        query: () => mkQuery([
          { id: 'i1', workspaceId: 'ws1', itemType: 'lakehouse', updatedAt: now, state: { sensitivityLabel: 'Confidential', description: 'desc', endorsement: 'Certified', capacityId: 'cap1', domain: 'dom1' } },
          { id: 'i2', workspaceId: 'ws1', itemType: 'report', updatedAt: old, state: {} },
        ]),
      },
    }),
    auditLogContainer: async () => ({ items: { query: () => mkQuery([3]) } }),
    postureAggregatesAdminContainer: async () => ({
      item: () => ({ read: async () => ({ resource: null }) }),
      items: { upsert: async () => {} },
    }),
  };
});

vi.mock('@/lib/azure/mip-graph-client', () => ({
  MipNotConfiguredError: H.MockMipErr,
  listSensitivityLabels: async () => { throw new H.MockMipErr({ missingEnvVar: 'LOOM_MIP_ENABLED' }); },
}));

vi.mock('@/lib/azure/dlp-graph-client', () => ({
  DlpNotConfiguredError: H.MockDlpErr,
  listDlpAlerts: async () => { throw new H.MockDlpErr({ missingEnvVar: 'LOOM_DLP_ENABLED' }); },
}));

vi.mock('@/lib/azure/purview-client', () => ({
  PurviewNotConfiguredError: H.MockPurviewErr,
  listDataSources: async () => { throw new H.MockPurviewErr({ missingEnvVar: 'LOOM_PURVIEW_ACCOUNT' }); },
  listScansForSource: async () => [],
  listScanRuns: async () => [],
}));

vi.mock('@/lib/azure/monitor-client', () => ({
  MonitorNotConfiguredError: H.MockMonitorErr,
  queryLogs: async () => { throw new H.MockMonitorErr(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']); },
}));

import { computePosture, assertCosmosConfigured, PostureNotConfiguredError } from '../posture-client';

describe('posture-client.computePosture', () => {
  beforeEach(() => {
    process.env.LOOM_COSMOS_ENDPOINT = 'https://fake.documents.azure.com:443/';
  });

  it('computes Cosmos estate + trust/reuse aggregates from real item state', async () => {
    const { posture } = await computePosture('tenant-1');
    expect(posture.workspaceCount).toBe(1);
    expect(posture.totalItems).toBe(2);
    expect(posture.capacityCount).toBe(1);
    expect(posture.domainCount).toBe(1);
    // i1 fresh+described+endorsed; i2 neither → 50% each.
    expect(posture.freshItemsPct).toBe(50);
    expect(posture.describedItemsPct).toBe(50);
    expect(posture.endorsedItemsPct).toBe(50);
    expect(posture.sharedItems30d).toBe(3);
  });

  it('degrades every absent metric source to an honest gate (no fabricated numbers)', async () => {
    const { posture, gates } = await computePosture('tenant-1');
    expect(posture.mipCoveragePct).toBeNull();
    expect(posture.dlpViolations30d).toBeNull();
    expect(posture.purviewLastScanAt).toBeNull();
    expect(gates.mip?.missingEnvVar).toBe('LOOM_MIP_ENABLED');
    expect(gates.dlp?.missingEnvVar).toBe('LOOM_DLP_ENABLED');
    expect(gates.purview?.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
    expect(gates.featureUsage?.missingEnvVar).toBe('LOOM_LOG_ANALYTICS_WORKSPACE_ID');
  });

  it('hard-gates when LOOM_COSMOS_ENDPOINT is unset', () => {
    delete process.env.LOOM_COSMOS_ENDPOINT;
    expect(() => assertCosmosConfigured()).toThrow(PostureNotConfiguredError);
  });
});
