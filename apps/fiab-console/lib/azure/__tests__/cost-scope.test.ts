/**
 * C1 — cost-scope pure folds + per-scope cache key builder.
 *
 * Covers the sub/RG scope fold (dedupe, bounding, malformed ids), the TagKey
 * query-response fold (robust value-column detection, untagged skip, cost-desc
 * order), and costKey stability/distinctness — all pure, no Azure.
 */
import { describe, it, expect } from 'vitest';
import { scopesFromInventory, tagValuesFromQueryResponse, MAX_COST_SCOPES } from '../cost-scope';
import { costKey } from '../cost-client';

const SUB_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUB_B = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('scopesFromInventory', () => {
  it('emits one subscription scope per distinct sub, then distinct RGs', () => {
    const out = scopesFromInventory(
      [SUB_A, SUB_B, SUB_A],
      [
        `/subscriptions/${SUB_A}/resourceGroups/rg-loom/providers/Microsoft.Kusto/clusters/adx1`,
        `/subscriptions/${SUB_A}/resourceGroups/RG-LOOM/providers/Microsoft.Storage/storageAccounts/sa1`,
        `/subscriptions/${SUB_B}/resourceGroups/rg-dlz/providers/Microsoft.Synapse/workspaces/syn1`,
      ],
    );
    expect(out.filter((s) => s.kind === 'subscription').map((s) => s.subscriptionId)).toEqual([SUB_A, SUB_B]);
    const rgs = out.filter((s) => s.kind === 'resourceGroup');
    // rg-loom / RG-LOOM dedupe case-insensitively (first-seen casing wins).
    expect(rgs.map((s) => s.resourceGroup)).toEqual(['rg-loom', 'rg-dlz']);
    expect(rgs[0].scope).toBe(`/subscriptions/${SUB_A}/resourceGroups/rg-loom`);
  });

  it('skips malformed / non-RG-scoped resource ids', () => {
    const out = scopesFromInventory([SUB_A], ['', 'not-an-arm-id', `/subscriptions/${SUB_A}/providers/Microsoft.Insights/x`]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('subscription');
  });

  it('is bounded at max', () => {
    const ids = Array.from({ length: 50 }, (_, i) =>
      `/subscriptions/${SUB_A}/resourceGroups/rg-${i}/providers/Microsoft.Storage/storageAccounts/s${i}`);
    const out = scopesFromInventory([SUB_A], ids, 10);
    expect(out).toHaveLength(10);
    expect(MAX_COST_SCOPES).toBeGreaterThan(0);
  });
});

describe('tagValuesFromQueryResponse', () => {
  const resp = (cols: string[], rows: any[][]) => ({ properties: { columns: cols.map((name) => ({ name })), rows } });

  it('folds distinct tag values summed by cost, descending', () => {
    const out = tagValuesFromQueryResponse(resp(
      ['Cost', 'Environment', 'Currency'],
      [[10, 'prod', 'USD'], [5, 'dev', 'USD'], [7, 'prod', 'USD']],
    ));
    expect(out).toEqual([{ value: 'prod', cost: 17 }, { value: 'dev', cost: 5 }]);
  });

  it('detects the value column regardless of its name (TagValue vs the tag key)', () => {
    const out = tagValuesFromQueryResponse(resp(['Cost', 'TagValue'], [[3, 'team-a']]));
    expect(out).toEqual([{ value: 'team-a', cost: 3 }]);
  });

  it('skips untagged rows and handles empty/missing responses', () => {
    expect(tagValuesFromQueryResponse(resp(['Cost', 'Environment'], [[9, ''], [4, null]]))).toEqual([]);
    expect(tagValuesFromQueryResponse(null)).toEqual([]);
    expect(tagValuesFromQueryResponse({})).toEqual([]);
  });
});

describe('costKey', () => {
  it('is stable for identical inputs and distinct per scope/timeframe/groupBy', () => {
    const a1 = costKey('/subscriptions/x', 'MonthToDate', 'summary');
    const a2 = costKey('/subscriptions/x', 'MonthToDate', 'summary');
    expect(a1).toBe(a2);
    expect(costKey('/subscriptions/y', 'MonthToDate', 'summary')).not.toBe(a1);
    expect(costKey('/subscriptions/x', 'Last7Days', 'summary')).not.toBe(a1);
    expect(costKey('/subscriptions/x', 'MonthToDate', 'resource')).not.toBe(a1);
    // groupBy defaults to 'summary'.
    expect(costKey('/subscriptions/x', 'MonthToDate')).toBe(a1);
  });
});
