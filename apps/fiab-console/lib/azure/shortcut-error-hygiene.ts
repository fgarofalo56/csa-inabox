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

/** Any `scheme://…` run inside free text. */
const URL_IN_TEXT_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>]+)/gi;

/*
 * A SAS value ends at `&`, whitespace, a quote, `<`/`>`, `)`, `]` or `;` — none
 * of which a SAS value contains — so text that closes around it (a bracket, a
 * parenthesis, a connection-string separator) survives the redaction.
 */

/**
 * A SAS parameter `name=value`: after `?`/`&`, at the start of the text, or after
 * any character that cannot be part of a longer name (so `assign=` and
 * `turnkey=` are left alone).
 */
const SAS_PARAM_RE = /(?<![A-Za-z0-9_])((?:sig|signature|sv|se|sp|skoid|key)=)([^&\s"'<>)\];]*)/gi;

/** A function key `code=`, only in a query — elsewhere `code=` is usually an error code. */
const QUERY_CODE_RE = /([?&]code=)([^&\s"'<>)\];]*)/gi;

/** The same parameters URL-encoded (`sig%3D…`); the value ends at an encoded `&` (`%26`). */
const ENCODED_SAS_PARAM_RE =
  /(?:(?<=%26|%3[Ff])|(?<![A-Za-z0-9_%]))((?:sig|signature|sv|se|sp|skoid|key)%3[Dd])((?:(?!%26)[^&\s"'<>)\];])*)/gi;

/** A storage / Event Hubs / Service Bus connection-string secret; the value ends at `;`. */
const CONNECTION_STRING_SECRET_RE =
  /(?<![A-Za-z0-9_])((?:AccountKey|SharedAccessKey|SharedAccessSignature)=)([^;\s"'<>]*)/gi;

/** The same names as JSON members (`"sig":"…"`), including JSON escaped inside a string. */
const JSON_SECRET_RE =
  /(\\?"(?:sig|signature|sv|se|sp|skoid|key|accountKey|sharedAccessKey|sharedAccessSignature)\\?"\s*:\s*\\?")([^"\\]*)/gi;

/**
 * Strip the query string, fragment and (for http/https) user-info from every
 * URL in `text`. For `abfss://container@account…` the part before `@` is a
 * container name, not a credential, so it is kept. A `)` or `]` that closed
 * around the URL is kept too.
 */
export function stripUrlQueryAndCredentials(text: string): string {
  if (!text) return text;
  return String(text).replace(URL_IN_TEXT_RE, (_m, scheme: string, rest: string) => {
    let body = rest;
    const cut = body.search(/[?#]/);
    if (cut >= 0) body = body.slice(0, cut) + (body.slice(cut).match(/[)\]]+$/)?.[0] ?? '');
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
 * The ONE redactor for shortcut error text. URLs lose their query, fragment and
 * credentials; then every remaining secret value is replaced with `REDACTED`:
 * connection-string keys (`AccountKey=`, `SharedAccessKey=`,
 * `SharedAccessSignature=`), JSON members (`"sig":"…"`), URL-encoded SAS
 * parameters (`sig%3D…`), a query `code=`, and SAS parameters bare or in a
 * query (`sig=…`, `?sv=…&sig=…`, `[sig=…]`, `(sig=…)`).
 */
export function redactErrorText(text: string): string {
  if (!text) return text;
  const keep = (_m: string, name: string) => `${name}REDACTED`;
  return stripUrlQueryAndCredentials(String(text))
    .replace(CONNECTION_STRING_SECRET_RE, keep)
    .replace(JSON_SECRET_RE, keep)
    .replace(ENCODED_SAS_PARAM_RE, keep)
    .replace(QUERY_CODE_RE, keep)
    .replace(SAS_PARAM_RE, keep);
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
