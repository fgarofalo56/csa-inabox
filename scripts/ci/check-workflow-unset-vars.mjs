#!/usr/bin/env node
/**
 * GUARDRAIL: workflow-unset-vars  (merge-blocker, RATCHETING)
 * ---------------------------------------------------------------------------
 * RULE: a shell variable read by a `run:` step must be ASSIGNED somewhere —
 * in the same script, in a workflow/job/step `env:` block, by an earlier step's
 * write to `$GITHUB_ENV`, or by the runner itself. A read of a name that is
 * never assigned is, under `set -u`, a step that aborts at that line.
 *
 * WHY THIS EXISTS (#3030, deploy-integrity.md R1)
 * -----------------------------------------------
 * On 2026-08-05 `.github/workflows/full-app-deploy-commercial.yml` — the ONLY
 * producer of the app container images and the only path that rolls the
 * Container Apps — failed three consecutive runs. The whole cause was one line:
 *
 *     echo "admin_sub=$ADMIN_SUB" >> "$GITHUB_OUTPUT"
 *
 * `ADMIN_SUB` was read and never assigned; #3013 had removed the assignment and
 * left the reader. The step runs under `set -uo pipefail`, so it aborted at the
 * first output line and took every image build and app roll with it. The repo
 * had no mechanical check for this, and the class is entirely mechanical.
 *
 * WHY NOT JUST RUN actionlint (verified, not assumed)
 * ---------------------------------------------------
 * actionlint pipes `run:` blocks through shellcheck, whose SC2154 is exactly
 * "referenced but not assigned" — so actionlint looks like the answer. It is
 * not, for two independent reasons, both checked against actionlint v1.7.12 and
 * shellcheck v0.11.0 rather than taken on faith:
 *
 *   1. shellcheck exempts ALL-CAPS names from SC2154 by default (it assumes
 *      they are environment variables), so it is silent on `ADMIN_SUB`. Only
 *      the optional `check-unassigned-uppercase` removes that exemption.
 *   2. actionlint hard-codes
 *        --norc … -e SC1091,SC2194,SC2050,SC2153,SC2154,SC2157,SC2043
 *      i.e. it EXCLUDES SC2154 outright, and `--norc` means a repo
 *      `.shellcheckrc` cannot switch it back on.
 *
 * Running actionlint over the pre-#3030 file reports SC2086/SC2129 and says
 * NOTHING about ADMIN_SUB. actionlint is still wired in — see
 * check-workflow-actionlint.mjs — for the classes it does cover. It simply
 * cannot cover this one, and a guard adopted on the assumption that it did
 * would have been decoration.
 *
 * actionlint's exclusion is right for actionlint: `run:` scripts read `env:`
 * keys shellcheck cannot see, so bare SC2154 would be a false-positive machine.
 * This guard does the same analysis WITH that context supplied.
 *
 * SCOPE — `.github/workflows/*.yml|yaml`, steps with a `run:` body whose
 * effective shell is POSIX-ish (`bash`/`sh`/…). `pwsh`, `powershell`, `python`
 * and `cmd` steps are skipped: `$Foo` does not mean the same thing there.
 *
 * NOT A VIOLATION — the safe-by-construction expansions, which do not abort
 * under `set -u`:  ${V:-d} ${V-d} ${V:=d} ${V=d} ${V:+a} ${V+a} ${V:?m} ${V?m}
 *
 * TWO TIERS
 *   - DEPLOY-CRITICAL files (below) are held at ZERO and are never baselined.
 *     These are the paths where this defect is catastrophic rather than
 *     annoying — the image producers, the rolls, the bootstrap, and every Gov
 *     deploy lane, which cannot be exercised locally at all.
 *   - Everything else ratchets: per-file counts are frozen, CI fails on a RISE
 *     (a net-new unassigned read) and on a STALE entry (a violation that has
 *     been fixed but left in the baseline). The list can only shrink.
 *
 * ESCAPE HATCH — an intentional read of a variable injected by something this
 * guard cannot see may be marked in the script with `# unset-var-ok: NAME`.
 *
 * MODES
 *   node scripts/ci/check-workflow-unset-vars.mjs                  # CHECK
 *   node scripts/ci/check-workflow-unset-vars.mjs --self-test      # prove it can fail
 *   node scripts/ci/check-workflow-unset-vars.mjs --update-baseline
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runRatchet, loadBaseline } from './_ratchet-count.mjs';
import { parseWorkflow, mapKeys, scalarValue } from './_workflow-yaml.mjs';
import { unassignedReferences, isPosixShell, githubEnvWrites, sourcesAFile, envFileWrites } from './_shell-vars.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const BASELINE_FILE = join(__dirname, 'workflow-unset-vars-baseline.json');

/**
 * Held at ZERO. An unassigned read here does not merely annoy — it stops the
 * estate. The first five are the image/roll/bootstrap path named in
 * deploy-integrity.md; `gov-*` is every Azure Government lane, which by policy
 * cannot be run locally, so a mechanical check is the only check they get.
 */
const DEPLOY_CRITICAL = [
  'full-app-deploy-commercial.yml',
  'deploy-fiab-commercial.yml',
  'loom-roll-and-validate.yml',
  'build-fiab-images-acr-tasks.yml',
  'csa-loom-post-deploy-bootstrap.yml',
];
const isDeployCritical = (file) => DEPLOY_CRITICAL.includes(file) || /^gov-.*\.ya?ml$/.test(file);

const META = {
  owner: 'CSA Loom platform / deploy-integrity',
  why:
    'A `run:` step that reads a never-assigned variable aborts under `set -u`. ' +
    'This killed full-app-deploy-commercial.yml for three runs (#3030). ' +
    'actionlint cannot catch it: it excludes SC2154 by design.',
  unblock:
    'Assign the variable, add it to an `env:` block, or mark a genuinely external ' +
    'read with `# unset-var-ok: NAME`. Deploy-critical workflows are held at ZERO ' +
    'and cannot be baselined. Otherwise: node scripts/ci/check-workflow-unset-vars.mjs ' +
    '--update-baseline (in the blocked PR, with a one-line justification).',
};

/** Every step of every job, with its effective shell and env scopes resolved. */
export function scanWorkflow(text) {
  const doc = parseWorkflow(text);
  const wfEnv = new Set(mapKeys(doc.env));
  const wfShell = scalarValue(doc.defaults?.run?.shell);
  const jobs = doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
  const findings = [];
  let steps = 0;

  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
    const jobEnv = new Set(mapKeys(job.env));
    const jobShell = scalarValue(job.defaults?.run?.shell) ?? wfShell;
    const stepList = Array.isArray(job.steps) ? job.steps : [];

    // Names any step of this job publishes into the job's environment, and
    // names any step writes into an env-style FILE (only consulted for steps
    // that actually source one — see below).
    const ghEnv = new Set();
    const fileEnv = new Set();
    for (const st of stepList) {
      const body = scalarValue(st?.run);
      if (!body) continue;
      for (const n of githubEnvWrites(body)) ghEnv.add(n);
      for (const n of envFileWrites(body)) fileEnv.add(n);
    }

    for (const st of stepList) {
      if (!st || typeof st !== 'object' || Array.isArray(st)) continue;
      const runNode = st.run;
      const body = scalarValue(runNode);
      if (!body || !body.trim()) continue;
      const shell = scalarValue(st.shell) ?? jobShell;
      if (!isPosixShell(shell)) continue;
      steps++;

      const defined = new Set([...wfEnv, ...jobEnv, ...mapKeys(st.env), ...ghEnv]);
      if (sourcesAFile(body)) for (const n of fileEnv) defined.add(n);
      const startLine = runNode.line ?? 1;
      for (const { name, line } of unassignedReferences(body, defined)) {
        findings.push({ job: jobId, name, line: startLine + line - 1 });
      }
    }
  }
  return { findings, steps };
}

// ── self-test: the guard must be observed FAILING on the defect it exists for ─
const FIXTURE_DEFECT = `
name: fixture
on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve the registry
        id: acr
        run: |
          set -uo pipefail
          ACR=$(az acr list --query "[0].name" -o tsv)
          echo "acr_name=$ACR" >> "$GITHUB_OUTPUT"
          # Coordinates for the chained post-deploy bootstrap (rel-T34).
          echo "admin_sub=$ADMIN_SUB" >> "$GITHUB_OUTPUT"
`;
const FIXTURE_CLEAN = `
name: fixture
on: workflow_dispatch
env:
  REGION: eastus
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      TAG: v0.1
    steps:
      - name: ok
        env:
          EXTRA: yes
        run: |
          set -uo pipefail
          ADMIN_SUB=$(az account show --query id -o tsv)
          echo "admin_sub=$ADMIN_SUB region=$REGION tag=$TAG extra=$EXTRA" >> "$GITHUB_OUTPUT"
          echo "opt=\${MAYBE_MISSING:-default}"
          echo 'literal $NOT_A_REF'
      - name: publishes to GITHUB_ENV
        run: echo "LATER=1" >> "$GITHUB_ENV"
      - name: consumes it
        run: echo "later=$LATER"
      - name: powershell is not scanned
        shell: pwsh
        run: Write-Host "$SomePwshVar"
`;

function selfTest() {
  let ok = true;
  const say = (pass, msg) => {
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!pass) ok = false;
  };
  console.log('[workflow-unset-vars] self-test — the guard must FAIL on the real defect');

  const bad = scanWorkflow(FIXTURE_DEFECT).findings;
  say(
    bad.some((f) => f.name === 'ADMIN_SUB'),
    `the #3030 defect (read-but-never-assigned ADMIN_SUB) is detected — found [${bad.map((f) => f.name).join(', ') || 'nothing'}]`,
  );
  say(bad.length === 1, `exactly the one real name is reported (got ${bad.length})`);

  const clean = scanWorkflow(FIXTURE_CLEAN);
  say(
    clean.findings.length === 0,
    `the fixed shape is silent — env scopes, $GITHUB_ENV, :- defaults, single quotes, pwsh (got [${clean.findings.map((f) => f.name).join(', ')}])`,
  );
  say(clean.steps >= 3, `bash steps were actually examined (${clean.steps})`);

  console.log(ok ? '[workflow-unset-vars] self-test OK' : '[workflow-unset-vars] self-test FAILED');
  return ok ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  if (!existsSync(WORKFLOW_DIR)) {
    console.error(`[workflow-unset-vars] FAIL — ${WORKFLOW_DIR} does not exist.`);
    return 1;
  }
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

  const current = {};
  const detail = new Map();
  let examinedSteps = 0;
  const parseFailures = [];

  for (const file of files) {
    let res;
    try {
      res = scanWorkflow(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    } catch (e) {
      parseFailures.push(`${file}: ${e.message}`);
      continue;
    }
    examinedSteps += res.steps;
    if (res.findings.length) {
      current[file] = res.findings.length;
      detail.set(file, res.findings);
    }
  }

  // Refuse to pass vacuously. A guard that examined nothing has verified
  // nothing, and that is this repo's dominant defect class.
  if (files.length === 0 || examinedSteps === 0) {
    console.error(
      `[workflow-unset-vars] FAIL — examined ${files.length} workflow file(s) and ${examinedSteps} shell step(s). ` +
        'A run of this guard that inspects no shell steps is measuring nothing; refusing to report success.',
    );
    return 1;
  }
  if (parseFailures.length) {
    console.error('[workflow-unset-vars] FAIL — could not read these workflows:');
    for (const f of parseFailures) console.error(`   - ${f}`);
    return 1;
  }
  console.log(
    `[workflow-unset-vars] examined ${examinedSteps} shell step(s) across ${files.length} workflow file(s).`,
  );

  // ── tier 1: deploy-critical, held at zero, never baselined ────────────────
  const critical = Object.keys(current).filter(isDeployCritical).sort();
  if (critical.length && !argv.includes('--update-baseline')) {
    console.error(
      '\n[workflow-unset-vars] FAIL — DEPLOY-CRITICAL workflow reads a variable it never assigns.',
    );
    console.error('   These are held at ZERO and cannot be baselined (deploy-integrity.md R1).');
    for (const file of critical) {
      for (const f of detail.get(file)) {
        console.error(`   - ${file}:${f.line}  $${f.name}  (job: ${f.job})`);
      }
    }
    console.error(
      '\n   Under `set -u` each of these aborts the step at that line. Assign the variable,\n' +
        '   put it in an `env:` block, or mark a genuinely external read with `# unset-var-ok: NAME`.',
    );
    return 1;
  }

  // ── tier 2: everything else ratchets ──────────────────────────────────────
  const ratcheted = Object.fromEntries(
    Object.entries(current).filter(([f]) => !isDeployCritical(f)),
  );

  // Stale-entry rule: the baseline may only SHRINK, and must stay truthful.
  // A fixed violation left in the list is a false record of debt and would
  // silently re-admit the same defect later.
  if (!argv.includes('--update-baseline')) {
    const { entries: baseline } = loadBaseline(BASELINE_FILE);
    const stale = Object.entries(baseline)
      .map(([k, n]) => ({ key: k, was: n, now: ratcheted[k] ?? 0 }))
      .filter((e) => e.now < e.was);
    if (stale.length) {
      console.error('\n[workflow-unset-vars] FAIL — the baseline is STALE (it must only shrink):');
      for (const e of stale.sort((a, b) => a.key.localeCompare(b.key))) {
        console.error(
          `   - ${e.key}: baseline records ${e.was}, only ${e.now} remain` +
            (e.now === 0 ? ' — fully fixed, remove the entry' : ''),
        );
      }
      console.error(
        '\n   Regenerate so the recorded debt matches reality:\n' +
          '     node scripts/ci/check-workflow-unset-vars.mjs --update-baseline',
      );
      return 1;
    }
  }

  const code = runRatchet({
    name: 'workflow-unset-vars',
    baselineFile: BASELINE_FILE,
    meta: META,
    current: ratcheted,
    argv: process.argv,
  });

  if (code !== 0) {
    console.error('\n   Offending reads:');
    for (const file of Object.keys(ratcheted).sort()) {
      for (const f of detail.get(file) ?? []) {
        console.error(`   - ${file}:${f.line}  $${f.name}  (job: ${f.job})`);
      }
    }
  }
  return code;
}

// Only run when invoked directly, so the unit tests can import `scanWorkflow`
// (same pattern as check-cloud-endpoint-literals.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
