#!/usr/bin/env node
/**
 * check-no-optional-severity — the `optional` readiness severity stays DELETED.
 *
 * WHY THIS GUARD EXISTS (#3347).
 *
 * The operator's standing instruction is "nothing should be optional; everything
 * should be opt-out by default". `optional` never changed any behaviour — the
 * readiness scorer gives a `blocked` capability a value of 0 whatever its
 * severity — so the label's only effect was on how a human read the number, and
 * it was used exactly that way: on 2026-08-12 a readiness gap was reported as
 * "13 blocked, all optional severity", phrasing that excused thirteen
 * capabilities the deploy was supposed to wire and had not. While the label
 * exists, someone will reach for it again.
 *
 * So it is gone: `AuditSeverity` is `'critical' | 'recommended'`, and the 113
 * capabilities that carried `optional` are now `recommended`.
 *
 * WHAT THIS CHECKS (comments are stripped first, so prose explaining the
 * removal — including this file — never trips it; only real code does):
 *
 *   1. optional-in-union     — the AuditSeverity union re-admits 'optional'.
 *   2. optional-severity     — any `severity: 'optional'` value, with or without
 *                              `as const`, anywhere under the scanned roots.
 *   3. optional-weight       — an `optional:` entry in a severity weight/rank map
 *                              (SEVERITY_WEIGHT / weight / sevRank), i.e. the
 *                              scoring tier being wired back up.
 *   4. severity-union-missing — the AuditSeverity declaration is GONE from
 *                              core.ts. Rules 1-3 are all trivially satisfiable
 *                              by deleting the type they protect; a guard that
 *                              can be satisfied by removing the thing it guards
 *                              is a guard that cannot fail.
 *
 * ZERO-POPULATION IS A FAILURE, NOT A PASS. The debt here is already 0, so
 * "found nothing" is the expected steady state and proves nothing on its own
 * (guard_with_zero_population_needs_embedded_control). Two defences: the scan
 * fails if it matched no files at all, and every run executes the embedded
 * control in `selfTest()` — a known-violating fixture that MUST still be
 * detected — before it reports the tree clean.
 *
 * Run `--self-test` alone for the mutation proof in isolation.
 *
 * Exit codes: 0 pass, 1 violation, 2 the check itself could not run (an
 * unreadable file or an empty file set is UNKNOWN, never clean).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CONSOLE_DIR = join(REPO, 'apps', 'fiab-console');
const SCAN_ROOTS = [join(CONSOLE_DIR, 'lib'), join(CONSOLE_DIR, 'app')];
const CORE = join(CONSOLE_DIR, 'lib', 'admin', 'env-checks', 'core.ts');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', 'test-results']);

/** Strip block + line comments so explanatory prose never trips the detector. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The detector. PURE over source text, so the self-test exercises the SAME code
 * path the real scan runs — not a re-implementation of it.
 *
 * @param {string} source
 * @returns {{id: string, message: string}[]}
 */
export function findViolations(source) {
  const out = [];
  const code = stripComments(source);

  // 1. The union itself re-admitting the tier.
  const union = code.match(/type\s+AuditSeverity\s*=\s*([^;]+);/);
  if (union && /['"]optional['"]/.test(union[1])) {
    out.push({
      id: 'optional-in-union',
      message:
        "AuditSeverity re-admits 'optional'. The tier was deleted in #3347: a blocked capability labelled optional is the defect, not a mitigation. Classify as 'critical' (global blast radius — the Console cannot boot, authenticate or persist state) or 'recommended' (everything else the deploy provisions by default). A genuine cost-material or tenant-consent opt-in uses the explicit EnvSpec.optIn flag with a reason, never a severity label.",
    });
  }

  // 2. Any severity value of 'optional' (bare or `as const`).
  if (/\bseverity\s*:\s*['"]optional['"]/.test(code)) {
    out.push({
      id: 'optional-severity',
      message:
        "severity: 'optional' is set on a check, spec or probe. Use 'recommended' — if the deploy is meant to wire it and did not, fix the deploy (auto-bind-by-default.md §5), do not relabel the capability.",
    });
  }

  // 3. The scoring tier being wired back into a weight / rank map.
  if (/\b(?:SEVERITY_WEIGHT|weight|sevRank)\b[^=;]*=\s*[^;]*?\boptional\s*:\s*-?\d/.test(code)) {
    out.push({
      id: 'optional-weight',
      message:
        "A severity weight/rank map carries an 'optional' entry. The scoring tiers are critical=3 and recommended=2 only (#3347).",
    });
  }

  return out;
}

/** Rule 4 is about a file's EXISTENCE + shape, so it is checked separately. */
export function findUnionViolations(source) {
  const code = stripComments(source);
  const union = code.match(/type\s+AuditSeverity\s*=\s*([^;]+);/);
  if (!union) {
    return [{
      id: 'severity-union-missing',
      message:
        'The AuditSeverity union is gone from lib/admin/env-checks/core.ts. Deleting the type satisfies every other rule in this guard while removing what they protect — that is a failure, not a pass.',
    }];
  }
  return [];
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    throw new Error(`could not read directory ${dir}: ${e && e.message}`);
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch (e) {
      throw new Error(`could not stat ${full}: ${e && e.message}`);
    }
    if (st.isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(name)) acc.push(full);
  }
  return acc;
}

function selfTest({ quiet = false } = {}) {
  const cases = [
    {
      name: 'compliant source (and prose naming the removed label)',
      source: `// this comment mentions severity: 'optional' and must NOT trip the guard
        /* nor must this block comment about type AuditSeverity = 'critical' | 'recommended' | 'optional'; */
        export type AuditSeverity = 'critical' | 'recommended';
        const SEVERITY_WEIGHT = { critical: 3, recommended: 2 };
        const spec = { id: 'svc-x', severity: 'recommended' as const };`,
      expect: [],
    },
    {
      name: "an unrelated 'optional' string is not a severity",
      source: `const opts = [{ value: 'optional', label: 'Optional (false)' }];`,
      expect: [],
    },
    {
      // EMBEDDED CONTROL — the known-true fixture. If this stops firing the
      // detector has gone blind and the clean tree above means nothing.
      name: 'CONTROL: union re-admits optional',
      source: `export type AuditSeverity = 'critical' | 'recommended' | 'optional';`,
      expect: ['optional-in-union'],
    },
    {
      name: 'CONTROL: a spec sets severity optional',
      source: `const s = { id: 'svc-x', category: 'azure-services', severity: 'optional', required: ['X'] };`,
      expect: ['optional-severity'],
    },
    {
      name: 'CONTROL: a probe sets severity optional as const',
      source: `const base = { id: 'probe-x', title: 'X', severity: 'optional' as const };`,
      expect: ['optional-severity'],
    },
    {
      name: 'CONTROL: the weight map re-adds the tier',
      source: `const SEVERITY_WEIGHT: Record<AuditSeverity, number> = { critical: 3, recommended: 2, optional: 1 };`,
      expect: ['optional-weight'],
    },
    {
      name: 'CONTROL: a UI rank map re-adds the tier',
      source: `const sevRank = { critical: 0, recommended: 1, optional: 2 } as Record<string, number>;`,
      expect: ['optional-weight'],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = findViolations(c.source).map((v) => v.id).sort();
    const want = [...c.expect].sort();
    const ok = got.length === want.length && got.every((g, i) => g === want[i]);
    if (!quiet || !ok) console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} — expected [${want}], got [${got}]`);
    if (!ok) failed++;
  }

  // Rule 4's own control: a source with no union declaration must be caught.
  const missing = findUnionViolations(`export type Something = 'a' | 'b';`).map((v) => v.id);
  const okMissing = missing.length === 1 && missing[0] === 'severity-union-missing';
  if (!quiet || !okMissing) {
    console.log(`${okMissing ? 'ok  ' : 'FAIL'} CONTROL: union deleted — expected [severity-union-missing], got [${missing}]`);
  }
  if (!okMissing) failed++;

  if (failed > 0) {
    console.error(`\ncheck-no-optional-severity self-test FAILED (${failed} case(s)). The detector cannot see its own known-violating fixtures, so a clean scan proves nothing.`);
    process.exit(1);
  }
  if (!quiet) console.log('\ncheck-no-optional-severity self-test passed.');
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  // The embedded control runs on EVERY invocation, before the tree is scanned.
  selfTest({ quiet: true });

  if (!existsSync(CORE)) {
    console.error(`check-no-optional-severity: ${relative(REPO, CORE)} does not exist — the AuditSeverity union is missing entirely. That is a failure, not a pass.`);
    process.exit(2);
  }

  let coreSource;
  try {
    coreSource = readFileSync(CORE, 'utf8');
  } catch (e) {
    console.error(`check-no-optional-severity: could not read ${relative(REPO, CORE)}: ${e && e.message}`);
    process.exit(2);
  }

  /** @type {{file: string, id: string, message: string}[]} */
  const violations = [];
  for (const v of findUnionViolations(coreSource)) {
    violations.push({ file: relative(REPO, CORE).split(sep).join('/'), ...v });
  }

  let files = [];
  try {
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) {
        console.error(`check-no-optional-severity: scan root ${relative(REPO, root)} is missing — the population is unknown, not clean.`);
        process.exit(2);
      }
      walk(root, files);
    }
  } catch (e) {
    console.error(`check-no-optional-severity: ${e && e.message}`);
    process.exit(2);
  }

  if (files.length === 0) {
    console.error('check-no-optional-severity: scanned 0 files. An empty population cannot be clean — the roots or the extension filter are wrong.');
    process.exit(2);
  }

  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`check-no-optional-severity: could not read ${relative(REPO, file)}: ${e && e.message}`);
      process.exit(2);
    }
    for (const v of findViolations(source)) {
      violations.push({ file: relative(REPO, file).split(sep).join('/'), ...v });
    }
  }

  if (violations.length === 0) {
    console.log(`check-no-optional-severity: OK — the 'optional' severity stays deleted (${files.length} files scanned, embedded control green).`);
    return;
  }
  for (const v of violations) console.error(`check-no-optional-severity: ${v.file}: [${v.id}] ${v.message}`);
  process.exit(1);
}

// Run as a script, not as an import side effect (#3436). Without this,
// `import`ing this module to unit-test its helpers runs the WHOLE scan and can
// process.exit() inside the test runner — which surfaces as a runner that dies
// with no failed assertion, the same non-diagnostic shape as a `set -u` abort.
if (process.argv[1] && process.argv[1].endsWith('check-no-optional-severity.mjs')) {
  main();
}
