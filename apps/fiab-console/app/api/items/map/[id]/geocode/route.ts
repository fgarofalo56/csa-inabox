/**
 * POST /api/items/map/[id]/geocode
 *
 * Fabric-IQ Map · address → lat/lon GEOCODING for the map editor's "address
 * column" binding. The editor collects a batch of address strings (typed, or
 * pulled from a bound label column) and posts them here; this route resolves
 * each to a coordinate through the Azure Maps **Search** data-plane REST API
 * and returns geo rows the editor folds into the map GeoJSON — the exact same
 * `{ lat, lon, value?, label? }` shape `…/data` returns, so every layer renders
 * the geocoded points live.
 *
 * ── Azure-native, no Fabric (no-fabric-dependency.md) ────────────────────────
 * Azure Maps is an Azure-native service. Auth is brokered by the SAME
 * `resolveMapsBackend()` the interactive canvas + `…/map-token` use — a
 * short-lived Entra (AAD) token scoped to atlas.microsoft.com ALONE (preferred,
 * gov-safe) or a subscription key (commercial). No api.fabric / api.powerbi host
 * is ever contacted; the Search host is atlas.microsoft.com (overridable for
 * sovereign clouds via LOOM_AZURE_MAPS_SEARCH_HOST).
 *
 * ── no-vaporware (honest gate) ───────────────────────────────────────────────
 * When the Maps account/env is absent, this returns an HONEST 503 naming the
 * exact env var + the bicep module — never a mock coordinate, never a silent
 * empty result.
 *
 * Owner-checked exactly like …/data + …/map-token: 401 without a session, 404
 * when the map isn't the caller's. A not-yet-saved map (id === 'new') only needs
 * a session — the Maps credential is account-scoped, not item-scoped.
 *
 * Body: { addresses: string[], countrySet?: string, limit?: number }
 * 200   → { ok:true, rows:[{lat,lon,label,query,confidence}], geocoded, failed, total, results:[{query, ok, ...}] }
 *         partial success (>=1 geocoded) is ok:true with the failed ones in results[].
 * 200   → { ok:false, code:'geocode_all_failed', error, geocoded:0, failed, total, results } (EVERY address failed)
 * 400   → { ok:false, error }                                   (no addresses)
 * 401   → { ok:false, error }                                   (unauthenticated)
 * 404   → { ok:false, error }                                   (map not found / not owned)
 * 503   → { ok:false, error, code:'maps_not_configured', envVar, bicep }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveMapsBackend } from '@/lib/azure/maps-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { apiServerError, apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'map';
const AZURE_MAPS_BICEP = 'platform/fiab/bicep/modules/landing-zone/azure-maps.bicep';
/** Azure Maps Search host — atlas by default; overridable for sovereign clouds. */
const SEARCH_HOST = (process.env.LOOM_AZURE_MAPS_SEARCH_HOST || 'atlas.microsoft.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
/** Cap the batch so a single request can't fan out unbounded Search calls. */
const MAX_ADDRESSES = 250;

interface GeoRow { lat: number; lon: number; label?: string; query?: string; confidence?: number }

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);

  // ── Owner-check THIS map item (parity with …/data + …/map-token). ────────────
  const { id } = await ctx.params;
  if (id && id !== 'new') {
    try {
      const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
      if (!item) return err('map item not found', 404);
    } catch (e: any) {
      return apiServerError(e);
    }
  }

  const body = await req.json().catch(() => ({} as any));
  const raw: unknown[] = Array.isArray(body?.addresses) ? body.addresses : [];
  // De-dup + trim; preserve order of first occurrence.
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const a of raw) {
    const t = String(a ?? '').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    addresses.push(t);
    if (addresses.length >= MAX_ADDRESSES) break;
  }
  if (addresses.length === 0) {
    return err('No addresses to geocode. Provide one or more address strings.', 400, { code: 'NO_ADDRESSES' });
  }

  // ── Resolve the Azure Maps credential (or the honest gate) ───────────────────
  const backend = await resolveMapsBackend();
  if (!backend.ok) {
    return err(backend.reason, 503, { code: 'maps_not_configured', envVar: backend.envVar, bicep: AZURE_MAPS_BICEP });
  }

  const countrySet = String(body?.countrySet || '').trim();
  const limit = Math.max(1, Math.min(Number(body?.limit) || 1, 10));

  // Build the auth for the Search REST call once (matches the SDK contract).
  const headers: Record<string, string> = { accept: 'application/json' };
  let keyParam = '';
  if (backend.mode === 'aad') {
    headers['Authorization'] = `Bearer ${backend.token}`;
    headers['x-ms-client-id'] = backend.clientId;
  } else {
    keyParam = `&subscription-key=${encodeURIComponent(backend.key)}`;
  }

  const results: Array<{ query: string; ok: boolean; lat?: number; lon?: number; label?: string; confidence?: number; error?: string }> = [];
  const rows: GeoRow[] = [];

  // Geocode sequentially in small parallel chunks so one bad address never
  // fails the whole batch and we stay within Search's rate envelope.
  const CHUNK = 5;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const slice = addresses.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(slice.map(async (query) => {
      try {
        const params = new URLSearchParams({ 'api-version': '1.0', query, limit: String(limit) });
        if (countrySet) params.set('countrySet', countrySet);
        const url = `https://${SEARCH_HOST}/search/address/json?${params.toString()}${keyParam}`;
        const r = await fetch(url, { headers, cache: 'no-store' });
        if (!r.ok) {
          let detail = `HTTP ${r.status}`;
          try { const j = await r.json(); detail = j?.error?.message || j?.error?.code || detail; } catch { /* text below */ }
          results.push({ query, ok: false, error: detail });
          return;
        }
        const j: any = await r.json();
        const top = Array.isArray(j?.results) ? j.results[0] : undefined;
        const pos = top?.position;
        const lat = pos ? Number(pos.lat) : NaN;
        const lon = pos ? Number(pos.lon) : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          results.push({ query, ok: false, error: 'no match' });
          return;
        }
        const label = top?.address?.freeformAddress ? String(top.address.freeformAddress) : query;
        const confidence = typeof top?.score === 'number' ? top.score : undefined;
        rows.push({ lat, lon, label, query, confidence });
        results.push({ query, ok: true, lat, lon, label, confidence });
      } catch (e: any) {
        results.push({ query, ok: false, error: (e?.message || String(e)).slice(0, 200) });
      }
    }));
  }

  const geocoded = rows.length;
  const failed = addresses.length - geocoded;
  // CORRECTNESS: when EVERY address failed to resolve, the operation did not
  // succeed — report ok:false so the editor surfaces an error (and does not
  // clear the map with an empty result set). HTTP stays 200 so the client can
  // still read the per-address `results[]` error detail. Partial success (at
  // least one geocoded) remains ok:true with the failed list preserved.
  const allFailed = geocoded === 0 && failed > 0;
  return NextResponse.json({
    ok: !allFailed,
    ...(allFailed
      ? {
          error: `None of the ${addresses.length} address(es) could be geocoded. See results[] for per-address detail.`,
          code: 'geocode_all_failed',
        }
      : {}),
    mode: backend.mode,
    rows,
    geocoded,
    failed,
    total: addresses.length,
    results,
  });
}
