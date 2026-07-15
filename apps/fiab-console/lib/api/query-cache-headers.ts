/**
 * query-cache-headers — PSR-6 HTTP cache headers (ETag + Cache-Control) for the
 * KQL / query BFF responses so the browser and any fronting CDN can REVALIDATE
 * a repeat query instead of re-running it end-to-end.
 *
 * A response body is hashed to a weak ETag; the route sets `Cache-Control:
 * private, max-age=<n>` so a per-user client caches for the tile-refresh
 * window (never cross-tenant — `private`). When the client re-issues the same
 * request carrying `If-None-Match: <etag>`, {@link ifNoneMatch304} short-circuits
 * with a 304 (empty body) — the client keeps its already-rendered result.
 *
 * All Azure-native — the cached payload is rows an Azure backend already
 * produced (no-vaporware.md); no Fabric / Power BI dependency
 * (no-fabric-dependency.md). Defaults are conservative (private, short max-age)
 * so a missed invalidation self-heals fast, mirroring the result-cache TTLs.
 */

import { NextResponse } from 'next/server';
import { createHash } from 'crypto';

/** Default cacheable window (seconds) for a query response when unspecified. */
export const DEFAULT_QUERY_MAX_AGE_SEC = 60;

/**
 * Weak ETag over a JSON-serialisable body: `W/"<sha256-first-32-hex>"`. Weak
 * because it identifies semantic (row) equality, not byte-for-byte transport
 * equality — exactly the HTTP-spec meaning for a revalidatable representation.
 * Grounded in RFC 9110 §8.8.3 (weak validators). Pure — unit tested.
 */
export function weakEtag(body: unknown): string {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  const hex = createHash('sha256').update(json).digest('hex').slice(0, 32);
  return `W/"${hex}"`;
}

/**
 * Normalise a client `If-None-Match` header for comparison. Handles a bare
 * ETag, a comma list, and the `W/` weak prefix; returns the set of raw hex
 * tags the client already holds.
 */
export function parseIfNoneMatch(header: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!header) return out;
  for (const part of header.split(',')) {
    const t = part.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
    if (t) out.add(t);
  }
  return out;
}

/** True when the client's `If-None-Match` already matches this ETag. */
export function etagMatches(etag: string, ifNoneMatch: string | null | undefined): boolean {
  const bare = etag.replace(/^W\//i, '').replace(/^"|"$/g, '');
  return parseIfNoneMatch(ifNoneMatch).has(bare);
}

/** Apply ETag + `Cache-Control: private, max-age=<n>` to a response, in place. */
export function withQueryCacheHeaders(
  res: NextResponse,
  etag: string,
  maxAgeSec: number = DEFAULT_QUERY_MAX_AGE_SEC,
): NextResponse {
  const sec = Math.max(0, Math.floor(maxAgeSec));
  res.headers.set('ETag', etag);
  res.headers.set('Cache-Control', `private, max-age=${sec}`);
  return res;
}

/**
 * PSR-6 one-shot: build a JSON query response with ETag + Cache-Control, and
 * short-circuit to `304 Not Modified` (empty body, same validators) when the
 * caller's `If-None-Match` already holds this body's ETag. Returns the
 * NextResponse to hand straight back from the route.
 */
export function jsonWithQueryCache(
  body: Record<string, unknown>,
  opts: { ifNoneMatch?: string | null; maxAgeSec?: number },
): NextResponse {
  const etag = weakEtag(body);
  const maxAge = opts.maxAgeSec ?? DEFAULT_QUERY_MAX_AGE_SEC;
  if (etagMatches(etag, opts.ifNoneMatch)) {
    const notModified = new NextResponse(null, { status: 304 });
    return withQueryCacheHeaders(notModified, etag, maxAge);
  }
  return withQueryCacheHeaders(NextResponse.json(body), etag, maxAge);
}
