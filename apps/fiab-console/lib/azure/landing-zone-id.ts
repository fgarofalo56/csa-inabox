/**
 * landing-zone-id — codec for the landing-zone id used in the attach routes'
 * `[id]` path segment.
 *
 * A landing zone id is `${subscriptionId}/${resourceGroup}` (a DLZ) or the
 * literal `hub` (admin-plane services attach to the hub — §2.1 / open-question
 * #2). The DLZ form contains a `/`, which can't ride in a single Next.js route
 * segment (and `%2F` is unreliable behind Front Door), so the client base64url-
 * encodes it and the server decodes. `hub` and other single-segment ids pass
 * through unencoded for readability.
 */

/** Encode a landing-zone id for a `[id]` path segment. */
export function encodeLandingZoneId(landingZoneId: string): string {
  if (!landingZoneId.includes('/')) return landingZoneId; // 'hub' etc. — readable
  return Buffer.from(landingZoneId, 'utf-8').toString('base64url');
}

/** Decode a `[id]` path segment back to a landing-zone id. */
export function decodeLandingZoneId(param: string): string {
  const raw = decodeURIComponent(param || '');
  if (!raw || raw === 'hub' || raw.includes('/')) return raw;
  // base64url → utf-8 when it decodes to a `sub/rg` shape; otherwise treat as-is.
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    if (decoded.includes('/')) return decoded;
  } catch { /* not base64url — fall through */ }
  return raw;
}
