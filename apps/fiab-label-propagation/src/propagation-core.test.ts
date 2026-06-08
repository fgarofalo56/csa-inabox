import { describe, it, expect } from 'vitest';
import { computePropagation, labelRank } from './propagation-core';

// Mirror of the canonical fiab-console tests — guards behavioural parity of the
// standalone runtime copy.
describe('propagation-core (Function copy)', () => {
  it('ranks standard labels least → most restrictive', () => {
    expect(labelRank('General')).toBeLessThan(labelRank('Restricted'));
  });

  it('flags an un-inherited child as pending', () => {
    const recs = computePropagation(
      [{ id: 'p', sensitivity: 'Confidential' }, { id: 'c', sensitivity: '' }],
      [{ from: 'p', to: 'c' }],
    );
    const c = recs.find((r) => r.itemId === 'c')!;
    expect(c.expectedLabel).toBe('Confidential');
    expect(c.status).toBe('pending');
  });

  it('marks a manual raise as overridden', () => {
    const recs = computePropagation(
      [{ id: 'p', sensitivity: 'Internal' }, { id: 'c', sensitivity: 'Restricted' }],
      [{ from: 'p', to: 'c' }],
    );
    expect(recs.find((r) => r.itemId === 'c')!.status).toBe('overridden');
  });

  it('propagates the most restrictive transitively', () => {
    const recs = computePropagation(
      [
        { id: 'a', sensitivity: 'General' },
        { id: 'b', sensitivity: 'Highly Confidential' },
        { id: 'mid', sensitivity: '' },
        { id: 'leaf', sensitivity: '' },
      ],
      [
        { from: 'a', to: 'mid' },
        { from: 'b', to: 'mid' },
        { from: 'mid', to: 'leaf' },
      ],
    );
    expect(recs.find((r) => r.itemId === 'leaf')!.expectedLabel).toBe('Highly Confidential');
  });
});
