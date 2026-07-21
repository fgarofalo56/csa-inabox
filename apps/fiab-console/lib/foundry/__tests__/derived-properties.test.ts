/**
 * WS-4.2 — derived-property rollup compute (linked-object aggregation).
 * Pure unit coverage over the SAME RawNeighbor shape the object-view route feeds
 * from the real AGE traversal (weave-explore.traverseObject).
 */
import { describe, it, expect } from 'vitest';
import {
  computeRollup, computeRollups, describeDerived, validateDerivedProperty,
  normalizeDerivedProperty, normalizeDerivedProperties, normalizeDerivedPropertyMap, derivedPropertiesFor,
  type OntoDerivedProperty,
} from '@/lib/foundry/derived-properties';
import type { RawNeighbor } from '@/lib/foundry/object-view';
import type { OntoProperty } from '@/lib/editors/ontology-model';

function n(linkType: string, direction: 'out' | 'in', objectType: string, props: Record<string, unknown>): RawNeighbor {
  return { linkType, direction, neighbor: { id: String(Math.random()), objectType, properties: props } };
}

const ORDERS: RawNeighbor[] = [
  n('placed', 'in', 'Order', { total: 100, status: 'open' }),
  n('placed', 'in', 'Order', { total: 250, status: 'open' }),
  n('placed', 'in', 'Order', { total: 50, status: 'closed' }),
  n('livesAt', 'out', 'Address', { city: 'Reston' }), // different link/type — must be excluded
];

describe('computeRollup — count', () => {
  it('counts matching neighbours by link type', () => {
    const dp: OntoDerivedProperty = { apiName: 'orderCount', kind: 'rollup', aggregation: 'count', linkType: 'placed', direction: 'in' };
    expect(computeRollup(dp, ORDERS)).toBe(3);
  });
  it('counts across any link when linkType is unset', () => {
    const dp: OntoDerivedProperty = { apiName: 'linkCount', kind: 'rollup', aggregation: 'count', direction: 'any' };
    expect(computeRollup(dp, ORDERS)).toBe(4);
  });
  it('respects the target-type filter', () => {
    const dp: OntoDerivedProperty = { apiName: 'addr', kind: 'rollup', aggregation: 'count', targetType: 'Address', direction: 'any' };
    expect(computeRollup(dp, ORDERS)).toBe(1);
  });
});

describe('computeRollup — numeric aggregations', () => {
  const base = { kind: 'rollup', linkType: 'placed', direction: 'in', targetProperty: 'total' } as const;
  it('sums a linked property', () => {
    expect(computeRollup({ apiName: 'sum', aggregation: 'sum', ...base }, ORDERS)).toBe(400);
  });
  it('averages a linked property', () => {
    expect(computeRollup({ apiName: 'avg', aggregation: 'avg', ...base }, ORDERS)).toBeCloseTo(400 / 3);
  });
  it('takes the min and max', () => {
    expect(computeRollup({ apiName: 'min', aggregation: 'min', ...base }, ORDERS)).toBe(50);
    expect(computeRollup({ apiName: 'max', aggregation: 'max', ...base }, ORDERS)).toBe(250);
  });
  it('returns null (honest —) when no matching neighbour has a numeric value', () => {
    const dp: OntoDerivedProperty = { apiName: 's', kind: 'rollup', aggregation: 'sum', linkType: 'placed', direction: 'in', targetProperty: 'missingProp' };
    expect(computeRollup(dp, ORDERS)).toBeNull();
  });
  it('coerces numeric strings and ignores non-numeric values', () => {
    const rows: RawNeighbor[] = [
      n('has', 'out', 'Line', { qty: '3' }),
      n('has', 'out', 'Line', { qty: 'n/a' }),
      n('has', 'out', 'Line', { qty: 4 }),
    ];
    expect(computeRollup({ apiName: 'q', kind: 'rollup', aggregation: 'sum', linkType: 'has', direction: 'out', targetProperty: 'qty' }, rows)).toBe(7);
  });
  it('returns null for a function-kind property (route computes those)', () => {
    expect(computeRollup({ apiName: 'f', kind: 'function', functionName: 'score' }, ORDERS)).toBeNull();
  });
});

describe('computeRollups — split rollups vs function refs', () => {
  it('computes rollups and defers function-kind derived props to the route', () => {
    const defs: OntoDerivedProperty[] = [
      { apiName: 'orderCount', kind: 'rollup', aggregation: 'count', linkType: 'placed', direction: 'in' },
      { apiName: 'risk', kind: 'function', functionName: 'riskScore' },
    ];
    const { values, functionRefs } = computeRollups(defs, ORDERS);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ apiName: 'orderCount', kind: 'rollup', value: 3 });
    expect(functionRefs).toHaveLength(1);
    expect(functionRefs[0].apiName).toBe('risk');
  });
});

describe('normalizers', () => {
  it('drops a numeric rollup with no target property', () => {
    expect(normalizeDerivedProperty({ apiName: 'x', kind: 'rollup', aggregation: 'sum' })).toBeNull();
  });
  it('keeps a count rollup without a target property', () => {
    expect(normalizeDerivedProperty({ apiName: 'c', kind: 'rollup', aggregation: 'count' })).toMatchObject({ apiName: 'c', aggregation: 'count' });
  });
  it('drops a function derived prop with no function name', () => {
    expect(normalizeDerivedProperty({ apiName: 'f', kind: 'function' })).toBeNull();
  });
  it('dedupes by apiName and keys the map by object type', () => {
    const list = normalizeDerivedProperties([
      { apiName: 'a', kind: 'rollup', aggregation: 'count' },
      { apiName: 'a', kind: 'rollup', aggregation: 'count' },
    ]);
    expect(list).toHaveLength(1);
    const map = normalizeDerivedPropertyMap({ Customer: [{ apiName: 'a', kind: 'rollup', aggregation: 'count' }], '1bad': [{ apiName: 'x', kind: 'rollup', aggregation: 'count' }] });
    expect(Object.keys(map)).toEqual(['Customer']);
    expect(derivedPropertiesFor({ derivedProperties: map }, 'Customer')).toHaveLength(1);
  });
});

describe('describeDerived + validateDerivedProperty', () => {
  const props: OntoProperty[] = [{ apiName: 'name', baseType: 'string' }];
  const ctx = { ownProperties: props, linkTypeNames: new Set(['placed']), objectTypeNames: new Set(['Order']), functionNames: new Set(['riskScore']) };
  it('describes a rollup and a function', () => {
    expect(describeDerived({ apiName: 'c', kind: 'rollup', aggregation: 'sum', linkType: 'placed', targetProperty: 'total' })).toContain('sum');
    expect(describeDerived({ apiName: 'r', kind: 'function', functionName: 'riskScore' })).toContain('riskScore');
  });
  it('rejects a derived name colliding with a stored property', () => {
    const r = validateDerivedProperty({ apiName: 'name', kind: 'rollup', aggregation: 'count' }, ctx);
    expect(r.ok).toBe(false);
  });
  it('rejects an undeclared link type', () => {
    const r = validateDerivedProperty({ apiName: 'x', kind: 'rollup', aggregation: 'count', linkType: 'ghost' }, ctx);
    expect(r.ok).toBe(false);
  });
  it('rejects a function derived prop naming an unregistered function', () => {
    const r = validateDerivedProperty({ apiName: 'x', kind: 'function', functionName: 'nope' }, ctx);
    expect(r.ok).toBe(false);
  });
  it('accepts a valid rollup', () => {
    const r = validateDerivedProperty({ apiName: 'openTotal', kind: 'rollup', aggregation: 'sum', linkType: 'placed', targetType: 'Order', targetProperty: 'total' }, ctx);
    expect(r.ok).toBe(true);
  });
});
