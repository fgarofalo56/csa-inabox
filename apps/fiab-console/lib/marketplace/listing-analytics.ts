/**
 * Marketplace listing analytics (W18).
 *
 * Real Cosmos counters (data-product-analytics container, PK /dataProductId)
 * incremented on the EXISTING view + subscribe paths — a publisher-analytics
 * projection over live telemetry, not a synthetic number (no-vaporware.md).
 *   - views     : consumer detail-page reads (owner's own views excluded).
 *   - subscribes: access-requests raised against the listing.
 * Single-partition point ops keep every increment a 1-RU upsert.
 */

import { dataProductAnalyticsContainer } from '@/lib/azure/cosmos-client';

export interface ListingAnalytics {
  /** id === dataProductId (partition key). */
  id: string;
  dataProductId: string;
  views: number;
  subscribes: number;
  /** Distinct subscriber oids (bounded — for the "top subscribers" tile). */
  subscriberOids: string[];
  firstSeenAt: string;
  lastViewedAt?: string;
  lastSubscribedAt?: string;
}

function empty(dataProductId: string): ListingAnalytics {
  return {
    id: dataProductId,
    dataProductId,
    views: 0,
    subscribes: 0,
    subscriberOids: [],
    firstSeenAt: new Date().toISOString(),
  };
}

async function load(dataProductId: string): Promise<ListingAnalytics> {
  const c = await dataProductAnalyticsContainer();
  try {
    const { resource } = await c.item(dataProductId, dataProductId).read<ListingAnalytics>();
    if (resource) return resource;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return empty(dataProductId);
}

/** Read the counters (never throws; returns zeros when absent). */
export async function getListingAnalytics(dataProductId: string): Promise<ListingAnalytics> {
  try {
    return await load(dataProductId);
  } catch {
    return empty(dataProductId);
  }
}

/**
 * Increment the view counter (best-effort, fire-and-forget). Owner self-views
 * are excluded by the caller. Never throws.
 */
export async function recordListingView(dataProductId: string): Promise<void> {
  try {
    const c = await dataProductAnalyticsContainer();
    const cur = await load(dataProductId);
    cur.views += 1;
    cur.lastViewedAt = new Date().toISOString();
    await c.items.upsert(cur);
  } catch {
    /* analytics are advisory */
  }
}

/** Increment the subscribe counter + track the distinct subscriber. */
export async function recordListingSubscribe(dataProductId: string, subscriberOid: string): Promise<void> {
  try {
    const c = await dataProductAnalyticsContainer();
    const cur = await load(dataProductId);
    cur.subscribes += 1;
    cur.lastSubscribedAt = new Date().toISOString();
    if (subscriberOid && !cur.subscriberOids.includes(subscriberOid)) {
      cur.subscriberOids = [...cur.subscriberOids, subscriberOid].slice(-500);
    }
    await c.items.upsert(cur);
  } catch {
    /* analytics are advisory */
  }
}
