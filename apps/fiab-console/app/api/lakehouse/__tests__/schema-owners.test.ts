/**
 * Unit tests for otherSchemaOwners. Cosmos is mocked, so these pin the query
 * text and parameters the helper sends and its filtering of the answer; the
 * query's behaviour against a live Cosmos account is not exercised here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fetchAll = vi.fn();
const query = vi.fn(() => ({ fetchAll }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  lakehouseSchemasContainer: vi.fn(async () => ({ items: { query } })),
}));

import { otherSchemaOwners } from '../_lib/schema-owners';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('otherSchemaOwners', () => {
  it('asks for rows with the same name under a different item id, across partitions', async () => {
    fetchAll.mockResolvedValue({ resources: ['lh-b'] });
    await otherSchemaOwners('lh-a', 'sales');
    expect(query.mock.calls.length).toBe(1);
    const [spec, opts] = query.mock.calls[0] as any[];
    expect(spec.query).toBe('SELECT VALUE c.lakehouseId FROM c WHERE c.name = @name AND c.lakehouseId != @lh');
    expect(spec.parameters).toEqual([{ name: '@name', value: 'sales' }, { name: '@lh', value: 'lh-a' }]);
    // A partitionKey option would confine the query to one item's rows.
    expect(opts).toBeUndefined();
  });

  it('returns the other ids once each, and never the asking item or a non-string', async () => {
    fetchAll.mockResolvedValue({ resources: ['lh-b', 'lh-a', 'lh-b', null, '', 'lh-c'] });
    expect(await otherSchemaOwners('lh-a', 'sales')).toEqual(['lh-b', 'lh-c']);
  });

  it('returns an empty list when no other item registers the name', async () => {
    fetchAll.mockResolvedValue({ resources: [] });
    expect(await otherSchemaOwners('lh-a', 'sales')).toEqual([]);
  });
});
