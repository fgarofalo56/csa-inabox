/**
 * egress-ssrf — the shared server-side-request-forgery egress guard core.
 *
 * Two Loom features fetch a CALLER-SUPPLIED URL server-side and therefore need
 * the identical SSRF policy: the MCP admin probes (mcp-egress-guard.ts) and the
 * WS-5.2 A2A outbound client (a2a-egress-guard.ts, Loom → external A2A agents).
 * Rather than duplicate the (security-critical) IP-classification + allow-list
 * policy in both, that policy lives here ONCE and each guard wraps it with its
 * own operator env var + error class.
 *
 * `assertEgressAllowed()`:
 *   1. requires `https:` (rejects http / file / gopher / …),
 *   2. resolves the host's A/AAAA records and REJECTS if ANY record lands in a
 *      private / loopback / link-local / unique-local / unspecified range —
 *      IPv4 + IPv6, including IPv4-mapped IPv6 and 169.254.169.254 (IMDS),
 *   3. honors an optional operator EGRESS ALLOW-LIST (comma-separated host
 *      suffixes): when SET, ONLY matching hosts pass, and a suffix match also
 *      EXEMPTS the private-IP check (the operator has explicitly whitelisted that
 *      host — e.g. an internal, in-VNet endpoint),
 *   4. exempts an optional operator-configured built-in host from the private-IP
 *      check (a legitimately deployed internal Container App has a private IP).
 *
 * PRECISE, NOT CLEVER: the private-IP EXEMPTION is driven ONLY by operator env
 * (the built-in host + the allow-list suffixes), NEVER by user-supplied or
 * Cosmos-persisted rows — otherwise a caller could register an endpoint pointing
 * at 169.254.169.254 and self-authorize the fetch.
 *
 * Sovereign default (no-fabric-dependency.md): with an allow-list configured the
 * guard is a strict allow-list — the air-gap-safe posture, since ONLY the
 * operator-approved external hosts are reachable and everything else (incl. the
 * whole public internet) is refused.
 *
 * Residual: DNS-rebinding TOCTOU (the name could resolve to a different address
 * between this check and the real fetch) is not fully closed — pinning the
 * resolved IP into the socket is a larger change. This implements the
 * resolve-then-validate mitigation.
 */

import { lookup } from 'node:dns/promises';

/** Base class for an egress-guard rejection. Subclasses carry a feature name. */
export class EgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressError';
  }
}

/** Parse a comma-separated host-suffix allow-list from an env value. */
export function parseAllowSuffixes(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, ''))
    .filter(Boolean);
}

/** Host of a configured built-in URL, if any (lower-cased, no trailing dot). */
export function hostOfUrl(raw: string | undefined): string | null {
  const v = (raw || '').trim();
  if (!v) return null;
  try {
    return new URL(v).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith('.' + suffix);
}

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function inCidr(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

/** RFC-1918 / loopback / link-local / CGNAT / unspecified IPv4. */
export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return (
    inCidr(n, '0.0.0.0', 8) ||       // "this" network incl. 0.0.0.0
    inCidr(n, '10.0.0.0', 8) ||      // private
    inCidr(n, '127.0.0.0', 8) ||     // loopback
    inCidr(n, '169.254.0.0', 16) ||  // link-local incl. 169.254.169.254 (IMDS)
    inCidr(n, '172.16.0.0', 12) ||   // private
    inCidr(n, '192.168.0.0', 16) ||  // private
    inCidr(n, '100.64.0.0', 10)      // CGNAT / shared address space
  );
}

/** Loopback / link-local / unique-local / unspecified / IPv4-mapped IPv6. */
export function isBlockedIpv6(addr: string): boolean {
  let s = addr.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // IPv4-mapped / -embedded (::ffff:a.b.c.d or ::a.b.c.d) → classify the v4 part.
  const v4 = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (v4 && isBlockedIpv4(v4[1])) return true;
  if (s === '::' || s === '::1') return true;   // unspecified / loopback
  if (/^fe[89ab]/.test(s)) return true;         // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return true;            // fc00::/7 unique-local
  return false;
}

function isBlockedIp(address: string, family: number): boolean {
  return family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface EgressPolicy {
  /** Comma-separated host-suffix allow-list (already parsed via parseAllowSuffixes). */
  allowSuffixes: string[];
  /** An operator-configured built-in host exempt from the private-IP check. */
  builtinHost?: string | null;
  /** Construct the feature-specific error thrown on rejection. */
  makeError: (message: string) => EgressError;
  /** The allow-list env var name, used in messages (e.g. `LOOM_A2A_EGRESS_ALLOW`). */
  allowListName: string;
}

/**
 * Throw `policy.makeError(...)` unless `rawUrl` is a safe egress target under the
 * shared policy. Async because it resolves DNS. See the module header for the
 * full policy.
 */
export async function assertEgressAllowed(rawUrl: string, policy: EgressPolicy): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw policy.makeError('endpoint must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw policy.makeError(`endpoint must use https: (got "${url.protocol}")`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw policy.makeError('endpoint has no host');

  const allow = policy.allowSuffixes;
  const egressMatched = allow.some((suf) => hostMatchesSuffix(host, suf));
  const isBuiltin = !!policy.builtinHost && policy.builtinHost === host;

  // Restrictive allow-list: when configured, ONLY hosts that match a suffix (or
  // the configured built-in host) may be reached at all — the air-gap posture.
  if (allow.length && !egressMatched && !isBuiltin) {
    throw policy.makeError(
      `endpoint host "${host}" is not in the egress allow-list. Add its host suffix to ` +
        `${policy.allowListName} (comma-separated) to permit it.`,
    );
  }

  // Explicitly-trusted internal targets skip the private-IP guard: setting the
  // built-in host or whitelisting the host is the operator opting into reaching
  // it even on a private in-VNet ingress IP.
  if (isBuiltin || egressMatched) return;

  // Resolve every A/AAAA record and reject if ANY lands in a blocked range (a
  // name whose records mix a public + a private answer must not pass).
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw policy.makeError(`could not resolve endpoint host "${host}"`);
  }
  if (!records.length) throw policy.makeError(`endpoint host "${host}" did not resolve`);
  for (const rec of records) {
    if (isBlockedIp(rec.address, rec.family)) {
      throw policy.makeError(
        `endpoint host "${host}" resolves to a private/loopback/link-local address (${rec.address}) — ` +
          `refused to prevent server-side request forgery. If this is a legitimate internal endpoint, ` +
          `add its host suffix to ${policy.allowListName}.`,
      );
    }
  }
}
