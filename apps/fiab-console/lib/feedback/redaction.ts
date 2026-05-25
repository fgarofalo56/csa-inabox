/**
 * PII / customer-data redaction. Used by every outbound feedback path
 * (file-bug, request-feature, auto-issue-on-error, telemetry) before
 * payload leaves a customer tenant.
 *
 * Rules:
 *  - Never include the signed-in user's name, email, UPN, OID.
 *  - Never include workspace IDs, item IDs, or any GUIDs (could leak
 *    customer topology).
 *  - Never include URLs that contain a tenant-specific subdomain
 *    (loom-*.<region>.azurecontainerapps.io, *.fabric.microsoft.com,
 *    *.dfs.core.windows.net) — replace with placeholder.
 *  - Never include data values from BFF responses (tables, rows,
 *    query results). Only error class + stack frame paths within
 *    /lib + /app of the Loom bundle.
 *  - Replace anything matching email, phone, IPv4/6, credit-card,
 *    or 10+-char hex/base64 with [REDACTED:<kind>].
 */

const GUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const IPV4_RE  = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE  = /\b(?:[A-Fa-f0-9]{1,4}:){5,7}[A-Fa-f0-9]{1,4}\b/g;
const CC_RE    = /\b(?:\d[ -]?){13,19}\b/g;
const LONG_HEX_RE = /\b[A-Fa-f0-9]{32,}\b/g;
const TENANT_HOST_RE = /\b(loom-[a-z0-9-]+|[a-z0-9-]+\.fabric\.microsoft\.com|[a-z0-9-]+\.dfs\.core\.windows\.net|[a-z0-9-]+\.blob\.core\.windows\.net|[a-z0-9-]+\.azurecontainerapps\.io)\b/g;

const SAFE_STACK_PREFIXES = ['/lib/', '/app/', 'webpack-internal:///./lib/', 'webpack-internal:///./app/'];

export function redact(input: string): string {
  if (!input) return input;
  return input
    .replace(EMAIL_RE,       '[REDACTED:email]')
    .replace(PHONE_RE,       '[REDACTED:phone]')
    .replace(CC_RE,          '[REDACTED:cc]')
    .replace(IPV6_RE,        '[REDACTED:ipv6]')
    .replace(IPV4_RE,        '[REDACTED:ipv4]')
    .replace(TENANT_HOST_RE, '[REDACTED:tenant-host]')
    .replace(GUID_RE,        '[REDACTED:guid]')
    .replace(LONG_HEX_RE,    '[REDACTED:hex]');
}

/** Trim a stack trace to only frames inside Loom application code. */
export function redactStack(stack: string | undefined): string {
  if (!stack) return '';
  const lines = stack.split('\n');
  const kept = lines.filter((l) => SAFE_STACK_PREFIXES.some((p) => l.includes(p)));
  return redact(kept.slice(0, 12).join('\n'));
}

export interface ScrubbableEnv {
  url?: string;
  userAgent?: string;
  loomVersion?: string;
}

export function scrubEnv(env: ScrubbableEnv): ScrubbableEnv {
  return {
    // Keep only the route path, not the host or query.
    url: env.url ? new URL(env.url, 'https://x').pathname : undefined,
    userAgent: env.userAgent?.split(')')[0] + ')', // browser+OS family only
    loomVersion: env.loomVersion,
  };
}
