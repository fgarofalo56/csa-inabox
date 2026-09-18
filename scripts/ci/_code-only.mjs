/**
 * Shared comment stripper for the raw-source CI guards.
 * ---------------------------------------------------------------------------
 * NO SHEBANG — DO NOT RE-ADD ONE. This is a shared library, not a control;
 * `_`-prefixed files are excluded from check-ci-guard-reachability.mjs's
 * population precisely because they are not independently invoked. Same
 * convention as _logical-lines.mjs / _ratchet-count.mjs / _gate-consumption.mjs.
 *
 * WHY THIS EXISTS (#4467, and the round after it)
 *
 * A guard that applies a regex to RAW SOURCE is satisfied by a COMMENT. #4467
 * recorded that defect on `check-route-toolkit.mjs`, where a single sentence of
 * prose — "Unlike almost every sibling route this one is a bare handler, not
 * `withSession(...)`" — excluded a live route from the ratchet, and rewording
 * that sentence moved the population by one with zero executable change.
 *
 * The fix taken then was a LINE-PREFIX filter: drop any line whose trim()
 * starts with `//`, `*` or `/*`. That closes exactly ONE of the four shapes a
 * comment can take. Measured against the real `TOOLKIT_RE`, lifted from the
 * guard source rather than transcribed:
 *
 *   A  line-leading comment holding the wrapper name      -> blocked
 *   B  TRAILING comment on a code line                    -> STILL CLOAKED
 *   C  block-comment body line with no leading asterisk   -> STILL CLOAKED
 *   D  block comment opened mid-line                      -> STILL CLOAKED
 *
 * So the previous fix stopped one layer short of the control point, in exactly
 * the way its own header comment warns about. This module is a real scanner,
 * not a line filter, and both guards consume it so the fix cannot be applied to
 * one side of the symmetry and not the other.
 *
 * WHAT IT DOES
 *   - removes a line comment to end of line, wherever it starts on the line
 *   - removes a block comment, including mid-line and spanning lines
 *   - does NOT look inside string literals ('…', "…", `…`), so a URL
 *     ('https://x') or a string holding '/*' is left intact
 *   - preserves OFFSETS: the result has the same length and the same line and
 *     column geometry as the CRLF-normalised input (comment characters become
 *     spaces, newlines are kept), so a line- or offset-indexed consumer and any
 *     `line=` annotation it emits stay true
 *   - normalises CRLF to LF first: this working tree is CRLF, and a line rule
 *     split on '\n' alone leaves a trailing '\r' that silently defeats matching
 *
 * DISCLOSED LIMITATION — REGEX LITERALS ARE NOT TRACKED. Telling a regex
 * literal from division needs a real parser. The consequence is bounded and is
 * measured, not assumed: an unescaped `//` inside a regex literal is only
 * reachable in a character class (`/[//]/`), and `/*` cannot open a regex at
 * all. Where it did occur it would REMOVE text, which pushes an EXCLUDE arm
 * (TOOLKIT_RE) toward failing CLOSED — into the ratchet — and is therefore the
 * safe direction for the arm that matters. `scripts/ci/__tests__/
 * code-only-comment-stripper.test.mjs` pins the census: zero route files under
 * apps/fiab-console/app/api change verdict for this reason today.
 *
 * SIBLING SWEEP — #4467's last acceptance box asked which OTHER guards share
 * the shape, enumerated rather than "fixed the one that was caught". Measured
 * 2026-09-18 with `grep -rn "startsWith('//')" scripts/ci/*.mjs`, the JS/TS
 * line-prefix filters are:
 *
 *   CONVERTED by this change (both consume codeOnly):
 *     check-route-toolkit.mjs                 EXCLUDE arm — the #4467 defect
 *     check-owner-only-workspace-guard.mjs    INCLUDE arms — prior art, same
 *                                             filter byte-for-byte
 *
 *   NOT CONVERTED — enumerated, and deliberately left alone here:
 *     check-afd-endpoint-discovery.mjs        check-license-inventory.mjs
 *     check-deploy-paths-coverage.mjs         check-mcr-image-pins.mjs
 *     check-regex-anchor.mjs                  check-roll-atomicity.mjs
 *     check-temp-artifact-safety.mjs          check-upstream-image-mirror.mjs
 *
 *   WHY NOT: each of those carries its OWN ratchet baseline, and converting a
 *   filter changes which lines its arms can see — so each needs a per-guard
 *   population measurement and, where the count moves, a justified baseline
 *   regeneration. Doing eight of those inside the fix for this one would be a
 *   blast radius nobody could review. They are a tracked follow-up, NOT a claim
 *   that they were checked and found clean. Several also strip `#` (bicep/YAML,
 *   not JS) and would need a different scanner, not this one.
 *
 *   ALSO FOUND, and deliberately NOT touched here: FIVE private `blankComments`
 *   implementations already exist — check-editor-read-failure-honesty.mjs:200,
 *   check-indexer-health-honesty.mjs:81, check-installed-content-reachable.mjs:183,
 *   check-module-existing-scope.mjs:250, check-postgres-quota-gate.mjs:189 — and
 *   they are NOT equivalent: the editor-read-failure and module-existing-scope
 *   copies track string literals, the indexer-health copy is a bare regex pair
 *   that WILL blank the `//` inside 'https://x'. That is the divergence
 *   _logical-lines.mjs warns about ("two private implementations of one idea is
 *   how that divergence became possible"), already realised five times. This
 *   module matches the stronger semantic so it can be their single home; the
 *   consolidation itself is a separate change with its own per-guard receipts.
 */

/**
 * Blank every comment in `src`, PRESERVING OFFSETS — the output has the same
 * length and the same line/column geometry as the input, with comment
 * characters replaced by spaces (newlines kept). A line-indexed or
 * offset-indexed consumer is therefore unaffected.
 *
 * Offset-preserving rather than merely line-preserving on purpose: that is the
 * semantic five private `blankComments` copies in scripts/ci already use
 * (check-editor-read-failure-honesty, check-indexer-health-honesty,
 * check-installed-content-reachable, check-module-existing-scope,
 * check-postgres-quota-gate), so this module can become the one home they
 * converge on instead of becoming a sixth dialect. Only the two guards #4467
 * names are migrated here — see the SIBLING SWEEP note above.
 *
 * @param {string} src
 * @returns {string}
 */
export function blankComments(src) {
  const s = String(src).replace(/\r\n?/g, '\n');
  const out = s.split('');
  const n = s.length;
  let i = 0;

  const blank = (at) => {
    if (out[at] !== '\n') out[at] = ' ';
  };

  while (i < n) {
    const c = s[i];
    const d = s[i + 1];

    // ── string / template literal: skipped, never blanked ───────────────────
    // Handled FIRST so a '//' inside 'https://x' is not read as a comment, and
    // so an apostrophe inside a comment is not read as a quote.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === quote) { i++; break; }
        // An unterminated ' or " cannot span a line in JS — resync at the
        // newline rather than swallowing the rest of the file as string text.
        if (quote !== '`' && s[i] === '\n') break;
        i++;
      }
      continue;
    }

    // ── line comment ────────────────────────────────────────────────────────
    if (c === '/' && d === '/') {
      while (i < n && s[i] !== '\n') blank(i++);
      continue;
    }

    // ── block comment ───────────────────────────────────────────────────────
    if (c === '/' && d === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2; // unterminated: blank to EOF
      while (i < stop) blank(i++);
      continue;
    }

    i++;
  }

  return out.join('');
}

/**
 * The name the route-toolkit / owner-only guards read this through: "the file
 * as CODE ONLY". Same function — an alias, not a second implementation.
 */
export const codeOnly = blankComments;

