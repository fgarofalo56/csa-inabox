/**
 * Redact secret query parameters from any ARM (or webhook) URL or error text
 * before it is returned to a browser or written to a log.
 *
 * Azure hands back invocable URLs and error strings that can embed a
 * signature (`sig=`) or a function key (`code=`) in the query. Those values are
 * secrets; the rest of the text is safe. This replaces the VALUE of a small
 * allowlist of secret parameter names with `REDACTED`, wherever the `name=value`
 * pair appears in a string, and leaves everything else intact so a real ARM
 * diagnostic (`code=` as an ARM ERROR CODE is a different token — see below) is
 * still legible.
 */

// Query secrets are `?name=value` / `&name=value`; an ARM error CODE is
// `"code": "..."` (JSON), never `code=` in a query, so this pattern does not
// touch it. Values run to the next `&`, quote, whitespace, or end.
const SECRET_QUERY_RE = /([?&](?:sig|code|sv|se|sp|skoid|sig|signature|key)=)([^&\s"'<>]*)/gi;

export function redactUrlSecrets(text: string): string {
  if (!text) return text;
  return String(text).replace(SECRET_QUERY_RE, (_m, prefix) => `${prefix}REDACTED`);
}
