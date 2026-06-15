/**
 * Deploy-planner cost-estimate maths — pure logic (no fetch, no render), so it
 * runs in the default node vitest env. Confirms the monthly normalization, the
 * representative-row selection, the per-domain/total aggregation, the honest
 * "not estimated" reasons, and the CSV/JSON + pricing-calculator deep-link
 * helpers behave per .claude/rules/no-vaporware.md (no fabricated numbers).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeToMonthly, pickMeterRow, priceResultFromRow, summarizePlan,
  HOURS_PER_MONTH, FALLBACK_MONTHLY_USD,
  type RetailPriceItem, type PriceResult,
} from '../cost-estimate';
import {
  pricingCalculatorUrl, breakdownToCsv, breakdownToJson, serviceDetailsUrl,
} from '../pricing-calculator-link';
import { metersForServices, serviceByKey } from '../service-catalog';
import {
  normalizeCurrency, isSupportedCurrency, normalizeRegion, regionLabel,
  RETAIL_CURRENCIES, COMMERCIAL_REGIONS, DEFAULT_CURRENCY,
} from '../cost-options';
import type { PlanSubscription } from '../types';

describe('normalizeToMonthly', () => {
  it('multiplies hourly meters by 730 hrs/mo', () => {
    expect(normalizeToMonthly(1, '1 Hour')).toBe(HOURS_PER_MONTH);
    expect(normalizeToMonthly(0.1, '1 Hour')).toBeCloseTo(73, 5);
  });
  it('divides by the leading unit count ("100 Hours")', () => {
    expect(normalizeToMonthly(100, '100 Hours')).toBe(HOURS_PER_MONTH); // $1/hr → 730/mo
  });
  it('passes monthly meters through unchanged', () => {
    expect(normalizeToMonthly(42, '1/Month')).toBe(42);
    expect(normalizeToMonthly(42, '1 Month')).toBe(42);
  });
  it('scales daily meters by 30', () => {
    expect(normalizeToMonthly(2, '1 Day')).toBe(60);
  });
  it('applies a quantity multiplier', () => {
    expect(normalizeToMonthly(1, '1 Hour', 2)).toBe(HOURS_PER_MONTH * 2);
    expect(normalizeToMonthly(10, '1 GB/Month', 5)).toBe(50);
  });
  it('is safe on garbage input', () => {
    expect(normalizeToMonthly(NaN as any, '1 Hour')).toBe(0);
    expect(normalizeToMonthly(-5, '1 Hour')).toBe(0);
  });
});

describe('pickMeterRow', () => {
  const items: RetailPriceItem[] = [
    { retailPrice: 0.10, unitOfMeasure: '1 Hour', skuName: 'B1', meterName: 'B1 App', type: 'Consumption' },
    { retailPrice: 0.05, unitOfMeasure: '1 Hour', skuName: 'B1', meterName: 'B1 App Windows', productName: 'App Service Windows', type: 'Consumption' },
    { retailPrice: 0.20, unitOfMeasure: '1 Hour', skuName: 'S1', meterName: 'S1 App', type: 'Consumption' },
    { retailPrice: 0.01, unitOfMeasure: '1 Hour', skuName: 'B1', meterName: 'B1 App Spot', type: 'Reservation' },
  ];
  it('honors match + exclude hints (case-insensitive) and picks lowest qualifying', () => {
    const row = pickMeterRow(items, { serviceName: 'Azure App Service', match: ['b1'], exclude: ['windows'], unitNote: 'x' });
    expect(row?.meterName).toBe('B1 App'); // 0.10 — the windows (0.05) and reservation rows excluded
  });
  it('excludes non-Consumption price types', () => {
    const row = pickMeterRow(items, { serviceName: 'x', match: ['spot'], unitNote: 'x' });
    expect(row).toBeNull(); // only the Spot row matches "spot" but it is a Reservation
  });
  it('returns null when nothing qualifies', () => {
    expect(pickMeterRow(items, { serviceName: 'x', match: ['nope'], unitNote: 'x' })).toBeNull();
    expect(pickMeterRow([], { serviceName: 'x', unitNote: 'x' })).toBeNull();
  });
  it('priceResultFromRow normalizes + records the source + assumption', () => {
    const pr = priceResultFromRow(items[0], { serviceName: 'Azure App Service', unitNote: 'Basic B1 · 730 hrs/mo' });
    expect(pr.monthly).toBeCloseTo(73, 5);
    expect(pr.source).toBe('retail-api');
    expect(pr.assumed).toContain('Basic B1');
    expect(pr.sku).toBe('B1');
  });
});

describe('summarizePlan', () => {
  const sub: PlanSubscription = {
    id: 'sub-1', name: 'Primary', boundary: 'Commercial',
    domains: [
      { domainId: 'fin', name: 'Finance', services: ['appService', 'fabricCapacity', 'vnet'] },
      { domainId: 'ops', name: 'Operations', services: ['appService', 'aiSearch'] },
    ],
  };
  const priceMap: Record<string, PriceResult> = {
    appService: { monthly: 13, unitPrice: 0.0178, unit: '1 Hour', qty: 1, sku: 'B1', assumed: 'B1', currency: 'USD', source: 'retail-api' },
    aiSearch: { monthly: 251, unitPrice: 0.344, unit: '1 Hour', qty: 1, sku: 'Standard S1', assumed: 'S1', currency: 'USD', source: 'retail-api' },
  };

  it('counts a service in every domain it is planned in (N deployments) and totals correctly', () => {
    const sum = summarizePlan(priceMap, {}, sub, { currency: 'USD', region: 'eastus2', boundary: 'Commercial', govDisclaimer: false });
    const fin = sum.byDomain.find((d) => d.domainId === 'fin')!;
    const ops = sum.byDomain.find((d) => d.domainId === 'ops')!;
    expect(fin.monthly).toBe(13);             // appService only (vnet + fabricCapacity unpriced)
    expect(ops.monthly).toBe(13 + 251);
    expect(sum.total).toBe(13 + 13 + 251);    // appService counted in BOTH domains
  });

  it('reports plan-only / core services as honest "not estimated" reasons (no fake number)', () => {
    const sum = summarizePlan(priceMap, {}, sub, { currency: 'USD', region: 'eastus2', boundary: 'Commercial', govDisclaimer: false });
    const keys = sum.unestimated.map((u) => u.key);
    expect(keys).toContain('fabricCapacity'); // plan-only
    expect(keys).toContain('vnet');           // core/abstract
    const fabric = sum.unestimated.find((u) => u.key === 'fabricCapacity')!;
    expect(fabric.reason.toLowerCase()).toContain('plan-only');
  });

  it('marks the summary source fallback / mixed appropriately', () => {
    const mixed: Record<string, PriceResult> = {
      ...priceMap,
      aiSearch: { ...priceMap.aiSearch, source: 'fallback-list-price' },
    };
    const sum = summarizePlan(mixed, {}, sub, { currency: 'USD', region: 'eastus2', boundary: 'Commercial', govDisclaimer: false });
    expect(sum.source).toBe('mixed');
  });

  it('carries the gov disclaimer flag through', () => {
    const sum = summarizePlan(priceMap, {}, sub, { currency: 'USD', region: 'usgovvirginia', priceRegion: 'eastus2', boundary: 'GCC-High', govDisclaimer: true });
    expect(sum.govDisclaimer).toBe(true);
    expect(sum.region).toBe('usgovvirginia');
    expect(sum.priceRegion).toBe('eastus2'); // Commercial reference region disclosed
  });

  it('defaults priceRegion to the reported region when none is supplied', () => {
    const sum = summarizePlan(priceMap, {}, sub, { currency: 'USD', region: 'westeurope', boundary: 'Commercial', govDisclaimer: false });
    expect(sum.priceRegion).toBe('westeurope');
  });
});

describe('cost-options (currency + region pickers)', () => {
  it('normalizeCurrency upper-cases + validates, else falls back to USD', () => {
    expect(normalizeCurrency('eur')).toBe('EUR');
    expect(normalizeCurrency('GBP')).toBe('GBP');
    expect(normalizeCurrency('xyz')).toBe(DEFAULT_CURRENCY);
    expect(normalizeCurrency('')).toBe('USD');
    expect(normalizeCurrency(null)).toBe('USD');
  });
  it('isSupportedCurrency is exact/case-sensitive against the API set', () => {
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('EUR')).toBe(true);
    expect(isSupportedCurrency('eur')).toBe(false);
    expect(isSupportedCurrency('ZZZ')).toBe(false);
    expect(isSupportedCurrency(undefined)).toBe(false);
  });
  it('normalizeRegion lower-cases + strips non-alnum (armRegionName safe)', () => {
    expect(normalizeRegion('East US 2')).toBe('eastus2');
    expect(normalizeRegion('west-europe')).toBe('westeurope');
    expect(normalizeRegion(null)).toBe('');
  });
  it('regionLabel maps known names + falls back to the raw name', () => {
    expect(regionLabel('eastus2')).toBe('East US 2');
    expect(regionLabel('madeupregion')).toBe('madeupregion');
  });
  it('catalog lists are non-empty and USD/eastus2 are present', () => {
    expect(RETAIL_CURRENCIES.some((c) => c.code === 'USD')).toBe(true);
    expect(COMMERCIAL_REGIONS.some((r) => r.name === 'eastus2')).toBe(true);
    expect(DEFAULT_CURRENCY).toBe('USD');
  });
});

describe('catalog retail meters', () => {
  it('plan-only services never carry a retail meter (no fake price for tenant-gated items)', () => {
    expect(serviceByKey('fabricCapacity')?.retail).toBeUndefined();
    const meters = metersForServices(['fabricCapacity', 'sqlMi', 'privateEndpoints']);
    expect(meters).toHaveLength(0);
  });
  it('returns one deduped meter per priced service key', () => {
    const meters = metersForServices(['appService', 'appService', 'aiSearch', 'vnet']);
    const keys = meters.map((m) => m.key).sort();
    expect(keys).toEqual(['aiSearch', 'appService']); // deduped; vnet has no meter
    for (const m of meters) {
      expect(m.meter.serviceName).toBeTruthy();
      expect(m.meter.unitNote).toBeTruthy();
    }
  });
  it('every fallback-list-price key maps to a real catalog service', () => {
    for (const key of Object.keys(FALLBACK_MONTHLY_USD)) {
      expect(serviceByKey(key)).toBeTruthy();
    }
  });
});

describe('pricing-calculator-link helpers', () => {
  const summary = {
    currency: 'USD', region: 'eastus2', boundary: 'Commercial', govDisclaimer: false,
    source: 'retail-api' as const,
    byDomain: [
      { domainId: 'fin', name: 'Finance', monthly: 264,
        rows: [
          { key: 'appService', label: 'App Service', category: 'compute', sku: 'B1', unit: '1 Hour', unitPrice: 0.0178, qty: 1, monthly: 13, assumed: 'B1 plan', source: 'retail-api' as const, pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/app-service/linux/' },
          { key: 'aiSearch', label: 'AI Search', category: 'ai', sku: 'Standard S1', unit: '1 Hour', unitPrice: 0.344, qty: 1, monthly: 251, assumed: 'S1', source: 'retail-api' as const },
        ] },
    ],
    total: 264,
    unestimated: [{ key: 'vnet', label: 'Virtual Network', reason: 'Core / always-deployed.' }],
  };

  it('pricingCalculatorUrl returns the calculator (gov-aware base)', () => {
    expect(pricingCalculatorUrl('Commercial')).toContain('azure.microsoft.com/pricing/calculator');
    expect(pricingCalculatorUrl('GCC-High')).toContain('azure.microsoft.com/pricing/calculator');
  });
  it('serviceDetailsUrl falls back to the generic pricing page', () => {
    expect(serviceDetailsUrl(summary.byDomain[0].rows[0])).toContain('/app-service/');
    expect(serviceDetailsUrl(summary.byDomain[0].rows[1])).toBe('https://azure.microsoft.com/pricing/');
  });
  it('breakdownToCsv includes a header, each row, the total + the unestimated lines', () => {
    const csv = breakdownToCsv(summary);
    expect(csv.split('\n')[0]).toContain('MonthlyEstimate');
    expect(csv).toContain('App Service');
    expect(csv).toContain('264.00'); // total line
    expect(csv).toContain('(not estimated)');
    expect(csv).toContain('Virtual Network');
  });
  it('breakdownToJson round-trips to the same summary', () => {
    expect(JSON.parse(breakdownToJson(summary))).toEqual(summary);
  });
});
