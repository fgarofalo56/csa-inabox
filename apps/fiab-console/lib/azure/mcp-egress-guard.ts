/**
 * MCP egress SSRF guard (rel-T13 / blocker B17).
 *
 * The MCP admin surface fetches a CALLER-SUPPLIED URL server-side — both the
 * `test-connection` probe and the connectivity probe on save/update run from the
 * Console Container App's network position. Without a guard an authenticated
 * caller could point that fetch at the cloud instance-metadata endpoint
 * (169.254.169.254), a localhost admin port, or any RFC-1918 host reachable from
 * the app — a classic authenticated server-side request forgery.
 *
 * `assertMcpEgressAllowed()`:
 *   1. requires `https:` (rejects http / file / gopher / …),
 *   2. resolves the host's A/AAAA records and REJECTS if ANY record lands in a
 *      private / loopback / link-local / unique-local / unspecified range —
 *      IPv4 + IPv6, including IPv4-mapped IPv6 and 169.254.169.254 (IMDS),
 *   3. honors an optional operator EGRESS ALLOW-LIST (`LOOM_MCP_EGRESS_ALLOW`,
 *      comma-separated host suffixes): when SET, ONLY matching hosts pass, and a
 *      suffix match also EXEMPTS the private-IP check (the operator has
 *      explicitly whitelisted that host — e.g. an internal MCP server),
 *   4. exempts the operator-configured built-in MCP server host
 *      (`LOOM_BUILTIN_MCP_URL`) from the private-IP check, since a legitimately
 *      deployed MCP server on the internal Container Apps environment network
 *      has a private ingress IP.
 *
 * PRECISE, NOT CLEVER: the private-IP EXEMPTION is driven ONLY by operator env
 * (`LOOM_BUILTIN_MCP_URL` host + `LOOM_MCP_EGRESS_ALLOW` suffixes), NEVER by
 * user-supplied or Cosmos-persisted server rows. Trusting a registered server's
 * own URL would let a caller register an endpoint pointing at 169.254.169.254
 * and self-authorize the probe. Catalog-deployed internal servers are registered
 * by the deploy route (not the user-URL POST) and are probed at deploy time; an
 * operator who wants to re-test them from the panel whitelists their internal
 * Container Apps domain suffix via `LOOM_MCP_EGRESS_ALLOW`.
 *
 * Residual: DNS-rebinding TOCTOU (the name could resolve to a different address
 * between this check and the real fetch) is not fully closed — pinning the
 * resolved IP into the socket is a larger change. This implements the
 * resolve-then-validate mitigation the blocker calls for.
 */

import { lookup } from 'node:dns/promises';

/** Thrown when a caller-supplied MCP endpoint fails the egress guard. Callers
 *  return its `message` as a 400 so the admin sees the exact reason. */
export class McpEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpEgressError';
  }
}

/** Operator egress allow-list — comma-separated host suffixes. */
function egressAllowSuffixes(): string[] {
  return (process.env.LOOM_MCP_EGRESS_ALLOW || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, ''))
    .filter(Boolean);
}

/** Host of the operator-configured built-in MCP server, if any. */
function builtinMcpHost(): string | null {
  const raw = (process.env.LOOM_BUILTIN_MCP_URL || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
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
function isBlockedIpv4(ip: string): boolean {
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
function isBlockedIpv6(addr: string): boolean {
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

/**
 * Throw `McpEgressError` unless `rawUrl` is a safe MCP egress target. See the
 * module header for the full policy. Async because it resolves DNS.
 */
export async function assertMcpEgressAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpEgressError('endpoint must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new McpEgressError(`endpoint must use https: (got "${url.protocol}")`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new McpEgressError('endpoint has no host');

  const allow = egressAllowSuffixes();
  const egressMatched = allow.some((suf) => hostMatchesSuffix(host, suf));
  const isBuiltin = builtinMcpHost() === host;

  // Restrictive allow-list: when LOOM_MCP_EGRESS_ALLOW is configured, ONLY hosts
  // that match a suffix (or the configured built-in host) may be reached at all.
  if (allow.length && !egressMatched && !isBuiltin) {
    throw new McpEgressError(
      `endpoint host "${host}" is not in the MCP egress allow-list. Add its host suffix to ` +
        'LOOM_MCP_EGRESS_ALLOW (comma-separated) to permit it.',
    );
  }

  // Explicitly-trusted internal targets skip the private-IP guard: setting the
  // built-in URL or whitelisting the host in LOOM_MCP_EGRESS_ALLOW is the
  // operator opting into reaching it even on a private CAE ingress IP.
  if (isBuiltin || egressMatched) return;

  // Resolve every A/AAAA record and reject if ANY lands in a blocked range (a
  // name whose records mix a public + a private answer must not pass).
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new McpEgressError(`could not resolve endpoint host "${host}"`);
  }
  if (!records.length) throw new McpEgressError(`endpoint host "${host}" did not resolve`);
  for (const rec of records) {
    if (isBlockedIp(rec.address, rec.family)) {
      throw new McpEgressError(
        `endpoint host "${host}" resolves to a private/loopback/link-local address (${rec.address}) — ` +
          'refused to prevent server-side request forgery. If this is a legitimate internal MCP server, ' +
          'add its host suffix to LOOM_MCP_EGRESS_ALLOW.',
      );
    }
  }
}
