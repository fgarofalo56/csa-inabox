/**
 * lib/util/path-strings.ts — linear-time replacements for the trailing/leading
 * slash regexes (#2655, CodeQL js/polynomial-redos).
 *
 * THE SHAPE. `s.replace(/\/+$/, '')` is the idiom this repo uses ~35 times to
 * strip trailing slashes. It is anchored at `$` but NOT at `^`, so on input with
 * a long run of slashes that does NOT end the string the engine retries the
 * `/+` match from every slash position, each time scanning to the end and
 * failing. That is O(n²).
 *
 *   'a' + '/'.repeat(50_000) + 'b'
 *
 * Several of the reported call sites take that string straight from a request —
 * a lakehouse download path, a Key Vault URI — so a single request can burn
 * quadratic CPU on the server. Not memory-unsafe, but a cheap way to degrade a
 * shared BFF.
 *
 * The fix is not a cleverer regex. Trimming characters from an end is a job for
 * an index walk: obviously linear, obviously correct, and no engine to reason
 * about. Same approach taken for the OneLake host predicate in #2609, where the
 * regex was replaced with `splitUri()` + `lastIndexOf`.
 */

/** '/' */
const SLASH = 47;

/**
 * Strip every trailing '/' — the linear equivalent of `.replace(/\/+$/, '')`.
 *
 * Returns the input unchanged (same reference) when there is nothing to strip,
 * so the common case allocates nothing.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === SLASH) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Strip every leading '/' — linear equivalent of `.replace(/^\/+/, '')`. */
export function stripLeadingSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === SLASH) start++;
  return start === 0 ? s : s.slice(start);
}

/** Strip leading AND trailing '/' in one pass. */
export function trimSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === SLASH) start++;
  while (end > start && s.charCodeAt(end - 1) === SLASH) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/**
 * The final path segment — the linear equivalent of the `leaf()` helpers that
 * did `path.replace(/\/+$/, '')` then `lastIndexOf('/')`.
 *
 * Trailing slashes are ignored, so `/a/b/` yields `b` (not an empty string),
 * which is what every current caller expects.
 */
export function lastSegment(path: string): string {
  const t = stripTrailingSlashes(path);
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}
