/**
 * GET /api/maps/tiles/[...path]
 *
 * OSS MapLibre (GCC-High / sovereign) · the session-guarded Console PROXY in
 * front of the self-hosted, INTERNAL-ingress `tileserver-gl` Azure Container App
 * (platform/fiab/bicep/modules/compute/loom-maps-app.bicep). The tile server is
 * VNet-internal — the operator's browser is NOT on the VNet, so it can never
 * reach the tile host directly. Every map surface therefore requests its style,
 * vector tiles, glyphs, sprites, and the MapLibre GL JS/CSS through THIS route;
 * we forward each to the in-VNet tile server and stream the bytes back. There is
 * no public map endpoint (design: docs/fiab/gov-replacements/maps-oss.md §3).
 *
 * ── no-fabric-dependency / sovereign ─────────────────────────────────────────
 * Only host contacted is the in-VNet tile server (LOOM_MAPS_TILE_URL origin) —
 * never atlas.microsoft.com / api.fabric / api.powerbi. Fully Gov-safe.
 *
 * ── no-vaporware (honest gate) ───────────────────────────────────────────────
 * When LOOM_MAPS_BACKEND!=maplibre or LOOM_MAPS_TILE_URL is unset, returns an
 * honest 412 naming the exact env var + bicep module — never a mock tile.
 *
 * ── style.json URL rewrite ───────────────────────────────────────────────────
 * The tileserver's style.json references its sources/glyphs/sprite by the
 * INTERNAL origin; the browser cannot resolve those. When the requested resource
 * is `style.json` we rewrite every internal absolute URL (and root-relative path)
 * to this proxy base (`/api/maps/tiles/…`) so the map's sub-resources also route
 * through the guard.
 *
 * Auth: a valid Loom session is required (parity with the item map-token routes) —
 * 401 without one. Path traversal is rejected.
 *
 * 200 → the proxied bytes (content-type + cache from the upstream)
 * 401 → { ok:false, error }                                    (unauthenticated)
 * 412 → { ok:false, error, envVar:'LOOM_MAPS_TILE_URL', bicep }  (not configured)
 * 502 → { ok:false, error }                                    (upstream failure)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveMapsTileOrigin, MAPS_TILE_PROXY_BASE } from '@/lib/azure/maps-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TILE_BICEP = 'platform/fiab/bicep/modules/compute/loom-maps-app.bicep';

/** Rewrite an upstream style.json so every sub-resource routes back through this
 *  proxy (the browser cannot reach the internal tile origin directly). */
function rewriteStyle(styleText: string, origin: string): string {
  let style: unknown;
  try {
    style = JSON.parse(styleText);
  } catch {
    return styleText; // not JSON — pass through unchanged
  }
  const toProxy = (u: unknown): unknown => {
    if (typeof u !== 'string') return u;
    if (u.startsWith(origin)) return `${MAPS_TILE_PROXY_BASE}${u.slice(origin.length)}`;
    // Root-relative (e.g. "/data/…", "/fonts/…", "/sprites/…") → proxy-prefixed.
    if (u.startsWith('/') && !u.startsWith(MAPS_TILE_PROXY_BASE)) return `${MAPS_TILE_PROXY_BASE}${u}`;
    return u;
  };
  const s = style as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (s && typeof s === 'object') {
    if (typeof s.sprite === 'string') s.sprite = toProxy(s.sprite);
    if (typeof s.glyphs === 'string') s.glyphs = toProxy(s.glyphs);
    if (s.sources && typeof s.sources === 'object') {
      for (const src of Object.values(s.sources as Record<string, any>)) { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (src && typeof src === 'object') {
          if (typeof src.url === 'string') src.url = toProxy(src.url);
          if (Array.isArray(src.tiles)) src.tiles = src.tiles.map(toProxy);
        }
      }
    }
  }
  return JSON.stringify(s);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const origin = resolveMapsTileOrigin();
  if (!origin) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The OSS MapLibre tile server is not configured. Set LOOM_MAPS_BACKEND=maplibre + LOOM_MAPS_TILE_URL ' +
          '(a Gov push-button deploy wires both). No Azure Maps / Power BI / Fabric required.',
        envVar: 'LOOM_MAPS_TILE_URL',
        bicep: TILE_BICEP,
      },
      { status: 412 },
    );
  }

  const segments = (await ctx.params).path || [];
  // Reject path traversal / absolute escapes; keep it to safe tile-server paths.
  if (segments.some((s) => s === '..' || s.includes('\\') || s.startsWith('/'))) {
    return NextResponse.json({ ok: false, error: 'invalid path' }, { status: 400 });
  }
  const rel = segments.map(encodeURIComponent).join('/');
  const search = req.nextUrl.search || '';
  const upstream = `${origin}/${rel}${search}`;

  let res: Response;
  try {
    res = await fetch(upstream, { cache: 'no-store', headers: { accept: req.headers.get('accept') || '*/*' } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Tile server unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `Tile server returned HTTP ${res.status}` }, { status: 502 });
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const isStyle = segments[segments.length - 1] === 'style.json';

  // style.json needs its internal URLs rewritten to proxy paths.
  if (isStyle) {
    const text = await res.text();
    const body = rewriteStyle(text, origin);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // Style can change with a redeploy; keep it short-lived.
        'cache-control': 'private, max-age=60',
      },
    });
  }

  // Tiles / glyphs / sprites / GL assets are immutable + cache-friendly.
  const buf = await res.arrayBuffer();
  const headers: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'private, max-age=86400, immutable',
  };
  const enc = res.headers.get('content-encoding');
  if (enc) headers['content-encoding'] = enc;
  return new NextResponse(buf, { status: 200, headers });
}
