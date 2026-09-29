/**
 * The TAG VALUE column of a Cost Management `TagKey` grouping, pinned to the
 * response shapes measured live against api-version 2023-03-01:
 *
 *   RG × TagKey grouping : Cost, ResourceGroupName, TagKey, TagValue, Currency
 *   TagKey-only grouping : Cost, TagKey, TagValue, Currency
 *
 * `TagKey` carries the key's own name on EVERY row. The defect these tests
 * condemn read that column as the value, so every row folded into one bucket
 * named after the key (cost-client: a single "environment" bucket; domain
 * chargeback: all spend attributed to a phantom domain "loom-domain"; tag
 * scopes: one scope "environment = environment").
 *
 * What breaks each test is stated at its site.
 */
import { describe, it, expect } from 'vitest';
import { tagValueColumnIndex } from '../cost-tag-column';
import { foldByTag } from '../cost-client';
import { tagValuesFromQueryResponse } from '../cost-scope';
import { tagCostRowsFromResponse, foldDomainCostRows } from '../domain-chargeback';

const cols = (...names: string[]) => names.map((name) => ({ name, type: 'String' }));

/** Measured shape, RG × TagKey (cost-client's grouping). */
const RG_TAG = {
  properties: {
    columns: cols('Cost', 'ResourceGroupName', 'TagKey', 'TagValue', 'Currency'),
    rows: [
      [10, 'rg-a', 'environment', 'commercial', 'USD'],
      [4, 'rg-a', 'environment', null, 'USD'],
      [3, 'rg-b', 'environment', 'dev', 'USD'],
      [99, 'rg-not-loom', 'environment', 'commercial', 'USD'],
    ],
  },
};

/** Measured shape, TagKey only (cost-scope + domain-chargeback grouping). */
const TAG_ONLY = (key: string, rows: [number, string | null][]) => ({
  properties: {
    columns: cols('Cost', 'TagKey', 'TagValue', 'Currency'),
    rows: rows.map(([cost, value]) => [cost, key, value, 'USD']),
  },
});

describe('tagValueColumnIndex', () => {
  it('picks TagValue, not TagKey, on both measured shapes', () => {
    // Breaks if the resolver returns the first non-Cost/RG/Currency column (2 / 1).
    expect(tagValueColumnIndex(RG_TAG.properties.columns, 'Environment')).toBe(3);
    expect(tagValueColumnIndex(cols('Cost', 'TagKey', 'TagValue', 'Currency'), 'loom-domain')).toBe(2);
  });

  it('falls back only to a column named after the key, never to TagKey', () => {
    // A column named after the key resolves; breaks if the key fallback is removed.
    expect(tagValueColumnIndex(cols('Cost', 'Environment', 'Currency'), 'Environment')).toBe(1);
    // No TagValue and no key-named column → -1. Breaks if any positional or
    // TagKey fallback returns 1 here.
    expect(tagValueColumnIndex(cols('Cost', 'TagKey', 'Currency'), 'Environment')).toBe(-1);
    // A key literally named "TagKey" must not select the TagKey column.
    expect(tagValueColumnIndex(cols('Cost', 'TagKey', 'Currency'), 'TagKey')).toBe(-1);
  });
});

describe('foldByTag (cost-client)', () => {
  it('buckets by tag VALUE, folds null into (untagged), and filters to Loom RGs', () => {
    const out = foldByTag(RG_TAG, 'Environment', new Set(['rg-a', 'rg-b']));
    // Breaks on the defect: the fold would return [{ key: 'environment', cost: 17 }].
    expect(out).toEqual([
      { key: 'commercial', cost: 10 },
      { key: '(untagged)', cost: 4 },
      { key: 'dev', cost: 3 },
    ]);
    expect(out.map((r) => r.key)).not.toContain('environment');
  });
});

describe('tagValuesFromQueryResponse (cost-scope)', () => {
  it('lists the tag values as scopes and skips untagged spend', () => {
    const out = tagValuesFromQueryResponse(
      TAG_ONLY('environment', [[10, 'commercial'], [4, null], [2, 'commercial'], [1, 'dev']]),
      'Environment',
    );
    // Breaks on the defect: one scope { value: 'environment', cost: 17 }.
    expect(out).toEqual([{ value: 'commercial', cost: 12 }, { value: 'dev', cost: 1 }]);
  });
});

describe('tagCostRowsFromResponse + foldDomainCostRows (domain chargeback)', () => {
  it('attributes untagged spend to untaggedCost, not to a domain named after the key', () => {
    const raw = tagCostRowsFromResponse(TAG_ONLY('loom-domain', [[994, null]]));
    const model = foldDomainCostRows(raw, {});
    // Breaks on the defect: rows = [{ domainId: 'loom-domain', cost: 994, … }], untaggedCost = 0.
    expect(model.rows).toEqual([]);
    expect(model.untaggedCost).toBe(994);
    expect(model.totalCost).toBe(994);
  });

  it('still attributes a real domain value', () => {
    const raw = tagCostRowsFromResponse(TAG_ONLY('loom-domain', [[5, 'finance'], [2, 'loom-domain:finance'], [1, null]]));
    const model = foldDomainCostRows(raw, { finance: 'Finance' });
    // Positive pair for the absence assertions above; breaks if values are dropped.
    expect(model.rows).toEqual([{ domainId: 'finance', name: 'Finance', cost: 7, pctOfTotal: 87.5 }]);
    expect(model.untaggedCost).toBe(1);
  });
});
