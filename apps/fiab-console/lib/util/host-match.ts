/**
 * Host matching for URL-boundary checks — the ONE definition.
 *
 * THE CLASS OF BUG THIS EXISTS TO KILL. Every one of these reads like a domain
 * check and is not one:
 *
 *   endpoint.includes('openai.azure.us')   → https://evil.com/?x=openai.azure.us
 *   vaultUri.includes('.usgovcloudapi.net')→ https://evil.com/.usgovcloudapi.net
 *   host.includes('.us')                   → login.contoso.com.usercontent.net
 *   host.endsWith('azconfig.io')           → evilazconfig.io  (a different
 *                                            registrable domain entirely)
 *   url.startsWith('https://learn.microsoft.com')
 *                                          → https://learn.microsoft.com.evil.com/
 *
 * The first three search the WHOLE URL, where the attacker controls the path,
 * query and fragment. The fourth omits the label boundary. The fifth omits the
 * boundary at the other end — the `.evil.com` suffix. All five accept a host the
 * author never intended.
 *
 * The correct check is always the same two steps, and both matter:
 *   1. PARSE the URL and take `hostname` — never substring the raw string.
 *   2. Match the host as a DNS LABEL: `host === suffix` OR `host` ends with
 *      `'.' + suffix`. The dot is the boundary; legitimate subdomains always
 *      carry it, and `evil<suffix>` never does.
 *
 * WHY THIS MODULE, AND WHY IT IS A LEAF. Two correct private implementations
 * already existed — `cloud-endpoints.ts` (with the reasoning written out in a
 * comment, from CodeQL #540) and `egress-ssrf.ts` — while four other call sites
 * kept substring-matching. The knowledge was in the repo and simply wasn't
 * reachable. A shared leaf module with no imports of its own is reachable from
 * anywhere, including the SSRF guard, with no cycle risk.
 */

/**
 * The lowercased hostname of `raw`, or null when it is absent or unparseable.
 *
 * Strips the root-label trailing dot: `contoso.com.` and `contoso.com` are the
 * same host to DNS, but not to `===`, so a trailing dot would otherwise walk
 * straight past an allowlist.
 */
export function hostOfUrl(raw: string | null | undefined): string | null {
  const v = (raw || '').trim();
  if (!v) return null;
  try {
    return new URL(v).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * True when `host` IS `suffix` or sits beneath it at a real DNS label boundary.
 *
 * `suffix` may be written with or without a leading dot — `.azurecontainerapps.io`
 * and `azurecontainerapps.io` behave identically — because both spellings are
 * already in use across the codebase and a silent mismatch here would fail OPEN.
 */
export function hostHasSuffix(host: string | null | undefined, suffix: string): boolean {
  if (!host || !suffix) return false;
  const h = host.toLowerCase().replace(/\.$/, '');
  const s = suffix.toLowerCase().replace(/^\./, '');
  if (!s) return false;
  return h === s || h.endsWith(`.${s}`);
}

/** `hostHasSuffix` against any of `suffixes` — the allowlist form. */
export function hostHasAnySuffix(host: string | null | undefined, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => hostHasSuffix(host, s));
}

/**
 * True when `url` parses AND its host sits under `suffix`. The single call that
 * replaces `url.includes('example.com')` at a boundary check.
 *
 * Fails CLOSED on an unparseable URL: a string that is not a URL cannot be shown
 * to be inside the boundary, so it is treated as outside.
 */
export function urlHostHasSuffix(url: string | null | undefined, suffix: string): boolean {
  return hostHasSuffix(hostOfUrl(url), suffix);
}
