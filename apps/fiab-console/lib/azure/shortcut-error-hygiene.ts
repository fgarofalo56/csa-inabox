/**
 * Error-message hygiene for the lakehouse shortcut surfaces.
 *
 * Shortcut errors reach API responses and the registry row's `statusDetail`.
 * Several upstream messages embed the request URL — `FetchTimeoutError`
 * (lib/azure/fetch-with-timeout.ts) names it, and an ADLS SAS request carries
 * its signature in the query — so every such message passes through
 * {@link redactErrorText} before it leaves the server or is stored, and a failed
 * outbound fetch is described by {@link networkFailureReason}, never by its
 * message.
 */
import { redactUrlSecrets } from '@/lib/azure/redact-url-secrets';

/** Any `scheme://…` run inside free text. */
const URL_IN_TEXT_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>]+)/gi;

/**
 * Strip the query string, fragment and (for http/https) user-info from every
 * URL in `text`. For `abfss://container@account…` the part before `@` is a
 * container name, not a credential, so it is kept.
 */
export function stripUrlQueryAndCredentials(text: string): string {
  if (!text) return text;
  return String(text).replace(URL_IN_TEXT_RE, (_m, scheme: string, rest: string) => {
    let body = rest;
    const cut = body.search(/[?#]/);
    if (cut >= 0) body = body.slice(0, cut);
    if (/^https?$/i.test(scheme)) {
      const slash = body.indexOf('/');
      const authority = slash >= 0 ? body.slice(0, slash) : body;
      const at = authority.lastIndexOf('@');
      if (at >= 0) body = authority.slice(at + 1) + (slash >= 0 ? body.slice(slash) : '');
    }
    return `${scheme}://${body}`;
  });
}

/**
 * The ONE redactor for shortcut error text: URLs lose their query, fragment and
 * credentials, and any remaining `?sig=` / `&sig=`-style secret parameter
 * (a bare SAS outside a URL) has its value replaced (`redactUrlSecrets`).
 */
export function redactErrorText(text: string): string {
  if (!text) return text;
  return redactUrlSecrets(stripUrlQueryAndCredentials(String(text)));
}

/**
 * A symbolic reason for a failed outbound fetch — a Node error code (e.g.
 * ENOTFOUND), `timeout`, or `network error`. Never the error message, which can
 * carry the request URL.
 */
export function networkFailureReason(e: any): string {
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  if (e?.name === 'FetchTimeoutError' || e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timeout';
  return 'network error';
}
