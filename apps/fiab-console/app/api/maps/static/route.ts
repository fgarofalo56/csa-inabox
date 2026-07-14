/**
 * GET /api/maps/static — server-side Azure Maps static-raster PROXY.
 *
 * The RUNTIME replacement for the client-baked NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY:
 * the geo editors used to build an atlas.microsoft.com static-map URL in the
 * BROWSER with the subscription key embedded in the query string — which (a)
 * required a build-time NEXT_PUBLIC_* var that can never be runtime-toggled, and
 * (b) leaked the key into every `<img src>`. This route moves both problems
 * server-side: the browser requests `/api/maps/static?...` (no credential), and
 * THIS route resolves the credential (AAD token preferred, key fallback) via the
 * SAME resolveMapsBackend() the item map-token brokers use, calls the Azure Maps
 * Render v2 static endpoint with the right auth header, and streams the PNG back.
 *
 * Auth: session-gated (any signed-in user) — the rendered basemap is not
 * item-scoped, and no credential ever reaches the client. Azure-native only; no
 * Power BI / Fabric on any path (no-fabric-dependency.md).
 *
 * Query params (validated, all optional): style, zoom, center (lon,lat),
 * width, height. Anything out of range is clamped to a safe default.
 *
 * 200 → image/png (the static basemap)
 * 401 → { ok:false, error }                 (unauthenticated)
 * 412 → { ok:false, error, envVar, bicep }  (Azure Maps not configured — honest gate)
 * 502 → { ok:false, error }                 (upstream Azure Maps error)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveMapsBackend } from '@/lib/azure/maps-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AZURE_MAPS_BICEP = 'platform/fiab/bicep/modules/landing-zone/azure-maps.bicep';
const STATIC_ENDPOINT = 'https://atlas.microsoft.com/map/static';
const API_VERSION = '2024-04-01';

/** Clamp a numeric query param into [min,max], falling back to `dflt`. */
function num(v: string | null, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const backend = await resolveMapsBackend();
  if (!backend.ok) {
    return NextResponse.json(
      { ok: false, error: backend.reason, envVar: backend.envVar, bicep: AZURE_MAPS_BICEP },
      { status: 412 },
    );
  }

  // ── Validate + clamp the render params (never trust the client verbatim) ──
  const q = req.nextUrl.searchParams;
  const style = /^[a-z0-9_-]{1,40}$/i.test(q.get('style') || '') ? q.get('style')! : 'main';
  const zoom = Math.round(num(q.get('zoom'), 0, 20, 8));
  const lon = num(q.get('lon') ?? (q.get('center')?.split(',')[0] ?? null), -180, 180, -77.0);
  const lat = num(q.get('lat') ?? (q.get('center')?.split(',')[1] ?? null), -85, 85, 38.9);
  const width = Math.round(num(q.get('width'), 80, 2000, 640));
  const height = Math.round(num(q.get('height'), 80, 1500, 360));

  const url =
    `${STATIC_ENDPOINT}?api-version=${API_VERSION}` +
    `&tilesetId=microsoft.base.road` +
    `&zoom=${zoom}&center=${lon},${lat}&width=${width}&height=${height}` +
    // The Render v2 static tileset already encodes the base style; `style` is kept
    // in the signature for forward-compat / callers that pass a custom style layer.
    (style && style !== 'main' ? `&layer=basic&style=${encodeURIComponent(style)}` : '');

  const headers: Record<string, string> = { Accept: 'image/png' };
  if (backend.mode === 'aad') {
    headers['Authorization'] = `Bearer ${backend.token}`;
    headers['x-ms-client-id'] = backend.clientId;
  } else {
    headers['subscription-key'] = backend.key;
  }

  try {
    const upstream = await fetch(url, { headers, cache: 'no-store' });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: `Azure Maps static render failed (${upstream.status}). ${detail.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'image/png',
        // Short client cache — the basemap for a given bbox is stable; the token
        // is never in the URL so caching the image is safe.
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Failed to reach Azure Maps: ${e?.message || String(e)}` },
      { status: 502 },
    );
  }
}
