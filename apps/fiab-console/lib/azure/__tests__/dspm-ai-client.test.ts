import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for the DSPM-for-AI posture compute. The Cosmos / Graph / Monitor
 * backends are mocked so the join logic (source-label resolution, max-label
 * ranking, protection state, per-agent usage, honest gates) is exercised
 * deterministically without a live Azure call.
 */

// --- mocked backends ---------------------------------------------------------

class MipNotConfiguredError extends Error { hint = { missingEnvVar: 'LOOM_MIP_ENABLED' }; }
class MonitorNotConfiguredError extends Error { missing = ['LOOM_LOG_ANALYTICS_WORKSPACE_ID']; }

const labelsMock = vi.fn();
const queryLogsMock = vi.fn();

const WS = { items: { query: () => ({ fetchAll: async () => ({ resources: [{ id: 'ws1' }] }) }) } };
let ITEMS_RESOURCES: any[] = [];
const ITEMS = { items: { query: () => ({ fetchAll: async () => ({ resources: ITEMS_RESOURCES }) }) } };

vi.mock('../cosmos-client', () => ({
  workspacesContainer: async () => WS,
  itemsContainer: async () => ITEMS,
}));
vi.mock('../mip-graph-client', () => ({
  listSensitivityLabels: () => labelsMock(),
  MipNotConfiguredError,
}));
vi.mock('../monitor-client', () => ({
  queryLogs: (...a: any[]) => queryLogsMock(...a),
  MonitorNotConfiguredError,
}));

import { computeDspmAiPosture, DspmAiNotConfiguredError } from '../dspm-ai-client';

const ORIG = process.env.LOOM_COSMOS_ENDPOINT;
beforeEach(() => {
  process.env.LOOM_COSMOS_ENDPOINT = 'https://acct.documents.azure.com:443/';
  ITEMS_RESOURCES = [
    { id: 'lh1', displayName: 'Sales LH', itemType: 'lakehouse', workspaceId: 'ws1', state: { sensitivityLabel: 'Confidential' } },
    { id: 'wh1', displayName: 'Ops WH', itemType: 'warehouse', workspaceId: 'ws1', state: { sensitivityLabel: 'Internal' } },
    { id: 'pub1', displayName: 'Public DS', itemType: 'lakehouse', workspaceId: 'ws1', state: {} },
    {
      id: 'da1', displayName: 'Revenue agent', itemType: 'data-agent', workspaceId: 'ws1',
      state: { sources: [
        { id: 'lh1', name: 'Sales LH', type: 'lakehouse' },
        { id: 'wh1', name: 'Ops WH', type: 'warehouse' },
        { name: 'Public DS', type: 'lakehouse' },
      ] },
    },
  ];
  labelsMock.mockResolvedValue([
    { name: 'Confidential', sensitivity: 3, hasProtection: true },
    { name: 'Internal', sensitivity: 2, hasProtection: false },
  ]);
  queryLogsMock.mockResolvedValue({
    columns: ['agent_id', 'calls', 'lastUsed'],
    rows: [['da1', 7, '2026-06-10T12:00:00Z']],
    rowCount: 1,
  });
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.LOOM_COSMOS_ENDPOINT;
  else process.env.LOOM_COSMOS_ENDPOINT = ORIG;
  vi.clearAllMocks();
});

describe('computeDspmAiPosture', () => {
  it('hard-gates when Cosmos is unconfigured', async () => {
    delete process.env.LOOM_COSMOS_ENDPOINT;
    await expect(computeDspmAiPosture('tenant')).rejects.toBeInstanceOf(DspmAiNotConfiguredError);
  });

  it('resolves each agent source to its bound item label and picks the max', async () => {
    const r = await computeDspmAiPosture('tenant');
    expect(r.summary.agentCount).toBe(1);
    expect(r.summary.agentsTouchingSensitive).toBe(1);

    const agent = r.agents[0];
    expect(agent.agentId).toBe('da1');
    expect(agent.totalSourceCount).toBe(3);
    // Two of three sources are labeled (Public DS is unlabeled).
    expect(agent.sensitiveSourceCount).toBe(2);
    // Confidential (rank 3) outranks Internal (rank 2).
    expect(agent.maxLabel).toBe('Confidential');
    // Confidential carries protection per the Graph label set.
    expect(agent.protected).toBe(true);
    // Real usage joined from the copilot.usage telemetry.
    expect(agent.usageCalls).toBe(7);
    expect(agent.lastUsedAt).toBe('2026-06-10T12:00:00.000Z');
  });

  it('honest-gates usage (blank columns) when Log Analytics is unconfigured', async () => {
    queryLogsMock.mockRejectedValue(new MonitorNotConfiguredError('no LAW'));
    const r = await computeDspmAiPosture('tenant');
    expect(r.summary.usageGated).toBe(true);
    expect(r.gates.usage?.missingEnvVar).toBe('LOOM_LOG_ANALYTICS_WORKSPACE_ID');
    expect(r.agents[0].usageCalls).toBe(0);
  });

  it('degrades to static label rank + a gate when MIP is unconfigured', async () => {
    labelsMock.mockRejectedValue(new MipNotConfiguredError('mip off'));
    const r = await computeDspmAiPosture('tenant');
    expect(r.gates.mip).toBeDefined();
    // Static fallback still ranks Confidential above Internal.
    expect(r.agents[0].maxLabel).toBe('Confidential');
    // Protection state is unknown without Graph → false.
    expect(r.agents[0].protected).toBe(false);
  });
});
