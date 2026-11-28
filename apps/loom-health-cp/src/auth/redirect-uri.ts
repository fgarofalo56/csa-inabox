// redirect_uri / launchUri grammar (#5514). `new URL()` keeps hosts a browser and a CSP cannot treat safely
// (`https://evil;script-src/cb` has host `evil;script-src`), so the HOST is held to a strict grammar on top of the
// URL rules: a DNS name of LDH labels (no leading or trailing hyphen, at least one dot), `localhost`, or an IPv4
// dotted quad. Everything else is refused, including `; , * $ _`, quotes, whitespace, a trailing dot, and a
// bracketed IPv6 literal: a CSP host-source cannot carry an IPv6 address (CSP3 host-char is ALPHA / DIGIT / "-"),
// so the picker's form-action could never allow the redirect back to one (picker-page.ts CSP_HOST_SOURCE, #5513).
// Every host this accepts is therefore one that serializer accepts; test/auth-redirect-uri.test.ts pins that
// against the regex lifted from picker-page.ts.

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/** True for `localhost`, an IPv4 dotted quad, or a DNS name of at most 253 characters. Case-insensitive. */
export function isSafeUriHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || IPV4.test(h) || (h.length <= 253 && DNS_NAME.test(h));
}

/**
 * The one redirect/launch URI rule, at registration, PATCH and authorize: https (http only to loopback), no
 * credentials, no fragment, and a host isSafeUriHost accepts. The host is the PARSED one (what the browser goes
 * to, lowercased and percent-decoded by the URL parser), not a substring of the input.
 */
export function isSafeRedirectUri(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol !== 'https:' && !LOOPBACK_HTTP.test(v)) return false;
  return isSafeUriHost(u.hostname);
}

export const REDIRECT_URI_RULE = 'must be https (or loopback http) without credentials or fragment, with a DNS name, IPv4 address or localhost as its host';
