/**
 * Client-IP derivation that a CALLER cannot choose.
 *
 * Every "per-IP" control in Loom — anonymous rate limits, the Delta Sharing
 * anonymous-deny burst guard, the `sourceIp` written into an audit row — is only
 * as good as the header it is keyed on. `x-forwarded-for` is appended to by each
 * hop, so its LEFTMOST entry is whatever the ORIGINAL client typed. Reading
 * `xff.split(',')[0]` therefore hands the attacker the key:
 *
 *   for i in $(seq 1 1000); do curl -H "X-Forwarded-For: 203.0.113.$i" …; done
 *
 * …lands in 1000 distinct buckets, defeating the limiter, and stamps 1000
 * attacker-chosen `sourceIp` values into the audit trail.
 *
 * The rule this module implements: **only a value written by a hop we control is
 * trustworthy, and for an appended header that is the RIGHTMOST value.**
 *
 * Header preference, grounded in the Azure Front Door → Container Apps path we
 * actually deploy on (learn.microsoft.com/azure/frontdoor/front-door-http-headers-protocol):
 *
 *   1. `x-azure-socketip` — "the socket IP address associated with the TCP
 *      connection that the current request originated from". Front Door derives
 *      it from the connection, not from a header. The same doc warns explicitly
 *      that `x-azure-clientip` "can be arbitrarily overwritten by a user"
 *      (it is XFF-derived), which is why the *client* header is NOT trusted here.
 *   2. `x-forwarded-for`, RIGHTMOST entry — appended by our own ingress, so the
 *      last element is the peer that actually opened the connection to us.
 *      Coarse behind Front Door (it is the edge node), but not forgeable.
 *   3. `x-real-ip` — single-valued, proxy-set.
 *   4. `unknown-ip` — one shared bucket, never a throw.
 *
 * Headers are read with `Headers.get`, which joins repeated fields with ", ";
 * taking the rightmost value therefore also survives a client that *pre-sets*
 * `x-azure-socketip`, because our hop's value is appended after theirs.
 *
 * {@link claimedClientIp} exists so the caller's own claim can still be RECORDED
 * (it is useful forensic context) without ever being mistaken for attribution —
 * write it under a field name that says it is untrusted.
 *
 * KNOWN LIMIT, stated rather than hidden: "rightmost hop" is only trustworthy
 * when SOMETHING in front of us appends. On a deployment with no proxy at all,
 * a client that sends `X-Forwarded-For` directly is the only writer of that
 * header and we would believe it. Loom always runs behind Front Door → Container
 * Apps ingress, and `x-azure-socketip` is preferred precisely because it does not
 * depend on that assumption — but any control that must hold regardless needs a
 * key-independent backstop as well (see the global deny budget in
 * `app/api/delta-sharing/[...path]/route.ts`).
 */

/** Rightmost (nearest-hop) entry of a comma-appended header. */
function lastHop(raw: string | null): string {
  if (!raw) return '';
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Leftmost (client-most) entry of a comma-appended header. */
function firstHop(raw: string | null): string {
  if (!raw) return '';
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[0] : '';
}

/**
 * The source address as reported by a hop we control. Safe to use as a rate-limit
 * key, a burst-guard key, and as audit attribution.
 *
 * Returns `'unknown-ip'` rather than an empty string so callers that concatenate
 * it into a bucket key cannot accidentally collapse to the same key as "no
 * value at all" while still being a stable single bucket.
 */
export function trustedClientIp(headers: Headers): string {
  const socket = lastHop(headers.get('x-azure-socketip'));
  if (socket) return socket.slice(0, 64);
  const xff = lastHop(headers.get('x-forwarded-for'));
  if (xff) return xff.slice(0, 64);
  const real = (headers.get('x-real-ip') || '').trim();
  if (real) return real.slice(0, 64);
  return 'unknown-ip';
}

/**
 * What the CALLER claims its address is (`x-azure-clientip`, else the leftmost
 * `x-forwarded-for` hop). Untrusted by construction — record it, never key on it.
 * Empty string when the caller claimed nothing.
 */
export function claimedClientIp(headers: Headers): string {
  const azure = firstHop(headers.get('x-azure-clientip'));
  if (azure) return azure.slice(0, 64);
  return firstHop(headers.get('x-forwarded-for')).slice(0, 64);
}
