#!/usr/bin/env node
/**
 * check-curl-httpcode-fallback.mjs
 *
 * RULE. A `curl -w '%{http_code}'` probe must not carry either of the two
 * shapes that make its FAILURE indistinguishable from a legitimate ANSWER:
 *
 *   ARM 1 — `|| echo <default>` on the capture. Default an EMPTY capture instead.
 *   ARM 2 — `-f` / `--fail` on the same probe. A probe whose PURPOSE is to
 *           observe the status treats 4xx/5xx as answers, not as errors.
 *
 * WHY ARM 1 — measured with real curl, not reasoned about:
 *
 *   connection failure : curl PRINTS `000` and exits non-zero  ->  "000000"
 *   HTTP 401 with -f   : curl PRINTS `401` and exits 22        ->  "401000"
 *
 * curl already writes the `-w` value on BOTH paths, so `||` can only CONCATENATE
 * onto what it printed. The result is a string that is not a status code, and
 * every comparison against one silently fails.
 *
 * WHY ARM 2 — `-f` suppresses the body AND exits non-zero on 4xx/5xx, so it
 * collapses "401", "403", "404", "500", a DNS failure, a TLS failure and a
 * timeout into one indistinguishable outcome, and destroys the response body
 * that would have told them apart. On a probe that READS the status that is
 * always wrong: the status is the answer. PR #3412 removed exactly this from
 * console-bluegreen-roll.yml's green-FQDN probe, where it had been reporting
 * "green FQDN not directly reachable" for a green that answered HTTP 500.
 *
 * TWO REAL INCIDENTS, both found 2026-08-11:
 *
 * 1. apps/loom-unity/bin/loom-entrypoint.sh — the anonymous-read enforcement
 *    probe. `000000 != "000"` is TRUE, so the 60-attempt wait-for-server loop
 *    broke on attempt 1, before the server was listening, and gov-uc-purview-wire
 *    (run 31503926181) refused to wire the Gov Console:
 *        [loom-unity] ANON-READ: 000000
 *        ##[error]anonymous read answered 000, which is neither a refusal
 *        (401/403) nor a success (200)
 *    The gate was right to fail closed. It was fed a code that is not a code.
 *
 * 2. .github/scripts/fiab-smoke-test.sh Test 2 — asserts /api/workspaces REFUSES
 *    an unauthenticated caller, i.e. 401 is the SUCCESS case. `-f` makes curl
 *    exit non-zero on exactly that, so the fallback concatenated. Verified live:
 *        old shape -> RESPONSE='401000'  (matches neither 401 nor 403)
 *        new shape -> RESPONSE='401'     (matches)
 *    The test failed when auth WORKED, and also failed when it was broken (200
 *    matches neither). It could not pass — in all three deploy paths — and
 *    nobody noticed because the step ran under `continue-on-error: true`.
 *
 * That pairing is the thing to remember: a check that cannot pass, wired so it
 * cannot fail. Either defect alone would have been caught by the other.
 *
 * THE SAFE SHAPE:
 *     CODE="$(curl -sS -o /dev/null -w '%{http_code}' … 2>/dev/null)" || true
 *     [ -n "$CODE" ] || CODE="000"
 * The trailing `|| true` fixes the EXIT STATUS and leaves stdout alone (it is
 * what check-httpcode-probe-aborts.mjs requires under `set -e`); `|| echo`
 * appends to stdout and corrupts the value. They are not interchangeable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (#3414, and a larger blind spot found with it)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * #3414: the paragraph above about `-f` was in the docstring from day one and
 * ARM 2 WAS NEVER IMPLEMENTED. The only matcher was `|| echo`. A reader auditing
 * "do we have a guard for -f on status probes?" got yes from the documentation
 * and no from the behaviour. Three live sites passed it cleanly.
 *
 * Found while implementing ARM 2, and worse: the matcher ran on PHYSICAL lines,
 * and a curl invocation is routinely spread over backslash continuations with
 * the `|| echo` on the LAST one — which does not contain `%{http_code}`, so the
 * line was skipped before it was ever tested. On 2026-08-13, against a tree this
 * guard reported as "0 concatenating fallbacks", ELEVEN live `|| echo` sites
 * existed. Every one of them had the `|| echo` on a continuation line. Two of
 * them were in .github/scripts/fiab-smoke-test.sh — the very file incident 2
 * above is written about, in tests added AFTER the fix — and Test 8 there was
 * unpassable in exactly the way Test 2 had been.
 *
 * So the population was never zero; it was invisible. The sibling guard
 * check-httpcode-probe-aborts.mjs had joined continuations since it was written;
 * this one had not. Both arms now judge LOGICAL lines (continuations joined).
 *
 * EMBEDDED CONTROL. Both arms are proven live on every run, before the repo is
 * judged, against fixtures that MUST match and fixtures that MUST NOT. A guard
 * whose population reaches zero and then stops matching is indistinguishable
 * from a clean codebase, and this repo has shipped that several times. If a
 * control fails, the guard fails — there is no path where it reports OK without
 * having demonstrated that it still detects.
 *
 * NO ALLOWLIST, by design. A probe that legitimately wants curl's exit status
 * as its verdict should not be reading `%{http_code}` into a comparison at all;
 * capture the code and branch on the code (scripts/sample-up/05-verify.sh was
 * converted that way rather than exempted). If a genuine exception ever exists,
 * it goes in EXEMPT with its reason written next to it — never a silent skip.
 *
 * KNOWN LIMIT, stated rather than hidden: flags passed through a wrapper (e.g.
 * fiab-smoke-test.sh's `http_code()` forwarding "$@") are invisible to any
 * text matcher. The wrapper itself is checked; its callers' arguments are not.
 *
 * SELF-DEFENCE. Fails if it scans no files, and fails if it finds no
 * `%{http_code}` usage at all — this repo probes constantly, so zero means the
 * matcher drifted.
 *
 * Usage:
 *   node scripts/ci/check-curl-httpcode-fallback.mjs               # CHECK
 *   node scripts/ci/check-curl-httpcode-fallback.mjs --self-test   # controls only
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();

function tracked() {
  try {
    return execFileSync('git', ['ls-files', '--', '*.sh', '*.yml', '*.yaml', '*.bash'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    console.error(
      `::error::curl-httpcode-fallback: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

// This guard and its own documentation legitimately contain the bad shapes.
// Belt-and-braces only: `tracked()` globs shell/YAML, so a `.mjs` is never
// listed in the first place — the entry documents intent, it is not protection.
export const EXEMPT = new Set(['scripts/ci/check-curl-httpcode-fallback.mjs']);

export const HTTP_CODE = /%\{http_code\}/;
export const CURL = /\bcurl\b/;

/** ARM 1 — `|| echo <default>` concatenating onto what curl already printed. */
export const BAD_FALLBACK = /\|\|\s*echo\b/;

/**
 * ARM 2 — `-f` / `--fail` as WHOLE TOKENS.
 *
 * `--fail(?![-\w])` deliberately excludes `--fail-with-body` and `--fail-early`,
 * which are DIFFERENT curl flags: `--fail-with-body` keeps the body (so the
 * probe can still see what answered) and `--fail-early` is about multiple URLs.
 * Neither is the defect this arm is about.
 *
 * `-[A-Za-z]*f[A-Za-z]*` catches BUNDLED short flags — `-fsS`, `-sSf`, `-sfL`
 * — and that is INTENDED, not incidental: curl's only lowercase-`f` short flag
 * is `-f` (`--fail`). `-F` is `--form` and is upper-case, so it does not match.
 * Any lowercase `f` inside a curl short-flag bundle therefore IS `--fail`.
 */
export const FAIL_FLAG = /(?:^|\s)(?:--fail(?![-\w])|-[A-Za-z]*f[A-Za-z]*)(?=\s|$)/;

/**
 * Join backslash continuations into LOGICAL lines, keeping the 1-based line
 * number of the first physical line so annotations point at the invocation.
 * This is what the sibling check-httpcode-probe-aborts.mjs has always done; not
 * doing it here is what hid eleven live violations (see the header).
 */
export function logicalLines(text) {
  const phys = text.split(/\r?\n/);
  const out = [];
  let buf = null;
  let start = 0;
  for (let i = 0; i < phys.length; i++) {
    const line = phys[i];
    if (buf === null) {
      buf = line;
      start = i;
    } else {
      buf += ' ' + line.replace(/^\s+/, '');
    }
    if (/\\\s*$/.test(line)) {
      buf = buf.replace(/\\\s*$/, ' ');
      continue;
    }
    out.push({ line: start + 1, text: buf });
    buf = null;
  }
  if (buf !== null) out.push({ line: start + 1, text: buf });
  return out;
}

/**
 * Judge one file's text. Returns the probe-line count (for the empty-population
 * self-defence) and one record per violation, tagged with the arm that fired.
 */
export function scanText(text) {
  const violations = [];
  let probeLines = 0;
  if (!HTTP_CODE.test(text)) return { probeLines, violations };

  for (const { line, text: raw } of logicalLines(text)) {
    if (/^\s*#/.test(raw)) continue; // prose about the rule is not the rule
    if (!HTTP_CODE.test(raw)) continue;
    probeLines++;

    if (BAD_FALLBACK.test(raw)) violations.push({ arm: 'fallback', line, text: raw.trim().slice(0, 150) });

    // Only the portion of the logical line AT OR AFTER `curl` is searched for
    // the fail flag, so an unrelated `[ -f "$X" ]` earlier on the same line is
    // not read as a curl flag.
    const at = raw.search(CURL);
    if (at >= 0 && FAIL_FLAG.test(raw.slice(at))) {
      violations.push({ arm: 'fail-flag', line, text: raw.trim().slice(0, 150) });
    }
  }
  return { probeLines, violations };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMBEDDED CONTROL — proven on every run, before the repo is judged.
// ─────────────────────────────────────────────────────────────────────────────

/** Fixtures the scanner MUST flag, with the arm each must trip. */
export const MUST_FLAG = [
  { why: 'ARM 1, same line', arm: 'fallback', src: 'CODE=$(curl -sS -w \'%{http_code}\' "$URL" || echo 000)' },
  {
    why: 'ARM 1, `|| echo` on a continuation (the shape that hid 11 live sites)',
    arm: 'fallback',
    src: 'CODE=$(curl -sS -w \'%{http_code}\' \\\n  --max-time 5 \\\n  "$URL" || echo 000)',
  },
  { why: 'ARM 2, lone -f', arm: 'fail-flag', src: 'curl -f -sS -w \'%{http_code}\' "$URL"' },
  { why: 'ARM 2, long --fail', arm: 'fail-flag', src: 'curl --fail -w \'%{http_code}\' "$URL"' },
  { why: 'ARM 2, bundled -fsS', arm: 'fail-flag', src: 'RESP=$(curl -fsS -o /dev/null -w "%{http_code}" "$URL")' },
  { why: 'ARM 2, bundled -sSf', arm: 'fail-flag', src: 'curl -sSf -o /dev/null -w "%{http_code}" "$URL"' },
  {
    why: 'ARM 2, --fail on a continuation line',
    arm: 'fail-flag',
    src: 'CODE=$(curl -sS -w \'%{http_code}\' \\\n  --fail \\\n  "$URL")',
  },
];

/** Fixtures the scanner MUST NOT flag — the over-broad direction. */
export const MUST_NOT_FLAG = [
  { why: 'the prescribed safe shape', src: 'CODE="$(curl -sS -w \'%{http_code}\' "$URL" 2>/dev/null)" || true' },
  { why: '`|| true` fixes the status without touching stdout', src: 'CODE=$(curl -sS -w \'%{http_code}\' "$URL") || true' },
  { why: '--fail-with-body is a DIFFERENT flag (it keeps the body)', src: 'curl --fail-with-body -w \'%{http_code}\' "$URL"' },
  { why: '--fail-early is a DIFFERENT flag (multi-URL sequencing)', src: 'curl --fail-early -w \'%{http_code}\' "$URL"' },
  { why: '-F is --form, upper-case, not --fail', src: 'curl -sS -F file=@a.json -w \'%{http_code}\' "$URL"' },
  { why: 'an unrelated -f test BEFORE the curl is not a curl flag', src: '[ -f "$TOKEN_FILE" ] && curl -sS -w \'%{http_code}\' "$URL"' },
  { why: 'a comment describing the rule is not the rule', src: '#   curl -fsS -w "%{http_code}" … || echo "000"' },
];

/** Runs the controls. Returns a list of failure descriptions (empty = healthy). */
export function runControls() {
  const failures = [];
  for (const c of MUST_FLAG) {
    const hit = scanText(c.src).violations.some((v) => v.arm === c.arm);
    if (!hit) failures.push(`MUST-FLAG missed (${c.arm}) — ${c.why}: ${c.src.replace(/\n/g, '\\n')}`);
  }
  for (const c of MUST_NOT_FLAG) {
    const hits = scanText(c.src).violations;
    if (hits.length > 0) {
      failures.push(`MUST-NOT-FLAG tripped (${hits.map((h) => h.arm).join(',')}) — ${c.why}: ${c.src}`);
    }
  }
  return failures;
}

function main() {
  const selfTestOnly = process.argv.includes('--self-test');

  // The control runs FIRST and unconditionally. A guard that has stopped
  // detecting must never reach the point where it prints OK.
  const controlFailures = runControls();
  if (controlFailures.length > 0) {
    console.error(
      `::error::curl-httpcode-fallback: the EMBEDDED CONTROL failed (${controlFailures.length}). The matchers no ` +
        'longer behave as documented, so any verdict about the repo would be meaningless — a guard that has stopped ' +
        'matching is indistinguishable from a clean codebase. Fix the matcher (or the control, if the rule changed).',
    );
    for (const f of controlFailures) console.error(`   - ${f}`);
    process.exit(1);
  }
  const controlCount = MUST_FLAG.length + MUST_NOT_FLAG.length;
  if (selfTestOnly) {
    console.log(`curl-httpcode-fallback self-test OK — ${controlCount} control fixture(s) behaved as documented.`);
    return;
  }

  const files = tracked();
  const violations = [];
  let probeLines = 0;

  for (const rel of files) {
    if (EXEMPT.has(rel)) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    const r = scanText(text);
    probeLines += r.probeLines;
    for (const v of r.violations) violations.push({ file: rel, ...v });
  }

  if (files.length === 0) {
    console.error('::error::curl-httpcode-fallback: scanned ZERO tracked files. Refusing to report a pass.');
    process.exit(1);
  }
  if (probeLines === 0) {
    console.error(
      `::error::curl-httpcode-fallback: found ZERO \`%{http_code}\` probes in ${files.length} tracked files. ` +
        'This repo probes constantly, so zero means the matcher has drifted off the code. ' +
        'Refusing to report a pass on an empty population.',
    );
    process.exit(1);
  }

  const fallback = violations.filter((v) => v.arm === 'fallback');
  const failFlag = violations.filter((v) => v.arm === 'fail-flag');

  if (fallback.length > 0) {
    console.error(
      `::error::curl-httpcode-fallback: ${fallback.length} \`%{http_code}\` capture(s) use an \`|| echo\` fallback. ` +
        'curl PRINTS the value on both failure paths and ALSO exits non-zero, so the fallback CONCATENATES: a ' +
        'connection failure becomes "000000" and an HTTP 401 under -f becomes "401000". Neither is a status code, ' +
        'so every comparison against one fails silently. Use: ' +
        'CODE="$(curl -sS -w \'%{http_code}\' … 2>/dev/null)" || true; [ -n "$CODE" ] || CODE="000"',
    );
    for (const v of fallback) console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
  }

  if (failFlag.length > 0) {
    console.error(
      `::error::curl-httpcode-fallback: ${failFlag.length} \`%{http_code}\` probe(s) pass \`-f\`/\`--fail\`. ` +
        '`-f` suppresses the body and exits non-zero on 4xx/5xx, so a probe that exists to OBSERVE the status ' +
        'collapses 401/403/404/500 and DNS/TLS/timeout into one indistinguishable outcome and throws away the body ' +
        'that would have separated them. Drop the `f` (`-fsS` -> `-sS`) and branch on the captured code. Note ' +
        '`--fail-with-body` and `--fail-early` are different flags and are not flagged.',
    );
    for (const v of failFlag) console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
  }

  if (violations.length > 0) process.exit(1);

  console.log(
    `curl-httpcode-fallback OK — ${files.length} tracked file(s) scanned, ${probeLines} \`%{http_code}\` probe ` +
      `line(s) (backslash continuations joined), 0 concatenating fallbacks, 0 \`-f\`/\`--fail\` probes; ` +
      `${controlCount} embedded control fixture(s) proved both arms still detect.`,
  );
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) main();
