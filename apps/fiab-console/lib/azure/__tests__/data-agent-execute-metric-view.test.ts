/**
 * DBX-5 delta: the data agent executes a `metric-view` source's SQL read-only
 * against the Azure-native warehouse (Synapse Dedicated), exactly like a
 * warehouse source, returning real rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(),
  dedicatedTarget: vi.fn(() => ({ server: 'ws.sql.azuresynapse.net', database: 'pool', cacheKey: 'k' })),
  serverlessTarget: vi.fn(() => ({ server: 'ws-ondemand.sql.azuresynapse.net', database: 'db', cacheKey: 'k2' })),
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
vi.mock('@/lib/azure/search-field-shapes', () => ({
  isVectorFieldType: vi.fn(() => false),
}));
vi.mock('@/lib/azure/graph-search-client', () => ({
  graphGroundingSearch: vi.fn(),
  GraphSearchAccessError: class extends Error {},
}));

import { executeSourceQuery } from '@/lib/azure/data-agent-execute';
import { executeQuery, dedicatedTarget } from '@/lib/azure/synapse-sql-client';

beforeEach(() => vi.resetAllMocks());

it('executes a metric-view SELECT against the Synapse Dedicated pool', async () => {
  (executeQuery as any).mockResolvedValue({ columns: ['status', 'total'], rows: [['O', 100]], rowCount: 1, truncated: false });
  const res = await executeSourceQuery(
    { id: 'm1', type: 'metric-view', name: 'orders_mv' } as any,
    'SELECT status, SUM(total) AS total FROM orders_mv GROUP BY status',
  );
  expect(res.executed).toBe(true);
  expect(res.rows).toEqual([['O', 100]]);
  expect(dedicatedTarget).toHaveBeenCalled();
  expect(executeQuery).toHaveBeenCalledOnce();
});

it('refuses a write query on a metric-view source (read-only guard)', async () => {
  const res = await executeSourceQuery(
    { id: 'm1', type: 'metric-view', name: 'orders_mv' } as any,
    'DROP TABLE orders_mv',
  );
  expect(res.executed).toBe(false);
  expect(res.gate).toBeTruthy();
});
