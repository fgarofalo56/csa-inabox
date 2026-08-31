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
 * IT DEADLOCKED ON WINDOWS — MEASURED, NOT SLOW (#3550)
 * ------------------------------------------------------
 * Reported as "does not complete". It is worse than that: it HANGS, and the
 * hang is in actionlint's shellcheck integration, not in this script.
 *
 * Measured 2026-08-29 on Windows 11 / Git Bash, actionlint on PATH,
 * shellcheck 0.11 on PATH:
 *
 *   one file,   shellcheck ON   → 1.2s, verdict returned
 *   2 files,    shellcheck ON   → 1s,   verdict returned
 *   3 files,    shellcheck ON   → 0s,   verdict returned
 *   4 files,    shellcheck ON   → NO VERDICT, killed at 90s (two different
 *                                 4-file sets; each of those files passes alone)
 *   125 files,  shellcheck ON   → NO VERDICT, killed at 1142s
 *   125 files,  shellcheck OFF  → 0s,   verdict returned
 *
 * The wedged processes consume NO CPU: two samples 45s apart reported the
 * identical cumulative CPU time. That is a deadlock, not slowness — and the
 * machine was carrying FIVE abandoned `actionlint` processes, the oldest
 * started five days earlier, each one a run some agent gave up on.
 *
 * "4 files is the threshold" was then MEASURED WRONG, which is the more useful
 * half of this: a per-file census (all 125 workflows linted one at a time, 25s
 * cap) found the wedge is a property of the FILE, not of the batch size.
 * 28 of 125 wedge; the other 97 return, slowest 8.3s, median 0.74s. The 28 are
 * the large ones — build-fiab-images-acr-tasks, csa-loom-post-deploy-bootstrap,
 * all four deploy-fiab-*, most gov-*, loom-roll-and-validate. Retried three
 * times on the same file it wedged three times. The earlier "3 files were fine"
 * run simply did not contain a big file.
 *
 * So this cannot be fixed here: it is an upstream actionlint/shellcheck defect
 * on Windows. What is fixed here is that it can no longer LIE.
 *
 * Consequences, all of which this file now handles:
 *   1. There was no way to reach a verdict locally. The sweep is CHUNKED (one
 *      file per invocation on win32) with a hard per-invocation timeout, and a
 *      wedged chunk is recorded as NOT LINTED and the sweep CONTINUES — so one
 *      run names every file it could not cover. Incomplete coverage FAILS.
 *      Chunked/explicit-path invocation was verified to return the IDENTICAL
 *      finding set as the single project-discovery invocation over all 125
 *      files, and the per-file counts it produces on Windows match the
 *      Linux-generated baseline exactly. On non-Windows the single invocation
 *      is kept unchanged, because that is what CI has been green on.
 *      `--changed` / `--files` is the usable local loop: seconds, not minutes.
 *   2. A killed run LOOKED LIKE A PASS: stdout ended on two cheerful
 *      "verified live" lines and nothing said the verdict had not been
 *      reached. Now nothing may be mistaken for a verdict — the sweep
 *      announces that no verdict exists yet, signals print NO VERDICT, and an
 *      exit that never produced one says so on the way out (deploy-integrity
 *      R7: the message states only what was established).
 *
 * MODES
 *   node scripts/ci/check-workflow-actionlint.mjs                  # CHECK (full, merge-blocking)
 *   node scripts/ci/check-workflow-actionlint.mjs --self-test      # probe only
 *   node scripts/ci/check-workflow-actionlint.mjs --files a.yml b.yml   # PARTIAL, advisory
 *   node scripts/ci/check-workflow-actionlint.mjs --changed        # PARTIAL, advisory
 *   node scripts/ci/check-workflow-actionlint.mjs --update-baseline
 *
 * ENV
 *   ACTIONLINT_BIN         path to actionlint (default: `actionlint` on PATH)
 *   ACTIONLINT_CHUNK       files per invocation; default 1 on win32, all elsewhere
 *   ACTIONLINT_TIMEOUT_MS  per-invocation timeout (default 30s chunked / 900s whole-dir)
 *   ACTIONLINT_ATTEMPTS    attempts per invocation before failing closed (default 1)
 *   ACTIONLINT_BASE_REF    base ref for --changed (default origin/main)
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

/**
 * Files per actionlint invocation on Windows.
 *
 * ONE, not three. The first measurement suggested a clean threshold at four
 * files; the per-file census then showed the wedge belongs to 28 specific large
 * workflows, and the "3 files were fine" run simply had not contained one.
 * Recording the wrong first conclusion on purpose — it was measured, and it was
 * still wrong. At one file per invocation a wedge costs exactly one file of
 * coverage and the report names it.
 */
const WIN32_CHUNK = 1;

/**
 * Per-chunk wall clock. A wedged invocation must FAIL, never hang a lane.
 * Across the 97 workflow files that lint successfully here the slowest took
 * 8.3s and the median 0.7s, so 30s is 3.6x the worst healthy case — long enough
 * not to fire on a slow machine, short enough that the 28 that wedge cost about
 * fourteen minutes rather than never terminating.
 */
const CHUNK_TIMEOUT_MS = Number(process.env.ACTIONLINT_TIMEOUT_MS || 30000);

/**
 * The single whole-directory invocation (the non-Windows default) legitimately
 * takes far longer than one chunk, so it gets its own, generous cap. It still
 * has one: an unbounded wait is what produced five abandoned processes.
 */
const SWEEP_TIMEOUT_MS = Number(process.env.ACTIONLINT_TIMEOUT_MS || 900000);

/**
 * Attempts per invocation. ONE by default, and that is a measurement, not a
 * guess: the wedge was retried 3/3 on the same file and wedged every time, and
 * a per-file census found it hits the same 28 large workflows while never
 * touching a small one. So it is deterministic per file, and a retry would only
 * buy N times the wall clock for the same answer. The knob stays for a machine
 * where the failure really is transient.
 */
const ATTEMPTS = Math.max(1, Number(process.env.ACTIONLINT_ATTEMPTS || 1));

/** Thrown when an invocation is killed on the timeout above. */
class ActionlintTimeout extends Error {}

/**
 * NOTHING may be mistaken for a verdict.
 *
 * Before this, a run killed mid-sweep left stdout ending on two "verified live"
 * lines — indistinguishable from success, which is how "I ran the guards
 * locally" stopped meaning anything on this platform (#3550). `main()` returning
 * a number IS a verdict, pass or fail; anything else is not, and says so.
 */
let verdictReached = false;

function noVerdict(reason) {
  console.error(
    `\n[workflow-actionlint] NO VERDICT — ${reason}.\n` +
      '   This run did NOT establish whether the workflows are clean. Do not read the lines\n' +
      '   above it as a pass: the liveness probes print before the sweep, not after it.',
  );
}

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
function runActionlint(paths, cwd, content, timeoutMs = CHUNK_TIMEOUT_MS) {
  const args = ['-no-color', '-format', '{{json .}}', ...(content == null ? paths : ['-'])];
  const opts = {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: content == null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  };
  if (content != null) opts.input = content;
  try {
    return JSON.parse(execFileSync(BIN, args, opts) || '[]');
  } catch (e) {
    // Timeout FIRST: a killed child can leave a truncated `[{…` on stdout, which
    // would otherwise be parsed as findings or blow up as a JSON syntax error —
    // either way reporting something the run never established (R7).
    if (e && (e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT' || e.errno === 'ETIMEDOUT')) {
      throw new ActionlintTimeout(
        `actionlint did not return within ${timeoutMs}ms for ${paths.length || 'all'} file(s)` +
          `${paths.length ? `: ${paths.join(', ')}` : ''}. On Windows this is the shellcheck-integration ` +
          'deadlock recorded in the header block — the process wedges consuming no CPU. ' +
          'Raise ACTIONLINT_ATTEMPTS/ACTIONLINT_TIMEOUT_MS, or lower ACTIONLINT_CHUNK.',
      );
    }
    if (typeof e.stdout === 'string' && e.stdout.trim().startsWith('[')) {
      return JSON.parse(e.stdout);
    }
    throw new Error(
      `actionlint invocation failed: ${e.message}${e.stderr ? `\nstderr: ${String(e.stderr).slice(0, 400)}` : ''}`,
    );
  }
}

/**
 * `runActionlint` with a bounded retry on the deadlock ONLY.
 *
 * A real lint error (bad flag, unreadable file) is NOT retried — retrying a
 * deterministic failure would just spend three times as long reaching the same
 * answer, and would blur a defect into "flaky". Exhaustion re-throws.
 */
function lintWithRetry(paths, content, timeoutMs) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return runActionlint(paths, REPO_ROOT, content, timeoutMs);
    } catch (e) {
      if (!(e instanceof ActionlintTimeout)) throw e;
      last = e;
      if (attempt < ATTEMPTS) {
        console.log(
          `[workflow-actionlint] attempt ${attempt}/${ATTEMPTS} wedged; retrying in a fresh process. ` +
            'Nothing has been concluded about these file(s) yet.',
        );
      }
    }
  }
  throw new ActionlintTimeout(`${last.message}\n   Exhausted ${ATTEMPTS} attempt(s); failing closed.`);
}

/**
 * How many workflow files to hand a single actionlint invocation.
 *
 * On win32 the default is one below the measured deadlock threshold. Everywhere
 * else the default is "all of them in one invocation", which is exactly what CI
 * has always run — this fix does not change the behaviour of the green lane.
 *
 * @param {number} fileCount
 * @returns {number}
 */
export function chunkSize(fileCount, env = process.env, platform = process.platform) {
  const raw = env.ACTIONLINT_CHUNK;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`ACTIONLINT_CHUNK must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return n;
  }
  return platform === 'win32' ? WIN32_CHUNK : Math.max(fileCount, 1);
}

/**
 * Lint `files` (repo-relative workflow paths), chunking when required.
 *
 * When a single invocation covers everything AND the caller asked for the whole
 * directory, actionlint is invoked with NO path arguments — its own project
 * discovery — because that is the invocation the CI lane is green on and it is
 * not worth changing under a fix for a different platform's bug.
 *
 * A wedged chunk does NOT abort the sweep. Aborting on the first one told you
 * about one file and nothing about the other 124; carrying on and recording
 * every file it could not lint tells you the whole truth in one run. Incomplete
 * coverage is still a FAILURE — see the caller — it is just an informative one.
 *
 * @param {string[]} files
 * @param {boolean} isWholeDir
 * @returns {{findings: Array<Record<string, any>>, unlinted: string[]}}
 */
function sweep(files, isWholeDir) {
  const size = chunkSize(files.length);
  if (isWholeDir && size >= files.length) {
    try {
      return { findings: lintWithRetry([], undefined, SWEEP_TIMEOUT_MS), unlinted: [] };
    } catch (e) {
      if (!(e instanceof ActionlintTimeout)) throw e;
      console.log(`[workflow-actionlint] the single whole-directory invocation wedged: ${e.message}`);
      return { findings: [], unlinted: [...files] };
    }
  }

  const findings = [];
  const unlinted = [];
  for (let i = 0; i < files.length; i += size) {
    const batch = files.slice(i, i + size);
    try {
      findings.push(...lintWithRetry(batch, undefined, CHUNK_TIMEOUT_MS));
    } catch (e) {
      if (!(e instanceof ActionlintTimeout)) throw e;
      unlinted.push(...batch);
      console.log(
        `[workflow-actionlint] WEDGED on ${batch.join(', ')} — recorded as NOT LINTED, continuing. ` +
          'These file(s) have been checked by NOTHING in this run.',
      );
    }
    if (size < files.length) {
      console.log(
        `[workflow-actionlint] … ${Math.min(i + size, files.length)}/${files.length} file(s) attempted, ` +
          `${findings.length} finding(s), ${unlinted.length} not linted — still NO VERDICT.`,
      );
    }
  }
  return { findings, unlinted };
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
    findings = lintWithRetry([], BROKEN_YAML_PROBE, CHUNK_TIMEOUT_MS);
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
    findings = lintWithRetry([], PROBE, CHUNK_TIMEOUT_MS);
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

/**
 * The `--files`/`--changed` selection, as repo-relative workflow paths.
 *
 * Returns null for a full sweep. Throws with a concrete message rather than
 * quietly narrowing the scan — a scoped run that silently linted nothing would
 * be the same false green this whole file is about.
 *
 * @param {string[]} argv
 * @returns {string[]|null}
 */
function selectFiles(argv) {
  const wantChanged = argv.includes('--changed');
  const filesIdx = argv.indexOf('--files');
  if (!wantChanged && filesIdx === -1) return null;
  if (wantChanged && filesIdx !== -1) {
    throw new Error('--files and --changed are mutually exclusive.');
  }

  /** @type {string[]} */
  let picked;
  if (filesIdx !== -1) {
    picked = argv.slice(filesIdx + 1).filter((a) => !a.startsWith('--'));
    if (picked.length === 0) throw new Error('--files needs at least one path.');
  } else {
    picked = changedWorkflowFiles();
  }

  const normalized = [];
  for (const p of picked) {
    const rel = p.replace(/\\/g, '/').replace(/^\.\//, '');
    const base = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
    const candidate = `.github/workflows/${base}`;
    if (!/\.ya?ml$/.test(base)) throw new Error(`not a workflow file: ${p}`);
    if (!existsSync(join(REPO_ROOT, candidate))) {
      throw new Error(`no such workflow: ${candidate} (derived from ${p})`);
    }
    if (!normalized.includes(candidate)) normalized.push(candidate);
  }
  return normalized;
}

/**
 * Workflow files this branch changed: working tree + untracked + the commits
 * since the merge-base with `ACTIONLINT_BASE_REF` (default origin/main).
 *
 * If the base ref does not resolve this FAILS loudly. Falling back to
 * "working-tree only" would silently shrink the scan and report a pass over a
 * file it never opened.
 *
 * @returns {string[]}
 */
function changedWorkflowFiles() {
  const git = (args) =>
    execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const baseRef = process.env.ACTIONLINT_BASE_REF || 'origin/main';
  let base;
  try {
    base = git(['merge-base', 'HEAD', baseRef]).trim();
  } catch (e) {
    throw new Error(
      `--changed cannot resolve a base: \`git merge-base HEAD ${baseRef}\` failed (${String(e.message).trim()}). ` +
        'Fetch the base ref, set ACTIONLINT_BASE_REF, or name the files with --files. ' +
        'It will not silently narrow the scan to the working tree.',
    );
  }
  const out = [
    git(['diff', '--name-only', '--diff-filter=d', base, '--', '.github/workflows']),
    git(['diff', '--name-only', '--diff-filter=d', '--', '.github/workflows']),
    git(['ls-files', '--others', '--exclude-standard', '--', '.github/workflows']),
  ].join('\n');
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
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

  /** @type {string[]|null} */
  let selection;
  try {
    selection = selectFiles(argv);
  } catch (e) {
    console.error(`[workflow-actionlint] FAIL — ${e.message}`);
    return 1;
  }

  // A scoped run is ADVISORY. It cannot see a regression in a file it did not
  // lint, so it must never be reported as the merge-blocking verdict and must
  // never rewrite a baseline covering files it never opened.
  const partial = selection !== null;
  if (partial && argv.includes('--update-baseline')) {
    console.error(
      '[workflow-actionlint] FAIL — --update-baseline cannot be combined with --files/--changed.\n' +
        '   The baseline records debt for EVERY workflow; rewriting it from a partial scan would\n' +
        '   erase the recorded debt of every file the scan never looked at.',
    );
    return 1;
  }
  if (partial && selection.length === 0) {
    console.log(
      '[workflow-actionlint] PARTIAL scan selected ZERO workflow files — nothing to lint.\n' +
        '   This is NOT a pass over the repo. Run without --files/--changed for the real verdict.',
    );
    return 0;
  }

  const target = selection ?? files.map((f) => `.github/workflows/${f}`);
  console.log(
    `[workflow-actionlint] linting ${target.length} workflow file(s)` +
      (partial ? ' (PARTIAL — advisory only)' : '') +
      ` in chunks of ${chunkSize(target.length)} — NO VERDICT HAS BEEN REACHED YET.`,
  );

  let findings;
  let unlinted;
  try {
    ({ findings, unlinted } = sweep(target, !partial));
  } catch (e) {
    console.error(`[workflow-actionlint] FAIL — ${e.message}`);
    return 1;
  }
  const current = {};
  const unparseable = new Set();
  for (const f of findings) {
    const key = String(f.filepath || '').replace(/\\/g, '/').replace(/^\.github\/workflows\//, '');
    current[key] = (current[key] ?? 0) + 1;
    if (isParseFailure(f)) unparseable.add(key);
  }
  console.log(
    `[workflow-actionlint] ${findings.length} finding(s) across ${Object.keys(current).length} of ${target.length} workflow file(s)` +
      (partial ? ` (PARTIAL — ${files.length - target.length} file(s) NOT linted).` : '.'),
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

  // A file that was NOT LINTED contributed zero findings, and zero findings is
  // exactly what "fully fixed" looks like to the stale check. Measured on the
  // first full Windows sweep: 14 baselined files were reported STALE purely
  // because actionlint had wedged on them, with the advice to regenerate the
  // baseline — which would have DELETED 73 recorded findings nobody fixed.
  const unlintedKeys = new Set(unlinted.map((p) => p.replace(/^\.github\/workflows\//, '')));

  // Incomplete coverage is a FAILURE, never a footnote under a pass, and it is
  // reported BEFORE the ratchet so it still prints when an earlier check exits.
  // The ratchet only ever saw the files that were linted.
  if (unlinted.length) {
    console.error(
      `\n[workflow-actionlint] FAIL — ${unlinted.length} workflow file(s) COULD NOT BE LINTED, so this run\n` +
        '   does not cover them. They contributed zero findings, which is not the same as being clean:',
    );
    for (const f of unlinted) console.error(`   - ${f}`);
    console.error(
      '\n   Cause on Windows: actionlint\'s shellcheck integration deadlocks on the larger workflow\n' +
        '   files (see the header block — the process wedges consuming no CPU). It is an upstream\n' +
        '   tool defect, not a finding about these files.\n' +
        (partial
          ? ''
          : '   For a usable local loop, scope the run to what you touched:\n' +
            '     node scripts/ci/check-workflow-actionlint.mjs --changed\n') +
        '   The authoritative full verdict comes from the Linux guardrails lane, where the sweep\n' +
        '   completes. Do NOT read this failure as "the workflows are broken".',
    );
  }

  // Same reasoning, one step earlier: a regen from an incomplete scan writes
  // away the debt of every file the scan could not open.
  if (unlinted.length && argv.includes('--update-baseline')) {
    console.error(
      `[workflow-actionlint] FAIL — refusing --update-baseline: ${unlinted.length} file(s) could not be\n` +
        '   linted in this run, so regenerating would erase their recorded debt as if it were fixed.\n' +
        '   Regenerate the baseline where the sweep completes — the Linux guardrails lane.',
    );
    return 1;
  }

  // The stale check compares EVERY baselined key against the scan, so it is
  // only meaningful over a full sweep: in a partial scan an unlinted file
  // reports zero findings and would be misread as "fully fixed".
  if (!partial && !argv.includes('--update-baseline')) {
    const { entries: baseline } = loadBaseline(BASELINE_FILE);
    const stale = Object.entries(baseline)
      .filter(([k]) => !unlintedKeys.has(k))
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

  const ratchetCode = runRatchet({
    name: 'workflow-actionlint',
    baselineFile: BASELINE_FILE,
    meta: META,
    current,
    argv: process.argv,
  });
  const code = unlinted.length ? 1 : ratchetCode;

  if (ratchetCode !== 0) {
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

  const covered = target.length - unlinted.length;
  if (partial) {
    console.log(
      `[workflow-actionlint] PARTIAL VERDICT: ${code === 0 ? 'clean' : 'not clean'} over ${covered} of the ` +
        `${target.length} selected file(s). This is ADVISORY — it says nothing about the other ` +
        `${files.length - target.length} workflow file(s), and it is not the merge-blocking verdict.`,
    );
  } else {
    console.log(
      `[workflow-actionlint] VERDICT: ${code === 0 ? 'PASS' : 'FAIL'} — ${covered} of ${target.length} ` +
        'workflow file(s) actually linted.',
    );
  }
  return code;
}

// A signal, an uncaught throw, or a kill must never leave output that reads
// like a pass. `main()` returning a number IS the verdict; anything else is not.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    noVerdict(`the run was killed by ${sig} before it finished`);
    process.exit(130);
  });
}
process.on('exit', (code) => {
  if (!verdictReached) noVerdict(`the process exited (code ${code}) without producing one`);
});

const exitCode = main();
verdictReached = true;
process.exit(exitCode);
