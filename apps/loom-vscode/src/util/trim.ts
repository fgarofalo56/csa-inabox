/**
 * Linear, ReDoS-safe string trims (no backtracking regex) — the extension-side
 * analogue of the Console's `lib/util/trim.ts`. `check-quadratic-trims` forbids
 * two-sided `/^x+|x+$/` run-trims because they can backtrack quadratically on a
 * pathological input; these char-scan helpers are O(n).
 */

/** Strip leading AND trailing '/' characters in a single linear pass. */
export function trimSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 47 /* '/' */) start++;
  while (end > start && s.charCodeAt(end - 1) === 47) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}
