import { describe, it, expect } from 'vitest';
import {
  buildAttributionRecord,
  rollupAttribution,
  ATTRIBUTION_RATES,
  USD_PER_LCU,
  type CostAttributionRow,
} from '@/lib/azure/cost-attribution';

describe('BR-COSTATTR buildAttributionRecord — attribution tagging', () => {
  it('derives LCU + USD from the published coefficient for the engine', () => {
    const r = buildAttributionRecord({
      tenantId: 't1', userOid: 'u1', engine: 'adx', quantity: 4, id: 'fixed', occurredAt: '2026-07-08T14:30:00.000Z',
    });
    expect(r.lcu).toBe(4 * ATTRIBUTION_RATES.adx.lcuPerUnit); // 2
    expect(r.estCostUsd).toBeCloseTo(4 * ATTRIBUTION_RATES.adx.lcuPerUnit * USD_PER_LCU, 6);
    expect(r.unit).toBe('query');
    expect(r.engine).toBe('adx');
  });

  it('defaults quantity to 1 when absent or non-positive', () => {
    expect(buildAttributionRecord({ tenantId: 't', userOid: 'u', engine: 'spark' }).lcu)
      .toBe(ATTRIBUTION_RATES.spark.lcuPerUnit);
    expect(buildAttributionRecord({ tenantId: 't', userOid: 'u', engine: 'spark', quantity: -5 }).lcu)
      .toBe(ATTRIBUTION_RATES.spark.lcuPerUnit);
  });

  it('computes the hour bucket from occurredAt (YYYY-MM-DDTHH)', () => {
    const r = buildAttributionRecord({
      tenantId: 't', userOid: 'u', engine: 'databricks', occurredAt: '2026-07-08T14:59:59.000Z',
    });
    expect(r.hourBucket).toBe('2026-07-08T14');
  });

  it('carries who/where tags + a positive TTL', () => {
    const r = buildAttributionRecord({
      tenantId: 't', userOid: 'u', userName: 'Ada', engine: 'spark',
      workspaceId: 'ws1', itemId: 'nb1', itemType: 'notebook', domainId: 'finance', resourceId: 'pool1',
    });
    expect(r).toMatchObject({
      tenantId: 't', userOid: 'u', userName: 'Ada', workspaceId: 'ws1',
      itemId: 'nb1', itemType: 'notebook', domainId: 'finance', resourceId: 'pool1',
    });
    expect(r.ttl).toBeGreaterThan(0);
  });
});

describe('BR-COSTATTR rollupAttribution — per-user / per-engine / per-domain', () => {
  const rows: CostAttributionRow[] = [
    buildAttributionRecord({ tenantId: 't', userOid: 'ada', userName: 'Ada', engine: 'spark', workspaceId: 'w1', domainId: 'finance' }),
    buildAttributionRecord({ tenantId: 't', userOid: 'ada', userName: 'Ada', engine: 'adx', quantity: 10, workspaceId: 'w1', domainId: 'finance' }),
    buildAttributionRecord({ tenantId: 't', userOid: 'bob', userName: 'Bob', engine: 'databricks', workspaceId: 'w2', domainId: 'sales' }),
  ];

  it('rolls per-user LCU + executions, sorted descending', () => {
    const out = rollupAttribution(rows, 30);
    expect(out.totalExecutions).toBe(3);
    const ada = out.byUser.find((u) => u.key === 'ada')!;
    const bob = out.byUser.find((u) => u.key === 'bob')!;
    expect(ada.executions).toBe(2);
    expect(ada.lcu).toBe(ATTRIBUTION_RATES.spark.lcuPerUnit + 10 * ATTRIBUTION_RATES.adx.lcuPerUnit);
    expect(bob.executions).toBe(1);
    // Ada (30 + 5 = 35 LCU) outranks Bob (25 LCU) → sorted first.
    expect(out.byUser[0].key).toBe('ada');
    expect(ada.displayName).toBe('Ada');
  });

  it('rolls per-engine and per-domain buckets', () => {
    const out = rollupAttribution(rows, 30);
    expect(out.byEngine.map((e) => e.key).sort()).toEqual(['adx', 'databricks', 'spark']);
    const finance = out.byDomain.find((d) => d.key === 'finance')!;
    expect(finance.executions).toBe(2);
  });

  it('totals LCU + USD across every row', () => {
    const out = rollupAttribution(rows, 30);
    const expectedLcu = rows.reduce((a, r) => a + r.lcu, 0);
    expect(out.totalLcu).toBeCloseTo(expectedLcu, 6);
    expect(out.totalEstCostUsd).toBeCloseTo(expectedLcu * USD_PER_LCU, 4);
    expect(out.windowDays).toBe(30);
  });

  it('is empty for no rows (honest empty state)', () => {
    const out = rollupAttribution([], 7);
    expect(out.byUser).toEqual([]);
    expect(out.totalLcu).toBe(0);
    expect(out.totalExecutions).toBe(0);
  });
});
