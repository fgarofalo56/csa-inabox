#!/usr/bin/env node
/**
 * GUARDRAIL: workflow-actionlint  (merge-blocker, RATCHETING)
 * ---------------------------------------------------------------------------
 * Runs actionlint (PINNED — see the install step in loom-guardrails.yml) over
 * `.github/workflows/**` and ratchets its findings per file.
 *
 * WHAT THIS DOES AND DOES NOT COVER — read this before trusting a green run
 * ------------------------------------------------------------------------
 * actionlint pipes every `run:` block through shellcheck, so it is tempting to
 * treat it as the guard for "workflow shell bugs". It is not the guard for the
 * bug that motivated this work (#3030, `$ADMIN_SUB` read but never assigned),
 * and that was VERIFIED rather than assumed:
 *
 *   - shellcheck exempts ALL-CAPS names from SC2154 by default;
 *   - actionlint additionally hard-codes
 *       --norc … -e SC1091,SC2194,SC2050,SC2153,SC2154,SC2157,SC2043
 *     so SC2154 is excluded outright and `--norc` blocks a repo `.shellcheckrc`
 *     from switching it back on.
 *
 * Run against the pre-#3030 file, actionlint reports SC2086/SC2129 and says
 * NOTHING about ADMIN_SUB. That class is covered by its own guard —
 * check-workflow-unset-vars.mjs. This one covers what actionlint genuinely
 * does catch: quoting, workflow schema, runner labels, and unparseable files.
 *
 * THE SILENT-SHELLCHECK HAZARD (why there is a liveness probe)
 * -----------------------------------------------------------
 * If `shellcheck` is not on PATH, actionlint does not fail and does not warn —
 * it silently skips every shellcheck rule. Measured on the pre-#3030 file:
 * 5 findings with shellcheck present, 0 without. A CI lane that lost shellcheck
 * would therefore keep reporting success while checking a fraction of what it
 * claims. So before judging the repo this guard lints a fixture containing a
 * known SC2086 and FAILS if that finding does not come back.
 *
 * UNPARSEABLE WORKFLOWS ARE A HARD FAIL — NEVER BASELINED (#3034)
 * ---------------------------------------------------------------
 * actionlint's `syntax-check` "could not parse as YAML" means GitHub cannot
 * parse the file either: it creates a run, fails it immediately and executes
 * NOTHING (`gh run view` shows `jobs=0`). Such a workflow has never run — the
 * loudest form of silent breakage (deploy-integrity.md R1/R3). Three files
 * (copilot-auto-fix.yml + both spark probes) sat in exactly that state from
 * the day they were written, "baselined and printed loudly" — and stayed dead,
 * because a baselined defect is a tolerated defect. So: ANY unparseable
 * workflow now FAILS this guard outright, before the ratchet, with no
 * --update-baseline escape. Fix the file (extract embedded Python/multi-line
 * strings to a script file — that is how all three broke) or delete it.
 *
 * Like the shellcheck probe, the parse-detection lane proves itself live on
 * every run: a fixture with the real column-0-breakout defect is linted from
 * stdin and the guard FAILS if the parse error does not come back.
 *
 * MODES
 *   node scripts/ci/check-workflow-actionlint.mjs                  # CHECK
 *   node scripts/ci/check-workflow-actionlint.mjs --self-test      # probe only
 *   node scripts/ci/check-workflow-actionlint.mjs --update-baseline
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRatchet, loadBaseline } from './_ratchet-count.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const BASELINE_FILE = join(__dirname, 'workflow-actionlint-baseline.json');
const BIN = process.env.ACTIONLINT_BIN || 'actionlint';

const META = {
  owner: 'CSA Loom platform / deploy-integrity',
  why:
    'actionlint findings over .github/workflows, ratcheted per file. Covers quoting, ' +
    'workflow schema and runner labels. Unparseable (invalid-YAML) workflows are a ' +
    'HARD FAIL outside this ratchet and can never be baselined (#3034). It does NOT ' +
    'cover read-but-never-assigned variables — actionlint excludes SC2154 by design; ' +
    'that is check-workflow-unset-vars.mjs.',
  unblock:
    'Fix the finding, or (for an intentional pattern) add an actionlint config / ' +
    'shellcheck directive. Then: node scripts/ci/check-workflow-actionlint.mjs ' +
    '--update-baseline (in the blocked PR, with a one-line justification).',
};

/**
 * A fixture whose SC2086 must come back, or shellcheck is not wired in.
 *
 * `FILE=$(ls)` matters: shellcheck 0.11 does dataflow analysis, so a literal
 * assignment like `FILE=a.txt` is KNOWN to contain no metacharacters and
 * produces NO SC2086 at all. A probe built on a literal would report "not live"
 * on a perfectly healthy install — the false alarm that hides a real one.
 * A command substitution has an unknown value, so the warning always fires.
 */
const PROBE = `name: probe
on: push
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: |
          FILE=$(ls)
          cp $FILE /tmp/b
`;

/**
 * Run actionlint, returning parsed findings. Exit 1 = findings, not an error.
 * `content` (when given) is linted from STDIN — actionlint refuses a file that
 * is not inside a git project ("no project was found in any parent
 * directories"), which would make a temp-dir probe silently return zero.
 */
function runActionlint(paths, cwd, content) {
  const args = ['-no-color', '-format', '{{json .}}', ...(content == null ? paths : ['-'])];
  const opts = {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: content == null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  };
  if (content != null) opts.input = content;
  try {
    return JSON.parse(execFileSync(BIN, args, opts) || '[]');
  } catch (e) {
    if (typeof e.stdout === 'string' && e.stdout.trim().startsWith('[')) {
      return JSON.parse(e.stdout);
    }
    throw new Error(
      `actionlint invocation failed: ${e.message}${e.stderr ? `\nstderr: ${String(e.stderr).slice(0, 400)}` : ''}`,
    );
  }
}

/**
 * A fixture with the EXACT defect class that killed copilot-auto-fix.yml and
 * both spark probes (#3034): content at column 0 inside a `run: |` block
 * scalar terminates the scalar, and the leftover lines make the whole file
 * invalid YAML. GitHub then creates jobs=0 runs forever. This is a synthetic
 * IN-MEMORY fixture linted from stdin — never a committed workflow file.
 */
const BROKEN_YAML_PROBE = `name: probe-broken
on: push
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: |
          python3 -c "
import sys
print(sys.argv)
"
`;

/**
 * Prove the parse-failure detection lane is LIVE before judging the repo: an
 * unparseable fixture must come back flagged as unparseable, or a regression
 * in actionlint / in our message-matching would silently stop this guard from
 * catching dead workflows. Returns an error string, or null when live.
 */
function parseDetectionLiveness() {
  let findings;
  try {
    findings = runActionlint([], REPO_ROOT, BROKEN_YAML_PROBE);
  } catch (e) {
    return e.message;
  }
  if (!findings.some(isParseFailure)) {
    return (
      'the invalid-YAML detection is NOT live — a fixture with a known column-0 block-scalar ' +
      `breakout came back with ${findings.length} finding(s) and none was a parse failure.\n` +
      '   A guard that cannot flag an unparseable workflow would let the #3034 class (files ' +
      'GitHub runs with jobs=0, i.e. never) back in unseen.'
    );
  }
  return null;
}

const isParseFailure = (f) =>
  /could not parse/i.test(f?.message || '') || (f?.kind === 'syntax-check' && /yaml/i.test(f?.message || ''));

/**
 * Prove the shellcheck integration is LIVE before judging the repo. Returns an
 * error string, or null when the probe found its planted SC2086.
 */
function shellcheckLiveness() {
  let findings;
  try {
    findings = runActionlint([], REPO_ROOT, PROBE);
  } catch (e) {
    return e.message;
  }
  const sawShellcheck = findings.some((f) => /SC2086/.test(f.message || ''));
  if (!sawShellcheck) {
    return (
      'the shellcheck integration is NOT live — a fixture with a planted SC2086 came back ' +
      `with ${findings.length} finding(s) and none of them was SC2086.\n` +
      '   actionlint does not fail or warn when `shellcheck` is missing from PATH; it silently ' +
      'skips every shellcheck rule,\n   so this run would have reported success while checking a ' +
      'fraction of what it claims. Install shellcheck and re-run.'
    );
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);

  // 1. the tool must exist. A lint gate that cannot lint has verified nothing,
  //    so this FAILS rather than skipping (sibling: the bicep compile gate).
  try {
    execFileSync(BIN, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    console.error(
      `[workflow-actionlint] FAIL — \`${BIN}\` is not available.\n` +
        '   This guard does not skip when its linter is missing: a lint gate that cannot lint\n' +
        '   has verified nothing. Install the pinned actionlint (see loom-guardrails.yml) or set\n' +
        '   ACTIONLINT_BIN to its path.',
    );
    return 1;
  }

  // 2. the shellcheck half must actually be running.
  const dead = shellcheckLiveness();
  if (dead) {
    console.error(`[workflow-actionlint] FAIL — ${dead}`);
    return 1;
  }
  console.log('[workflow-actionlint] shellcheck integration verified live (probe SC2086 returned).');

  // 3. the parse-failure detection must actually be running (#3034).
  const parseDead = parseDetectionLiveness();
  if (parseDead) {
    console.error(`[workflow-actionlint] FAIL — ${parseDead}`);
    return 1;
  }
  console.log('[workflow-actionlint] invalid-YAML detection verified live (broken-fixture parse error returned).');
  if (argv.includes('--self-test')) return 0;

  if (!existsSync(WORKFLOW_DIR)) {
    console.error(`[workflow-actionlint] FAIL — ${WORKFLOW_DIR} does not exist.`);
    return 1;
  }
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  if (files.length === 0) {
    console.error('[workflow-actionlint] FAIL — no workflow files found; refusing to pass vacuously.');
    return 1;
  }

  const findings = runActionlint([], REPO_ROOT);
  const current = {};
  const unparseable = new Set();
  for (const f of findings) {
    const key = String(f.filepath || '').replace(/\\/g, '/').replace(/^\.github\/workflows\//, '');
    current[key] = (current[key] ?? 0) + 1;
    if (isParseFailure(f)) unparseable.add(key);
  }
  console.log(
    `[workflow-actionlint] ${findings.length} finding(s) across ${Object.keys(current).length} of ${files.length} workflow file(s).`,
  );

  // Unparseable workflows never execute — GitHub creates the run, fails it
  // immediately, and executes zero jobs. #3034: three files sat in that state
  // from the day they were written, warned-and-baselined on every run, and
  // stayed dead. A baselined defect is a tolerated defect, so this is now a
  // HARD FAIL with no --update-baseline escape.
  if (unparseable.size) {
    console.error(
      `\n[workflow-actionlint] FAIL — ${unparseable.size} workflow file(s) CANNOT BE PARSED and therefore NEVER RUN\n` +
        '   (GitHub creates the run, fails it immediately, and executes no jobs — every run shows jobs=0):',
    );
    for (const f of [...unparseable].sort()) console.error(`   - ${f}`);
    console.error(
      '\n   This cannot be baselined (#3034). Fix the file — the recurring cause is embedded\n' +
        '   Python / multi-line strings at column 0 inside a `run:` block scalar; extract them\n' +
        '   to a script file invoked from `run:` (see scripts/csa-loom/spark-livy-probe.sh and\n' +
        '   .github/scripts/open-auto-fix-pr.sh for the pattern) — or delete the workflow.\n',
    );
    return 1;
  }

  if (!argv.includes('--update-baseline')) {
    const { entries: baseline } = loadBaseline(BASELINE_FILE);
    const stale = Object.entries(baseline)
      .map(([k, n]) => ({ key: k, was: n, now: current[k] ?? 0 }))
      .filter((e) => e.now < e.was);
    if (stale.length) {
      console.error('\n[workflow-actionlint] FAIL — the baseline is STALE (it must only shrink):');
      for (const e of stale.sort((a, b) => a.key.localeCompare(b.key))) {
        console.error(
          `   - ${e.key}: baseline records ${e.was}, only ${e.now} remain` +
            (e.now === 0 ? ' — fully fixed, remove the entry' : ''),
        );
      }
      console.error(
        '\n   Regenerate so the recorded debt matches reality:\n' +
          '     node scripts/ci/check-workflow-actionlint.mjs --update-baseline',
      );
      return 1;
    }
  }

  const code = runRatchet({
    name: 'workflow-actionlint',
    baselineFile: BASELINE_FILE,
    meta: META,
    current,
    argv: process.argv,
  });

  if (code !== 0) {
    const { entries: baseline } = loadBaseline(BASELINE_FILE);
    console.error('\n   New findings:');
    for (const f of findings) {
      const key = String(f.filepath || '').replace(/\\/g, '/').replace(/^\.github\/workflows\//, '');
      if ((current[key] ?? 0) > (baseline[key] ?? 0)) {
        // PHYSICAL-LINES-OK: the only split here truncates actionlint's own JSON message
        // for display. The analysis is actionlint's, not this file's (#3420).
        console.error(`   - ${key}:${f.line}:${f.column}  ${String(f.message).split('\n')[0].slice(0, 160)}`);
      }
    }
  }
  return code;
}

process.exit(main());
