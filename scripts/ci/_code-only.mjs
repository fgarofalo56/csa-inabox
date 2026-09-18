/**
 * _code-only — the single JS/TS non-code masker for the raw-source CI guards.
 * ---------------------------------------------------------------------------
 * NO SHEBANG — DO NOT RE-ADD ONE. This is a shared library, not a control;
 * `_`-prefixed files are excluded from check-ci-guard-reachability.mjs's
 * population precisely because they are not independently invoked. Same
 * convention as _logical-lines.mjs / _ratchet-count.mjs / _gate-consumption.mjs.
 *
 * WHY THIS EXISTS (#4467, and the two rounds after it)
 * ---------------------------------------------------
 * A guard that applies a regex to RAW SOURCE is satisfied by a COMMENT. #4467
 * recorded that on check-route-toolkit: one sentence of prose in
 * app/api/copilot/orchestrate/route.ts excluded a live route from the ratchet,
 * and rewording that sentence moved the population with zero executable change.
 *
 * ROUND 1's fix was a LINE-PREFIX filter — drop any line whose trim() starts
 * with '//', '*' or '/*'. That closes ONE of the four shapes a comment takes;
 * a TRAILING comment, a block-comment body line with no leading asterisk, and a
 * block comment opened mid-line all still cloaked (measured 3 of 4 at a77ba98).
 *
 * ROUND 2 (PR #4593) wrote a hand-rolled scanner to close the other three and
 * SHIPPED A REGRESSION: it entered string mode on any quote and did not track
 * REGEX LITERALS, so a quote inside a regex character class opened a phantom
 * string and everything downstream was SKIPPED rather than blanked. Measured on
 * the real corpus, that made it WEAKER THAN MAIN on the one shape #4467 closed:
 *
 *   app/api/items/report/[id]/visual-data/route.ts — a regex char class holding
 *   `"` at :311 desyncs the scanner, and the pure line comment at :332 comes out
 *   BYTE-IDENTICAL. Main's line-prefix filter deletes it.
 *   Route corpus: 1 file / 19 surviving pure line-comment lines.
 *   Owner-only corpus (reviewer-measured): 35 files / 370 lines.
 *
 * That is fail-OPEN — the #4467 defect reintroduced by its own fix. The round-1
 * census could not have caught it: it looked only for files the stripper
 * UN-cloaks, never for files where it FAILS, and both the old filter and the
 * broken scanner leave such a comment in place, so the diff was empty by
 * construction. A control drawn from the population it is judging.
 *
 * THE FIX IS NOT A SEVENTH IMPLEMENTATION. `maskNonCode` in
 * check-external-origin-urls.mjs already tracked regex-literal bodies, template
 * substitutions and the `://` case — written for #3468 after this same class of
 * bug. This module now HOSTS that lexer and that guard imports it, so there is
 * one implementation rather than two that can drift.
 *
 * WHY THE `keepStrings` OPTION EXISTS — MEASURED, NOT PREFERRED
 * ------------------------------------------------------------
 * `maskNonCode` blanks string BODIES. That is right for check-external-origin-
 * urls (it hunts URL construction) and CATASTROPHIC for check-route-toolkit,
 * whose include arm is
 *
 *   AUTH_SESSION_IMPORT_RE  ->  import { getSession } from '@/lib/auth/session'
 *
 * i.e. the discriminating token is a MODULE PATH INSIDE A STRING. Adopting the
 * lexer unmodified takes the route-toolkit population from 1002 to **ZERO** —
 * measured, not feared — which is a merge-blocking ratchet reporting green over
 * an empty set. So the string arm is a parameter: the LEXER is shared (that is
 * where the correctness lives), the masking POLICY is per consumer.
 *
 * OFFSETS ARE PRESERVED EXACTLY — same length, same bytes outside masked
 * regions, newlines kept, and NO CRLF normalisation, so an offset or line
 * computed on the output is true of the ORIGINAL file. check-external-origin-
 * urls depends on that for its `line=` annotations; the two ratchet guards do
 * not report offsets, and for them it is simply the stronger invariant.
 *
 * DISCLOSED LIMITATION — the regex-vs-division heuristic. A `/` is division
 * when the previous significant character can end an expression
 * (`[A-Za-z0-9_$)\]]`) and starts a regex otherwise. That is the standard lexer
 * heuristic, inherited unchanged from #3468, and it is a heuristic: a `/` after
 * a construct this rule misreads can still desync. It is stated here rather
 * than claimed solved, and `check-external-origin-urls.mjs` carries a live-site
 * FLOOR (`MIN_FILES_WITH_URL_CTOR`) whose whole job is to fail if the mask ever
 * starts eating code.
 *
 * SIBLING SWEEP — #4467's last acceptance box, re-measured at this head after
 * round 1 published the wrong numbers (8 files and 5 copies; both were low).
 * `grep -rln "startsWith('//')" scripts/ci/*.mjs` returns **11**, and
 * `grep -rln "function blankComments" scripts/ci/*.mjs` returns **6**:
 *
 *   CONVERTED here (3): check-route-toolkit, check-owner-only-workspace-guard,
 *     check-external-origin-urls (the lexer's origin — its local copy is gone).
 *   NOT CONVERTED, and NOT checked for live cloaking — tracked in #4597:
 *     check-afd-endpoint-discovery      check-license-inventory
 *     check-deploy-paths-coverage       check-mcr-image-pins
 *     check-regex-anchor                check-roll-atomicity
 *     check-temp-artifact-safety        check-upstream-image-mirror
 *     ghsa-4gvx-mutation-receipts
 *   SIX blankComments-class copies, NOT equivalent to each other:
 *     check-editor-read-failure-honesty  check-indexer-health-honesty
 *     check-installed-content-reachable  check-module-existing-scope
 *     check-postgres-quota-gate          (+ this module)
 *   AND a SECOND, WEAKER `maskNonCode` in check-bff-errors.mjs:176 with no
 *   regex-literal or template tracking — the divergence #3468 warned about,
 *   already realised. All of it is #4597; none of it is a claim that any of
 *   them was checked and found clean.
 *
 *   Round 1 missed check-external-origin-urls in its own sweep — i.e. the
 *   enumeration missed the one file that would have changed the design. That is
 *   the finding, not a footnote.
 */

/**
 * Replace every non-code region with spaces, IN PLACE (same length, same
 * newlines), so any regex run over the result reports true source offsets.
 *
 * Handled: `//` line comments, block comments, `'…'`/`"…"` strings, `` `…` ``
 * templates (with `${…}` substitutions LEFT AS CODE, nested), and regex
 * literals. Quote/comment characters inside each other cannot confuse it
 * because there is exactly one pass with one state machine.
 *
 * @param {string} src
 * @param {{ keepStrings?: boolean }} [opts] `keepStrings` leaves string and
 *   template TEXT intact and masks only comments — required by any consumer
 *   whose predicate matches a string literal (see the header).
 * @returns {string}
 */
export function maskNonCode(src, opts = {}) {
  const keepStrings = opts.keepStrings === true;
  const s = String(src);
  const out = s.split('');
  let i = 0;
  let prev = ''; // last significant (non-space, non-blanked) character
  const tpl = [];

  const blank = (from, to) => {
    for (let k = from; k < to && k < s.length; k++) out[k] = s[k] === '\n' ? '\n' : ' ';
  };
  const canEndExpression = (c) => /[A-Za-z0-9_$)\]]/.test(c);

  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];

    if (tpl.length && tpl[tpl.length - 1].inSub) {
      const top = tpl[tpl.length - 1];
      if (c === '{') top.depth++;
      else if (c === '}') {
        if (top.depth === 0) {
          top.inSub = false;
          prev = '}';
          i++;
          continue;
        }
        top.depth--;
      }
      // else: fall through to the generic handling below
    } else if (tpl.length) {
      // Inside a template's TEXT: mask until ` or ${
      const top = tpl[tpl.length - 1];
      if (c === '\\') {
        if (!keepStrings) blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        tpl.pop();
        prev = '`';
        i++;
        continue;
      }
      if (c === '$' && c2 === '{') {
        top.inSub = true;
        top.depth = 0;
        prev = '{';
        i += 2;
        continue;
      }
      if (!keepStrings) blank(i, i + 1);
      i++;
      continue;
    }

    // ── line comment. `://` is NOT one: a bare `https://…` in JSX text is not
    // a comment, and truncating there deletes real code from the scan.
    //
    // The colon must be IMMEDIATELY adjacent, not merely the last significant
    // character. #3468 used `prev === ':'`, and `prev` survives newlines, so a
    // comment line ending in ':' protected the `//` on the NEXT line from being
    // masked. Measured on the route corpus at this head: 6 files / 12 pure
    // line-comment lines survived that main's filter removes — e.g.
    // app/api/azure/connectables/route.ts:78 ends "…reliable here:" and :79-81
    // then came through verbatim. `https://` always has the colon adjacent, so
    // narrowing costs that case nothing.
    if (c === '/' && c2 === '/' && s[i - 1] !== ':') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    // ── block comment
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end === -1 ? s.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }

    // ── string literal
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === c || s[j] === '\n') break;
        j++;
      }
      if (!keepStrings) blank(i + 1, j);
      prev = c;
      i = j < s.length && s[j] === c ? j + 1 : j;
      continue;
    }

    // ── template literal
    if (c === '`') {
      tpl.push({ inSub: false, depth: 0 });
      prev = '`';
      i++;
      continue;
    }

    // ── regex literal
    if (c === '/' && !canEndExpression(prev)) {
      let j = i + 1;
      let cls = false;
      let ok = false;
      while (j < s.length) {
        const d = s[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') break;
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        // The BODY is masked only when strings are; what matters for every
        // consumer is that the lexer CONSUMED it, so a quote or a `//` inside
        // it can no longer desync the scan.
        if (!keepStrings) {
          blank(i + 1, j);
          let k = j + 1;
          while (k < s.length && /[a-z]/.test(s[k])) k++;
          blank(j + 1, k);
          prev = '/';
          i = k;
          continue;
        }
        let k = j + 1;
        while (k < s.length && /[a-z]/.test(s[k])) k++;
        prev = '/';
        i = k;
        continue;
      }
      // not a regex after all — treat as an operator
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out.join('');
}

/**
 * The file with COMMENTS blanked and code, strings and regex literals intact —
 * what check-route-toolkit and check-owner-only-workspace-guard read source
 * through. Offsets are preserved exactly.
 *
 * NOTE for anyone tightening a predicate on top of this: a string literal is
 * still CODE here, so `const doc = 'use withSession(...)'` does satisfy an arm
 * that matches `withSession(`. That is deliberate — the alternative takes
 * route-toolkit's population to zero (see the header) — but it means a string
 * is a residual cloak for the EXCLUDE arm, narrower than the comment one that
 * #4467 was about, and it is stated rather than implied.
 */
export const codeOnly = (src) => maskNonCode(src, { keepStrings: true });

/** House name for the same operation; an alias, never a second implementation. */
export const blankComments = codeOnly;
