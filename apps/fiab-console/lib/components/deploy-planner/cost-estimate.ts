/**
 * Pure cost-estimate maths for the Deployment planner — NO fetch, NO React, so
 * it runs in the default node vitest env and is shared by the BFF route.
 *
 * The estimate is a BEST-EFFORT monthly figure computed from the public Azure
 * Retail Prices API (https://prices.azure.com/api/retail/prices) using one
 * representative meter per planned service (see `RetailMeter` in
 * service-catalog.ts). It is honest about being a single representative SKU at
 * list price — never an exact bill. Per .claude/rules/no-vaporware.md there are
 * no fabricated numbers: a service with no live meter (or a fetch failure) is
 * reported as "not estimated" or, for the big-ticket services, a clearly
 * labelled `fallback-list-price` figure derived from the same Azure list prices
 * the admin-scaling CostPreview uses.
 */
import { serviceByKey, type RetailMeter } from './service-catalog';
import type { PlanSubscription } from './types';

/** Hours per month convention used to monthly-normalize hourly meters. */
export const HOURS_PER_MONTH = 730;

/** A single row from the Azure Retail Prices API `Items` array (subset we use). */
export interface RetailPriceItem {
  retailPrice?: number;
  unitPrice?: number;
  unitOfMeasure?: string;
  armRegionName?: string;
  meterName?: string;
  skuName?: string;
  armSkuName?: string;
  productName?: string;
  serviceName?: string;
  /** 'Consumption' | 'Reservation' | 'DevTestConsumption' */
  type?: string;
  currencyCode?: string;
}

/** Result of pricing one service (what the route stores in its priceMap). */
export interface PriceResult {
  /** Normalized monthly cost in the billing currency. */
  monthly: number;
  /** Raw unit price as returned by the API. */
  unitPrice: number;
  /** Unit of measure the unit price is quoted in (e.g. "1 Hour"). */
  unit: string;
  /** Quantity multiplier applied (defaultMonthlyQty, ≥1). */
  qty: number;
  /** The actual meter/sku the figure came from (transparency). */
  sku: string;
  /** Honest note about the representative SKU/quantity assumed. */
  assumed: string;
  currency: string;
  source: 'retail-api' | 'fallback-list-price';
}

/**
 * Convert a retail price quoted per `unitOfMeasure` into a monthly figure.
 * - "1 Hour" / "100 Hours" → price per single hour × 730 × qty
 * - "1/Month" / "1 Month"  → price × qty (already monthly)
 * - "1 Day"                → price × 30 × qty
 * - anything else (per-GB, per-operation, per-request) → price × qty, and the
 *   caller discloses the assumed quantity in `assumed`.
 */
export function normalizeToMonthly(retailPrice: number, unitOfMeasure: string, qty = 1): number {
  const price = Number(retailPrice);
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1;
  if (!Number.isFinite(price) || price < 0) return 0;
  const uom = (unitOfMeasure || '').trim();
  // Leading count, e.g. "100 Hours" → 100. Defaults to 1 when absent.
  const m = /^([\d.]+)\s*(.*)$/.exec(uom);
  const count = m ? Number(m[1]) || 1 : 1;
  const unit = (m ? m[2] : uom).toLowerCase();
  const perUnit = price / count;
  if (/hour/.test(unit)) return perUnit * HOURS_PER_MONTH * q;
  if (/month/.test(unit)) return perUnit * q;
  if (/day/.test(unit)) return perUnit * 30 * q;
  // per-GB / per-operation / per-request etc. — treat as a monthly quantity.
  return perUnit * q;
}

const norm = (s: string | undefined) => (s || '').toLowerCase();

/**
 * From the API `Items` for a serviceName query, pick the single representative
 * row for a meter: Consumption price type, honoring the case-insensitive
 * match/exclude substring hints, then the lowest non-zero retail price.
 * Returns null when nothing qualifies (→ service reported as not estimated).
 */
export function pickMeterRow(items: RetailPriceItem[], meter: RetailMeter): RetailPriceItem | null {
  const match = (meter.match || []).map(norm);
  const exclude = (meter.exclude || []).map(norm);
  const candidates = items.filter((it) => {
    // Consumption only (exclude Reservation / DevTest / Spot pricing rows).
    const ty = norm(it.type);
    if (ty && ty !== 'consumption') return false;
    const hay = `${norm(it.skuName)} ${norm(it.meterName)} ${norm(it.productName)} ${norm(it.armSkuName)}`;
    if (meter.armSkuName && norm(it.skuName).indexOf(norm(meter.armSkuName)) === -1
      && hay.indexOf(norm(meter.armSkuName)) === -1) {
      // armSkuName pin: require it to appear somewhere in the row identity.
      return false;
    }
    if (match.length && !match.every((tok) => hay.indexOf(tok) !== -1)) return false;
    if (exclude.some((tok) => tok && hay.indexOf(tok) !== -1)) return false;
    const price = Number(it.retailPrice ?? it.unitPrice);
    return Number.isFinite(price) && price > 0;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(a.retailPrice ?? a.unitPrice) - Number(b.retailPrice ?? b.unitPrice));
  return candidates[0];
}

/** Build a PriceResult from a chosen API row + the meter definition. */
export function priceResultFromRow(row: RetailPriceItem, meter: RetailMeter): PriceResult {
  const unitPrice = Number(row.retailPrice ?? row.unitPrice) || 0;
  const unit = row.unitOfMeasure || '1 Hour';
  const qty = meter.defaultMonthlyQty && meter.defaultMonthlyQty > 0 ? meter.defaultMonthlyQty : 1;
  return {
    monthly: normalizeToMonthly(unitPrice, unit, qty),
    unitPrice,
    unit,
    qty,
    sku: row.skuName || row.meterName || row.productName || 'representative SKU',
    assumed: meter.unitNote,
    currency: row.currencyCode || 'USD',
    source: 'retail-api',
  };
}

/**
 * Offline fallback monthly list prices (USD, East US 2 on-demand) for the
 * big-ticket services — the SAME figures the admin-scaling CostPreview uses,
 * duplicated here so this server-safe module never imports a client component.
 * Used ONLY when the live Retail Prices API is unreachable; every such row is
 * labelled `fallback-list-price` in the report.
 */
export const FALLBACK_MONTHLY_USD: Record<string, { monthly: number; sku: string }> = {
  appService: { monthly: 13, sku: 'B1 Linux (list)' },
  vm: { monthly: 70, sku: 'Standard_D2s_v5 Linux (list)' },
  redis: { monthly: 16, sku: 'Basic C0 (list)' },
  postgres: { monthly: 12, sku: 'Flexible B1ms (list)' },
  mysql: { monthly: 12, sku: 'Flexible B1ms (list)' },
  sql: { monthly: 15, sku: 'Standard S0 (list)' },
  aiSearch: { monthly: 251, sku: 'Standard S1 (list)' },
  apim: { monthly: 49, sku: 'Developer (list)' },
  adx: { monthly: 79, sku: 'Dev/Test no-SLA (list)' },
  appGateway: { monthly: 124, sku: 'Standard_v2 fixed (list)' },
  firewall: { monthly: 912, sku: 'Standard deployment (list)' },
  vpnGateway: { monthly: 138, sku: 'VpnGw1 (list)' },
};

export interface CostRow {
  key: string;
  label: string;
  category: string;
  sku: string;
  unit: string;
  unitPrice: number;
  qty: number;
  monthly: number;
  assumed: string;
  source: 'retail-api' | 'fallback-list-price';
  pricingDetailsUrl?: string;
}

export interface CostDomainGroup {
  domainId: string;
  name: string;
  monthly: number;
  rows: CostRow[];
}

export interface CostSummary {
  currency: string;
  /** The region REPORTED to the user (what bicep would deploy into). */
  region: string;
  /**
   * The Commercial `armRegionName` actually QUERIED for prices. Equals `region`
   * for Commercial boundaries; for Gov boundaries it is the Commercial
   * reference region the figures came from (disclosed in the report). Optional
   * for backward-compat with callers that predate the region picker.
   */
  priceRegion?: string;
  boundary: string;
  /** True when the boundary is a Gov cloud → figures are Commercial reference only. */
  govDisclaimer: boolean;
  source: 'retail-api' | 'fallback-list-price' | 'mixed';
  byDomain: CostDomainGroup[];
  total: number;
  unestimated: Array<{ key: string; label: string; reason: string }>;
}

/** Why a planned service has no dollar figure (honest, never a fake number). */
function unestimatedReason(key: string): string {
  const def = serviceByKey(key);
  if (!def) return 'Unknown service key.';
  if (def.planOnly) return 'Plan-only / tenant-gated — sized & quoted via the capacity estimator, not auto-priced.';
  if (!def.bicepFlag) return 'Core / always-deployed — usage-metered (no representative flat SKU).';
  return 'Usage-metered — varies by throughput/consumption; not a flat monthly SKU.';
}

/**
 * Aggregate a per-service price map into a per-domain + grand-total breakdown
 * for one planner subscription. A service planned in N domains is counted in
 * each (it is N deployments). Pure — the route supplies the priceMap.
 */
export function summarizePlan(
  priceMap: Record<string, PriceResult>,
  detailUrls: Record<string, string | undefined>,
  sub: PlanSubscription,
  ctx: { currency: string; region: string; priceRegion?: string; boundary: string; govDisclaimer: boolean },
): CostSummary {
  const byDomain: CostDomainGroup[] = [];
  const unestimatedMap = new Map<string, { key: string; label: string; reason: string }>();
  let total = 0;
  let sawApi = false;
  let sawFallback = false;

  for (const dom of sub.domains) {
    const rows: CostRow[] = [];
    let domMonthly = 0;
    for (const key of dom.services) {
      const def = serviceByKey(key);
      const label = def?.label || key;
      const pr = priceMap[key];
      if (pr) {
        if (pr.source === 'retail-api') sawApi = true; else sawFallback = true;
        rows.push({
          key, label, category: def?.category || 'other',
          sku: pr.sku, unit: pr.unit, unitPrice: pr.unitPrice, qty: pr.qty,
          monthly: pr.monthly, assumed: pr.assumed, source: pr.source,
          pricingDetailsUrl: detailUrls[key] || def?.pricingDetailsUrl,
        });
        domMonthly += pr.monthly;
      } else if (!unestimatedMap.has(key)) {
        unestimatedMap.set(key, { key, label, reason: unestimatedReason(key) });
      }
    }
    rows.sort((a, b) => b.monthly - a.monthly);
    byDomain.push({ domainId: dom.domainId, name: dom.name || dom.domainId, monthly: domMonthly, rows });
    total += domMonthly;
  }

  const source: CostSummary['source'] = sawApi && sawFallback ? 'mixed' : sawFallback ? 'fallback-list-price' : 'retail-api';
  return {
    currency: ctx.currency,
    region: ctx.region,
    priceRegion: ctx.priceRegion || ctx.region,
    boundary: ctx.boundary,
    govDisclaimer: ctx.govDisclaimer,
    source,
    byDomain,
    total,
    unestimated: [...unestimatedMap.values()],
  };
}
