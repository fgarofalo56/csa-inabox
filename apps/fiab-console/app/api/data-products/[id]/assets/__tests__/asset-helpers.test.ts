import { describe, it, expect } from 'vitest';
import {
  ENTITY_TYPE_CHIPS,
  ruleCoversAsset,
  dqRunningRuleName,
  type DataAssetRef,
  type DqRule,
} from '../asset-helpers';

const asset = (name: string): DataAssetRef => ({ guid: 'g-' + name, name });

describe('F9 data-assets helpers', () => {
  it('Table/View/File chips map to disjoint Atlas typeName buckets', () => {
    expect(ENTITY_TYPE_CHIPS.Table).toContain('azure_sql_table');
    expect(ENTITY_TYPE_CHIPS.View).toContain('azure_sql_view');
    expect(ENTITY_TYPE_CHIPS.File).toContain('adls_gen2_path');
    // a table type is not also classified as a view/file
    expect(ENTITY_TYPE_CHIPS.View).not.toContain('azure_sql_table');
    expect(ENTITY_TYPE_CHIPS.File).not.toContain('azure_sql_table');
  });

  it('ruleCoversAsset matches a table-scope rule by asset name', () => {
    expect(ruleCoversAsset({ id: 'r1', scope: 'table:sales' }, asset('sales'))).toBe(true);
    expect(ruleCoversAsset({ id: 'r2', scope: 'table:sales' }, asset('returns'))).toBe(false);
  });

  it('ruleCoversAsset matches a column-scope rule on the same table', () => {
    expect(ruleCoversAsset({ id: 'r3', scope: 'column:sales.amount' }, asset('sales'))).toBe(true);
    // column on a different table must not match
    expect(ruleCoversAsset({ id: 'r4', scope: 'column:orders.amount' }, asset('sales'))).toBe(false);
  });

  it('ruleCoversAsset ignores empty scope / empty name', () => {
    expect(ruleCoversAsset({ id: 'r5', scope: '' }, asset('sales'))).toBe(false);
    expect(ruleCoversAsset({ id: 'r6', scope: 'table:sales' }, { guid: 'g', name: '' })).toBe(false);
  });

  it('dqRunningRuleName returns the first ENABLED covering rule name, else null', () => {
    const rules: DqRule[] = [
      { id: 'disabled', name: 'Disabled', scope: 'table:sales', enabled: false },
      { id: 'live', name: 'Sales freshness', scope: 'table:sales', enabled: true },
    ];
    expect(dqRunningRuleName(rules, asset('sales'))).toBe('Sales freshness');
    expect(dqRunningRuleName(rules, asset('inventory'))).toBeNull();
    // a disabled-only rule does not block
    expect(dqRunningRuleName([{ id: 'd', scope: 'table:sales', enabled: false }], asset('sales'))).toBeNull();
  });
});
