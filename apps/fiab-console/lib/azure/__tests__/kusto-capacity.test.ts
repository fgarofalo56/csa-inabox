/**
 * Contract tests for the Eventhouse Capacity / throttle panel Kusto helpers.
 *
 * Stubs `fetch` (the cluster /v1/rest/mgmt endpoint) and asserts the exact
 * Kusto control-command CSL each helper sends plus how it shapes the v1
 * response. Per no-vaporware.md these exercise the real command text + row
 * parsing, not mocks of our own logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// cosmos-client is imported by kusto-client; stub it so the module loads.
vi.mock('../cosmos-client', () => ({
  itemsContainer: async () => ({}),
  workspacesContainer: async () => ({}),
}));

beforeEach(() => {
  process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureMgmt(table: { Columns: { ColumnName: string; DataType?: string }[]; Rows: unknown[][] }) {
  const bodies: Array<{ db: string; csl: string }> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ Tables: [{ TableName: 'Table_0', ...table }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return bodies;
}

describe('showCapacitySlots', () => {
  it('parses .show capacity rows into typed slots', async () => {
    const bodies = captureMgmt({
      Columns: [
        { ColumnName: 'Resource' }, { ColumnName: 'Total' }, { ColumnName: 'Consumed' },
        { ColumnName: 'Remaining' }, { ColumnName: 'Origin' },
      ],
      Rows: [
        ['ingestions', 576, 1, 575, 'CapacityPolicy/Ingestion'],
        ['data-export', 10, 0, 10, 'CapacityPolicy/Export'],
      ],
    });
    const { showCapacitySlots } = await import('../kusto-client');
    const slots = await showCapacitySlots();
    expect(bodies[0].csl).toBe('.show capacity');
    expect(bodies[0].db).toBe('NetDefaultDB');
    expect(slots).toHaveLength(2);
    expect(slots[0]).toEqual({ resource: 'ingestions', total: 576, consumed: 1, remaining: 575, origin: 'CapacityPolicy/Ingestion' });
  });
});

describe('showClusterCapacityPolicy', () => {
  it('parses the Policy JSON column into an object', async () => {
    const policy = { IngestionCapacity: { ClusterMaximumConcurrentOperations: 512, CoreUtilizationCoefficient: 0.75 } };
    const bodies = captureMgmt({
      Columns: [{ ColumnName: 'PolicyName' }, { ColumnName: 'Policy' }],
      Rows: [['CapacityPolicy', JSON.stringify(policy)]],
    });
    const { showClusterCapacityPolicy } = await import('../kusto-client');
    const out = await showClusterCapacityPolicy();
    expect(bodies[0].csl).toBe('.show cluster policy capacity');
    expect((out.IngestionCapacity as any).ClusterMaximumConcurrentOperations).toBe(512);
  });

  it('falls back to scanning cells when no named Policy column exists', async () => {
    const policy = { ExportCapacity: { ClusterMaximumConcurrentOperations: 5 } };
    captureMgmt({ Columns: [{ ColumnName: 'X' }], Rows: [[JSON.stringify(policy)]] });
    const { showClusterCapacityPolicy } = await import('../kusto-client');
    const out = await showClusterCapacityPolicy();
    expect((out.ExportCapacity as any).ClusterMaximumConcurrentOperations).toBe(5);
  });
});

describe('alterMergeCapacityPolicy', () => {
  it('builds the .alter-merge command with a triple-backtick JSON literal', async () => {
    const bodies = captureMgmt({ Columns: [{ ColumnName: 'Policy' }], Rows: [['{}']] });
    const { alterMergeCapacityPolicy } = await import('../kusto-client');
    await alterMergeCapacityPolicy({ IngestionCapacity: { ClusterMaximumConcurrentOperations: 256, CoreUtilizationCoefficient: 0.5 } });
    expect(bodies[0].csl).toBe('.alter-merge cluster policy capacity ```{"IngestionCapacity":{"ClusterMaximumConcurrentOperations":256,"CoreUtilizationCoefficient":0.5}}```');
  });

  it('rejects an unknown capacity component before hitting the cluster', async () => {
    const bodies = captureMgmt({ Columns: [], Rows: [] });
    const { alterMergeCapacityPolicy } = await import('../kusto-client');
    await expect(alterMergeCapacityPolicy({ NotAReal: { x: 1 } } as any)).rejects.toThrow(/unsupported component/i);
    expect(bodies).toHaveLength(0);
  });

  it('rejects an empty patch', async () => {
    captureMgmt({ Columns: [], Rows: [] });
    const { alterMergeCapacityPolicy } = await import('../kusto-client');
    await expect(alterMergeCapacityPolicy({})).rejects.toThrow(/at least one/i);
  });
});
