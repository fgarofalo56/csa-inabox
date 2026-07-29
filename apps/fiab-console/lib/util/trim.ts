/**
 * trim — linear-time character-run trimming.
 *
 * WHY THIS EXISTS (CodeQL js/polynomial-redos, 30+ instances): a trailing-run
 * regex such as `str.replace(/\/+$/, '')` is QUADRATIC — the engine retries
 * `X+$` at every offset of a long run of X, so an attacker-supplied
 * `"/".repeat(500_000) + "x"` in a request body pins a worker for seconds.
 * Same class as the FOCUS fingerprinter fix in `lib/finops/query-run.ts`
 * (619ms → 0ms). These helpers are single-pass index scans — O(n), no regex,
 * no backtracking — and are the sanctioned way to strip leading/trailing
 * character runs from request-reachable strings.
 */

/** Strip every trailing occurrence of the single character `ch` — linear. */
export function trimCharEnd(s: string, ch: string): string {
  const code = ch.charCodeAt(0);
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === code) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Strip every leading occurrence of the single character `ch` — linear. */
export function trimCharStart(s: string, ch: string): string {
  const code = ch.charCodeAt(0);
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === code) start++;
  return start === 0 ? s : s.slice(start);
}

/** Strip leading AND trailing runs of the single character `ch` — linear. */
export function trimChar(s: string, ch: string): string {
  return trimCharStart(trimCharEnd(s, ch), ch);
}

/** `"//a/b//"` → `"//a/b"` — replaces `replace(/\/+$/, '')`. */
export function trimTrailingSlashes(s: string): string {
  return trimCharEnd(s, '/');
}

/** `"//a/b//"` → `"a/b//"` — replaces `replace(/^\/+/, '')`. */
export function trimLeadingSlashes(s: string): string {
  return trimCharStart(s, '/');
}

/** `"//a/b//"` → `"a/b"` — replaces `replace(/^\/+|\/+$/g, '')`. */
export function trimSlashes(s: string): string {
  return trimChar(s, '/');
}

/** Strip leading AND trailing runs of ANY character in `chars` — linear. */
export function trimEdges(s: string, chars: string): string {
  const set = new Set([...chars]);
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start])) start++;
  while (end > start && set.has(s[end - 1])) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

export interface SlugifyOptions {
  /** Characters KEPT verbatim; everything else collapses to `sep`. */
  allow?: RegExp;
  /** Separator the disallowed runs collapse to (also the trimmed edge char). */
  sep?: string;
  /** Max length AFTER trimming. */
  max?: number;
  /** Lowercase before slugifying. Default true. */
  lower?: boolean;
  /** Returned when the slug comes out empty. */
  fallback?: string;
}

/**
 * The one slugifier. ~75 copies of
 *   `s.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,N)`
 * were pasted across the API routes and clients. Every one of them was
 * QUADRATIC (CodeQL js/polynomial-redos): when the "allow" class itself
 * contains the separator (`[^a-z0-9-]` permits `-`), a caller-supplied run of
 * separators is NOT collapsed, and the `-+$` branch then retries the whole run
 * from every offset — measured 1.35s at n=50k, ~135s at n=500k, i.e. one POST
 * body pins a worker for minutes.
 *
 * Here the edge trim is a linear index scan, so the shape cannot recur.
 */
export function slugify(input: string | null | undefined, opts: SlugifyOptions = {}): string {
  const sep = opts.sep ?? '-';
  const allow = opts.allow ?? /[^a-z0-9-]+/g;
  const lower = opts.lower !== false;
  const base = String(input ?? '');
  const collapsed = (lower ? base.toLowerCase() : base).replace(allow, sep);
  const trimmed = trimEdges(collapsed, sep);
  const sliced = opts.max ? trimEdges(trimmed.slice(0, opts.max), sep) : trimmed;
  return sliced || (opts.fallback ?? '');
}
