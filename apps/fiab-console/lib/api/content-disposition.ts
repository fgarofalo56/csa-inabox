/**
 * content-disposition — build the header value for a file download.
 *
 * THE CLASS THIS CLOSES (CodeQL js/incomplete-sanitization, "remover" shape):
 * `filename="${name.replace(/"/g, '')}"` is not a complete escape of an
 * HTTP quoted-string:
 *
 *   • the BACKSLASH is left alone, so `evil\` renders `filename="evil\"` —
 *     `\"` is a quoted-pair (RFC 9110 §5.6.4), the closing quote is consumed
 *     and the quoted-string never terminates, so the client falls back to a
 *     filename Loom did not choose;
 *   • CR / LF are left alone. `path` on `/api/aml/runs/[runId]/artifact` and
 *     `filename` on `/api/lakehouse/download` are QUERY PARAMETERS, so a raw
 *     CRLF reaches a header value — undici throws `Invalid header value` and
 *     the download turns into a 502 instead of a 400;
 *   • non-ASCII is not representable in a quoted-string at all.
 *
 * Structural fix: build the header from a whitelist instead of removing
 * characters — an ASCII-only `filename=` token for legacy clients plus the
 * RFC 6266 / RFC 5987 `filename*=UTF-8''<pct-encoded>` form, which every
 * current browser prefers and which is percent-encoded (so no quote, no
 * backslash, no CR/LF can survive).
 */

/** Characters allowed verbatim in the legacy ASCII `filename=` fallback. */
const ASCII_SAFE = /[^A-Za-z0-9 ._()[\]{}+,@=-]+/g;

/**
 * `contentDisposition('attachment', 'q1 "báz".csv')`
 *   → `attachment; filename="q1 baz.csv"; filename*=UTF-8''q1%20b%C3%A1z.csv`
 */
export function contentDisposition(
  kind: 'attachment' | 'inline',
  filename: string,
  fallback = 'download',
): string {
  const raw = String(filename ?? '').replace(/[\r\n\0]/g, '');
  // Never let a path separator or a `..` traversal reach the client's save dialog.
  const base = raw.split(/[/\\]/).pop() || '';
  const ascii = base.replace(ASCII_SAFE, '_').replace(/^\.+/, '').slice(0, 120) || fallback;
  const utf8 = encodeURIComponent(base || fallback).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
