#!/usr/bin/env node
/**
 * measurement-guard.mjs — PreToolUse hook for Bash.
 *
 * Blocks the three shell shapes that have produced FALSE MEASUREMENTS in this
 * repo — each one returns a value indistinguishable from a real answer, which
 * is why they are worth blocking rather than warning about:
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
];

import { readFileSync } from 'node:fs';

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
  const body =
    `BLOCKED — this command would produce a measurement you cannot trust.\n\n` +
    findings.map((f, i) => `${i + 1}. [${f.id}] ${f.message}`).join('\n\n') +
    `\n\nPrefer scripts/measure/measure.mjs, which makes these structurally impossible:\n` +
    `  a failed command throws instead of yielding a value, and a ZERO result is\n` +
    `  refused unless a positive control proves the query path works.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: body,
    },
  }));
  process.exit(0);
}
