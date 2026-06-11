/**
 * Deploy-plan cost-estimate API — best-effort monthly cost for a planned
 * subscription, computed from the PUBLIC Azure Retail Prices API
 * (https://prices.azure.com/api/retail/prices — no auth, Commercial cloud).
 *
 * POST /api/admin/deploy-plan/cost-estimate  body: { subscription: PlanSubscription }
 *   → { ok:true, summary: CostSummary }  (per-domain rows + grand total + the
 *      services that could not be priced, with an honest reason each)
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
import { metersForServices } from '@/lib/components/deploy-planner/service-catalog';
import { BOUNDARY_DEFAULT_REGION } from '@/lib/components/deploy-planner/bicepparam';
import {
  pickMeterRow, priceResultFromRow, summarizePlan,
  FALLBACK_MONTHLY_USD,
  type RetailPriceItem, type PriceResult,
} from '@/lib/components/deploy-planner/cost-estimate';
import type { PlanSubscription } from '@/lib/components/deploy-planner/types';

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
 * the region + Consumption price type. Throws on network/HTTP failure so the
 * caller can decide between "this service unpriced" and "API down → fallback".
 */
async function fetchMeterItems(serviceName: string, region: string, armSkuName?: string): Promise<RetailPriceItem[]> {
  const filterParts = [
    `armRegionName eq '${odata(region)}'`,
    `priceType eq 'Consumption'`,
    `serviceName eq '${odata(serviceName)}'`,
  ];
  if (armSkuName) filterParts.push(`armSkuName eq '${odata(armSkuName)}'`);
  let url: string | null =
    `${PRICES_BASE}/api/retail/prices?api-version=${API_VERSION}&$filter=${encodeURIComponent(filterParts.join(' and '))}`;
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
  };
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sub = sanitizeSubscription(body?.subscription);
  const boundary = sub.boundary || 'Commercial';
  const govDisclaimer = boundary === 'GCC-High' || boundary === 'IL5';
  // The planned region (what bicep would deploy into) is what we REPORT.
  const reportRegion = sub.region || BOUNDARY_DEFAULT_REGION[boundary] || 'eastus2';
  // The Retail Prices API only knows Commercial regions, so Gov boundaries are
  // priced against a Commercial reference region (disclosed via govDisclaimer).
  const queryRegion = govDisclaimer ? 'eastus2' : reportRegion;

  // Distinct planned services across all domains that carry a representative meter.
  const allKeys = new Set<string>();
  for (const d of sub.domains) for (const k of d.services) allKeys.add(k);
  const meters = metersForServices([...allKeys]);

  const priceMap: Record<string, PriceResult> = {};
  const detailUrls: Record<string, string | undefined> = {};
  let currency = 'USD';

  await Promise.all(meters.map(async (m) => {
    detailUrls[m.key] = m.pricingDetailsUrl;
    try {
      const items = await fetchMeterItems(m.meter.serviceName, queryRegion, m.meter.armSkuName);
      const row = pickMeterRow(items, m.meter);
      if (row) {
        const pr = priceResultFromRow(row, m.meter);
        priceMap[m.key] = pr;
        currency = pr.currency || currency;
      }
      // No qualifying row → leave unpriced; summarizePlan reports it honestly.
    } catch {
      // Per-meter failure: fall back to the labelled list price if we have one.
      const fb = FALLBACK_MONTHLY_USD[m.key];
      if (fb) {
        priceMap[m.key] = {
          monthly: fb.monthly, unitPrice: fb.monthly, unit: '1/Month', qty: 1,
          sku: fb.sku, assumed: `${m.meter.unitNote} — live API unreachable, showing cached Azure list price.`,
          currency: 'USD', source: 'fallback-list-price',
        };
      }
    }
  }));

  const summary = summarizePlan(priceMap, detailUrls, sub, {
    currency, region: reportRegion, boundary, govDisclaimer,
  });

  return NextResponse.json({ ok: true, summary });
}
