import { describe, it, expect } from 'vitest';
import {
  foldDomainCostRows,
  normalizeDomainTagValue,
  type TagCostRow,
} from '@/lib/azure/domain-chargeback';

describe('FGC-28 normalizeDomainTagValue', () => {
  it('strips the loom-domain: prefix (both : and =) case-insensitively', () => {
    expect(normalizeDomainTagValue('loom-domain:finance')).toBe('finance');
    expect(normalizeDomainTagValue('LOOM-DOMAIN=sales')).toBe('sales');
    expect(normalizeDomainTagValue('loom-domain: hr ')).toBe('hr');
  });
  it('returns a bare id verbatim and empty for blank', () => {
    expect(normalizeDomainTagValue('marketing')).toBe('marketing');
    expect(normalizeDomainTagValue('')).toBe('');
    expect(normalizeDomainTagValue('   ')).toBe('');
  });
});

describe('FGC-28 foldDomainCostRows — rollup aggregation', () => {
  const names = { finance: 'Finance', sales: 'Sales' };

  it('folds both tag forms of the same domain into one row', () => {
    const raw: TagCostRow[] = [
      { tagValue: 'loom-domain:finance', cost: 100 },
      { tagValue: 'finance', cost: 50 }, // bare form, same domain
    ];
    const out = foldDomainCostRows(raw, names);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ domainId: 'finance', name: 'Finance', cost: 150 });
    expect(out.totalCost).toBe(150);
    expect(out.untaggedCost).toBe(0);
  });

  it('sums across subscriptions, sorts descending, and computes % of total', () => {
    const raw: TagCostRow[] = [
      { tagValue: 'loom-domain:finance', cost: 60 }, // sub A
      { tagValue: 'loom-domain:finance', cost: 40 }, // sub B
      { tagValue: 'loom-domain:sales', cost: 300 },
    ];
    const out = foldDomainCostRows(raw, names);
    expect(out.totalCost).toBe(400);
    expect(out.rows.map((r) => r.domainId)).toEqual(['sales', 'finance']); // sorted desc
    const sales = out.rows.find((r) => r.domainId === 'sales')!;
    const finance = out.rows.find((r) => r.domainId === 'finance')!;
    expect(sales.cost).toBe(300);
    expect(sales.pctOfTotal).toBe(75);
    expect(finance.cost).toBe(100);
    expect(finance.pctOfTotal).toBe(25);
  });

  it('routes blank/untagged values to the untagged bucket, not a domain row', () => {
    const raw: TagCostRow[] = [
      { tagValue: 'loom-domain:finance', cost: 100 },
      { tagValue: '', cost: 25 },
      { tagValue: '   ', cost: 5 },
    ];
    const out = foldDomainCostRows(raw, names);
    expect(out.rows).toHaveLength(1);
    expect(out.untaggedCost).toBe(30);
    expect(out.totalCost).toBe(130);
  });

  it('falls back to the domain id as the display name when unknown', () => {
    const out = foldDomainCostRows([{ tagValue: 'loom-domain:mystery', cost: 10 }], names);
    expect(out.rows[0].name).toBe('mystery');
  });

  it('is empty + zeroed for no rows (honest empty state)', () => {
    const out = foldDomainCostRows([], names);
    expect(out.rows).toEqual([]);
    expect(out.totalCost).toBe(0);
    expect(out.untaggedCost).toBe(0);
  });

  it('handles a zero total without dividing by zero', () => {
    const out = foldDomainCostRows([{ tagValue: 'loom-domain:finance', cost: 0 }], names);
    expect(out.rows[0].pctOfTotal).toBe(0);
  });
});
