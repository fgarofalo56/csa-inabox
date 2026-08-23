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
// SUBJECT DISCOVERY (#3438) — the meta-guard's own blind spot.
// ─────────────────────────────────────────────────────────────────────────────
//
// This guard used to enumerate `check-*.mjs` and nothing else. But a guard is
// free to factor its line-splitting into a helper module, and several do — and
// once the split lives in a helper, BOTH the helper and every consumer classify
// `out-of-scope` and this meta-guard passes regardless of what the scanner does.
// That is the very shape it exists to prevent, one level up: a check whose
// population silently excludes the thing that matters, reporting clean.
//
// MEASURED when this was closed, and the numbers are the argument for doing BOTH
// halves rather than either:
//
//   check-*.mjs guards ................................. 128
//   helpers reached by FOLLOWING relative imports ....... 11
//   helpers matched by the `_*.mjs` glob ................ 12
//   reached ONLY by the glob (imported by no guard) ..... 4   _arm-absence,
//                                                             _azure-redact,
//                                                             _route-auth-scope,
//                                                             _route-backends
//   reached ONLY by import-following (NO `_` prefix) .... 3   deploy-image-roles,
//                                                             reconcile-policy,
//                                                             roll-plan
//   UNION ............................................... 15, of which ONE was
//                                                             `unclassified`
//                                                             (_workflow-yaml)
//
// The glob alone is the fix the issue proposed as "cheaper, and probably
// sufficient". It is not sufficient: three helper modules in this directory
// carry no `_` prefix, so renaming a helper is a one-character bypass of a
// glob-only rule. Import-following alone is not sufficient either — four
// `_`-modules are imported by no `check-*.mjs` today (tests and each other), so
// a guard could adopt one tomorrow and it would never have been judged.
//
// So: the subject set is the UNION, and the population is REPORTED on every run
// rather than left silent, per the issue's option 3.

/** Relative `.mjs` imports/exports, resolved against scripts/ci. */
const RELATIVE_MJS_IMPORT =
  /(?:^|\n)\s*(?:import[\s\S]{0,300}?from|export[\s\S]{0,300}?from|import)\s*['"`](\.\.?\/[^'"`]+\.mjs)['"`]/g;

/**
 * Helper modules that are subjects in their own right, SPLIT BY WHICH HALF OF
 * THE UNION FOUND THEM:
 *   `glob`     — every `scripts/ci/_*.mjs`;
 *   `imported` — every non-`check-` `.mjs` in this directory that a `check-*.mjs`
 *                imports.
 * The split is exposed, not internal, because the docblock above argues both
 * halves are load-bearing and that argument needs an assertion behind it
 * (see `assertUnionHalvesContribute`). Returns sorted basenames.
 */
export function helperModuleHalves(dir = HERE, guards = null) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const glob = new Set(names.filter((f) => f.startsWith('_')));
  const imported = new Set();
  const guardList = guards ?? names.filter((f) => f.startsWith('check-')).sort();
  for (const g of guardList) {
    let src;
    try { src = readFileSync(join(dir, g), 'utf8'); } catch { continue; }
    RELATIVE_MJS_IMPORT.lastIndex = 0;
    let m;
    while ((m = RELATIVE_MJS_IMPORT.exec(src))) {
      const spec = m[1];
      // One level, inside this directory only. `../x.mjs` and `./sub/x.mjs`
      // resolve outside the guard directory and are not this rule's subjects.
      const base = spec.replace(/^\.\//, '');
      if (base.includes('/') || base.startsWith('..')) continue;
      if (base.startsWith('check-')) continue; // already a subject
      if (!names.includes(base)) continue;     // import does not resolve here
      imported.add(base);
    }
  }
  return { glob: [...glob].sort(), imported: [...imported].sort() };
}

/**
 * Helper modules that are subjects in their own right: every `scripts/ci/_*.mjs`,
 * PLUS every non-`check-` `.mjs` in this directory that a `check-*.mjs` imports.
 * Returns sorted basenames.
 */
export function helperModules(dir = HERE, guards = null) {
  const { glob, imported } = helperModuleHalves(dir, guards);
  return [...new Set([...glob, ...imported])].sort();
}

/**
 * POPULATION FLOOR for the UNION (independent review of #3928).
 *
 * The docblock above argues at length that neither half is sufficient alone —
 * "renaming a helper is a one-character bypass of a glob-only rule" — but
 * NOTHING enforced it. Measured: neutering the import-following half dropped
 * the subject set 143 → 140 (15 → 12 helpers) at RC=0; neutering the glob half
 * dropped it to 139 (11 helpers), also RC=0. Half the argument's premise could
 * be deleted in silence.
 *
 * So both halves must contribute something the other does not. These floors are
 * an assertion about the DIRECTORY, not about a desired number: if the last
 * non-`_` helper genuinely disappears, that is a real change in the tree and the
 * remedy is to say so here — never to lower the floor to match a reading.
 */
function assertUnionHalvesContribute(halves) {
  const globOnly = halves.glob.filter((f) => !halves.imported.includes(f));
  const importOnly = halves.imported.filter((f) => !halves.glob.includes(f));
  const bad = [];
  if (!importOnly.length) {
    bad.push(
      'the IMPORT-FOLLOWING half now contributes NOTHING the `_*.mjs` glob does not already reach. '
      + 'A helper without a `_` prefix would then be invisible, which is the one-character bypass the '
      + 'subject-discovery note above exists to close (#3438).',
    );
  }
  if (!globOnly.length) {
    bad.push(
      'the `_*.mjs` GLOB half now contributes NOTHING import-following does not already reach. A '
      + '`_`-module that no guard imports YET would then never have been judged when one adopts it.',
    );
  }
  if (bad.length) {
    process.stderr.write('::error::guard-logical-lines: the subject UNION has collapsed to one half.\n');
    for (const b of bad) process.stderr.write(`   - ${b}\n`);
    process.stderr.write(
      `   glob half: ${halves.glob.length} (${globOnly.length} unique) | `
      + `import half: ${halves.imported.length} (${importOnly.length} unique)\n`,
    );
    process.exit(1);
  }
  console.log(
    `guard-logical-lines subject union: glob ${halves.glob.length} (${globOnly.length} reached ONLY by the `
    + `glob) + imports ${halves.imported.length} (${importOnly.length} reached ONLY by import-following) — `
    + 'both halves contribute, so neither can be removed in silence',
  );
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
  // #3438 — helper modules are subjects too. See SUBJECT DISCOVERY above.
  const halves = helperModuleHalves(HERE, guards);
  const helpers = [...new Set([...halves.glob, ...halves.imported])].sort();
  const subjects = [...guards, ...helpers];

  const buckets = { adopted: [], declared: [], unclassified: [], 'out-of-scope': [] };
  for (const f of subjects) {
    buckets[classify(readFileSync(join(HERE, f), 'utf8'))].push(f);
  }

  if (guards.length === 0) {
    console.error('::error::guard-logical-lines: discovered ZERO check-*.mjs guards. Refusing to report a pass.');
    process.exit(1);
  }
  // The helper population may not fall to zero either. This directory carries
  // `_logical-lines.mjs` itself, so a zero here means the glob AND the
  // import-follow both drifted — and a subject set that has stopped including
  // the escape hatch is exactly the state #3438 recorded.
  if (helpers.length === 0) {
    console.error(
      '::error::guard-logical-lines: discovered ZERO helper modules. scripts/ci carries `_logical-lines.mjs` ' +
        'and a dozen siblings, so zero means subject discovery has drifted — and a guard that factors its ' +
        'scanner into a helper would then be invisible again (#3438). Refusing to report a pass.',
    );
    process.exit(1);
  }
  assertUnionHalvesContribute(halves);
  const inScope = buckets.adopted.length + buckets.declared.length + buckets.unclassified.length;
  if (inScope === 0) {
    console.error(
      `::error::guard-logical-lines: ${subjects.length} subject(s) discovered and NOT ONE reads shell or YAML ` +
        'bodies line by line. This directory is full of them, so zero means the classifier has drifted off the ' +
        'code. Refusing to report a pass on an empty population.',
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
    `guard-logical-lines OK — ${subjects.length} subject(s) (${guards.length} check-*.mjs + ${helpers.length} ` +
      `helper module(s)): ${buckets.adopted.length} read logical lines, ` +
      `${buckets.declared.length} declare PHYSICAL-LINES-OK with a reason, ` +
      `${buckets['out-of-scope'].length} do not judge shell/YAML bodies line by line; ` +
      `${controlCount} embedded control fixture(s) proved the classifier still separates them.`,
  );
  // Named, not silent (#3438 option 3): "out-of-scope" for a helper module used
  // to be an unstated exclusion, which is how the escape hatch stayed open.
  console.log(`guard-logical-lines helper subjects: ${helpers.join(', ')}`);
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) main();
