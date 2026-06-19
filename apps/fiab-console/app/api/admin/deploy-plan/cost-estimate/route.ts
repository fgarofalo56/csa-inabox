/**
 * Deploy-plan cost-estimate API — best-effort monthly cost for a planned
 * subscription, computed from the PUBLIC Azure Retail Prices API
 * (https://prices.azure.com/api/retail/prices — no auth, Commercial cloud).
 *
 * POST /api/admin/deploy-plan/cost-estimate
 *   body: { subscription: PlanSubscription, currencyCode?: string, region?: string }
 *   → { ok:true, summary: CostSummary }  (per-domain rows + grand total + the
 *      services that could not be priced, with an honest reason each)
 *
 * `currencyCode` / `region` are optional overrides from the report's pickers,
 * validated against the shared cost-options catalog (only API-supported values
 * reach the public endpoint). When omitted they derive from the plan boundary.
 *
 * Honesty (per .claude/rules/no-vaporware.md):
 *   - Real public REST call; one representative meter per service from the
 *     service-catalog `retail` map; figures are list price for a single
 *     representative SKU, NOT an exact bill (each row carries its assumption).
 *   - The Retail Prices API only returns COMMERCIAL prices. For GCC-High / IL5
 *     boundaries the estimate is directional: we query a Commercial reference
 *     region and set `govDisclaimer` so the UI says "Gov pricing differs".
 *   - If the public API is unreachable we fall back to the same Azure list
 *     prices the admin-scaling CostPreview uses, clearly labelled
 *     `fallback-list-price` — never a fabricated number.
 *
 * No new Azure resource / role / Cosmos container is introduced (the route
 * only calls an unauthenticated public endpoint), so the bicep-sync requirement
 * is satisfied trivially. The prices host is overridable for sovereign / air-
 * gapped mirrors via LOOM_RETAIL_PRICES_BASE.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { metersForServices, meterSkuFromConfig, configFor, coerceConfigValue } from '@/lib/components/deploy-planner/service-catalog';
import { BOUNDARY_DEFAULT_REGION } from '@/lib/components/deploy-planner/bicepparam';
import { normalizeCurrency, normalizeRegion, DEFAULT_CURRENCY } from '@/lib/components/deploy-planner/cost-options';
import {
  pickMeterRow, priceResultFromRow, summarizePlan,
  FALLBACK_MONTHLY_USD,
  type RetailPriceItem, type PriceResult,
} from '@/lib/components/deploy-planner/cost-estimate';
import type { PlanSubscription, ServiceConfig } from '@/lib/components/deploy-planner/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRICES_BASE = (process.env.LOOM_RETAIL_PRICES_BASE || 'https://prices.azure.com').replace(/\/+$/, '');
const API_VERSION = '2023-01-01-preview';
const MAX_PAGES = 4; // 100 rows/page — keeps tight serviceName queries bounded.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Escape a single-quote for an OData string literal. */
const odata = (v: string) => v.replace(/'/g, "''");

/**
 * Fetch the (paged) retail-price items for one meter's serviceName, scoped to
 * the region + Consumption price type, in the requested currency. Throws on
 * network/HTTP failure so the caller can decide between "this service unpriced"
 * and "API down → fallback".
 */
async function fetchMeterItems(serviceName: string, region: string, currencyCode: string, armSkuName?: string): Promise<RetailPriceItem[]> {
  const filterParts = [
    `armRegionName eq '${odata(region)}'`,
    `priceType eq 'Consumption'`,
    `serviceName eq '${odata(serviceName)}'`,
  ];
  if (armSkuName) filterParts.push(`armSkuName eq '${odata(armSkuName)}'`);
  // currencyCode is a top-level query param (NOT part of $filter), quoted per
  // the Retail Prices API contract: ...?currencyCode='EUR'&$filter=...
  const currencyParam = currencyCode && currencyCode !== DEFAULT_CURRENCY
    ? `&currencyCode='${odata(currencyCode)}'` : '';
  let url: string | null =
    `${PRICES_BASE}/api/retail/prices?api-version=${API_VERSION}${currencyParam}&$filter=${encodeURIComponent(filterParts.join(' and '))}`;
  const items: RetailPriceItem[] = [];
  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    let res: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Math.min((Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0) || 800 * attempt, 5000));
        continue;
      }
      break;
    }
    if (!res || !res.ok) throw new Error(`retail-prices ${res?.status ?? 'no-response'} for ${serviceName}`);
    const json: any = await res.json();
    if (Array.isArray(json?.Items)) items.push(...json.Items);
    url = typeof json?.NextPageLink === 'string' && json.NextPageLink ? json.NextPageLink : null;
  }
  return items;
}

/**
 * Validate + coerce one service's stored config for the cost-estimate route —
 * mirrors the sanitizeServiceConfigs function in the PUT route so the same
 * validation gate (coerceConfigValue) protects both paths. Drops unknown keys
 * and values the bicep module would reject, so only valid SKU choices reach
 * the meterSkuFromConfig override and the pricing query.
 */
function sanitizeCostServiceConfigs(raw: unknown): Record<string, ServiceConfig> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, ServiceConfig> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const fields = configFor(key);
    if (!fields.length || !val || typeof val !== 'object') continue;
    const cfg: ServiceConfig = {};
    for (const field of fields) {
      const coerced = coerceConfigValue(field, (val as Record<string, unknown>)[field.key]);
      if (coerced !== undefined) cfg[field.key] = coerced;
    }
    if (Object.keys(cfg).length) out[key] = cfg;
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeSubscription(raw: any): PlanSubscription {
  return {
    id: String(raw?.id || 'sub-1').slice(0, 80),
    name: String(raw?.name || 'Subscription').slice(0, 120),
    boundary: ['Commercial', 'GCC-High', 'GCC', 'IL5'].includes(raw?.boundary) ? raw.boundary : 'Commercial',
    region: raw?.region ? String(raw.region).slice(0, 40) : undefined,
    domains: Array.isArray(raw?.domains) ? raw.domains.slice(0, 100).map((d: any) => ({
      domainId: String(d?.domainId || '').slice(0, 80),
      name: String(d?.name || d?.domainId || '').slice(0, 120),
      services: Array.isArray(d?.services) ? d.services.map((x: any) => String(x)).slice(0, 64) : [],
    })) : [],
    // Pass serviceConfigs through (validated) so per-SKU meter overrides apply
    // to the cost estimate — previously this was silently dropped here, causing
    // all cost estimates to use the static representative-SKU meter regardless
    // of what the operator had configured (e.g. Redis Premium priced as Basic C0).
    serviceConfigs: sanitizeCostServiceConfigs(raw?.serviceConfigs),
  };
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sub = sanitizeSubscription(body?.subscription);
  const boundary = sub.boundary || 'Commercial';
  const govDisclaimer = boundary === 'GCC-High' || boundary === 'IL5';

  // Optional user overrides from the cost-report pickers (validated against the
  // shared catalog so only API-supported values reach the public endpoint).
  const reqCurrency = normalizeCurrency(body?.currencyCode);
  const overrideRegion = normalizeRegion(body?.region);

  // The region REPORTED to the user (what bicep would deploy into). For a Gov
  // boundary this stays the Gov deploy region; for Commercial the picker, then
  // the plan's own region, then the boundary default win in that order.
  const reportRegion = govDisclaimer
    ? (sub.region || BOUNDARY_DEFAULT_REGION[boundary] || 'usgovvirginia')
    : (overrideRegion || sub.region || BOUNDARY_DEFAULT_REGION[boundary] || 'eastus2');
  // The Retail Prices API only knows Commercial regions, so Gov boundaries are
  // priced against a Commercial REFERENCE region (the picker lets the user
  // choose which one; default eastus2). Disclosed via govDisclaimer + priceRegion.
  const queryRegion = govDisclaimer ? (overrideRegion || 'eastus2') : reportRegion;

  // Distinct planned services across all domains that carry a representative meter.
  const allKeys = new Set<string>();
  for (const d of sub.domains) for (const k of d.services) allKeys.add(k);
  const meters = metersForServices([...allKeys]);

  const priceMap: Record<string, PriceResult> = {};
  const detailUrls: Record<string, string | undefined> = {};
  // Default the report currency to what the user asked for; live retail-api rows
  // echo the API's currencyCode (same value), and fallback rows are honestly
  // labelled USD list price below.
  let currency = reqCurrency;

  // Per-service configs (validated above) — used to derive the config-aware
  // meter for services whose configured SKU selects a different retail-price row
  // than the static representative-SKU default (e.g. Redis Premium ≠ Basic C0,
  // App Service P1v3 ≠ B1, AI Search S3 ≠ S1, APIM Standard ≠ Developer).
  const svcConfigs = sub.serviceConfigs ?? {};

  await Promise.all(meters.map(async (m) => {
    detailUrls[m.key] = m.pricingDetailsUrl;
    // Derive the effective meter for this service: if the operator configured a
    // SKU that maps to a different price row, meterSkuFromConfig returns an
    // overridden meter (different match/exclude/qty); otherwise it returns the
    // static meter unchanged. The armSkuName pin (for VM sizes) also comes from
    // the config-aware meter so the API filter is as tight as possible.
    const effectiveMeter = meterSkuFromConfig(m.key, svcConfigs[m.key], m.meter);
    try {
      const items = await fetchMeterItems(effectiveMeter.serviceName, queryRegion, reqCurrency, effectiveMeter.armSkuName);
      const row = pickMeterRow(items, effectiveMeter);
      if (row) {
        const pr = priceResultFromRow(row, effectiveMeter);
        priceMap[m.key] = pr;
        currency = pr.currency || currency;
      }
      // No qualifying row → leave unpriced; summarizePlan reports it honestly.
    } catch {
      // Per-meter failure: fall back to the labelled list price if we have one.
      // The offline list is USD-only, so disclose that when a non-USD currency
      // was requested rather than silently mis-labelling the figure.
      const fb = FALLBACK_MONTHLY_USD[m.key];
      if (fb) {
        const usdNote = reqCurrency !== 'USD' ? ' (USD list price)' : '';
        priceMap[m.key] = {
          monthly: fb.monthly, unitPrice: fb.monthly, unit: '1/Month', qty: 1,
          sku: fb.sku, assumed: `${effectiveMeter.unitNote} — live API unreachable, showing cached Azure list price${usdNote}.`,
          currency: 'USD', source: 'fallback-list-price',
        };
      }
    }
  }));

  const summary = summarizePlan(priceMap, detailUrls, sub, {
    currency, region: reportRegion, priceRegion: queryRegion, boundary, govDisclaimer,
  });

  return NextResponse.json({ ok: true, summary });
}
