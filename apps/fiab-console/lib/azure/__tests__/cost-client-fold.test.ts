/**
 * Unit tests for `foldByDimension` — the pure fold behind the per-resource-TYPE
 * chargeback rollup (Cost Management ResourceGroupName × ResourceType response
 * → descending `{ key, cost }` rows, filtered to the Loom resource groups).
 *
 * Locks the "all Loom resource types, grouped + totaled" logic: RG filtering,
 * per-type summing across rows, descending sort, and the robust fallbacks
 * (missing dimension column, absent RG column). No network.
 */
import { describe, it, expect } from 'vitest';
import { foldByDimension } from '../cost-client';

/** Build a Cost Management-shaped response for (Cost, ResourceGroupName, ResourceType). */
function resp(rows: [number, string, string][]) {
  return {
    properties: {
      columns: [
        { name: 'Cost', type: 'Number' },
        { name: 'ResourceGroupName', type: 'String' },
        { name: 'ResourceType', type: 'String' },
      ],
      rows,
    },
  };
}

const LOOM = new Set(['rg-loom-admin', 'rg-loom-dlz']);

describe('foldByDimension (ResourceType rollup)', () => {
  it('sums cost per resource type, filters to Loom RGs, and sorts descending', () => {
    const r = foldByDimension(
      resp([
        [10, 'rg-loom-admin', 'microsoft.synapse/workspaces'],
        [5, 'rg-loom-dlz', 'microsoft.synapse/workspaces'], // same type, other Loom sub → accumulates
        [30, 'rg-loom-dlz', 'microsoft.kusto/clusters'],
        [999, 'rg-not-loom', 'microsoft.kusto/clusters'], // outside Loom RGs → excluded
      ]),
      'ResourceType',
      LOOM,
    );
    expect(r).toEqual([
      { key: 'microsoft.kusto/clusters', cost: 30 },
      { key: 'microsoft.synapse/workspaces', cost: 15 },
    ]);
  });

  it('folds rows with no resource-type value under "unknown"', () => {
    const r = foldByDimension(resp([[7, 'rg-loom-admin', '']]), 'ResourceType', LOOM);
    expect(r).toEqual([{ key: 'unknown', cost: 7 }]);
  });

  it('applies no RG filter when the Loom RG set is empty (all spend counts)', () => {
    const r = foldByDimension(
      resp([[4, 'rg-anything', 'microsoft.storage/storageaccounts']]),
      'ResourceType',
      new Set<string>(),
    );
    expect(r).toEqual([{ key: 'microsoft.storage/storageaccounts', cost: 4 }]);
  });

  it('returns [] for an empty / malformed response', () => {
    expect(foldByDimension({ properties: { columns: [], rows: [] } }, 'ResourceType', LOOM)).toEqual([]);
    expect(foldByDimension({}, 'ResourceType', LOOM)).toEqual([]);
    expect(foldByDimension(null, 'ResourceType', LOOM)).toEqual([]);
  });

  it('is case-insensitive on the RG filter (Cost Management may vary casing)', () => {
    const r = foldByDimension(
      resp([[8, 'RG-LOOM-ADMIN', 'microsoft.app/containerapps']]),
      'ResourceType',
      LOOM,
    );
    expect(r).toEqual([{ key: 'microsoft.app/containerapps', cost: 8 }]);
  });
});
