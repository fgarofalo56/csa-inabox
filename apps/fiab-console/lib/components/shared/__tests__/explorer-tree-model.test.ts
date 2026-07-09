/**
 * explorer-tree-model — pure logic behind the shared <ExplorerTree> (SC-7):
 * branch/leaf classification, name matching, recursive filtering, leaf counting.
 */
import { describe, it, expect } from 'vitest';
import {
  isBranch, nodeMatches, filterExplorerNodes, countLeaves,
  type ExplorerNode,
} from '../explorer-tree-model';

const forest: ExplorerNode[] = [
  {
    id: 'g-pipelines', label: 'Pipelines', kind: 'group', children: [
      { id: 'p-ingest', label: 'ingest_daily', kind: 'pipeline' },
      { id: 'p-copy', label: 'copy_orders', kind: 'pipeline' },
    ],
  },
  {
    id: 'g-datasets', label: 'Datasets', kind: 'group', children: [
      { id: 'd-orders', label: 'orders_delta', kind: 'dataset' },
    ],
  },
  { id: 'g-lazy', label: 'Notebooks', kind: 'group', hasChildren: true },
];

describe('isBranch', () => {
  it('classifies branches (children or hasChildren) vs leaves', () => {
    expect(isBranch(forest[0])).toBe(true);
    expect(isBranch(forest[2])).toBe(true); // lazy branch
    expect(isBranch({ id: 'x', label: 'x', kind: 'pipeline' })).toBe(false);
  });
});

describe('nodeMatches', () => {
  it('matches all on empty query', () => {
    expect(nodeMatches(forest[0], '')).toBe(true);
  });
  it('matches case-insensitively on the label', () => {
    expect(nodeMatches({ id: 'p', label: 'copy_orders', kind: 'pipeline' }, 'ORDERS')).toBe(true);
    expect(nodeMatches({ id: 'p', label: 'copy_orders', kind: 'pipeline' }, 'zzz')).toBe(false);
  });
});

describe('filterExplorerNodes', () => {
  it('returns the forest unchanged (same reference) for empty query', () => {
    expect(filterExplorerNodes(forest, '')).toBe(forest);
  });
  it('keeps only branches with a surviving descendant', () => {
    const out = filterExplorerNodes(forest, 'orders');
    // g-pipelines keeps copy_orders; g-datasets keeps orders_delta; g-lazy dropped.
    expect(out.map((n) => n.id)).toEqual(['g-pipelines', 'g-datasets']);
    expect(out[0].children?.map((c) => c.id)).toEqual(['p-copy']);
    expect(out[1].children?.map((c) => c.id)).toEqual(['d-orders']);
  });
  it('keeps all children when the branch label itself matches', () => {
    const out = filterExplorerNodes(forest, 'pipelines');
    expect(out).toHaveLength(1);
    expect(out[0].children).toHaveLength(2);
  });
  it('keeps a lazy branch when its own label matches', () => {
    const out = filterExplorerNodes(forest, 'notebook');
    expect(out.map((n) => n.id)).toEqual(['g-lazy']);
  });
});

describe('countLeaves', () => {
  it('counts leaves across branches (lazy branches contribute 0)', () => {
    expect(countLeaves(forest)).toBe(3);
  });
});
