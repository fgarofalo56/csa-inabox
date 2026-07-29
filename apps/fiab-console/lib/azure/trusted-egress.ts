/**
 * trusted-egress — the DESTINATION of a credential-bearing server-side fetch
 * must come from CONFIG, never from a request.
 *
 * Why this file exists (the class, not the instance):
 *
 *   Loom's BFF calls Azure control-plane and data-plane endpoints with the
 *   Console's MANAGED IDENTITY (ARM / Graph / Key Vault tokens) and with Key
 *   Vault-sourced secrets. Any code path where a request-influenced value
 *   decides the *host* of such a call is not "fetch an internal URL" — it is
 *   "make Azure calls as the Console's identity" or "post a Key Vault secret to
 *   an attacker". Two shapes carried that risk across this tree:
 *
 *   1. ABSOLUTE-URL PASSTHROUGH — `path.startsWith('http') ? path : BASE+path`,
 *      repeated in ~13 ARM/Graph clients so `nextLink` / LRO `Location` polling
 *      works. It also silently accepts ANY absolute URL, so one caller that
 *      forwards a request value as `path` sends a bearer token off-tenant.
 *      {@link resolveSameOriginUrl} keeps the nextLink capability and makes the
 *      off-origin case unrepresentable.
 *
 *   2. CALLER-SUPPLIED ENDPOINT — a base URL read from user-writable state
 *      (item `state.azureFunctionUrl`, a registry row's `baseUrlOverride`) that
 *      then receives a Key Vault secret in a header.
 *      {@link resolveConfiguredBase} lets a request only *select* one of the
 *      operator-configured bases; the string that is actually fetched is the
 *      CONFIG string, so the destination cannot diverge from an approved one
 *      by construction (same approach as the delta-sharing `upstreamTablePath`
 *      rebuild and `lib/azure/client-ip.ts`).
 *
 * Neither helper filters or rewrites a URL — filtering is what loses. They
 * reconstruct the destination from trusted state and refuse otherwise.
 */

/** Thrown when a fetch destination did not come from configuration. */
export class UntrustedEgressError extends Error {
  /** The destination that was refused (safe to log — never a secret). */
  readonly attempted: string;
  /** What the destination was required to match. */
  readonly expected: string;
  readonly status = 502;
  constructor(label: string, attempted: string, expected: string) {
    super(
      `${label}: refusing to send a credentialed request to "${attempted}" — ` +
        `the destination must be ${expected}. The destination of an identity-bearing ` +
        `call is taken from configuration, never from a request.`,
    );
    this.name = 'UntrustedEgressError';
    this.attempted = attempted;
    this.expected = expected;
  }
}

/** `scheme://host[:port]`, lowercased, or null when `u` is not an absolute URL. */
export function originOf(u: string): string | null {
  try {
    const parsed = new URL(String(u || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `value` looks like an absolute URL (has a scheme), e.g. `https:`. */
function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.\-]*:/i.test(value);
}

/**
 * Resolve an ARM/Graph-style `pathOrUrl` against `base`, allowing the absolute
 * form ONLY when it is same-origin with `base`.
 *
 * - `/subscriptions/…`           → `${base}/subscriptions/…`  (unchanged behaviour)
 * - `${base}/…?$skiptoken=…`     → returned verbatim (nextLink / LRO Location)
 * - `https://evil.example/…`     → throws {@link UntrustedEgressError}
 *
 * The origin check runs on the FINAL concatenated string, so a relative path
 * cannot smuggle a host either (`https://x@evil/`, `//evil`, `https:/evil`).
 */
export function resolveSameOriginUrl(base: string, pathOrUrl: string, label: string): string {
  const b = String(base || '').trim().replace(/\/+$/, '');
  const expected = originOf(b);
  if (!expected) {
    // A misconfigured base is a config bug, not a request bug — fail closed.
    throw new UntrustedEgressError(label, String(pathOrUrl ?? ''), `resolvable from a configured https base (got "${b}")`);
  }
  const p = String(pathOrUrl ?? '');
  const url = hasScheme(p) ? p : `${b}${p}`;
  if (originOf(url) !== expected) {
    throw new UntrustedEgressError(label, url, `same-origin with ${expected}`);
  }
  return url;
}

/** Structured, honest gate returned when a requested base is not configured. */
export interface ConfiguredBaseGate {
  /** The env var an operator must set to allow this destination. */
  missing: string;
  detail: string;
}

/**
 * Resolve a fetch base that a request may only SELECT from configuration.
 *
 * `allowed` is the operator-configured set (env-derived). When `requested` is
 * blank the first configured base is used. When `requested` is supplied it must
 * match a configured base (scheme+host+port+path, case-insensitive host,
 * trailing slashes ignored) — and the value RETURNED is the configured string,
 * not the requested one, so the bytes that reach `fetch` always came from
 * config.
 */
export function resolveConfiguredBase(
  requested: string | undefined | null,
  allowed: string[],
  gate: ConfiguredBaseGate,
): { base: string } | { gate: ConfiguredBaseGate } {
  const configured = (allowed || [])
    .map((v) => String(v || '').trim().replace(/\/+$/, ''))
    .filter((v) => !!v && !!originOf(v));
  const want = String(requested || '').trim().replace(/\/+$/, '');
  if (!want) {
    return configured.length ? { base: configured[0] } : { gate };
  }
  const norm = (v: string) => {
    const o = originOf(v);
    if (!o) return null;
    try {
      const u = new URL(v);
      return `${o}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  };
  const target = norm(want);
  const match = target ? configured.find((c) => norm(c) === target) : undefined;
  if (match) return { base: match };
  return {
    gate: {
      missing: gate.missing,
      detail:
        `"${want}" is not an approved endpoint for this deployment. ` +
        (configured.length
          ? `Approved: ${configured.join(', ')}. `
          : '') +
        `Add it to ${gate.missing} (comma-separated) on the Console Container App to allow it. ` +
        `Loom will not send an identity- or Key Vault-backed credential to an endpoint that is not configured.`,
    },
  };
}

/** Parse a comma/whitespace-separated env list of base URLs. */
export function parseBaseList(raw: string | undefined | null): string[] {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}
