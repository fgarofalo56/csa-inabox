import { describe, it, expect } from 'vitest';
import {
  computePropagation,
  labelRank,
  STANDARD_LABELS,
} from '../label-propagation';

describe('labelRank', () => {
  it('orders standard labels least → most restrictive', () => {
    expect(labelRank('General')).toBeLessThan(labelRank('Confidential'));
    expect(labelRank('Confidential')).toBeLessThan(labelRank('Restricted'));
    expect(labelRank('Restricted')).toBe(STANDARD_LABELS.length - 1);
  });
  it('treats missing as -1 and custom as 0', () => {
    expect(labelRank('')).toBe(-1);
    expect(labelRank(null)).toBe(-1);
    expect(labelRank('TopSecret//Custom')).toBe(0);
  });
});

describe('computePropagation', () => {
  it('flags a child that has not yet inherited a more restrictive parent label as pending', () => {
    const recs = computePropagation(
      [
        { id: 'parent', sensitivity: 'Confidential' },
        { id: 'child', sensitivity: '' },
      ],
      [{ from: 'parent', to: 'child' }],
    );
    const child = recs.find((r) => r.itemId === 'child')!;
    expect(child.expectedLabel).toBe('Confidential');
    expect(child.currentLabel).toBe('');
    expect(child.status).toBe('pending');
    expect(child.upstream).toEqual([{ id: 'parent', label: 'Confidential' }]);
  });

  it('marks a child carrying the parent label as in-sync', () => {
    const recs = computePropagation(
      [
        { id: 'p', sensitivity: 'Internal' },
        { id: 'c', sensitivity: 'Internal' },
      ],
      [{ from: 'p', to: 'c' }],
    );
    expect(recs.find((r) => r.itemId === 'c')!.status).toBe('in-sync');
  });

  it('marks a child raised ABOVE the parent label as overridden (allowed manual raise)', () => {
    const recs = computePropagation(
      [
        { id: 'p', sensitivity: 'Internal' },
        { id: 'c', sensitivity: 'Restricted' },
      ],
      [{ from: 'p', to: 'c' }],
    );
    expect(recs.find((r) => r.itemId === 'c')!.status).toBe('overridden');
  });

  it('propagates the MOST restrictive across multiple parents and transitively', () => {
    const recs = computePropagation(
      [
        { id: 'a', sensitivity: 'General' },
        { id: 'b', sensitivity: 'Highly Confidential' },
        { id: 'mid', sensitivity: '' }, // inherits Highly Confidential
        { id: 'leaf', sensitivity: '' }, // inherits from mid transitively
      ],
      [
        { from: 'a', to: 'mid' },
        { from: 'b', to: 'mid' },
        { from: 'mid', to: 'leaf' },
      ],
    );
    expect(recs.find((r) => r.itemId === 'mid')!.expectedLabel).toBe('Highly Confidential');
    expect(recs.find((r) => r.itemId === 'leaf')!.expectedLabel).toBe('Highly Confidential');
    expect(recs.find((r) => r.itemId === 'leaf')!.status).toBe('pending');
  });

  it('reports root items with no parents as no-upstream', () => {
    const recs = computePropagation([{ id: 'root', sensitivity: 'Confidential' }], []);
    expect(recs[0].status).toBe('no-upstream');
  });

  it('does not loop forever on a cycle', () => {
    const recs = computePropagation(
      [
        { id: 'x', sensitivity: 'Internal' },
        { id: 'y', sensitivity: '' },
      ],
      [
        { from: 'x', to: 'y' },
        { from: 'y', to: 'x' },
      ],
    );
    expect(recs).toHaveLength(2);
  });
});
