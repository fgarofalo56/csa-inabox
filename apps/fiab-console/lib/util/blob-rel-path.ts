/**
 * blob-rel-path — shape check for a caller-supplied path INSIDE an ADLS / blob
 * container (#4619).
 *
 * Used by the console routes in #4619 that forward a request path to an ADLS
 * data-plane call (`setBlobTier`, `copyBlobToTier`, `removePrincipalFromPathAcl`,
 * the recorded Spark-environment library path). It answers one question: does
 * this string name a path strictly BELOW the container it will be joined to?
 *
 * Refused, each with its own reason so the 400 says which rule tripped:
 *   - empty input, or longer than 1024 characters (the blob-name ceiling);
 *   - a NUL or any other C0 control character, or DEL (U+0000-U+001F, U+007F);
 *   - a leading `/` or `\` (absolute form);
 *   - a `..` segment, with `/` AND `\` both treated as separators, so
 *     `a\..\b` is refused the same way `a/../b` is;
 *   - a `.` segment. The storage SDK URL builders fold it away, so `.` and `./`
 *     would name the container ROOT and `./x` would name `x` — not the path the
 *     caller spelled, and not a path below the container.
 *
 * NOT the same rule as `isSafePrefix` in `app/api/storage/_lib/validate.ts`,
 * which validates a LISTING prefix for the `/api/storage/**` browser: that one
 * accepts the empty prefix (the container root is a valid thing to list) and
 * additionally refuses `?`, `#` and a URL scheme, because its value is appended
 * to a data-plane URL as a query parameter; it does not refuse a leading
 * separator, a backslash-separated `..`, or a `.` segment. This function is for
 * a path that NAMES an object an operation acts on, so the root is never a
 * valid answer. `?` and `#` are not refused here: these values are passed to
 * the storage SDK as a blob / path name, never appended to a URL by the route,
 * and how the SDK encodes them is that library's rule, not this one's.
 *
 * Linear scans only — no quantified regex over request-reachable input (see
 * `lib/util/trim.ts` for why).
 */

/** Longest blob name Azure Storage accepts. */
export const MAX_BLOB_REL_PATH = 1024;

/**
 * Return why `p` is not a safe container-relative path, or `null` when it is.
 * The returned string is safe to put in a 400 body: it never echoes `p`.
 */
export function blobRelPathError(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'path is required';
  if (p.length > MAX_BLOB_REL_PATH) return `path must be at most ${MAX_BLOB_REL_PATH} characters`;
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return 'path must not contain NUL or control characters';
  }
  const first = p.charCodeAt(0);
  if (first === 0x2f /* / */ || first === 0x5c /* \ */) {
    return 'path must be relative to the container: no leading "/" or "\\"';
  }
  for (const seg of p.split(/[\\/]/)) {
    if (seg === '..') return 'path must not contain ".." segments';
    if (seg === '.') return 'path must not contain "." segments';
  }
  return null;
}
