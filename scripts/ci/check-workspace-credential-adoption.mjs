#!/usr/bin/env node
/**
 * GUARDRAIL: workspace-credential-adoption (merge-blocker) — loom-next-level I5
 * ---------------------------------------------------------------------------
 * RULE (shrink-only adoption ratchet, same mechanic as check-no-raw-px /
 * the vitest coverage floor):
 *
 *   Server-side Azure clients must resolve credentials through the
 *   per-workspace credential FACTORY —
 *     apps/fiab-console/lib/azure/workspace-credential-factory.ts
 *       - credentialFor(ctx?)            (async, per-call resolution)
 *       - workspaceScopedCredential(ctx?) (lazy TokenCredential adapter — the
 *         drop-in replacement for a module-level ChainedTokenCredential)
 *
 *   Direct `new ChainedTokenCredential(…)` constructions resolve the identity
 *   ONCE at module load and can never carry a workspace context, so the
 *   I3 shadow audit and the I6 enforce flip cannot see those calls. The count
 *   of direct constructions may therefore only ever SHRINK. New code MUST use
 *   the factory (or `uamiArmCredential()` for pure admin/ARM-plane clients —
 *   that helper is itself factory-served and stays out of this count via the
 *   definition allowlist).
 *
 * BASELINE: set to the repo-wide count at I5 (post pilot migration). When you
 * migrate a client, re-run this script — it tells you the new lower number to
 * ratchet BASELINE down to. Raising the number is a rule violation.
 *
 * ── WHY THIS COUNTS CODE AND NOT TEXT (#4014) ─────────────────────────────
 *
 * The first cut was `text.indexOf('new ChainedTokenCredential(')` over the raw
 * file. Measured on #4014: that reddened the gate on a JSDoc block whose only
 * offence was NAMING this guard's needle while explaining why the module it sits
 * in does not hand-roll a chain. A doc comment cannot construct anything, so the
 * count was reporting prose as adoption debt — and the "fix" it invited was to
 * misspell the needle in the comment, i.e. to make the repo less greppable in
 * order to satisfy a ratchet. The rule is about CONSTRUCTIONS; the predicate is
 * now about constructions too.
 *
 * The scanner classifies each byte (code / line comment / block comment /
 * string / template / regex) and only counts a needle in CODE. It is written to
 * fail in the SAFE direction: every ambiguity keeps the occurrence counted, and
 * string / regex / line-comment states abort at a newline, so a mis-read is
 * bounded to one line instead of swallowing a file.
 *
 * That change can only ever LOWER a count, which is exactly the direction that
 * silently weakens a ratchet — so two things now defend it, and both run on
 * every invocation:
 *   1. `--self-test` arms that are RED against the naive implementation, most
 *      importantly a real construction sharing a line with a string that
 *      contains `//`. A stripper that truncated there would drop a live
 *      construction and report a clean shrink.
 *   2. A POPULATION FLOOR. A scanner defect that returned ~0 would have sailed
 *      through the old `count < BASELINE` branch as a congratulatory NOTE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const SCAN_ROOTS = [path.join(CONSOLE_ROOT, 'lib'), path.join(CONSOLE_ROOT, 'app')];

// Direct-construction count allowed. SHRINK-ONLY — lower it as clients migrate.
const BASELINE = 130;

// The scan must keep finding a real population. Below this the result is treated
// as a SCANNER DEFECT, not an adoption win: the only ways to get here are a
// migration wave far larger than any single PR has ever landed (in which case
// lower BASELINE and FLOOR together, with the measured number in the PR body) or
// a parser bug that stopped seeing code. Both need a human; neither is a pass.
const FLOOR = 100;

// Files that legitimately construct the chain (they DEFINE the shared chain
// the factory serves) — POSIX repo-relative suffixes.
const DEFINITION_ALLOWLIST = [
  'apps/fiab-console/lib/azure/arm-credential.ts',
  'apps/fiab-console/lib/azure/aca-managed-identity.ts',
  'apps/fiab-console/lib/azure/workspace-credential-factory.ts',
];

const NEEDLE = 'new ChainedTokenCredential(';

// ── The scanner ─────────────────────────────────────────────────────────────

const IDENT_END = /[A-Za-z0-9_$)\]}'"`.]/;
// Keywords after which a `/` begins a REGEX, not a division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * True when the `/` at `i` starts a regex literal rather than a division.
 *
 * Wrong either way costs at most ONE line (see the state machine's newline
 * aborts), and the default when nothing precedes is "regex", matching JS.
 */
function startsRegex(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  if (j < 0) return true;
  const c = text[j];
  if (!IDENT_END.test(c)) return true;
  if (!/[A-Za-z0-9_$]/.test(c)) return false;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k -= 1;
  return REGEX_PRECEDING_KEYWORDS.has(text.slice(k + 1, j + 1));
}

/**
 * Count occurrences of `needle` that sit in EXECUTABLE CODE.
 *
 * Returns `{ code, raw }` so the caller can report both — a large and
 * unexplained gap between them is itself a signal worth seeing.
 */
export function countInCode(text, needle = NEEDLE) {
  let raw = 0;
  for (let i = 0; (i = text.indexOf(needle, i)) !== -1; i += needle.length) raw += 1;

  let code = 0;
  // Stack so a template's `${ … }` can return to code and nest again.
  const stack = [];
  let state = 'code';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (state === 'code') {
      if (c === '/' && text[i + 1] === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && text[i + 1] === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'squote'; i += 1; continue; }
      if (c === '"') { state = 'dquote'; i += 1; continue; }
      if (c === '`') { stack.push('code'); state = 'template'; i += 1; continue; }
      if (c === '/' && startsRegex(text, i)) { state = 'regex'; i += 1; continue; }
      if (c === '}' && stack.length > 0 && stack[stack.length - 1] === 'template') {
        stack.pop(); state = 'template'; i += 1; continue;
      }
      if (c === needle[0] && text.startsWith(needle, i)) { code += 1; i += needle.length; continue; }
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') state = 'code';
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && text[i + 1] === '/') { state = 'code'; i += 2; continue; }
      i += 1;
      continue;
    }

    if (state === 'squote' || state === 'dquote') {
      if (c === '\\') { i += 2; continue; }
      // An unterminated string cannot cross a line — abort rather than swallow
      // the rest of the file (the failure mode that would blind the ratchet).
      if (c === '\n') { state = 'code'; i += 1; continue; }
      if ((state === 'squote' && c === "'") || (state === 'dquote' && c === '"')) state = 'code';
      i += 1;
      continue;
    }

    if (state === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { state = stack.pop() ?? 'code'; i += 1; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push('template'); state = 'code'; i += 2; continue; }
      i += 1;
      continue;
    }

    // regex
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') { state = 'code'; i += 1; continue; }
    if (c === '[') {
      i += 1;
      while (i < n && text[i] !== ']' && text[i] !== '\n') { i += text[i] === '\\' ? 2 : 1; }
      i += 1;
      continue;
    }
    if (c === '/') { state = 'code'; i += 1; continue; }
    i += 1;
  }

  return { code, raw };
}

// ── The verdict ─────────────────────────────────────────────────────────────

/** Pure so the self-test can exercise every branch, including the FAIL path. */
export function decide(count, baseline = BASELINE, floor = FLOOR) {
  if (count > baseline) return 'over-baseline';
  if (count < floor) return 'below-floor';
  if (count < baseline) return 'ratchet-down';
  return 'ok';
}

// ── Self-test — the guard must FAIL on the real defects ─────────────────────

function selfTest() {
  const fails = [];
  const check = (name, actual, expected) => {
    const ok = actual === expected;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (expected ${expected}, got ${actual})`}`);
    if (!ok) fails.push(name);
  };

  console.log('[ws-credential-adoption] self-test — the guard must FAIL on the real defects');

  // The control. Without it a scanner that counted nothing would score every
  // exclusion arm below as a pass.
  check('a real construction IS counted',
    countInCode('const c = new ChainedTokenCredential(a, b);').code, 1);
  check('two real constructions are both counted',
    countInCode('new ChainedTokenCredential(a);\nnew ChainedTokenCredential(b);').code, 2);
  check('a clean file counts zero', countInCode('export const x = 1;\n').code, 0);

  // The #4014 defect, in each comment shape.
  check('a `//` line comment naming the needle is NOT counted',
    countInCode('// new ChainedTokenCredential( is what this replaces\n').code, 0);
  check('a JSDoc block naming the needle is NOT counted',
    countInCode('/**\n * a ratchet on `new ChainedTokenCredential(`, and the\n * first version added two.\n */\n').code, 0);
  check('an inline /* */ comment naming the needle is NOT counted',
    countInCode('const x = 1; /* new ChainedTokenCredential( */\n').code, 0);
  check('a trailing comment after real code counts the code only',
    countInCode('const c = new ChainedTokenCredential(a); // not new ChainedTokenCredential(b)\n').code, 1);

  // THE ARM THAT MATTERS: a naive comment stripper truncates at the `//` inside
  // the string, drops the construction after it, and reports a clean shrink.
  check('a `//` inside a STRING does not hide the construction on that line',
    countInCode(`const u = 'https://x'; const c = new ChainedTokenCredential(a);`).code, 1);
  check('a `/*` inside a STRING does not swallow the rest of the file',
    countInCode(`const s = "/* not a comment";\nconst c = new ChainedTokenCredential(a);\n`).code, 1);
  check('a `//` inside a TEMPLATE literal does not hide a later construction',
    countInCode('const u = `https://x`;\nconst c = new ChainedTokenCredential(a);\n').code, 1);
  check('a construction inside a template `${}` IS counted',
    countInCode('const s = `${new ChainedTokenCredential(a)}`;\n').code, 1);
  check('a `/*` inside a REGEX does not swallow the rest of the file',
    countInCode('const re = /a\\/*b/;\nconst c = new ChainedTokenCredential(a);\n').code, 1);
  check('a DIVISION is not mistaken for a regex that eats the next line',
    countInCode('const r = a / b;\nconst c = new ChainedTokenCredential(a);\n').code, 1);
  check('an unterminated quote does not swallow the next line',
    countInCode("const bad = 'oops;\nconst c = new ChainedTokenCredential(a);\n").code, 1);
  check('the raw count still sees comment occurrences (the delta is reportable)',
    countInCode('// new ChainedTokenCredential(\n').raw, 1);

  // The verdict, including the branches that must FAIL.
  check('a count OVER baseline fails', decide(131, 130, 100), 'over-baseline');
  check('a count AT baseline passes', decide(130, 130, 100), 'ok');
  check('a count under baseline but above the floor is a ratchet note',
    decide(120, 130, 100), 'ratchet-down');
  check('a scanner that returned ZERO fails on the FLOOR, not a congratulation',
    decide(0, 130, 100), 'below-floor');
  check('a count just under the floor fails', decide(99, 130, 100), 'below-floor');

  if (fails.length > 0) {
    console.error(`[ws-credential-adoption] self-test FAILED: ${fails.join(', ')}`);
    process.exit(1);
  }
  console.log('[ws-credential-adoption] self-test OK');
}

// ── The scan ────────────────────────────────────────────────────────────────

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      yield* walk(p);
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      yield p;
    }
  }
}

const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

function main() {
  // The self-test runs on EVERY invocation, not as a separate workflow step: a
  // control the caller can omit is a control that eventually is omitted.
  selfTest();
  if (process.argv.includes('--self-test')) return;

  let count = 0;
  let rawCount = 0;
  const perFile = new Map();
  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root)) {
      const r = rel(file);
      if (DEFINITION_ALLOWLIST.some((a) => r === a)) continue;
      const { code, raw } = countInCode(fs.readFileSync(file, 'utf8'));
      rawCount += raw;
      if (code > 0) { perFile.set(r, code); count += code; }
    }
  }

  const inComments = rawCount - count;
  console.log(
    `[ws-credential-adoption] direct ChainedTokenCredential constructions: ${count} ` +
      `(baseline ${BASELINE}, floor ${FLOOR}, shrink-only; ` +
      `${inComments} further textual occurrence(s) are in comments and do not construct anything)`,
  );

  const verdict = decide(count);

  if (verdict === 'over-baseline') {
    console.error(`\n[ws-credential-adoption] FAIL — ${count} direct constructions > baseline ${BASELINE}.`);
    console.error('New Azure-client code must resolve credentials through the factory:');
    console.error("  import { workspaceScopedCredential } from '@/lib/azure/workspace-credential-factory';");
    console.error("  const credential = workspaceScopedCredential(); // or credentialFor({ workspaceId })");
    console.error('(pure admin/ARM-plane clients may use uamiArmCredential() from lib/azure/arm-credential.)');
    console.error('\nOffending files (occurrences):');
    for (const [f, n] of [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.error(`  ${String(n).padStart(3)}  ${f}`);
    }
    process.exit(1);
  }

  if (verdict === 'below-floor') {
    console.error(`\n[ws-credential-adoption] FAIL — ${count} direct constructions is BELOW the floor of ${FLOOR}.`);
    console.error('This is read as a SCANNER DEFECT, not an adoption win. A drop this large has');
    console.error('never come from one migration, and the failure mode it looks like — a parser');
    console.error('that stopped seeing code — would otherwise pass as a congratulatory note.');
    console.error(`Raw textual occurrences seen: ${rawCount}. Files with a construction: ${perFile.size}.`);
    console.error('If the migration is real, lower BASELINE and FLOOR together in');
    console.error('scripts/ci/check-workspace-credential-adoption.mjs and put the measured number in the PR.');
    process.exit(1);
  }

  if (verdict === 'ratchet-down') {
    console.log(`[ws-credential-adoption] NOTE — count dropped below baseline; ratchet it: set BASELINE = ${count} in scripts/ci/check-workspace-credential-adoption.mjs (this run still passes).`);
  }
  console.log('[ws-credential-adoption] OK.');
}

// Fenced so importing this module for `countInCode` / `decide` does not run the
// whole scan and `process.exit()` inside a test runner (#3422's signature —
// `check-guard-import-side-effects.mjs` enforces it, and caught this exact
// regression when the helpers above were first exported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
