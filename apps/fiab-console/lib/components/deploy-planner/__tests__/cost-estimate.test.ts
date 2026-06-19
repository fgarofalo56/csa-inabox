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
import { metersForServices, serviceByKey, meterSkuFromConfig, configFor, type RetailMeter } from '../service-catalog';
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

describe('meterSkuFromConfig — P1: config-aware meter derivation', () => {
  it('appService: changing planSku changes the match substring', () => {
    const staticMeter = serviceByKey('appService')!.retail!;
    const defaultMeter = meterSkuFromConfig('appService', { planSku: 'B1' }, staticMeter);
    const premiumMeter = meterSkuFromConfig('appService', { planSku: 'P1v3' }, staticMeter);
    // Both should have match arrays
    expect(defaultMeter.match).toBeDefined();
    expect(premiumMeter.match).toBeDefined();
    // They must differ — different SKU = different match
    expect(defaultMeter.match).not.toEqual(premiumMeter.match);
    // B1 match should contain 'b1'
    expect(defaultMeter.match!.some((m) => m.toLowerCase().includes('b1'))).toBe(true);
    // P1v3 match should contain 'p1'
    expect(premiumMeter.match!.some((m) => m.toLowerCase().includes('p1'))).toBe(true);
    // Both exclude Windows
    expect(defaultMeter.exclude).toContain('Windows');
    expect(premiumMeter.exclude).toContain('Windows');
  });

  it('vm: changing vmSize changes the armSkuName pin', () => {
    const staticMeter = serviceByKey('vm')!.retail!;
    const b2sMeter = meterSkuFromConfig('vm', { vmSize: 'Standard_B2s' }, staticMeter);
    const d4Meter = meterSkuFromConfig('vm', { vmSize: 'Standard_D4s_v5' }, staticMeter);
    expect(b2sMeter.armSkuName).toBe('Standard_B2s');
    expect(d4Meter.armSkuName).toBe('Standard_D4s_v5');
    // They differ
    expect(b2sMeter.armSkuName).not.toBe(d4Meter.armSkuName);
    // Note in the unitNote should mention the VM size
    expect(b2sMeter.unitNote).toContain('Standard_B2s');
    expect(d4Meter.unitNote).toContain('Standard_D4s_v5');
  });

  it('redis: Basic/Standard/Premium produce distinct match+exclude sets', () => {
    const staticMeter = serviceByKey('redis')!.retail!;
    const basicMeter = meterSkuFromConfig('redis', { skuName: 'Basic' }, staticMeter);
    const stdMeter = meterSkuFromConfig('redis', { skuName: 'Standard' }, staticMeter);
    const premMeter = meterSkuFromConfig('redis', { skuName: 'Premium' }, staticMeter);
    // Each tier should have at least one match token
    expect(basicMeter.match!.length).toBeGreaterThan(0);
    expect(stdMeter.match!.length).toBeGreaterThan(0);
    expect(premMeter.match!.length).toBeGreaterThan(0);
    // Tiers differ from each other
    expect(basicMeter.match).not.toEqual(stdMeter.match);
    expect(stdMeter.match).not.toEqual(premMeter.match);
    // Premium should not be excluded when pricing Premium
    expect(premMeter.exclude).not.toContain('Premium');
    // Standard should not be excluded when pricing Standard
    expect(stdMeter.exclude).not.toContain('Standard');
    // Basic should not be excluded when pricing Basic
    expect(basicMeter.exclude).not.toContain('Basic');
  });

  it('streamAnalytics: configured SU count flows into defaultMonthlyQty', () => {
    const staticMeter = serviceByKey('streamAnalytics')!.retail!;
    const meter3 = meterSkuFromConfig('streamAnalytics', { streamingUnits: 3 }, staticMeter);
    const meter12 = meterSkuFromConfig('streamAnalytics', { streamingUnits: 12 }, staticMeter);
    expect(meter3.defaultMonthlyQty).toBe(3);
    expect(meter12.defaultMonthlyQty).toBe(12);
    // Different quantity → different monthly cost when same unit price
    const fakeItem: RetailPriceItem = { retailPrice: 1, unitOfMeasure: '1 Hour', skuName: 'Standard SU', type: 'Consumption' };
    const pr3 = priceResultFromRow(fakeItem, meter3);
    const pr12 = priceResultFromRow(fakeItem, meter12);
    expect(pr12.monthly).toBe(pr3.monthly * 4); // 12 SU vs 3 SU
  });

  it('aiSearch: tier and replica/partition counts affect match + qty', () => {
    const staticMeter = serviceByKey('aiSearch')!.retail!;
    const s1Meter = meterSkuFromConfig('aiSearch', { tier: 'standard', replicaCount: 1, partitionCount: 1 }, staticMeter);
    const s3Meter = meterSkuFromConfig('aiSearch', { tier: 'standard3', replicaCount: 2, partitionCount: 3 }, staticMeter);
    const basicMeter = meterSkuFromConfig('aiSearch', { tier: 'basic', replicaCount: 1, partitionCount: 1 }, staticMeter);
    // Different tiers → different match
    expect(s1Meter.match).not.toEqual(s3Meter.match);
    expect(basicMeter.match).not.toEqual(s1Meter.match);
    // S3 with 2r×3p = 6 units
    expect(s3Meter.defaultMonthlyQty).toBe(6);
    // S1 1r×1p = 1 unit
    expect(s1Meter.defaultMonthlyQty).toBe(1);
    // Unit note mentions the tier label
    expect(s1Meter.unitNote).toContain('S1');
    expect(s3Meter.unitNote).toContain('S3');
    expect(basicMeter.unitNote).toContain('B');
  });

  it('apim: different SKU tiers produce different match arrays', () => {
    const staticMeter = serviceByKey('apim')!.retail!;
    const devMeter = meterSkuFromConfig('apim', { skuName: 'Developer' }, staticMeter);
    const stdMeter = meterSkuFromConfig('apim', { skuName: 'Standard' }, staticMeter);
    const premMeter = meterSkuFromConfig('apim', { skuName: 'Premium' }, staticMeter);
    // Tiers differ
    expect(devMeter.match).not.toEqual(stdMeter.match);
    expect(stdMeter.match).not.toEqual(premMeter.match);
    // Developer meter should match 'Developer'
    expect(devMeter.match!.some((m) => m.toLowerCase().includes('developer'))).toBe(true);
    // Standard meter should match 'Standard'
    expect(stdMeter.match!.some((m) => m.toLowerCase().includes('standard'))).toBe(true);
    // Premium meter should not exclude Premium
    expect(premMeter.exclude).not.toContain('Premium');
  });

  it('vpnGateway: SKU choice changes the match + exclude set', () => {
    const staticMeter = serviceByKey('vpnGateway')!.retail!;
    const gw1 = meterSkuFromConfig('vpnGateway', { skuName: 'VpnGw1' }, staticMeter);
    const gw2 = meterSkuFromConfig('vpnGateway', { skuName: 'VpnGw2' }, staticMeter);
    expect(gw1.match!.some((m) => m.includes('VpnGw1'))).toBe(true);
    expect(gw2.match!.some((m) => m.includes('VpnGw2'))).toBe(true);
    // VpnGw1 meter should exclude VpnGw2 to prevent picking the wrong row
    expect(gw1.exclude!.some((e) => e.includes('VpnGw2'))).toBe(true);
    // VpnGw2 meter should exclude VpnGw1
    expect(gw2.exclude!.some((e) => e.includes('VpnGw1'))).toBe(true);
  });

  it('appGateway: WAF_v2 vs Standard_v2 produces different match arrays', () => {
    const staticMeter = serviceByKey('appGateway')!.retail!;
    const stdMeter = meterSkuFromConfig('appGateway', { tier: 'Standard_v2', capacity: 2 }, staticMeter);
    const wafMeter = meterSkuFromConfig('appGateway', { tier: 'WAF_v2', capacity: 2 }, staticMeter);
    expect(stdMeter.match).not.toEqual(wafMeter.match);
    // WAF meter should have 'WAF' in match
    expect(wafMeter.match!.some((m) => m.toLowerCase().includes('waf'))).toBe(true);
  });

  it('returns the static meter unchanged for unknown service keys', () => {
    const meter: RetailMeter = { serviceName: 'Unknown', unitNote: 'test' };
    expect(meterSkuFromConfig('unknownService', { foo: 'bar' }, meter)).toBe(meter);
  });

  it('returns the static meter unchanged when config is undefined', () => {
    const staticMeter = serviceByKey('redis')!.retail!;
    expect(meterSkuFromConfig('redis', undefined, staticMeter)).toBe(staticMeter);
  });
});

describe('P2 — new config schemas (aiSearch, apim, aks, vpnGateway, appGateway)', () => {
  it('aiSearch has a config schema with tier, replicaCount, partitionCount', () => {
    const fields = configFor('aiSearch');
    expect(fields.length).toBeGreaterThanOrEqual(3);
    const tierField = fields.find((f) => f.key === 'tier');
    expect(tierField).toBeDefined();
    expect(tierField!.allowed).toContain('free');
    expect(tierField!.allowed).toContain('standard');
    expect(tierField!.allowed).toContain('standard3');
    expect(tierField!.bicepParam).toBe('aiSearchTier');
    const replicaField = fields.find((f) => f.key === 'replicaCount');
    expect(replicaField).toBeDefined();
    expect(replicaField!.type).toBe('number');
    expect(replicaField!.bicepParam).toBe('aiSearchReplicaCount');
    const partField = fields.find((f) => f.key === 'partitionCount');
    expect(partField).toBeDefined();
    expect(partField!.bicepParam).toBe('aiSearchPartitionCount');
  });

  it('apim has a config schema with skuName selector', () => {
    const fields = configFor('apim');
    expect(fields.length).toBeGreaterThanOrEqual(1);
    const skuField = fields.find((f) => f.key === 'skuName');
    expect(skuField).toBeDefined();
    expect(skuField!.allowed).toContain('Developer');
    expect(skuField!.allowed).toContain('Standard');
    expect(skuField!.allowed).toContain('Premium');
    expect(skuField!.allowed).toContain('Consumption');
    expect(skuField!.bicepParam).toBe('apimSkuName');
  });

  it('aks has a config schema with nodeVmSize, nodeCount, tier', () => {
    const fields = configFor('aks');
    expect(fields.length).toBeGreaterThanOrEqual(3);
    const vmField = fields.find((f) => f.key === 'nodeVmSize');
    expect(vmField).toBeDefined();
    expect(vmField!.bicepParam).toBe('aksNodeVmSize');
    const countField = fields.find((f) => f.key === 'nodeCount');
    expect(countField).toBeDefined();
    expect(countField!.type).toBe('number');
    expect(countField!.bicepParam).toBe('aksNodeCount');
    const tierField = fields.find((f) => f.key === 'tier');
    expect(tierField).toBeDefined();
    expect(tierField!.allowed).toContain('Free');
    expect(tierField!.allowed).toContain('Standard');
    expect(tierField!.allowed).toContain('Premium');
    expect(tierField!.bicepParam).toBe('aksTier');
  });

  it('vpnGateway has a config schema with skuName', () => {
    const fields = configFor('vpnGateway');
    expect(fields.length).toBeGreaterThanOrEqual(1);
    const skuField = fields.find((f) => f.key === 'skuName');
    expect(skuField).toBeDefined();
    expect(skuField!.allowed).toContain('VpnGw1');
    expect(skuField!.allowed).toContain('VpnGw2AZ');
    expect(skuField!.bicepParam).toBe('vpnGatewaySkuName');
  });

  it('appGateway has a config schema with tier and capacity', () => {
    const fields = configFor('appGateway');
    expect(fields.length).toBeGreaterThanOrEqual(2);
    const tierField = fields.find((f) => f.key === 'tier');
    expect(tierField).toBeDefined();
    expect(tierField!.allowed).toContain('Standard_v2');
    expect(tierField!.allowed).toContain('WAF_v2');
    expect(tierField!.bicepParam).toBe('appGatewayTier');
    const capField = fields.find((f) => f.key === 'capacity');
    expect(capField).toBeDefined();
    expect(capField!.type).toBe('number');
    expect(capField!.bicepParam).toBe('appGatewayCapacity');
  });

  it('all new P2 config services remain toggleable (not core/plan-only)', () => {
    for (const key of ['aiSearch', 'apim', 'aks', 'vpnGateway', 'appGateway']) {
      const def = serviceByKey(key)!;
      expect(def.bicepFlag, `${key} must be toggleable`).toBeTruthy();
      expect(def.planOnly).toBeFalsy();
    }
  });
});
