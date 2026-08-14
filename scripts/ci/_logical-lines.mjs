/**
 * _logical-lines — fold a shell/YAML text into LOGICAL lines before judging it.
 * ---------------------------------------------------------------------------
 * NO SHEBANG — DO NOT RE-ADD ONE. This is a shared library, not a control;
 * `_`-prefixed files are excluded from check-ci-guard-reachability.mjs's
 * population precisely because they are not independently invoked.
 *
 * WHY THIS EXISTS (#3420, and the two guards that proved the class)
 * ----------------------------------------------------------------
 * A guard that keys on a token in one physical line and then requires a SECOND
 * token on that same physical line cannot see the second token when the shell
 * author put it on a backslash continuation. The guard reports clean and the
 * defect ships — which is worse than having no guard, because the zero gets
 * read as evidence.
 *
 * Measured twice, in two different guards:
 *
 *   check-curl-httpcode-fallback.mjs reported "0 concatenating fallbacks"
 *   against a tree carrying ELEVEN live `|| echo` sites. Every one had the
 *   `|| echo` on a continuation — a line with no `%{http_code}` on it, so the
 *   line was skipped before the fallback matcher ever ran (#3417).
 *
 *   `csa_loom_guard_blind_continuation_lines_scripts` records the same shape:
 *   a guard passing 10/10 on a tree carrying three live `|| true`s.
 *
 * And the two guards over the SAME construct disagreed for their entire lives —
 * check-httpcode-probe-aborts joined continuations from the day it was written,
 * check-curl-httpcode-fallback never did. Two private implementations of one
 * idea is how that divergence became possible, so there is now exactly one.
 *
 * WHAT IT DOES
 * ------------
 *   readLogicalLines(text) -> [{ line, text }]
 *
 * `line` is the 1-based number of the FIRST physical line of the logical line,
 * so an `::error file=…,line=…::` annotation still points at the invocation.
 * `text` is the joined command with each continuation's leading indentation
 * collapsed to a single space.
 *
 * TWO CORRECTNESS DETAILS that the promoted implementation did not have, both
 * of which are ways for a guard to go QUIET rather than noisy:
 *
 *   1. AN EVEN RUN OF TRAILING BACKSLASHES IS NOT A CONTINUATION. `foo \\` ends
 *      in an ESCAPED backslash and the command ends there; only an odd run
 *      splices the next line. Treating `\\` as a splice swallows the following
 *      line into a logical line the matcher then judges as one command.
 *
 *   2. A COMMENT DOES NOT CONTINUE. In shell a `#` comment runs to end of line
 *      and a trailing backslash inside it is just text. Splicing it would let
 *
 *          # example: curl -w '%{http_code}' \
 *          CODE=$(curl -sS -w '%{http_code}' "$URL" || echo 000)
 *
 *      hide a real violation behind a comment, because every guard here skips
 *      logical lines that START with `#`. That is a one-character exploit of a
 *      guard, so the comment terminates its own logical line.
 *
 * KNOWN LIMITS, stated rather than hidden:
 *   - Heredoc bodies are not modelled. A `\` at the end of a heredoc line is
 *     literal text, and this will splice it. Guards that care about heredocs
 *     (check-set-e-restore) track them separately, on physical lines.
 *   - Quoting is not modelled. A trailing `\` inside a single-quoted string is
 *     literal to the shell and is spliced here. Both directions of that error
 *     merge two lines that were already part of one quoted blob, so no guard in
 *     this repo changes verdict on it; if one ever does, it needs a real lexer,
 *     not a bigger regex.
 *   - It joins with whitespace of unspecified WIDTH (the backslash becomes a
 *     space and the join adds one), so a matcher must use `\s+` across a seam,
 *     never a literal single space.
 *
 * Tests: node --test scripts/ci/__tests__/logical-lines.test.mjs
 */

/** Number of backslashes immediately before end-of-line (after trailing blanks). */
function trailingBackslashRun(line) {
  const body = line.replace(/[ \t]+$/, '');
  let n = 0;
  for (let i = body.length - 1; i >= 0 && body[i] === '\\'; i--) n++;
  return n;
}

/**
 * Does this physical line splice the next one?
 * Odd run of trailing backslashes = continuation; even (including zero) = not.
 */
export function continuesToNextLine(line) {
  return trailingBackslashRun(line) % 2 === 1;
}

/** A line whose first non-blank character starts a comment. */
export function isCommentLine(line) {
  return /^\s*#/.test(line);
}

/**
 * Fold backslash continuations into logical lines.
 *
 * @param {string} text raw file contents (LF or CRLF)
 * @returns {{line:number,text:string}[]} one entry per logical line, in order
 */
export function readLogicalLines(text) {
  const phys = String(text).split(/\r?\n/);
  const out = [];
  let buf = null;
  let start = 0;

  for (let i = 0; i < phys.length; i++) {
    const line = phys[i];
    const starting = buf === null;

    if (starting) {
      buf = line;
      start = i;
    } else {
      buf += ' ' + line.replace(/^\s+/, '');
    }

    // A comment that STARTS a logical line ends it, whatever it trails with.
    // (Once inside a splice we keep going: the shell has already joined those
    // physical lines before it ever looks for a comment.)
    const spliceable = !(starting && isCommentLine(line));

    if (spliceable && continuesToNextLine(line)) {
      buf = buf.replace(/\\[ \t]*$/, ' ');
      continue;
    }

    out.push({ line: start + 1, text: buf });
    buf = null;
  }

  if (buf !== null) out.push({ line: start + 1, text: buf });
  return out;
}

export default readLogicalLines;
