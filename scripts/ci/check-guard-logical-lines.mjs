#!/usr/bin/env node
/**
 * check-guard-logical-lines.mjs — the META-GUARD for #3420.
 *
 * RULE. A guard under scripts/ci/ that judges SHELL or YAML bodies line by line
 * must read LOGICAL lines — `scripts/ci/_logical-lines.mjs` — or say in one line
 * why physical lines are correct for it.
 *
 * WHY (measured twice, in two different guards, before this existed)
 * -----------------------------------------------------------------
 * Shell commands span lines with a trailing `\`. A guard that keys on a token in
 * line 1 and then requires a SECOND token on that same PHYSICAL line cannot see
 * the second token when the author put it on the continuation. It then reports
 * the codebase CLEAN — which is worse than having no guard, because the zero is
 * read as evidence.
 *
 *   check-curl-httpcode-fallback.mjs reported "0 concatenating fallbacks"
 *   against a tree carrying ELEVEN live `|| echo` sites. Every one had the
 *   `|| echo` on a continuation (#3417).
 *
 *   `csa_loom_guard_blind_continuation_lines_scripts` records the same shape:
 *   a guard passing 10/10 on a tree carrying three live `|| true`s.
 *
 * And two guards over the SAME construct disagreed for their entire lives:
 * check-httpcode-probe-aborts folded continuations from the day it was written,
 * its sibling never did. Nineteen individual patches would have re-created that
 * gap the moment guard #105 was written, so the answer is one primitive plus
 * this rule about using it.
 *
 * ── HOW A GUARD SATISFIES THIS ───────────────────────────────────────────────
 *
 *   1. import { readLogicalLines } from './_logical-lines.mjs'   — the fix; or
 *   2. a `PHYSICAL-LINES-OK: <reason>` pragma in a comment       — the opt-out.
 *
 * The pragma is deliberately cheap AND deliberately visible. Reading physical
 * lines is only a defect when a guard needs a SECOND token that can legitimately
 * land on a continuation. A guard that only detects a command's PRESENCE, or one
 * that judges YAML keys (`uses:`, `on:`, `continue-on-error:`) which never
 * continue with a backslash, is unaffected — and every such guard now says so
 * once, in its own source, so the next reader does not re-open the question.
 *
 * ── EMBEDDED CONTROL (this guard must not become what it guards against) ─────
 *
 * The population here can legitimately fall to zero — every guard adopts or
 * declares — and a matcher that has drifted off the code produces the SAME
 * empty result as a clean tree. So six fixtures run BEFORE the repo is judged,
 * three that MUST be flagged and three that MUST NOT. If any control
 * disagrees, this guard fails and reports nothing about the repo, because a
 * verdict from a scanner that has stopped scanning is not a verdict
 * (`guard_with_zero_population_needs_embedded_control`).
 *
 * It also refuses to pass when it discovers no guards at all, or when NO guard
 * in the tree reads shell/YAML bodies — this directory is full of them, so zero
 * means the classifier drifted, not that the repo changed.
 *
 * Usage:
 *   node scripts/ci/check-guard-logical-lines.mjs              # CHECK
 *   node scripts/ci/check-guard-logical-lines.mjs --self-test  # controls only
 *
 * Tests: node --test scripts/ci/__tests__/guard-logical-lines.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Splits text into PHYSICAL lines: `.split(/\r?\n/)` or `.split('\n')`. */
export const SPLITS_PHYSICAL = /\.split\(\s*(?:\/\\r\?\\n\/|['"`]\\n['"`])\s*\)/;

/**
 * Reads SHELL or YAML bodies. Each alternative is a way a guard in this
 * directory actually selects its corpus; anything narrower misses guards, and
 * anything broader sweeps in the bicep-only and markdown-only scanners, whose
 * languages have no backslash continuation and for which a pragma would be
 * noise rather than a decision.
 */
export const READS_SHELL_OR_YAML = [
  /ls-files[\s\S]{0,200}?['"`]\*\.(?:sh|ya?ml|bash)['"`]/, // git ls-files -- '*.sh' …
  /\.github[/\\]+workflows/,                                // the workflow directory
  /endsWith\(\s*['"`]\.(?:sh|ya?ml)['"`]/,                  // extension filter
  /\\\.\(\?:[^)]*\b(?:sh|ya?ml)\b[^)]*\)\$/,                // /\.(ya?ml|sh)$/ style
  /\\\.(?:sh|ya\?ml|yml|yaml)\$/,                           // /\.sh$/ / /\.ya?ml$/ style
  /['"`]\.(?:sh|ya?ml)['"`]\s*[,)\]]/,                      // '.sh' in a list
];

/** The adoption: importing the shared primitive. */
export const IMPORTS_PRIMITIVE = /from\s+['"`]\.\/_logical-lines\.mjs['"`]/;

/**
 * The declared opt-out. A reason is REQUIRED, ON THE SAME LINE — a bare marker
 * would be a way to silence the rule without making a decision, which is the
 * thing this file exists to stop.
 *
 * The first spelling was `PHYSICAL-LINES-OK:\s*\S+`, and `\s` matches a NEWLINE:
 * a bare `// PHYSICAL-LINES-OK:` was satisfied by whatever code happened to sit
 * on the next line. Its own unit test caught that. `[^\S\n]` is "horizontal
 * whitespace", and at least four word characters must follow it.
 */
export const PRAGMA = /PHYSICAL-LINES-OK:[^\S\n]*\w[^\n]{3,}/;

/** @returns {'adopted'|'declared'|'unclassified'|'out-of-scope'} */
export function classify(src) {
  if (!SPLITS_PHYSICAL.test(src)) return 'out-of-scope';
  if (!READS_SHELL_OR_YAML.some((re) => re.test(src))) return 'out-of-scope';
  if (IMPORTS_PRIMITIVE.test(src)) return 'adopted';
  if (PRAGMA.test(src)) return 'declared';
  return 'unclassified';
}

// ─────────────────────────────────────────────────────────────────────────────
// EMBEDDED CONTROL — proven on every run, before the repo is judged.
// ─────────────────────────────────────────────────────────────────────────────

const SHELL_CORPUS = "execFileSync('git', ['ls-files', '--', '*.sh', '*.yml'])";
const SPLIT = 'text.split(/\\r?\\n/).forEach((line) => {})';

/** Fixtures the classifier MUST report as `unclassified`. */
export const MUST_FLAG = [
  {
    why: 'git-ls-files shell corpus, split into physical lines, no primitive and no pragma',
    src: `${SHELL_CORPUS}\n${SPLIT}\n`,
  },
  {
    why: 'reads .github/workflows and splits on a bare newline literal',
    src: "readdirSync('.github/workflows')\nyaml.split('\\n').forEach(() => {})\n",
  },
  {
    why: 'an extension filter plus a physical split is still a physical-line judgement',
    src: "files.filter((f) => f.endsWith('.sh'))\n" + SPLIT + '\n',
  },
];

/** Fixtures the classifier MUST NOT report as `unclassified`. */
export const MUST_NOT_FLAG = [
  {
    why: 'ADOPTED — imports the shared primitive',
    expect: 'adopted',
    src: `import { readLogicalLines } from './_logical-lines.mjs';\n${SHELL_CORPUS}\n${SPLIT}\n`,
  },
  {
    why: 'DECLARED — a pragma with a reason',
    expect: 'declared',
    src: `// PHYSICAL-LINES-OK: judges \`uses:\` keys, which never continue with a backslash.\n${SHELL_CORPUS}\n${SPLIT}\n`,
  },
  {
    why: 'OUT OF SCOPE — splits lines, but the corpus is bicep, which has no line continuation',
    expect: 'out-of-scope',
    src: "files.filter((f) => f.endsWith('.bicep'))\n" + SPLIT + '\n',
  },
];

/** Runs the controls. Returns failure descriptions (empty = healthy). */
export function runControls() {
  const failures = [];
  for (const c of MUST_FLAG) {
    const got = classify(c.src);
    if (got !== 'unclassified') failures.push(`MUST-FLAG classified as "${got}" — ${c.why}`);
  }
  for (const c of MUST_NOT_FLAG) {
    const got = classify(c.src);
    if (got !== c.expect) failures.push(`MUST-NOT-FLAG classified as "${got}", expected "${c.expect}" — ${c.why}`);
  }
  return failures;
}

function main() {
  const controlFailures = runControls();
  if (controlFailures.length > 0) {
    console.error(
      `::error::guard-logical-lines: the EMBEDDED CONTROL failed (${controlFailures.length}). The classifier no ` +
        'longer behaves as documented, so any verdict about scripts/ci would be meaningless — a scanner that has ' +
        'stopped matching is indistinguishable from a compliant directory.',
    );
    for (const f of controlFailures) console.error(`   - ${f}`);
    process.exit(1);
  }
  const controlCount = MUST_FLAG.length + MUST_NOT_FLAG.length;

  if (process.argv.includes('--self-test')) {
    console.log(`guard-logical-lines self-test OK — ${controlCount} control fixture(s) classified as documented.`);
    return;
  }

  const guards = readdirSync(HERE)
    .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
    .sort();

  const buckets = { adopted: [], declared: [], unclassified: [], 'out-of-scope': [] };
  for (const f of guards) {
    buckets[classify(readFileSync(join(HERE, f), 'utf8'))].push(f);
  }

  if (guards.length === 0) {
    console.error('::error::guard-logical-lines: discovered ZERO check-*.mjs guards. Refusing to report a pass.');
    process.exit(1);
  }
  const inScope = buckets.adopted.length + buckets.declared.length + buckets.unclassified.length;
  if (inScope === 0) {
    console.error(
      `::error::guard-logical-lines: ${guards.length} guard(s) discovered and NOT ONE reads shell or YAML bodies ` +
        'line by line. This directory is full of them, so zero means the classifier has drifted off the code. ' +
        'Refusing to report a pass on an empty population.',
    );
    process.exit(1);
  }

  if (buckets.unclassified.length > 0) {
    console.error(
      `::error::guard-logical-lines: ${buckets.unclassified.length} guard(s) judge SHELL/YAML bodies by PHYSICAL ` +
        'line. A shell command routinely spans lines with a trailing `\\`, so a guard that keys on a token in ' +
        'line 1 and requires a second token on that same line cannot see the second token — and then reports the ' +
        'codebase CLEAN. That is how eleven live `|| echo` sites read as zero (#3417). Either:\n' +
        "  1. import { readLogicalLines } from './_logical-lines.mjs' and judge logical lines; or\n" +
        '  2. add a `PHYSICAL-LINES-OK: <reason>` comment saying why physical lines are right here\n' +
        '     (e.g. it only needs a command\'s PRESENCE, or it judges YAML keys that never continue).\n' +
        '  NOTE when adopting: re-scope any "this line is prose" exclusion (`echo`, `::warning::`) to the text ' +
        'BEFORE the match. On a folded line an invocation carries its own fallback message, and an ' +
        'anywhere-on-the-line test then discards real call sites.',
    );
    for (const f of buckets.unclassified) console.error(`::error file=scripts/ci/${f}::judges shell/YAML by physical line`);
    process.exit(1);
  }

  console.log(
    `guard-logical-lines OK — ${guards.length} guard(s): ${buckets.adopted.length} read logical lines, ` +
      `${buckets.declared.length} declare PHYSICAL-LINES-OK with a reason, ` +
      `${buckets['out-of-scope'].length} do not judge shell/YAML bodies line by line; ` +
      `${controlCount} embedded control fixture(s) proved the classifier still separates them.`,
  );
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) main();
