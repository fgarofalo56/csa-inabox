/**
 * internal-token single-writer guard (#3056).
 *
 * ── WHAT IT ENFORCES ─────────────────────────────────────────────────────────
 * The shared internal trust token has ONE owner: the live estate's
 * `loom-internal-token` Container Apps secret. bicep ADOPTS that value; it does
 * not mint one on an estate that already has a console. Two invariants keep
 * that true, and both are easy to undo by accident, so they are asserted here:
 *
 *  R1. `admin-plane/main.bicep` computes `loomInternalToken` from
 *      `loomInternalTokenValue` when supplied, falling back to the derived guid
 *      only when it is empty. If someone reverts that to a bare
 *      `guid(loomGeneratedSecretSeed, …)`, every deploy silently re-mints the
 *      token again — the exact defect that broke the estate three times in two
 *      days.
 *
 *  R2. Every workflow that runs `az deployment sub create` on
 *      `platform/fiab/bicep/main.bicep` first resolves the live value
 *      (`resolve-internal-token.sh`) AND passes `loomInternalTokenValue`. A
 *      deploy lane that skips either half is a lane that clobbers.
 *
 *  R3. Every invocation of the resolver leaves its STDOUT alone (#4061).
 *      `::add-mask::` is a workflow command the runner parses off the emitting
 *      process's stdout, so `… > /dev/null` discards the mask registration
 *      while the `$GITHUB_ENV` write happens anyway — and `$GITHUB_ENV` is
 *      job-level environment, which the runner renders in EVERY subsequent
 *      step's Run group. All four deploy lanes carried that shape, in a public
 *      repo. The stderr `log()` lines survived the same redirect, so the log
 *      looked healthy the whole time.
 *
 *      R3 keys on the SHAPE of the redirect rather than on the spelling
 *      `> /dev/null`: a stdout redirect anywhere on the invocation's logical
 *      line (`>`, `>>`, `1>`, `&>`, `>&`, `> "$F"`, with or without surrounding
 *      whitespace), a pipe, a mask-swallowing `$( )`, an `exec >` before it,
 *      and a redirect on the line that CLOSES its block (`}`, `)`, `done`,
 *      `fi`, `esac`). The resolver is matched by BASENAME, so a relative path
 *      or a `"$DIR/…"` prefix does not hide it.
 *
 *      `2>` is deliberately NOT flagged — moving stderr does not touch the
 *      mask.
 *
 *      STATED LIMITS, because a guard that overstates its reach is how the
 *      original defect survived review — and because R3 has now been defeated
 *      in three successive review rounds, every time by a case its author had
 *      not enumerated. R3 reasons about TEXT, not about a shell. Outside its
 *      reach, each MEASURED rather than assumed:
 *        - a redirect built at runtime (`R=">/dev/null"; bash script.sh $R`)
 *        - an `exec` in a sourced file
 *        - a path SPLICED across variables, where no single line carries the
 *          basename (`N=resolve-internal; bash "$D/$N-token.sh"`)
 *        - A FUNCTION WRAPPER whose CALL SITE carries the redirect:
 *              resolve() { bash …resolve-internal-token.sh --github-env; }
 *              resolve >/dev/null
 *          The invocation line is genuinely clean; catching this needs
 *          call-graph awareness, not a line matcher.
 *        - A MULTI-LINE command substitution, where `$(` opens on one physical
 *          line and the invocation sits on the next. `captured` looks only at
 *          text to the left ON THE SAME logical line, so the capture is
 *          invisible. Catching it needs `$(`-depth tracked across lines.
 *        - any wrapper that rebinds fd 1 in another process
 *      The script's own fail-closed check is the second layer, and it detects
 *      `/dev/null` and regular files on Linux only — not a pipe, not a `$( )`,
 *      not a closed descriptor.
 *
 * ── WHY A STATIC GUARD AT ALL ────────────────────────────────────────────────
 * The live drift guard (loom-internal-token-drift.yml) catches divergence AFTER
 * a deploy has already caused it. This one refuses to merge the change that
 * would cause it. They are complements, not duplicates: the estate-side guard
 * cannot run on a PR, and this one cannot see a hand-run `az deployment`.
 *
 * Mutation-proven in scripts/ci/__tests__/internal-token-single-writer.test.mjs:
 * strip the adopt step from a deploy lane, or revert the bicep var, and the
 * corresponding assertion goes red.
 *
 * Usage: node scripts/ci/check-internal-token-single-writer.mjs [repo-root]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { readLogicalLines, isCommentLine } from './_logical-lines.mjs';

/** The bicep module that owns the token expression. */
export const OWNER_BICEP = 'platform/fiab/bicep/modules/admin-plane/main.bicep';
/** The shared existing-value lookup every deploy lane must call. */
export const RESOLVER = 'scripts/csa-loom/resolve-internal-token.sh';
/**
 * Match the resolver by BASENAME, not by the full repo-relative path.
 *
 * `text.indexOf(RESOLVER)` could not see `bash ./resolve-internal-token.sh`
 * after a `cd`, nor `bash "$DIR/resolve-internal-token.sh"` — both invisible,
 * both counted as zero, and the repo-wide population check could not notice
 * because the four known lanes held the global count at 4. A sibling script in
 * `scripts/csa-loom/` calling it by relative path is the natural next caller.
 */
export const RESOLVER_RE = /resolve-internal-token\.sh/;
/** The ARM parameter that carries the adopted value. */
export const ADOPT_PARAM = 'loomInternalTokenValue';

/**
 * R1 — the bicep var must be conditional on the adopted value, not a bare mint.
 * @param {string} src contents of admin-plane/main.bicep
 * @returns {string[]} failures
 */
export function checkBicepAdopts(src) {
  const fail = [];
  const assign = src.match(/^var loomInternalToken\s*=([\s\S]*?)(?=\n(?:var|param|resource|module|output|@)\s)/m);
  if (!assign) {
    fail.push(
      `${OWNER_BICEP}: could not find the \`var loomInternalToken =\` assignment. ` +
        'This guard cannot verify what it cannot find, and a guard that silently passes when its ' +
        'target moved is worse than no guard. Update the guard alongside the rename.',
    );
    return fail;
  }
  const expr = assign[1];
  if (!expr.includes(ADOPT_PARAM)) {
    fail.push(
      `${OWNER_BICEP}: \`loomInternalToken\` no longer reads \`${ADOPT_PARAM}\`, so every deploy MINTS a ` +
        'new trust token. `loomGeneratedSecretSeed` defaults to newGuid() — the compiled template carries ' +
        '"defaultValue": "[newGuid()]" — so the value changes on every deployment and every holder outside ' +
        'that deployment (the consumer jobs, the LOOM_INTERNAL_TOKEN GitHub secret) is silently invalidated. ' +
        'That is #3056. Restore the adopt-or-mint form.',
    );
  }
  if (!/empty\(\s*loomInternalTokenValue\s*\)/.test(expr)) {
    fail.push(
      `${OWNER_BICEP}: \`loomInternalToken\` must fall back to a minted guid ONLY when ${ADOPT_PARAM} is ` +
        'empty (the greenfield case). Without the empty() guard a day-one deploy has no token at all and ' +
        'isValidInternalToken() fails closed on every internal callback (the #3089 class).',
    );
  }
  return fail;
}

/**
 * Strip whole-line comments before matching.
 *
 * Measured on the first run of this guard: it flagged `deploy.yml` and
 * `full-app-deploy-commercial.yml`, and BOTH were false positives from prose.
 * `deploy.yml` deploys `deploy/bicep/landing-zone-alz/main.bicep` and only
 * mentions the platform template in a header comment; `full-app-deploy-commercial.yml`
 * contains the sentence "this deliberately does NOT run `az deployment sub create`".
 * A guard that fires on a comment teaches people to ignore it, so the match is
 * made against executable lines only — the same comment-stripping discipline the
 * ratchet guard already uses.
 *
 * @param {string} src
 * @returns {string} src with `#`-comment lines removed
 */
export function stripCommentLines(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/**
 * Does this workflow actually APPLY the platform template (as opposed to
 * merely mentioning it)? Requires `--template-file` and the platform path on
 * the SAME executable COMMAND, plus a real `az deployment sub create`.
 *
 * THE SAME COMMAND, NOT THE SAME PHYSICAL LINE (#3420). An `az deployment sub
 * create` is always wrapped, and both halves of this predicate can land on
 * different continuations:
 *
 *     az deployment sub create \
 *       --template-file \
 *         platform/fiab/bicep/main.bicep
 *
 * A physical-line read then answers FALSE, and answering false here does not
 * report a violation — it SKIPS the lane entirely, so R2 never asks whether the
 * lane resolves the internal token. That is the silent direction: a deploy lane
 * that applies main.bicep without the token reads as "not a deploy lane". The
 * `az deployment sub create` pre-filter is folded for the same reason.
 *
 * @param {string} src workflow contents
 * @returns {boolean}
 */
export function appliesPlatformTemplate(src) {
  const code = stripCommentLines(src);
  const logical = readLogicalLines(code).map((l) => l.text);
  if (!/az\s+deployment\s+sub\s+create/.test(logical.join('\n'))) return false;
  return logical.some((l) => l.includes('--template-file') && l.includes('platform/fiab/bicep/main.bicep'));
}

/**
 * R2 — every lane that applies main.bicep must resolve AND pass the value.
 * @param {string} name workflow filename
 * @param {string} src workflow contents
 * @returns {string[]} failures
 */
export function checkDeployLane(name, src) {
  const fail = [];
  if (!appliesPlatformTemplate(src)) return fail;

  const code = stripCommentLines(src);
  if (!code.includes(RESOLVER)) {
    fail.push(
      `${name} applies platform/fiab/bicep/main.bicep but never calls ${RESOLVER}. ` +
        'It therefore deploys with no adopted token and bicep re-mints one, stranding the consumer jobs ' +
        'and the LOOM_INTERNAL_TOKEN GitHub secret (#3056).',
    );
  }
  if (!code.includes(ADOPT_PARAM)) {
    fail.push(
      `${name} applies platform/fiab/bicep/main.bicep but never passes \`${ADOPT_PARAM}\`. ` +
        'Resolving the live value and then not passing it is the same clobber with extra steps.',
    );
  }
  return fail;
}

/* ── R3 — the resolver's stdout must reach the runner (#4061) ─────────────── */

/**
 * Modes the resolver accepts. The script itself treats a missing mode as
 * `--export`, and so does this classifier — an invocation with no mode prints
 * the secret exactly as an explicit `--export` would.
 */
export const RESOLVER_MODES = ['--github-env', '--fingerprint', '--rotate', '--export'];

/**
 * Any redirect that moves fd 1: `>`, `>>`, `1>`, `1>>`, `&>`, `>&`.
 *
 * `2>` and `2>&1` are deliberately NOT matched. Moving stderr cannot destroy a
 * stdout workflow command, and `2>"$ERR_FILE"` is a shape this repo uses on
 * purpose — per deploy-integrity R7 stderr is captured, never discarded.
 *
 * NO LEADING-SEPARATOR REQUIREMENT. An earlier form required whitespace (or one
 * of `;&|(`) immediately before the operator, which let `--github-env>/dev/null`
 * — valid bash, verified — read as clean. The operator is now matched wherever
 * it appears; `(?<![02-9])` is what keeps `2>` (and any other explicit fd) out,
 * while still admitting `1>` and `&>`.
 */
export const STDOUT_REDIRECT = /(?<![02-9])>/;

/** A real pipe, not the `||` control operator. */
export const PIPE = /(?<!\|)\|(?!\|)/;

/**
 * Redirections that move stdout for a WHOLE BLOCK rather than for one command,
 * split by the DIRECTION they must be scanned in — scanning both ways with one
 * pattern is what produced a false positive on an unrelated later `exec`.
 *
 * EXEC_REDIRECT rebinds fd 1 for everything AFTER it, so it only matters when it
 * appears BEFORE the invocation. It is not anchored to line-start: `set -e; exec
 * >/dev/null` and `true && exec >/dev/null` both swallow the mask, and both were
 * invisible to a `^\s*exec` match.
 *
 * CLOSER_REDIRECT rides the line that CLOSES a compound command, so it only
 * matters AFTER the invocation. The closers are not just `}` and `)`: measured
 * in bash 5.3.15, `done`, `fi` and `esac` swallow the workflow command exactly
 * the same way, and an enumeration that stopped at braces was the identical
 * shape of blindness it was written to fix.
 */
export const EXEC_REDIRECT = /(?<![\w-])exec\s*(?:[1&]\s*)?>/;
/**
 * A line that CLOSES a compound command. Identifying the KEYWORD is
 * deliberately separated from judging the REDIRECT.
 *
 * An earlier form required the operator IMMEDIATELY after the keyword
 * (`(?:[})]|done|fi|esac)\s*(?:[1&]?>|\|)`), so two natural shapes slipped:
 * `} 2>&1 >/dev/null` (stderr moved first, then stdout) and
 * `done < /dev/null >/dev/null` (the ordinary `while read … done < file` form).
 * That is the same mistake this guard has now made three times — enumerating
 * positions instead of generalising. The keyword now only says "this line
 * closes a block"; STDOUT_REDIRECT/PIPE judge the rest of it.
 * The `\b` applies ONLY to the word keywords. `}` and `)` are non-word
 * characters, and a `\b` between `}` and a following space matches nothing —
 * which silently un-caught every brace-group and subshell case the moment this
 * was generalised. The tests caught it; the shape is worth remembering.
 */
export const CLOSER_LINE = /^\s*(?:[})]|(?:done|fi|esac)\b)/;

/**
 * Blank out quoted spans so a `>` or `|` INSIDE an argument is not read as a
 * redirect. `--query "a > b"` on the same logical line as an invocation used to
 * turn the whole line red. A guard that cries wolf gets ignored, which costs
 * more than the case it was protecting.
 *
 * IT FOLLOWS BASH'S REAL QUOTING RULES, and the reason is a regression this
 * function itself caused. A first cut had no backslash handling at all, so in
 * `--label "a\"b" >/dev/null` it closed the string on the ESCAPED quote and
 * reopened on the final one — blanking everything after it, including the real
 * `>/dev/null`. It stopped seeing a redirect it used to see, in the service of
 * a false-positive fix. So:
 *
 *   - inside single quotes NOTHING escapes; the string ends at the next `'`
 *   - inside double quotes and outside quotes, `\` escapes the next character
 *   - an escaped character is never an operator, so `\>` is blanked too
 *
 * Length is preserved so any index computed against the original still lines up.
 *
 * @param {string} text
 * @returns {string}
 */
export function blankQuotedSpans(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      // Single quotes: a backslash is literal text, not an escape.
      out += c === "'" ? c : ' ';
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < text.length) {
      // The escape and what it escapes are both inert as operators.
      out += '  ';
      i += 1;
      continue;
    }
    if (quote === '"') {
      out += c === '"' ? c : ' ';
      if (c === '"') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      quote = c;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Strip an inline `#` comment so a comment cannot decide the verdict.
 *
 * This is not cosmetic. `--export  # TODO: move to --github-env` used to
 * classify as `--github-env` — the mode was chosen by scanning the whole tail
 * and taking the first hit in RESOLVER_MODES order, so a mode named only in
 * PROSE outranked the one actually passed. That is a one-comment bypass of the
 * guard, on the single shape that prints the token straight into the log.
 *
 * TWO CORRECTNESS DETAILS, BOTH LEARNED THE HARD WAY:
 *
 * 1. A backslash escapes ONLY outside single quotes. A first fix applied the
 *    skip unconditionally, so `echo 'a\' ; bash …resolve-internal-token.sh # --github-env`
 *    read as an unterminated quote — bash sees a TERMINATED string containing a
 *    literal backslash. The function bailed, the comment survived, and the mode
 *    came out of the prose again: the exact defect this function exists to
 *    close, resurrected by its own fix.
 * 2. AN UNTERMINATED QUOTE FAILS CLOSED, not open. Returning the whole line
 *    PRESERVES the comment, and a preserved comment can only ever DOWNGRADE the
 *    verdict (a mode named in prose outranks the real one). Cutting at the first
 *    candidate `#` can only remove text, which drives the mode toward the
 *    `--export` default — the shape that goes RED. When the parse is
 *    ambiguous, take the direction that cannot hide a leak.
 *
 * @param {string} text
 * @returns {string} text with any unquoted `#` tail removed
 */
export function stripInlineComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i += 1; // outside quotes, or inside "" — the next character is literal
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  if (quote !== null) {
    // Unterminated: fail CLOSED (see 2 above).
    const m = /(?:^|\s)#/.exec(text);
    if (m) return text.slice(0, m.index === 0 ? 0 : m.index + 1);
  }
  return text;
}

/**
 * Describe one resolver invocation found on a logical line.
 *
 * @param {string} text a logical (continuation-folded) line
 * @returns {{mode:string,captured:boolean,evaled:boolean,redirected:boolean,piped:boolean}|null}
 */
export function classifyResolverInvocation(text) {
  const code = stripInlineComment(text);
  const at = code.search(RESOLVER_RE);
  if (at < 0) return null;
  const m = code.match(RESOLVER_RE);
  const head = code.slice(0, at);
  const tail = code.slice(at + m[0].length);
  // Mode is chosen by POSITION in the string, not by RESOLVER_MODES order: with
  // order precedence, a line naming two modes was judged on whichever happened
  // to sit earlier in the array rather than on the one the shell would use.
  //
  // The terminator is `(?![\w-])`, not `(?:\s|$)`: a captured invocation ends in
  // `)` — `FP=$(… --fingerprint)` — and a whitespace-or-end terminator does not
  // match there, so every captured call silently fell back to `--export`.
  let mode = '--export';
  let best = Infinity;
  for (const cand of RESOLVER_MODES) {
    const hit = new RegExp(`(?:^|\\s)${cand}(?![\\w-])`).exec(tail);
    if (hit && hit.index < best) {
      best = hit.index;
      mode = cand;
    }
  }
  // Redirects and pipes are tested across the WHOLE line, not just the tail.
  // `>/dev/null bash …resolve-internal-token.sh --github-env` is valid bash
  // (verified) and puts the redirect entirely to the LEFT of the invocation,
  // where a tail-only test cannot see it. Quoted spans are blanked first so a
  // `>` inside an argument is not mistaken for an operator.
  const bare = blankQuotedSpans(code)
  return {
    mode,
    // An unclosed `$(` or backtick to our left means our stdout is being
    // CAPTURED by the caller's shell rather than reaching the runner.
    captured: /\$\([^)]*$/.test(head) || /`[^`]*$/.test(head),
    evaled: /\beval\b/.test(head),
    redirected: STDOUT_REDIRECT.test(bare),
    piped: PIPE.test(bare),
  };
}

const R3_WHY =
  'The mask is a workflow command the runner parses off this process\'s STDOUT. Anything that ' +
  'moves, discards or swallows that stream destroys the ::add-mask:: registration while the ' +
  '$GITHUB_ENV write still happens — and $GITHUB_ENV is JOB-level environment, which the runner ' +
  'renders in every subsequent step. That is #4061: the live token published in a public repo, ' +
  'with the stderr log() lines surviving the same redirect so the log looked healthy.';

/**
 * The physical-line range of the `run:` block (or whole file) containing a
 * given line, so a block-level redirect can be attributed to the invocation it
 * silences.
 *
 * @param {string[]} lines physical lines
 * @param {number} idx 0-based index of the invocation's first physical line
 * @returns {[number, number]} [start, end) as 0-based indices
 */
export function enclosingBlock(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(/^(\s*)(?:-\s*)?run:/);
    if (!m) continue;
    const indent = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (lines[j].match(/^\s*/)[0].length <= indent) {
        end = j;
        break;
      }
    }
    return [i + 1, end];
  }
  // No `run:` above it — a plain shell script. The whole file is the block.
  return [0, lines.length];
}

/**
 * R3 — every invocation leaves stdout alone, and uses a mode whose stdout is
 * safe to leave alone.
 *
 * @param {string} name file path, for the message
 * @param {string} src file contents
 * @returns {{failures:string[],invocations:number}}
 */
export function checkResolverInvocation(name, src) {
  const failures = [];
  const physical = String(src).split(/\r?\n/);
  let invocations = 0;

  for (const { line, text } of readLogicalLines(src)) {
    if (isCommentLine(text)) continue;
    const inv = classifyResolverInvocation(text);
    if (!inv) continue;
    invocations += 1;
    const at = `${name}:${line}`;

    if (inv.redirected || inv.piped) {
      const what = inv.redirected ? 'redirects' : 'pipes';
      failures.push(
        `${at} ${what} the resolver's stdout. ${R3_WHY} Use \`--github-env\` with NO redirect: ` +
          'it writes $GITHUB_ENV itself and prints only the mask, so there is nothing to discard.',
      );
      continue;
    }

    // A redirect on the ENCLOSING block never appears on the invocation's own
    // line, and swallows the mask just as completely. The two directions are
    // scanned separately: an `exec` only matters BEFORE the invocation, a
    // closing-keyword redirect only AFTER. Scanning both ways for both shapes
    // is what made an unrelated later `exec >` in a plain .sh flag a clean
    // invocation.
    //
    // NO DEDENT BOUND ON THE FORWARD SCAN. A first fix stopped at the first
    // line dedented past the invocation, reasoning that it was the closer. It
    // is the INNER closer: with
    //
    //     {
    //       {
    //         bash …resolve-internal-token.sh --github-env
    //       }
    //     } >/dev/null
    //
    // the scan hit the inner `}`, stopped, and never reached the redirect —
    // measured GREEN, and measured in bash to swallow the mask. Six nesting
    // variants behaved identically, and a conventionally-formatted `case` whose
    // `;;` sits below the body defeated the `esac` arm the same way. The
    // false positive that motivated the bound was an `exec >` AFTER the
    // invocation, and the direction split already fixes that on its own — so
    // the bound bought nothing and cost the whole nested class.
    const [bs, be] = enclosingBlock(physical, line - 1);
    const inv0 = line - 1;
    let blockHit = null;

    for (let i = bs; i < inv0 && blockHit === null; i++) {
      if (isCommentLine(physical[i])) continue;
      if (EXEC_REDIRECT.test(blankQuotedSpans(stripInlineComment(physical[i])))) blockHit = i;
    }
    for (let i = inv0 + 1; i < be && blockHit === null; i++) {
      if (isCommentLine(physical[i])) continue;
      const t = blankQuotedSpans(stripInlineComment(physical[i]));
      // The keyword identifies the line; the operator may sit anywhere after it.
      if (CLOSER_LINE.test(t) && (STDOUT_REDIRECT.test(t) || PIPE.test(t))) blockHit = i;
    }

    if (blockHit !== null) {
      failures.push(
        `${at} sits in a block whose stdout is redirected at ${name}:${blockHit + 1} ` +
          `(\`${physical[blockHit].trim()}\`). The invocation itself looks clean, which is exactly why this ` +
          `has to be checked separately. ${R3_WHY}`,
      );
      continue;
    }

    if (inv.mode === '--github-env' && inv.captured) {
      failures.push(
        `${at} captures \`--github-env\` in a command substitution. A \`$( )\` swallows the mask ` +
          `exactly as \`> /dev/null\` did. ${R3_WHY} Call it as a plain command.`,
      );
      continue;
    }

    if (inv.mode === '--export' && !inv.captured) {
      failures.push(
        `${at} runs \`--export\` without capturing it. That mode PRINTS THE TOKEN by design — ` +
          'that is the eval contract — so an uncaptured call writes the secret straight into the ' +
          'log. In a workflow use `--github-env`; in a shell use `eval "$(… --export)"`.',
      );
      continue;
    }

    if (inv.mode === '--export' && inv.captured && !inv.evaled) {
      failures.push(
        `${at} captures \`--export\` into something other than an \`eval\`. Its stdout is shell ` +
          'code, and the `::add-mask::` registration is part of that code — captured and never ' +
          'run, the value is assigned to a variable and never masked. Use `eval "$(… --export)"`.',
      );
    }
  }

  return { failures, invocations };
}

/**
 * Files that could plausibly invoke the resolver. Deliberately BROADER than the
 * four deploy lanes: a guard scoped to the files that already carry the defect
 * cannot see the fifth caller, and `check-cloud-endpoint-literals`' SCOPE_DIRS
 * hole is the standing example of that failure mode in this repo.
 *
 * @param {string} root repo root
 * @returns {string[]} repo-relative paths
 */
export function callerCandidates(root) {
  const out = [];
  const walk = (absDir, wanted) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // a missing tree is reported by the zero-population check, not here
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(abs, wanted);
      } else if (wanted.some((ext) => e.name.endsWith(ext))) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  walk(resolve(root, '.github'), ['.yml', '.yaml', '.sh']);
  walk(resolve(root, 'scripts'), ['.sh']);
  return out.sort();
}

/** @param {string} root repo root */
export function run(root) {
  const failures = [];

  failures.push(...checkBicepAdopts(readFileSync(resolve(root, OWNER_BICEP), 'utf8')));

  const wfDir = resolve(root, '.github/workflows');
  const lanes = readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  let checked = 0;
  for (const f of lanes) {
    const src = readFileSync(join(wfDir, f), 'utf8');
    if (appliesPlatformTemplate(src)) checked += 1;
    failures.push(...checkDeployLane(f, src));
  }

  // R3 over every plausible caller, not only the deploy lanes.
  let invocations = 0;
  for (const rel of callerCandidates(root)) {
    let src;
    try {
      src = readFileSync(resolve(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (!RESOLVER_RE.test(src)) continue;
    const r = checkResolverInvocation(rel, src);
    invocations += r.invocations;
    failures.push(...r.failures);
  }

  // A guard that inspected ZERO deploy lanes has measured nothing. Fail rather
  // than print a green line over an empty set.
  if (checked === 0) {
    failures.push(
      'No workflow was found that applies platform/fiab/bicep/main.bicep. Either the deploy lanes moved ' +
        '(update this guard) or the glob is wrong — either way this run verified nothing.',
    );
  }
  // Same accounting for R3. Four deploy lanes call the resolver; if that count
  // drops to zero, every R3 "pass" is vacuous and the zero is not evidence.
  if (invocations === 0) {
    failures.push(
      `R3 found ZERO invocations of ${RESOLVER} under .github/** or scripts/**. Either every deploy ` +
        'lane stopped adopting the estate token (R2 should have caught that), or the callers moved out ' +
        "of this guard's reach. An empty population is an unmeasured tree, not a pass (#4061).",
    );
  }

  return { failures, checked, invocations };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  const root = process.argv[2] || process.cwd();
  const { failures, checked, invocations } = run(root);
  if (failures.length > 0) {
    for (const f of failures) console.error(`[internal-token-single-writer] FAIL — ${f}`);
    console.error(
      '[internal-token-single-writer] See docs/fiab/runbooks/internal-token-ownership.md for the ownership model.',
    );
    process.exit(1);
  }
  console.log(
    `[internal-token-single-writer] PASS — bicep adopts the estate value; ${checked} deploy lane(s) resolve ` +
      `and pass it; ${invocations} resolver invocation(s) leave stdout intact.`,
  );
}
