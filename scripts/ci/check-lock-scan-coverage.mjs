#!/usr/bin/env node
/**
 * GUARDRAIL: the scans over `requirements/**` must actually have PARSED them.
 *
 * WHY THIS EXISTS (refs #3485)
 * ----------------------------
 * For as long as the lock files have existed, both the vulnerability scan and
 * the SBOM reported green against an EMPTY SET.
 *
 *   Trivy fs, job `trivy-fs`, run 31834443174:
 *       INFO  Number of language-specific files  num=0
 *   The published `sbom-python-portal-cyclonedx.json` from sbom run
 *   31789267009: 0 components.
 *
 * The CRITICAL-gated check named "Trivy Filesystem (lock files)" had never
 * examined a single package. Neither tool was broken: both key on the FILENAME,
 * and `requirements/portal.lock` matched nothing either of them looks for. The
 * comment at sbom.yml:78 asserting that `file:` makes Syft read it as
 * `python-requirements` was simply not true — and it survived review because it
 * reads as a deliberate, reasoned choice.
 *
 * The layout fix (`requirements/locks/<extra>/requirements.txt`) is in
 * scripts/update-locks.sh. This is the part that makes the fix STAY fixed: a
 * scan that finds nothing must FAIL, not pass. That single assertion, present on
 * day one, would have caught the whole thing — which is exactly the argument for
 * adding it now rather than trusting the rename.
 *
 * AND IT IMMEDIATELY EARNED ITS KEEP. The first run against the renamed tree
 * failed on `requirements/dev/requirements.txt`: Trivy's default skip list is
 * ROOT-ANCHORED and `dev` is on it, so with the scan rooted at `requirements/`
 * that one lock was silently dropped while its nine siblings were scanned.
 * Measured on a probe directory — `dev/` and `proc/` skipped, `nested/dev/`,
 * `devx/`, `tmp/` and `portal/` all scanned. Hence the `locks/` level, which
 * moves every extra off the anchor. Without this check the rename would have
 * shipped looking complete with one file still invisible, which is the same
 * defect in a new place.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   --trivy <report.json>
 *       Every tracked lock appears in the report as its own target, with a
 *       non-zero package count. Not "the report is non-empty" — PER FILE, so a
 *       renamed or newly added extra that the analyser silently skips is a
 *       failure rather than an unnoticed gap.
 *
 *   --sbom <cyclonedx.json> --extra <name>
 *       The generated SBOM has a non-zero component count. A 0-component SBOM is
 *       a published document asserting the software has no dependencies.
 *
 * Vulnerability COUNT is deliberately not asserted in either direction. Zero
 * findings is a legitimate and desirable state; zero PACKAGES never is. Keying
 * the floor on findings would make a clean scan look broken and — worse — make a
 * broken scan look clean the moment the tree happens to be vulnerable.
 *
 * FAILING CLOSED
 * --------------
 * Missing report, unparseable JSON, zero tracked locks, a lock with no target,
 * a target with no packages: every one is a failure. "I could not check that" is
 * not "there was nothing to check".
 *
 * Usage:
 *   node scripts/ci/check-lock-scan-coverage.mjs --selftest
 *   node scripts/ci/check-lock-scan-coverage.mjs --trivy trivy-fs-all.json
 *   node scripts/ci/check-lock-scan-coverage.mjs --sbom sbom.json --extra portal
 * Tests: node --test scripts/ci/__tests__/lock-scan-coverage.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Every `name==version` pin in a compiled lock. This is the EXPECTED count. */
export function countPins(text) {
  let n = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\s*==/.test(line)) n += 1;
  }
  return n;
}

/**
 * The committed locks, from git, each with the number of pins it declares.
 * Never a filesystem walk (stale worktrees); the READ is the filesystem so an
 * unstaged regeneration is judged rather than the index.
 */
export function trackedLocks(root = REPO_ROOT) {
  return execFileSync('git', ['ls-files', 'requirements/locks/*/requirements.txt'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => ({ path: p, pins: countPins(readFileSync(path.join(root, p), 'utf8')) }));
}

/**
 * How many packages Trivy reported per target, keyed by the target path as the
 * report gives it. The scan root varies (`requirements/` in CI, the repo root
 * locally), so `findTarget` matches on the trailing segments rather than
 * assuming a prefix.
 */
export function trivyPackageCounts(report) {
  const out = new Map();
  for (const r of (report && report.Results) || []) {
    const target = String(r.Target || '').replace(/\\/g, '/');
    const packages = Array.isArray(r.Packages) ? r.Packages.length : 0;
    out.set(target, Math.max(out.get(target) ?? 0, packages));
  }
  return out;
}

/** Does any reported target correspond to this tracked lock path? */
export function findTarget(counts, lockPath) {
  const want = lockPath.replace(/\\/g, '/');
  for (const [target, n] of counts) {
    if (target === want || target.endsWith(`/${want}`)) return { target, packages: n };
  }
  // The scan is usually rooted AT `requirements/`, in which case the target is
  // `locks/portal/requirements.txt`. Match on the trailing two segments, which
  // is the extra name plus the filename — the part that identifies the lock.
  const tail = want.split('/').slice(-2).join('/');
  for (const [target, n] of counts) {
    if (target === tail || target.endsWith(`/${tail}`)) return { target, packages: n };
  }
  return null;
}

/**
 * Pure: the whole --trivy verdict, given already-read inputs.
 *
 * The expectation is DERIVED FROM EACH FILE, not from an allowlist: a lock
 * declaring N pins must be reported with exactly N packages. Measured against
 * the real report, Trivy's count matches the pin count exactly (portal 58/58,
 * bff 12/12), so equality is the honest assertion — "the file appeared" would
 * still pass if the analyser read the header and gave up.
 *
 * `base` legitimately declares ZERO pins (the bare package has no runtime
 * dependencies), so it is allowed to be absent. That is not an exemption: it
 * comes from the file's own content, and the moment `base` gains a dependency
 * the same rule starts requiring it in the report.
 */
export function evaluateTrivy({ report, locks }) {
  const problems = [];
  if (locks.length === 0) {
    problems.push(
      'git ls-files matched ZERO requirements/locks/*/requirements.txt files. Either the layout moved ' +
        'or discovery broke; a run that checks nothing must not report success.'
    );
    return { problems, scanned: 0, packages: 0 };
  }
  if (locks.every((l) => l.pins === 0)) {
    problems.push(
      `all ${locks.length} tracked lock(s) declare ZERO pins. Either the locks were emptied or the ` +
        `pin counter broke; there is nothing here a scan could have examined.`
    );
    return { problems, scanned: 0, packages: 0 };
  }

  const counts = trivyPackageCounts(report);
  let scanned = 0;
  let packages = 0;
  for (const lock of locks) {
    const hit = findTarget(counts, lock.path);
    if (!hit) {
      if (lock.pins === 0) continue; // empty by construction, nothing to report
      problems.push(
        `${lock.path} declares ${lock.pins} pin(s) and does not appear in the Trivy report at all. ` +
          `The analyser did not recognise it — which is #3485 verbatim: Trivy keys on the FILENAME, ` +
          `and on the DIRECTORY (its default skip list is root-anchored and includes \`dev\`), and a ` +
          `file it does not reach is silently absent from a green report. Targets seen: ` +
          `${counts.size ? [...counts.keys()].join(', ') : '(none)'}.`
      );
      continue;
    }
    if (hit.packages !== lock.pins) {
      problems.push(
        `${lock.path} declares ${lock.pins} pin(s) but Trivy reported ${hit.packages} package(s) for ` +
          `target "${hit.target}". The analyser reached the file and did not read all of it, so the ` +
          `green verdict covers only part of the dependency set.`
      );
      continue;
    }
    if (lock.pins === 0) continue;
    scanned += 1;
    packages += hit.packages;
  }
  return { problems, scanned, packages };
}

/** Pure: the whole --sbom verdict. */
export function evaluateSbom({ doc, extra }) {
  const problems = [];
  const components = Array.isArray(doc && doc.components) ? doc.components.length : null;
  if (components === null) {
    problems.push(
      `the SBOM for '${extra}' has no \`components\` array at all. This guard cannot confirm the ` +
        `document describes anything, and will not vouch for what it could not read.`
    );
    return { problems, components: 0 };
  }
  if (components === 0) {
    problems.push(
      `the SBOM for '${extra}' has ZERO components. A published SBOM with no components asserts ` +
        `that this software has no dependencies — which is false, and is how the portal SBOM read ` +
        `for as long as the locks were named \`.lock\` (#3485).`
    );
  }
  return { problems, components };
}

/* --------------------------- the embedded control -------------------------- */

/**
 * Runs before any real report is judged. Feeds the analyser each shape the
 * #3485 defect can take — the locks absent from the report entirely, a lock
 * reached but under-read, an empty population — and requires it to FAIL on each,
 * then requires it to PASS on a healthy one. If the verdict does not MOVE, this
 * file is not measuring anything and must not certify a scan.
 */
export function runControl() {
  const failures = [];
  const lock = 'requirements/locks/portal/requirements.txt';
  const locks = [{ path: lock, pins: 2 }];
  const pkgs = (n) => Array.from({ length: n }, (_, i) => ({ Name: `p${i}` }));

  if (evaluateTrivy({ report: { Results: [] }, locks }).problems.length === 0) {
    failures.push('a Trivy report with NO results came back clean — that is the #3485 shape itself.');
  }
  if (evaluateTrivy({ report: { Results: [{ Target: lock, Packages: [] }] }, locks }).problems.length === 0) {
    failures.push('a target reported with ZERO packages came back clean.');
  }
  if (evaluateTrivy({ report: { Results: [{ Target: lock, Packages: pkgs(1) }] }, locks }).problems.length === 0) {
    failures.push('a target reported with FEWER packages than the lock pins came back clean.');
  }
  // A report rooted at `requirements/`, which is how CI scans: the target is
  // `locks/portal/requirements.txt`, not the repo-relative path.
  const rooted = evaluateTrivy({
    report: { Results: [{ Target: 'locks/portal/requirements.txt', Packages: pkgs(2) }] },
    locks,
  });
  if (rooted.problems.length > 0) {
    failures.push(`a correctly scanned report came back dirty (${rooted.problems.join(' | ')}) — the verdict does not move.`);
  }
  if (rooted.scanned !== 1 || rooted.packages !== 2) {
    failures.push(`a healthy report was miscounted (scanned=${rooted.scanned}, packages=${rooted.packages}).`);
  }
  // A lock with no pins is allowed to be absent — and that leniency must not
  // extend to a population where NOTHING has pins.
  if (evaluateTrivy({ report: { Results: [] }, locks: [{ path: lock, pins: 0 }] }).problems.length === 0) {
    failures.push('a population where every lock declares zero pins came back clean.');
  }
  if (evaluateTrivy({ report: { Results: [] }, locks: [] }).problems.length === 0) {
    failures.push('zero tracked locks came back clean — the population floor is not wired.');
  }
  if (countPins('# comment\nfoo==1.0 \\\nbar==2.0\n') !== 2) {
    failures.push('the pin counter does not count pins.');
  }
  if (evaluateSbom({ doc: { components: [] }, extra: 'control' }).problems.length === 0) {
    failures.push('a 0-component SBOM came back clean.');
  }
  if (evaluateSbom({ doc: { components: [{ name: 'x' }] }, extra: 'control' }).problems.length > 0) {
    failures.push('a 1-component SBOM came back dirty — the SBOM verdict does not move.');
  }
  return failures;
}

/* --------------------------------- driver --------------------------------- */

function readJson(file) {
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist. The scan step did not produce a report.`);
  }
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) throw new Error(`${file} is empty.`);
  return JSON.parse(raw);
}

function main(argv) {
  const controlFailures = runControl();
  if (controlFailures.length > 0) {
    console.error('[lock-scan-coverage] FAIL — the embedded control did not move:\n');
    for (const f of controlFailures) console.error(`  - ${f}`);
    return 1;
  }
  if (argv.includes('--selftest')) {
    console.log(
      '[lock-scan-coverage] control OK — an empty report, a zero-package target, a zero-lock ' +
        'population and a 0-component SBOM all FAIL; healthy inputs pass. The verdict moves.'
    );
    return 0;
  }

  const arg = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : null;
  };

  const trivyReport = arg('--trivy');
  if (trivyReport) {
    let report;
    try {
      report = readJson(trivyReport);
    } catch (err) {
      console.error(`[lock-scan-coverage] FAIL — ${err.message}`);
      return 1;
    }
    const locks = trackedLocks();
    const { problems, scanned, packages } = evaluateTrivy({ report, locks });
    if (problems.length > 0) {
      console.error(`\n[lock-scan-coverage] FAIL — ${problems.length} problem(s):\n`);
      for (const p of problems) console.error(`  - ${p}`);
      console.error(
        '\n  Trivy and Syft both key on the FILENAME. The locks live at\n' +
          '  requirements/<extra>/requirements.txt precisely so both tools recognise them with no\n' +
          '  configuration; a rename back to anything else makes them invisible again and this\n' +
          '  check is what stops that landing green.\n'
      );
      return 1;
    }
    console.log(
      `[lock-scan-coverage] OK — Trivy parsed all ${scanned} tracked lock file(s), ${packages} ` +
        `package(s) total. The CRITICAL gate examined a real package set.`
    );
    return 0;
  }

  const sbomFile = arg('--sbom');
  if (sbomFile) {
    const extra = arg('--extra') || '(unnamed)';
    let doc;
    try {
      doc = readJson(sbomFile);
    } catch (err) {
      console.error(`[lock-scan-coverage] FAIL — ${err.message}`);
      return 1;
    }
    const { problems, components } = evaluateSbom({ doc, extra });
    if (problems.length > 0) {
      console.error(`\n[lock-scan-coverage] FAIL — ${problems.length} problem(s):\n`);
      for (const p of problems) console.error(`  - ${p}`);
      return 1;
    }
    console.log(`[lock-scan-coverage] OK — the '${extra}' SBOM describes ${components} component(s).`);
    return 0;
  }

  console.error('[lock-scan-coverage] FAIL — nothing to check. Pass --trivy <json>, --sbom <json>, or --selftest.');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
