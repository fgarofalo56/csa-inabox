/**
 * _publication-surfaces.mjs — enumerate every PUBLICATION SURFACE in a script,
 * mechanically, so a redaction guard cannot be written against a hand-listed
 * subset of them.
 *
 * NO SHEBANG, `_`-PREFIXED, NOT `*.test.mjs`. It is a shared test library, not a
 * control and not a suite: `check-ci-guard-reachability.mjs` excludes
 * `__tests__/` and `_`-prefixed files from its population, and
 * `check-node-test-suites.mjs` discovers `*.test.<ext>` only, so this file is
 * neither expected to be invoked by a workflow nor run as a suite.
 *
 * WHY THIS EXISTS (#3829 round 5)
 *
 *   PR #3835 ran four rounds and every round was the SAME defect: a publication
 *   surface is given a redaction boundary, its NEIGHBOUR is left uncovered, and
 *   the fix asserts the enumeration is complete. Round 2 was specifically the
 *   discovery that stderr publishes; round 4 bounded stdout in
 *   deploy-notify-failure.mjs and left stderr in THAT SAME FILE bare, with a
 *   structural assertion whose regex — `process\.stdout\.write` — could not see
 *   a stderr write even in principle.
 *
 *   A guard scoped to the surface the author happened to be thinking about is
 *   how that recurs. So the enumeration is done by this module, over the SOURCE,
 *   and each suite asserts a property of the whole set rather than of one row:
 *
 *     every stream write's argument begins with a call to a NAMED function that
 *     is either a redaction boundary or a counted, disclosed exception.
 *
 *   Adding `process.stderr.write(`oops ${id}`)` to any of the three scripts goes
 *   red because the argument begins with a template literal. Adding a fifth
 *   `unredactedByDesign()` goes red because its count is pinned. Neither needs
 *   anyone to remember to extend a list.
 *
 * THE TWO WAYS THIS COULD MEASURE NOTHING, and what stops each
 *
 *   1. COMMENTS. All three scripts document their own write sites in prose —
 *      `deploy-notify-failure.mjs`'s header literally contains the string
 *      `process.stdout.write(formatStdout(…))`. A scan that counted those would
 *      inflate every count and, worse, a violation could be hidden by writing it
 *      inside a comment-looking construct. Comments are stripped first, and
 *      `stripComments()` carries its own embedded controls in each suite (it
 *      really removes a comment; it really keeps code).
 *
 *   2. CRLF. Every one of these files is CRLF in a Windows working tree and LF
 *      in CI (`.gitattributes` marks them `text`). A matcher anchored with
 *      `[^\n]*` silently captures a trailing `\r`, and a mutation needle spliced
 *      in with `\n` line endings can no-op against a `\r\n` file
 *      (csa_loom_crlf_makes_mutation_needles_silently_noop). Everything here
 *      normalizes to `\n` before matching.
 */

/**
 * Remove `//` line comments and block comments, preserving line structure so a
 * reported line number still means something.
 *
 * STRING LITERALS ARE TRACKED, AND THAT IS NOT OPTIONAL. All three of these
 * scripts carry `'https://github.com'` / `'https://api.github.com'`, and a
 * stripper that treated the `//` inside a string as a comment would blank the
 * REST OF THAT LINE — which is the dangerous direction of the two, because it
 * removes code the guard is supposed to judge. `'` / `"` / `` ` `` all open a
 * literal, `\` escapes the next character, and a comment's apostrophes are
 * consumed while in comment state so `don't` in prose cannot throw off quote
 * parity.
 *
 * DELIBERATELY NOT A PARSER. Regex literals are not modelled; in this corpus
 * every regex carries balanced quotes or none, and the failure mode of getting
 * one wrong is a WRONG count, which is loud. What it must never do is silently
 * stop finding writes — which the embedded controls in each suite pin, by
 * asserting a known write survives the strip and known prose does not.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  const text = String(src).replace(/\r\n/g, '\n');
  let out = '';
  let state = 'code'; // code | line | block | sq | dq | tpl
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);

    if (state === 'line') {
      if (c === '\n') {
        out += '\n';
        state = 'code';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (two === '*/') {
        out += '  ';
        state = 'code';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (state === 'sq' || state === 'dq' || state === 'tpl') {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
        state = 'code';
      }
      i += 1;
      continue;
    }

    // state === 'code'
    if (two === '//') {
      out += '  ';
      state = 'line';
      i += 2;
      continue;
    }
    if (two === '/*') {
      out += '  ';
      state = 'block';
      i += 2;
      continue;
    }
    if (c === "'") state = 'sq';
    else if (c === '"') state = 'dq';
    else if (c === '`') state = 'tpl';
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Every `process.stdout.write(` / `process.stderr.write(` in the EXECUTABLE
 * source, with the head of its argument.
 *
 * @param {string} src
 * @returns {{stream:'stdout'|'stderr', line:number, arg:string}[]}
 */
export function streamWrites(src) {
  const code = stripComments(src);
  const hits = [];
  const re = /process\.(stdout|stderr)\.write\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const arg = code.slice(m.index + m[0].length, m.index + m[0].length + 160).trim();
    hits.push({
      stream: m[1],
      line: code.slice(0, m.index).split('\n').length,
      arg,
    });
  }
  return hits;
}

/**
 * The stream writes whose argument does NOT begin with one of `allowed`.
 *
 * `allowed` names BOTH the redaction boundaries and the disclosed exceptions,
 * because a surface may legitimately be either — what may not happen is a
 * surface being neither, which is the state rounds 1-4 kept shipping.
 *
 * @param {string} src
 * @param {string[]} allowed  function names, e.g. ['formatStdout','formatStderr']
 */
export function unboundedWrites(src, allowed) {
  return streamWrites(src).filter((w) => !allowed.some((fn) => w.arg.startsWith(`${fn}(`)));
}

/** How many times `fn(` is CALLED in the executable source. */
export function callCount(src, fn) {
  const code = stripComments(src);
  const re = new RegExp(`\\b${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g');
  return (code.match(re) ?? []).length;
}

/**
 * Publication shapes that must not appear in these scripts AT ALL, because each
 * would be a surface with no boundary and no name for one to attach to.
 *
 * `console.*` is the one that matters in practice: it writes to stdout/stderr
 * without going near `process.stdout.write`, so every structural assertion in
 * this lane — including round 4's — is blind to it. The others are the Actions
 * side channels a future author might reach for; a step summary is rendered on
 * the public run page exactly as an annotation is.
 */
export const FORBIDDEN_PUBLISHERS = [
  ['console.*', /\bconsole\s*\.\s*(log|error|warn|info|debug|trace|dir|table|group|groupEnd|count|assert)\s*\(/g],
  ['a process stream method other than .write', /\bprocess\s*\.\s*(stdout|stderr)\s*\.\s*(?!write\b)[A-Za-z_$][\w$]*\s*\(/g],
  ['GITHUB_STEP_SUMMARY / GITHUB_OUTPUT / GITHUB_ENV', /\bGITHUB_(STEP_SUMMARY|OUTPUT|ENV)\b/g],
  ['core.setOutput / core.summary (actions toolkit)', /\bcore\s*\.\s*(setOutput|summary|notice|warning|error|info)\s*\(/g],
];

/**
 * @param {string} src
 * @returns {{why:string, hit:string, line:number}[]}
 */
export function forbiddenPublishers(src) {
  const code = stripComments(src);
  const found = [];
  for (const [why, re] of FORBIDDEN_PUBLISHERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      found.push({ why, hit: m[0], line: code.slice(0, m.index).split('\n').length });
    }
  }
  return found;
}

/**
 * SPAWNS THAT HAND A CHILD OUR OWN STREAM FILE DESCRIPTORS.
 *
 * THE SURFACE NO WRITE-BASED ENUMERATOR CAN SEE, and the reason this function
 * exists. `stdio: ['inherit', 'inherit', 'pipe']` gives the child process the
 * parent's stdout fd directly: every byte it prints lands in the same public
 * Actions run log, with NO `process.stdout.write` anywhere in the parent's
 * source. Round 4's `process\.stdout\.write` regex was blind to it; so is
 * streamWrites() above; so is any assertion written by reading the file for
 * writes. It is exactly the "neighbour" shape rounds 1-4 kept re-discovering,
 * one level further out.
 *
 * Reported as `{ index, stream }` for each inherited slot, where index 1 is
 * stdout and 2 is stderr. Index 0 is stdin and is NOT a publication surface.
 *
 * @param {string} src
 * @returns {{line:number, stdio:string, inherits:string[]}[]}
 */
export function inheritedStreamSpawns(src) {
  const code = stripComments(src);
  const out = [];
  const re = /stdio:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const slots = m[1].split(',').map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''));
    const inherits = [];
    if (slots[1] === 'inherit') inherits.push('stdout');
    if (slots[2] === 'inherit') inherits.push('stderr');
    if (inherits.length > 0) {
      out.push({ line: code.slice(0, m.index).split('\n').length, stdio: m[0], inherits });
    }
  }
  return out;
}

/**
 * THE EMBEDDED CONTROL, shared so all three suites prove the SAME enumerator can
 * fail rather than each trusting it.
 *
 * A structural guard over a clean tree has, by construction, a zero population:
 * it reports "no unbounded writes" both when there are none and when it has
 * stopped looking (guard_with_zero_population_needs_embedded_control). These are
 * the verbatim shapes it must catch, in a synthetic source that is CRLF — the
 * line ending every one of these files actually carries on Windows — so a
 * newline-sensitive regression is caught here rather than by being silently
 * green in CI (csa_loom_crlf_makes_mutation_needles_silently_noop).
 */
export const CONTROL_SOURCE_CRLF = [
  '/**',
  ' * A doc comment that MENTIONS process.stdout.write(`raw ${id}`) in prose.',
  ' */',
  "function bounded(t) { process.stdout.write(formatStdout(t)); }",
  "function alsoBounded(t) { process.stderr.write(formatStderr(t)); }",
  "function exempt(c) { process.stdout.write(unredactedByDesign(c)); }",
  "function bad(id) { process.stderr.write(`deploy: ${id}\\n`); } // the violation",
  "function alsoBad(id) { process.stdout.write(redact(id)); }",
  '',
].join('\r\n');
