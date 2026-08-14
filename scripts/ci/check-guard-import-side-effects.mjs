#!/usr/bin/env node
/**
 * A CI guard must run as a SCRIPT, not as an import side effect. (refs #3436)
 *
 * PHYSICAL-LINES-OK: judges JavaScript statement structure — a bare top-level
 * `main();` call, anchored at column 0. JS continues with `\` only inside a
 * string literal, never between statements, so folding logical lines would
 * join nothing here and would break the column-0 anchor that IS the test.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * `scripts/ci/check-*.mjs` files end either with a bare `main();` or with a
 * fenced call. Bare means: `import`ing the module to unit-test its exported
 * helpers runs the ENTIRE scan as a side effect — and `main()` here routinely
 * ends in `process.exit(1)`.
 *
 * Inside `node --test` that is the test process exiting mid-suite, which
 * produces the same non-diagnostic signature this repo has now hit twice: a
 * runner that dies having emitted no failed assertion. #3422 spent a session
 * on exactly that shape (359 `ok` lines, zero `not ok`, no TAP footer, exit 1)
 * when a `set -u` abort killed an extracted script. A `process.exit` on import
 * is indistinguishable from the outside.
 *
 * Testing a guard's helpers by importing it is the NORMAL way this repo proves
 * a guard has teeth, so the trap is directly in the path of doing the right
 * thing.
 *
 * ── WHY THIS GUARD KEYS ON THE PROPERTY, NOT THE PATTERN ───────────────────
 * The first scan written for this asked "does the file mention
 * `import.meta.url`?" and reported THREE offenders. That was wrong twice over:
 * it false-POSITIVED on check-console-corpus-staged.mjs, which fences with
 * `process.argv[1].endsWith(...)` and never mentions import.meta.url; and it
 * false-NEGATIVED on four files that mention import.meta.url for `__dirname`
 * while still calling `main()` bare. The real population was SEVEN.
 *
 * That is the guard-keyed-to-the-implementation failure class. The property is
 * "is the call reachable at module scope", so that is what this tests: a
 * `main();` anchored at column 0 is unfenced; one indented inside any block is
 * not. It deliberately does NOT care which fence idiom is used.
 *
 * Run: node scripts/ci/check-guard-import-side-effects.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI_DIR = path.join(REPO_ROOT, 'scripts', 'ci');

/**
 * @param {string} src
 * @returns {{unfenced:boolean, line:number|null, fenced:boolean}}
 */
export function classify(src) {
  const lines = String(src).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^main\(\)\s*;?\s*$/.test(lines[i])) return { unfenced: true, line: i + 1, fenced: false };
  }
  const fenced = lines.some((l) => /^\s+main\(\)\s*;?\s*$/.test(l));
  return { unfenced: false, line: null, fenced };
}

/** Known-violating and known-clean fixtures, run on EVERY invocation. */
const CONTROLS = [
  { name: 'bare call at column 0', src: 'function main(){}\nmain();\n', expect: true },
  { name: 'bare call, no semicolon', src: 'function main(){}\nmain()\n', expect: true },
  {
    name: 'fenced by endsWith',
    src: "function main(){}\nif (process.argv[1] && process.argv[1].endsWith('x.mjs')) {\n  main();\n}\n",
    expect: false,
  },
  {
    name: 'fenced by import.meta.url compare',
    src: 'function main(){}\nif (import.meta.url === `file://${process.argv[1]}`) {\n  main();\n}\n',
    expect: false,
  },
  { name: 'no main() at all', src: 'export function helper(){}\n', expect: false },
];

function selfTest() {
  for (const c of CONTROLS) {
    const got = classify(c.src).unfenced;
    if (got !== c.expect) {
      console.error(`::error::guard-import-side-effects: EMBEDDED CONTROL FAILED — "${c.name}" expected unfenced=${c.expect}, got ${got}. The detector has drifted; a clean scan from it would mean nothing.`);
      process.exit(1);
    }
  }
}

function main() {
  selfTest();

  const files = readdirSync(CI_DIR).filter((f) => f.startsWith('check-') && f.endsWith('.mjs'));
  // Refuse to pass vacuously: this population is 112 today and cannot plausibly
  // collapse. An empty scan is a broken enumerator, not a clean repo.
  if (files.length < 50) {
    console.error(`::error::guard-import-side-effects: enumerated only ${files.length} check-*.mjs (expected >= 50). The scan is broken — FAILING rather than reporting a clean sweep of nothing.`);
    process.exit(1);
  }

  const bad = [];
  let fenced = 0;
  for (const f of files) {
    const v = classify(readFileSync(path.join(CI_DIR, f), 'utf8'));
    if (v.unfenced) bad.push({ f, line: v.line });
    else if (v.fenced) fenced++;
  }

  for (const b of bad) {
    console.error(`::error file=scripts/ci/${b.f},line=${b.line}::guard-import-side-effects: ${b.f} calls main() at module scope (line ${b.line}), so importing it to unit-test its helpers runs the whole scan and can process.exit() inside the test runner — a runner that dies with no failed assertion (#3422's signature). Fix: wrap the call.\n  if (process.argv[1] && process.argv[1].endsWith('${b.f}')) {\n    main();\n  }`);
  }

  console.log(`guard-import-side-effects: ${files.length} check-*.mjs scanned, ${fenced} fenced, ${bad.length} unfenced; ${CONTROLS.length} embedded control(s) passed.`);
  if (bad.length) {
    console.error(`::error::guard-import-side-effects: ${bad.length} guard(s) run their scan on import.`);
    process.exit(1);
  }
}

// Run as a script, not as an import side effect (#3436) — this guard obeys the
// rule it enforces, which is also how its own tests import `classify`.
if (process.argv[1] && process.argv[1].endsWith('check-guard-import-side-effects.mjs')) {
  main();
}
