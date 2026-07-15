/**
 * G5 (Prep for AI): the data agent executes a `semantic-model` source's emitted
 * DAX against the Azure-native tabular backend (evalDax → Synapse serverless SQL
 * by default; opt-in AAS XMLA) — NO Power BI / Fabric. It returns real rows when
 * the owner context is threaded, an honest gate when it is not, and surfaces
 * evalDax's TabularError message (which names the backend / env var) on failure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { MockTabularError } = vi.hoisted(() => {
  class MockTabularError extends Error {
    status?: number;
    backend?: string;
    constructor(message: string, status?: number, backend?: string) {
      super(message);
      this.status = status;
      this.backend = backend;
    }
  }
  return { MockTabularError };
});

vi.mock('@/lib/azure/tabular-eval-client', () => ({
  evalDax: vi.fn(),
  TabularError: MockTabularError,
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(),
  dedicatedTarget: vi.fn(() => ({ server: 's', database: 'd', cacheKey: 'k' })),
  serverlessTarget: vi.fn(() => ({ server: 's2', database: 'd2', cacheKey: 'k2' })),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: vi.fn(),
  clusterUri: vi.fn(() => 'https://adx'),
  defaultDatabase: vi.fn(() => 'db'),
  kustoConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/search-index-client', () => ({
  searchDocuments: vi.fn(),
  searchConfigGate: vi.fn(() => null),
  getIndex: vi.fn(),
  semanticConfigNames: vi.fn(() => []),
}));
vi.mock('@/lib/azure/search-field-shapes', () => ({ isVectorFieldType: vi.fn(() => false) }));
vi.mock('@/lib/azure/graph-search-client', () => ({
  graphGroundingSearch: vi.fn(),
  GraphSearchAccessError: class extends Error {},
}));

import { executeSourceQuery } from '@/lib/azure/data-agent-execute';
import { evalDax } from '@/lib/azure/tabular-eval-client';

beforeEach(() => vi.resetAllMocks());

describe('data-agent semantic-model DAX execution', () => {
  it('runs the DAX via evalDax and returns real rows (owner context present)', async () => {
    (evalDax as any).mockResolvedValue({
      columns: ['Status', 'Total'],
      rows: [{ Status: 'Open', Total: 100 }, { Status: 'Closed', Total: 50 }],
      backend: 'loom-native',
    });
    const res = await executeSourceQuery(
      { id: 'semantic-model:model-123:1720', type: 'semantic-model', name: 'Sales model' } as any,
      'EVALUATE SUMMARIZECOLUMNS(Orders[Status], "Total", [Total])',
      { tenantId: 'oid-1' },
    );
    expect(res.executed).toBe(true);
    // model id is parsed out of the source id and passed to evalDax with the tenant.
    expect(evalDax).toHaveBeenCalledWith('model-123', expect.stringContaining('EVALUATE'), 'oid-1');
    expect(res.columns).toEqual(['Status', 'Total']);
    expect(res.rows).toEqual([['Open', 100], ['Closed', 50]]);
    expect(res.rowCount).toBe(2);
  });

  it('honestly gates (does not execute) when no owner context is threaded', async () => {
    const res = await executeSourceQuery(
      { id: 'semantic-model:model-123:1720', type: 'semantic-model', name: 'Sales model' } as any,
      'EVALUATE ROW("x", 1)',
    );
    expect(res.executed).toBe(false);
    expect(res.gate).toMatch(/owner context/i);
    expect(evalDax).not.toHaveBeenCalled();
  });

  it('surfaces evalDax TabularError (backend + message) as an honest gate', async () => {
    (evalDax as any).mockRejectedValue(new MockTabularError('LOOM_AAS_SERVER is not set.', 503, 'analysis-services'));
    const res = await executeSourceQuery(
      { id: 'semantic-model:model-9:1', type: 'semantic-model', name: 'M' } as any,
      'EVALUATE ROW("x", 1)',
      { tenantId: 'oid-1' },
    );
    expect(res.executed).toBe(false);
    expect(res.gate).toContain('analysis-services');
    expect(res.gate).toContain('LOOM_AAS_SERVER');
  });
});
