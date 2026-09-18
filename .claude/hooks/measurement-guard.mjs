#!/usr/bin/env node
/**
 * measurement-guard.mjs — PreToolUse hook for Bash.
 *
 * Blocks four shell shapes. The first three have produced FALSE MEASUREMENTS in
 * this repo — each returns a value indistinguishable from a real answer, which
 * is why they are worth blocking rather than warning about. The fourth is a
 * different hazard and is labelled as such below:
 *
 *   1. `RC=$?` after a pipeline. `$?` is the LAST element's status, so
 *      `R=$(az ... | tr -d '\r'); RC=$?` reports `tr` succeeding while az failed.
 *      Seven container apps were reported at "0 requests, rc=0" from a query
 *      that never ran.
 *
 *   2. A leading-slash Azure resource id passed to az from Git Bash. MSYS
 *      rewrites `/subscriptions/...` into a Windows path, az answers "usage
 *      error", and the metric comes back null -- then read as zero.
 *
 *   3. `2>/dev/null` on a measurement command. Discarding stderr converts a
 *      permission denial into an empty string and the empty string into a
 *      confident false claim. Explicitly forbidden by deploy-integrity R7.
 *
 *   4. `python -` at command position. NOT a false-measurement shape -- it is
 *      RESOURCE EXHAUSTION. A heredoc that misses stdin leaves an interactive
 *      REPL looping on a traceback: 65 GB written in one measured case, and
 *      8.3 GB of IO with ZERO file growth in another. It is here because it
 *      recurred eight times in one session despite being documented, and per
 *      the global operating rules only a hook executes.
 *
 * Design notes:
 *  - DENY, not warn. A warning in a tool result is easy to skim past, and the
 *    whole failure mode is that the wrong answer looks fine.
 *  - Every message names the FIX, not just the problem.
 *  - Detection is deliberately narrow. A false denial is the pressure that gets
 *    a guard deleted, so each rule requires several co-occurring signals.
 */

/**
 * Blank out quoted spans so a `|` inside a string argument is not mistaken for
 * a shell pipeline. Real false positive: `gh api ... --jq '.x[] | select(...)'`
 * was denied because of the jq pipe. Quote-awareness is not optional here — a
 * guard that blocks correct commands is the pressure that gets it deleted.
 * Length is preserved so any offsets/offending-text stay meaningful.
 */
function maskQuoted(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') { out += '__'; i++; continue; }
      if (c === quote) { quote = null; out += c; continue; }
      out += c === '\n' ? '\n' : '_';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * Blank out HEREDOC BODIES, preserving line count.
 *
 * Without this, writing a file whose CONTENT mentions a blocked pattern is
 * denied — and a heredoc is the only way an agent with no Write tool can
 * create a file at all. Measured: a reviewer of the python-dash-repl rule was
 * denied twice while writing their own verdict file, and the rule's FIX text
 * pointed them at a tool they may not have. A guard that blocks its own
 * documented workaround is worse than no guard.
 *
 * Deliberately scoped to the rule that asked for it rather than applied to
 * every rule: the other three predate this and changing what they see is a
 * behaviour change none of their tests cover. A heredoc body containing
 * `az ... 2>/dev/null` therefore still trips `discarded-stderr` — known, and
 * left alone on purpose.
 *
 * Residual, disclosed rather than hidden: only the FIRST heredoc opener on a
 * line is tracked, so `cat <<A > x; cat <<B > y` on one line is handled for A
 * only. Multi-heredoc single lines do not occur in this repo's traffic.
 */
function stripHeredocBodies(s) {
  const lines = s.split(/\r?\n/);
  const out = [];
  let delim = null;
  let allowIndent = false;
  for (const line of lines) {
    if (delim !== null) {
      const probe = allowIndent ? line.replace(/^\t+/, '') : line;
      if (probe.trim() === delim) { delim = null; out.push(line); continue; }
      out.push(''); // body line -> blanked, line count preserved
      continue;
    }
    // `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`. NOT `<<<` (herestring: no body).
    //
    // THE LOOKBEHIND IS LOAD-BEARING. An earlier version wrote `<<(?!<)` and
    // was blind: a negative LOOKAHEAD only guards the leftmost match attempt,
    // so against `<<<x` the engine retries at offset 1, matches `<<` on
    // characters 1-2, sees `x` at 3, and reads a heredoc whose delimiter is
    // `x`. Everything after was then blanked as "body" and this rule stopped
    // watching entirely — strictly worse than a false positive, because the
    // guard stays installed while seeing nothing.
    //
    // Measured, and the measurement is the point: `<<<'print(1)'` did NOT
    // reproduce it (the `(` breaks the `\2` backreference) while `<<<'x'` did.
    // The shipped test used the former, so it passed for a reason it did not
    // claim — the same defect the M9 arm exists to catch, recurring inside the
    // fix for it.
    const m = line.match(/(?<!<)<<(-?)\s*(?!<)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (m) { allowIndent = m[1] === '-'; delim = m[3]; }
    out.push(line);
  }
  return out.join('\n');
}

const RULES = [
  {
    id: 'rc-after-pipe',
    // `... | ... ; RC=$?`  or a pipeline line followed by a line capturing $?
    test: (raw) => {
      const cmd = maskQuoted(raw);
      const lines = cmd.split(/\r?\n/);
      const rawLines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // same-line:  foo | bar; RC=$?
        if (/\|[^|]*;\s*\w+=\$\?/.test(line)) return rawLines[i].trim();
        // next-line:  foo | bar
        //             RC=$?
        const pipeline = /\|/.test(line) && !/\|\|/.test(line) && !/^\s*#/.test(line);
        const next = (lines[i + 1] || '').trim();
        const rawNext = (rawLines[i + 1] || '').trim();
        if (pipeline && /^\w+=\$\?/.test(next)) return `${rawLines[i].trim()}  ⏎  ${rawNext}`;
        // assignment from a pipeline, then $?:  R=$(a | b)\n RC=$?
        if (/=\$\([^)]*\|[^)]*\)/.test(line) && /^\w+=\$\?/.test(next)) {
          return `${rawLines[i].trim()}  ⏎  ${rawNext}`;
        }
      }
      return null;
    },
    message: (hit) =>
      `\`$?\` after a pipeline reports the LAST element's status, not the command you care about.\n` +
      `  offending: ${hit}\n` +
      `  FIX: capture on the line immediately after the SUBJECT, with no pipe:\n` +
      `       az ... > out.json 2>err.txt\n` +
      `       RC=$?\n` +
      `  This exact shape reported seven apps at "0 requests, rc=0" from a query that never ran.`,
  },
  {
    id: 'msys-arm-id',
    test: (cmd) => {
      if (/MSYS_NO_PATHCONV/.test(cmd)) return null;
      if (!/\b(az|gh)\b/.test(cmd)) return null;
      // a bare leading-slash ARM-ish path as an argument (not inside a URL/quote-path)
      const m = cmd.match(/(?:^|\s)(["']?)(\/subscriptions\/[^\s"']*)/);
      return m ? m[2].slice(0, 70) : null;
    },
    message: (hit) =>
      `Git Bash rewrites a leading-slash path before az/gh sees it, so this resource id never arrives.\n` +
      `  offending: ${hit}...\n` +
      `  FIX: prefix the command with MSYS_NO_PATHCONV=1\n` +
      `  Symptom when you don't: "usage error: --resource ID | --resource NAME ..." for a\n` +
      `  perfectly well-formed id, and metrics that come back null and get read as zero.`,
  },
  {
    id: 'discarded-stderr',
    test: (raw) => {
      // Scope the check to the SEGMENT carrying the redirect, not the whole
      // command. Real false positive: `ps -ef 2>/dev/null | grep ...` in a
      // script that ALSO ran `gh pr list` on a later line was denied, because
      // the binary test looked at the entire string. The redirect belonged to
      // `ps`, which is not a measurement.
      //
      // Matched by SHAPE -- stderr going somewhere unreadable -- not by one
      // spelling. An earlier version tested `2>/dev/null` alone, so `&>/dev/null`
      // (which discards BOTH streams and is strictly worse), the canonical
      // `>/dev/null 2>&1`, `2>>/dev/null`, and `2>&-` all sailed through. A guard
      // keyed to a spelling is one keystroke from useless.
      const MEASUREMENT = /\b(az|gh|kubectl|terraform|curl)\b/;
      // ORDER MATTERS. `>/dev/null 2>&1` also matches the plain-stdout branch at
      // the same start position, and alternation is leftmost-first -- so if the
      // plain form came first this would be classified stdout-only and skipped.
      // The combined form has to be tried before its own prefix.
      const DISCARD = /(?:>\s*\/dev\/null\s+2>\s*&\s*1|2>\s*&\s*-|\d*&?>>?\s*\/dev\/null|&>>?\s*\/dev\/null)/;
      for (const line of raw.split(/\r?\n/)) {
        const idx = line.search(DISCARD);
        if (idx < 0) continue;
        // A plain `>/dev/null` discards only stdout, which is often deliberate
        // and harmless. It is a finding only when stderr goes with it.
        const matched = line.slice(idx).match(DISCARD)?.[0] ?? '';
        const stdoutOnly = /^>>?\s*\/dev\/null$/.test(matched.trim());
        if (stdoutOnly) continue;
        // Within the line, look only at the command segment that owns the redirect.
        const before = line.slice(0, idx);
        const segment = before.split(/[;&|]{1,2}/).pop() || before;
        if (MEASUREMENT.test(segment)) return line.trim().slice(0, 90);
      }
      return null;
    },
    message: (hit) =>
      `discarding stderr on a measurement throws away the reason it failed.\n` +
      `  offending: ${hit}\n` +
      `  FIX: send stderr to a file and read it on failure:  cmd > out 2>err ; RC=$?\n` +
      `  Precedent: a discarded stderr turned "I could not reach the registry" into\n` +
      `  "the tag does not exist" and sent two investigations down the wrong path (R7).`,
  },
  {
    id: 'python-dash-repl',
    // `python -` that does not cleanly attach to stdin becomes an INTERACTIVE
    // REPL. It then loops on a traceback forever. Measured twice, same session:
    //   stderr -> a file   : 69,887,069,161 bytes (~65 GB), stdout 0 bytes
    //   stderr -> /dev/null: 8.3 GB of write IO, ~1h CPU, and NO file grew at all
    // The second is worse. It is invisible to every size check and to
    // `git status` (temp/ is gitignored), so it is found only by listing
    // processes -- usually after something unrelated gets killed for memory.
    //
    // This rule exists because KNOWING the rule demonstrably does not prevent
    // it: six occurrences in one session, three by agents who were actively
    // quoting the prohibition at the time, and one by the coordinator while
    // writing a comment about a different trap. Per the global operating rules,
    // automatic behaviour requires a hook -- memory only informs.
    test: (raw) => {
      // Heredoc bodies first (see stripHeredocBodies), THEN quote masking.
      // Order matters: the delimiter itself is often quoted (`<<'EOF'`), and
      // masking first would hide it from the opener match.
      const rawLines = raw.split(/\r?\n/);
      const cmd = maskQuoted(stripHeredocBodies(raw));

      // ANCHORED AT COMMAND POSITION, and pipe-fed invocations excluded.
      //
      // The first version tested the whole line for a bare `-` anywhere. That
      // denied six legitimate shapes, including `cmd | python -` — which
      // CANNOT become a REPL, because its stdin is a pipe that reaches EOF.
      // Matching position rather than substring also closes two false
      // negatives for free: `python3.11 -` and `python.exe -`.
      //
      // Accepts before the interpreter: env assignments (`PYTHONPATH=x`),
      // `env`, and any path prefix (`/usr/bin/`, `./venv/bin/`).
      // Requires the bare `-` to be the interpreter's FIRST argument, which is
      // what keeps `python tools/fmt.py -` allowed — there the `-` belongs to
      // the script, not to python.
      const CMD = new RegExp(
        '^\\s*(?:\\w+=\\S*\\s+)*(?:env\\s+(?:\\w+=\\S*\\s+)*)?' +
        '(?:\\S*[\\/\\\\])?(?:py|python)(?:\\d+(?:\\.\\d+)?)?(?:\\.exe)?' +
        '\\s+-(?=\\s|$|[<>&|])',
      );

      const lines = cmd.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*#/.test(line)) continue;
        // Split keeping separators. Only a BARE `|` supplies stdin; `||`,
        // `&&`, `;` and `&` leave stdin on the terminal, so they still fire.
        const parts = line.split(/(\|\||&&|;|\||&)/);
        let prevSep = '';
        for (let p = 0; p < parts.length; p += 2) {
          const seg = parts[p];
          // STDIN SUPPLIED FROM SOMETHING THAT ENDS. Either form removes the
          // hazard, because the REPL requires stdin to stay open on a terminal:
          //   `<<<str`   herestring  -- no delimiter to mismatch
          //   `< file`   redirect    -- reaches EOF
          // A HEREDOC (`<<DELIM`) is deliberately NOT in this set: it is the
          // one that degrades into a REPL when the delimiter does not land,
          // which is the whole reason this rule exists.
          // The lookarounds are what separate a lone `<` from `<<` and `<<<`.
          const stdinSupplied = /<<</.test(seg) || /(?<!<)<(?!<)/.test(seg);
          if (prevSep !== '|' && !stdinSupplied && CMD.test(seg)) {
            return rawLines[i].trim().slice(0, 90);
          }
          prevSep = parts[p + 1] || '';
        }
      }
      return null;
    },
    message: (hit) =>
      `\`python -\` becomes an interactive REPL when the heredoc misses stdin.\n` +
      `  offending: ${hit}\n` +
      `  FIX: put the script in a file and run it.\n` +
      `       Write tool -> temp/thing.py, OR (no Write tool) a heredoc that\n` +
      `       writes the FILE rather than feeding python:\n` +
      `         cat > temp/thing.py <<'PY'\n` +
      `         ...\n` +
      `         PY\n` +
      `         python temp/thing.py\n` +
      `       Heredoc BODIES are exempt from this rule, so a file whose content\n` +
      `       mentions the pattern is not blocked.\n` +
      `       A true one-liner is fine as  python -c "..."  and a herestring\n` +
      `       (\`python - <<<'...'\`) is allowed -- it has no delimiter to mismatch.\n` +
      `  There is NO safe inline heredoc shape. Redirecting stdout does not help --\n` +
      `  the REPL's loop is on STDERR. An empty body does not help either; two of\n` +
      `  the eight occurrences were deliberate no-ops that still hung for 120s.\n` +
      `  Measured: 65 GB written in one case; 8.3 GB of IO and zero file growth in\n` +
      `  another, which is the shape no size check can see.`,
  },
];

import { readFileSync } from 'node:fs';

/**
 * Build the deny text for a set of findings.
 *
 * EXPORTED so it can be tested. It was inline in `main()`, which put it beyond
 * `evaluate()`'s reach — a reviewer mutated the headline in both directions and
 * both mutants survived 48/48, i.e. the R7 fix had no kill power and that was
 * not disclosed. An untestable correctness fix is the shape this file polices.
 */
export function denyBody(findings) {
  // RULE-AWARE. Asserting "a measurement you cannot trust" over a
  // python-dash-repl finding is false — that rule is about resource
  // exhaustion, not a wrong number — and recommending measure.mjs for it is
  // advice that does not apply. Stating a cause the code did not establish is
  // the R7 defect this file exists to police, so it must not appear in the
  // file's own output.
  //
  // FAILS TOWARD THE MEASUREMENT TEXT for an unknown id, deliberately: a new
  // measurement rule added without updating this set still gets the (correct)
  // measurement framing, and only a new NON-measurement rule would be
  // mislabelled. The test below pins that direction so the choice is visible.
  const anyMeasurement = findings.some((f) => !NON_MEASUREMENT_RULES.has(f.id));
  const headline = anyMeasurement
    ? 'BLOCKED — this command would produce a measurement you cannot trust.'
    : 'BLOCKED — this command carries a known hazard.';
  const footer = anyMeasurement
    ? `\n\nPrefer scripts/measure/measure.mjs, which makes these structurally impossible:\n` +
      `  a failed command throws instead of yielding a value, and a ZERO result is\n` +
      `  refused unless a positive control proves the query path works.`
    : '';
  return `${headline}\n\n` +
    findings.map((f, i) => `${i + 1}. [${f.id}] ${f.message}`).join('\n\n') +
    footer;
}

/** Rules that are NOT about a false measurement. See denyBody(). */
const NON_MEASUREMENT_RULES = new Set(['python-dash-repl']);

/**
 * Read the hook payload from fd 0.
 *
 * Returns `{ raw, readFailed }` rather than a bare string, because the two
 * empty cases are NOT the same and the caller has to tell them apart. An
 * earlier version returned '' for both and the caller could not distinguish
 * "no payload" from "could not read the payload"; it allowed either way, while
 * a comment claimed the fail-open had been fixed. It had not.
 */
function readStdin() {
  try {
    return { raw: readFileSync(0, 'utf8'), readFailed: false };
  } catch (e) {
    process.stderr.write(`measurement-guard: could not read stdin: ${e.message}\n`);
    return { raw: '', readFailed: true };
  }
}

export function evaluate(command) {
  const findings = [];
  for (const rule of RULES) {
    let hit = null;
    try {
      hit = rule.test(command);
    } catch (e) {
      // A rule that CRASHES has not passed -- it produced no verdict. Reporting
      // it as a finding is the only honest option: swallowing the throw makes a
      // broken rule indistinguishable from a satisfied one, which is precisely
      // the "gate that cannot fail" shape this file exists to prevent.
      findings.push({
        id: `${rule.id}-ERRORED`,
        message:
          `the '${rule.id}' rule threw while evaluating this command: ${e.message}\n` +
          `  This is NOT a pass. The rule produced no verdict, so the command is\n` +
          `  refused rather than allowed on an unevaluated guard. Fix the rule.`,
      });
      continue;
    }
    if (hit) findings.push({ id: rule.id, message: rule.message(hit) });
  }
  return findings;
}

// CLI / hook mode (skipped when imported by the self-test)
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[2] === '--hook') {
  const { raw, readFailed } = readStdin();

  let findings;
  if (readFailed) {
    // No payload reached us, so there is no command to judge. Denying here would
    // block every Bash call on a harness fault, which is worse than the guard
    // being absent -- so this allows, but says so on stderr where it is visible.
    // Stated plainly because the previous version claimed otherwise: THIS PATH
    // FAILS OPEN, deliberately, and it is the only one that does.
    process.stderr.write('measurement-guard: no payload readable — ALLOWING unjudged\n');
    process.exit(0);
  }

  let payload = null;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    // Input arrived but is malformed. That is an anomaly, not an empty case, and
    // guessing `{}` turns it into a silent allow. Refuse.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `measurement-guard received an unparseable payload (${e.message}).\n` +
          `Refusing rather than allowing a command it could not read. This is a\n` +
          `harness fault, not a problem with your command — re-run it.`,
      },
    }));
    process.exit(0);
  }

  const command = payload?.tool_input?.command ?? '';
  findings = command ? evaluate(command) : [];

  if (findings.length === 0) {
    process.exit(0); // allow
  }
  const body = denyBody(findings);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: body,
    },
  }));
  process.exit(0);
}
