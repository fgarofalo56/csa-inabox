/**
 * lib/util/path-strings.ts — slash-trimming for URI/path strings.
 *
 * THIS MODULE IS NOW A THIN FACADE OVER `lib/util/trim.ts`. It keeps its own
 * names because existing call sites and a 28-case test suite use them, but it
 * owns NO implementation.
 *
 * WHY. Two modules landed independently solving the same problem:
 *
 *   path-strings.ts  (#2655)  stripTrailingSlashes / stripLeadingSlashes /
 *                             trimSlashes / lastSegment
 *   trim.ts          (#2677)  trimCharEnd/Start/Char / trim*Slashes /
 *                             stripTrailingSemicolons / trimEdges / slugify
 *
 * Both replaced quadratic trailing-run regexes (`s.replace(/\/+$/, '')`) with
 * linear index scans, and both are correct. But TWO implementations of one
 * trimming rule is exactly the hazard `lib/sql/quoting.ts` exists to prevent:
 * a divergence in either copy becomes a latent ReDoS while the other copy's
 * tests still report green.
 *
 * Found when #2677 rebased onto main and the two collided at four call sites —
 * each having fixed a DIFFERENT subset. In `marketplace/mini-app`, main had
 * fixed `gatewayUrl` and #2677 had fixed `apiPath`; taking either side alone
 * would have silently left the other quadratic. That is the concrete cost of
 * duplication, not a hypothetical one.
 *
 * `trim.ts` is the strict SUPERSET — it generalises to any character, and it
 * carries the `slugify` fix for ~75 pasted quadratic slug builders, a class this
 * module never covered. So `trim.ts` is canonical and this file delegates.
 *
 * PREFER `lib/util/trim.ts` IN NEW CODE. This facade exists so the existing call
 * sites and their tests keep working without a rename sweep inside a security PR.
 */
import {
  trimTrailingSlashes,
  trimLeadingSlashes,
  trimSlashes as trimBothSlashes,
} from '@/lib/util/trim';

/** Strip every trailing '/'. Alias of `trim.ts` {@link trimTrailingSlashes}. */
export function stripTrailingSlashes(s: string): string {
  return trimTrailingSlashes(s);
}

/** Strip every leading '/'. Alias of `trim.ts` {@link trimLeadingSlashes}. */
export function stripLeadingSlashes(s: string): string {
  return trimLeadingSlashes(s);
}

/** Strip leading AND trailing '/'. Alias of `trim.ts` `trimSlashes`. */
export function trimSlashes(s: string): string {
  return trimBothSlashes(s);
}

/**
 * The final path segment, ignoring trailing slashes (`/a/b/` → `b`).
 *
 * Kept here rather than pushed into `trim.ts`: this is path semantics, not
 * character trimming. The "a trailing slash still yields the parent name"
 * behaviour is relied on by the lakehouse download filename, where an empty
 * name would be a user-visible bug rather than a style difference.
 */
export function lastSegment(path: string): string {
  const t = trimTrailingSlashes(path);
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}
