/**
 * Unit tests for the per-resource Cost Management adapter (F5 capacity cost).
 *
 *   - subscriptionFromResourceId (pure): extracts the sub GUID from an ARM id
 *   - parseResourceCost (pure): sums the Cost column + reads Currency from a
 *     real-shaped Microsoft.CostManagement query response
 *
 * No network — the network call in getResourceMonthlyCost is exercised
 * separately at the route level; here we lock the pure parse/extraction logic.
 */
import { describe, it, expect } from 'vitest';
import { subscriptionFromResourceId, parseResourceCost } from '../cost-parse';

const SUB = '11111111-2222-3333-4444-555555555555';

describe('subscriptionFromResourceId', () => {
  it('extracts the subscription GUID from a full ARM resource id', () => {
    const id = `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.Kusto/clusters/adxloom`;
    expect(subscriptionFromResourceId(id)).toBe(SUB);
  });

  it('handles a bare subscription-scoped id', () => {
    expect(subscriptionFromResourceId(`/subscriptions/${SUB}`)).toBe(SUB);
  });

  it('returns null for a non-subscription id', () => {
    expect(subscriptionFromResourceId('/providers/Microsoft.Foo/bar')).toBeNull();
    expect(subscriptionFromResourceId('')).toBeNull();
  });
});

describe('parseResourceCost', () => {
  it('sums the Cost column and reads Currency (CostManagement column/row shape)', () => {
    const json = {
      properties: {
        columns: [
          { name: 'Cost', type: 'Number' },
          { name: 'Currency', type: 'String' },
        ],
        rows: [
          [12.34, 'USD'],
          [0.66, 'USD'],
        ],
      },
    };
    expect(parseResourceCost(json)).toEqual({ cost: 13, currency: 'USD' });
  });

  it('rounds to cents and defaults currency to USD when no Currency column', () => {
    const json = { properties: { columns: [{ name: 'Cost' }], rows: [[1.005]] } };
    const r = parseResourceCost(json);
    expect(r.currency).toBe('USD');
    expect(r.cost).toBeCloseTo(1.0, 2);
  });

  it('returns 0 for an empty result (resource has no separate billing line)', () => {
    expect(parseResourceCost({ properties: { columns: [{ name: 'Cost' }], rows: [] } })).toEqual({ cost: 0, currency: 'USD' });
    expect(parseResourceCost({})).toEqual({ cost: 0, currency: 'USD' });
  });
});
