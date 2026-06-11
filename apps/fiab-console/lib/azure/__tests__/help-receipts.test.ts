/**
 * Unit tests for help-receipts.gatherReceipts — the auto-error-detect input
 * layer. Mocks cosmos-client (itemsContainer / auditLogContainer) and
 * adf-client (run APIs + config gate) so the receipt-shaping logic is tested
 * without real Azure backends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Mocks ----------

let fakeItem: any = null;
let fakeAudit: any[] = [];

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: fakeItem ? [fakeItem] : [] }) }),
    },
  }),
  auditLogContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: fakeAudit }) }),
    },
  }),
}));

const adfState = {
  gate: null as null | { missing: string },
  pipelineRuns: [] as any[],
  activityRuns: [] as any[],
  throwOnRuns: false,
};

vi.mock('@/lib/azure/adf-client', () => ({
  adfConfigGate: () => adfState.gate,
  listPipelineRuns: async () => {
    if (adfState.throwOnRuns) throw new Error('ADF 403');
    return adfState.pipelineRuns;
  },
  listActivityRuns: async () => adfState.activityRuns,
}));

import { gatherReceipts } from '../help-receipts';

beforeEach(() => {
  fakeItem = null;
  fakeAudit = [];
  adfState.gate = null;
  adfState.pipelineRuns = [];
  adfState.activityRuns = [];
  adfState.throwOnRuns = false;
});

describe('gatherReceipts — provisioning', () => {
  it('reports itemNotFound when no item exists', async () => {
    const r = await gatherReceipts({ itemId: 'missing', source: 'provisioning' });
    expect(r.itemNotFound).toBe(true);
    expect(r.provisioning?.found).toBe(false);
  });

  it('surfaces a remediation gate from state.provisioning', async () => {
    fakeItem = {
      id: 'itm-1',
      itemType: 'eventstream',
      workspaceId: 'ws-1',
      state: {
        provisioning: {
          status: 'remediation',
          gate: { reason: 'Event Hubs namespace not set', remediation: 'Set LOOM_EVENTHUBS_NAMESPACE', link: 'https://x' },
          at: '2026-06-10T00:00:00Z',
        },
      },
    };
    const r = await gatherReceipts({ itemId: 'itm-1', itemType: 'eventstream', source: 'provisioning' });
    expect(r.itemNotFound).toBeFalsy();
    expect(r.workspaceId).toBe('ws-1');
    expect(r.provisioning?.found).toBe(true);
    expect(r.provisioning?.status).toBe('remediation');
    expect(r.provisioning?.gate?.remediation).toContain('LOOM_EVENTHUBS_NAMESPACE');
  });
});

describe('gatherReceipts — audit', () => {
  it('returns recent audit entries', async () => {
    fakeItem = { id: 'itm-2', itemType: 'notebook', state: {} };
    fakeAudit = [
      { action: 'run', summary: 'executed cell 1', at: '2026-06-10T01:00:00Z', upn: 'a@b.com' },
      { action: 'edit', summary: 'changed query', at: '2026-06-10T00:00:00Z' },
    ];
    const r = await gatherReceipts({ itemId: 'itm-2', source: 'audit' });
    expect(r.audit?.length).toBe(2);
    expect(r.audit?.[0].action).toBe('run');
  });
});

describe('gatherReceipts — runs (Azure-native ADF)', () => {
  it('honest-gates when factory env vars are unset', async () => {
    adfState.gate = { missing: 'LOOM_ADF_NAME' };
    fakeItem = { id: 'itm-3', itemType: 'data-pipeline', state: {} };
    const r = await gatherReceipts({ itemId: 'itm-3', source: 'runs' });
    expect(r.runs?.configured).toBe(false);
    expect(r.runs?.gate?.missing).toBe('LOOM_ADF_NAME');
    expect(r.runs?.gate?.remediation).toContain('LOOM_ADF_NAME');
  });

  it('reports failed runs + activity errors for a bound pipeline', async () => {
    fakeItem = {
      id: 'itm-4',
      itemType: 'data-pipeline',
      state: { pipelineName: 'pl-ingest', provisioning: { secondaryIds: { pipelineName: 'pl-ingest' } } },
    };
    adfState.pipelineRuns = [
      { runId: 'r1', pipelineName: 'pl-ingest', status: 'Failed', message: 'activity failed' },
      { runId: 'r2', pipelineName: 'pl-ingest', status: 'Succeeded' },
    ];
    adfState.activityRuns = [
      { activityName: 'CopyData', activityType: 'Copy', status: 'Failed', error: { errorCode: '2200', message: 'sink timeout' } },
    ];
    const r = await gatherReceipts({ itemId: 'itm-4', source: 'runs' });
    expect(r.runs?.configured).toBe(true);
    expect(r.runs?.pipelineName).toBe('pl-ingest');
    expect(r.runs?.failedRuns?.length).toBe(1);
    expect(r.runs?.failedActivities?.[0].message).toBe('sink timeout');
  });

  it('notes when there are no failed runs', async () => {
    fakeItem = { id: 'itm-5', itemType: 'data-pipeline', state: { pipelineName: 'pl-ok' } };
    adfState.pipelineRuns = [{ runId: 'r1', pipelineName: 'pl-ok', status: 'Succeeded' }];
    const r = await gatherReceipts({ itemId: 'itm-5', source: 'runs' });
    expect(r.runs?.failedRuns?.length).toBe(0);
    expect(r.runs?.note).toContain('No failed runs');
  });

  it('surfaces the ADF error honestly rather than hiding it', async () => {
    fakeItem = { id: 'itm-6', itemType: 'data-pipeline', state: { pipelineName: 'pl-x' } };
    adfState.throwOnRuns = true;
    const r = await gatherReceipts({ itemId: 'itm-6', source: 'runs' });
    expect(r.runs?.configured).toBe(true);
    expect(r.runs?.error).toContain('ADF 403');
  });
});
