#!/usr/bin/env node
/**
 * GUARDRAIL: guardrails-observability  (merge-blocker — #3042)
 * ---------------------------------------------------------------------------
 * THE RULE: every `run:` step in loom-guardrails.yml's `guardrails` job must
 * carry `if: ${{ !cancelled() }}`.
 *
 * WHY (#3042, and #2957 before it): the guards are sequential steps in one
 * job. Without the `if`, the FIRST failing step renders every later step as
 * `skipped` — and nothing on the run page distinguishes "did not run" from
 * "had nothing to report", so skipped reads as passed. On 2026-08-05 that hid
 * a second, unrelated main-blocker behind the #3040 false positive: fixing
 * the visible failure would have turned main green for exactly one run.
 * Serial discovery of parallel problems. With the `if`, every guard runs and
 * every failure reports; the job still fails if any step failed. Two
 * simultaneous, unrelated guard failures are both visible from a single run —
 * the acceptance criterion the issue names.
 *
 * `uses:` steps (checkout, setup-node) are exempt: they have no verdict of
 * their own to hide. If a setup step fails, every guard fails loudly — that
 * is fail-closed, not noise.
 *
 * `always()` is deliberately NOT accepted: it also runs on a CANCELLED
 * workflow, which burns runner minutes reporting verdicts nobody will read
 * and delays the cancellation. `!cancelled()` is the precise condition.
 *
 * MODES
 *   node scripts/ci/check-guardrails-observability.mjs              # CHECK
 *   node scripts/ci/check-guardrails-observability.mjs --self-test  # prove it can fail
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseWorkflow, scalarValue } from './_workflow-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SUBJECT = join(REPO_ROOT, '.github', 'workflows', 'loom-guardrails.yml');

const REQUIRED_IF = '${{ !cancelled() }}';

/** Analyze one workflow text: every run-step of every job needs the `if`. */
export function analyze(text) {
  const findings = [];
  let runSteps = 0;
  const doc = parseWorkflow(text);
  const jobs = doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    const steps = Array.isArray(job?.steps) ? job.steps : [];

    // THE HOLE IN THE `if: !cancelled()` CONVENTION (#3042, measured 2026-08-11).
    //
    // That convention stops the FIRST FAILING STEP from masking later ones. It
    // does nothing about a `timeout-minutes` kill, because the runner is gone:
    // every later step reports `skipped`, and GitHub reports the job itself as
    // `cancelled` — which in a run list reads as "superseded by a newer push",
    // not "this job died". Measured: the guardrails job ran 10m15s against a
    // 10-minute budget, was killed at step 94 of 98, and I twice diagnosed it as
    // a concurrency cancellation before reading the timestamps.
    //
    // A job cannot detect its own timeout from the inside — an `always()` step
    // does not run either. What IS checkable statically is that the budget was
    // declared at all. A job with NO `timeout-minutes` inherits GitHub's 6-hour
    // default, so a single hung guard burns six hours of runner time and reports
    // `cancelled` at the end of it, which is the same misreading with a much
    // worse bill.
    if (steps.some((st) => st && typeof st === 'object' && st.run != null)) {
      const budget = scalarValue(job?.['timeout-minutes']);
      if (budget == null) {
        findings.push({
          job: jobId,
          name: '(job-level)',
          line: 0,
          msg:
            'declares no `timeout-minutes`, so it inherits the 6-hour GitHub default. A hung guard ' +
            'then burns six hours and ends as `cancelled` — and a timeout kill makes every later ' +
            'step read `skipped`, which is exactly the masking `if: ${{ !cancelled() }}` exists to ' +
            'prevent. Declare a budget with headroom.',
        });
      }
    }

    for (const st of steps) {
      if (!st || typeof st !== 'object' || Array.isArray(st)) continue;
      const run = st.run;
      if (run == null) continue; // `uses:` steps are exempt — no verdict to hide
      runSteps++;
      const name = scalarValue(st.name) ?? '(unnamed step)';
      const line = run.line ?? 0;
      const cond = scalarValue(st.if);
      if (cond == null) {
        findings.push({
          job: jobId,
          name,
          line,
          msg: `has no \`if:\` — when an EARLIER guard fails this one is skipped, and skipped reads as passed. Add: if: \${{ !cancelled() }}`,
        });
      } else if (cond.replace(/\s+/g, ' ').trim() !== REQUIRED_IF) {
        findings.push({
          job: jobId,
          name,
          line,
          msg: `has \`if: ${cond}\` — the required condition is exactly \`\${{ !cancelled() }}\` (success()-family conditions re-create the masking; always() also runs on a cancelled workflow).`,
        });
      }
    }
  }
  return { findings, runSteps };
}

// ── self-test: the guard must be observed FAILING on the defect ─────────────
const FIX_CLEAN = `
name: fixture
on: push
jobs:
  guardrails:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - name: guard one
        if: \${{ !cancelled() }}
        run: node scripts/ci/one.mjs
      - name: guard two
        if: \${{ !cancelled() }}
        run: node scripts/ci/two.mjs
`;
const FIX_NO_IF = `
name: fixture
on: push
jobs:
  guardrails:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - name: guard one
        if: \${{ !cancelled() }}
        run: node scripts/ci/one.mjs
      - name: guard two
        run: node scripts/ci/two.mjs
`;
const FIX_WRONG_IF = `
name: fixture
on: push
jobs:
  guardrails:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - name: guard one
        if: success()
        run: node scripts/ci/one.mjs
`;

// The `if: !cancelled()` convention protects against a FAILING step masking its
// successors. It does NOT protect against a `timeout-minutes` kill, which ends
// the runner and makes every later step read `skipped` — the same masking, and
// GitHub labels the job `cancelled`, which in a run list reads as "superseded".
// Measured 2026-08-11: this very job ran 10m15s against a 10-minute budget and
// was killed at step 94 of 98. A job with NO budget inherits 6 hours, so the
// same misreading arrives after six hours of burnt runner time.
//
// The three fixtures above now declare a budget precisely so they test ONLY the
// `if:` property; this one tests only the budget.
const FIX_NO_TIMEOUT = `
name: fixture
on: push
jobs:
  guardrails:
    runs-on: ubuntu-latest
    steps:
      - name: guard one
        if: \${{ !cancelled() }}
        run: node scripts/ci/one.mjs
`;

// A job with no `run:` steps has no verdict to hide, so it needs no budget for
// THIS rule's purposes — the check must not fire on it.
const FIX_NO_RUN_STEPS = `
name: fixture
on: push
jobs:
  guardrails:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

function selfTest() {
  let ok = true;
  const say = (pass, msg) => {
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!pass) ok = false;
  };
  console.log('[guardrails-observability] self-test — the guard must FAIL on the masking shapes');

  const clean = analyze(FIX_CLEAN);
  say(clean.findings.length === 0 && clean.runSteps === 2, `clean shape is silent (${clean.findings.length} finding(s), ${clean.runSteps} run step(s))`);

  const noIf = analyze(FIX_NO_IF);
  say(
    noIf.findings.length === 1 && /guard two/.test(noIf.findings[0].name),
    'a run step WITHOUT `if:` is detected (the #3042 masking)',
  );

  const wrongIf = analyze(FIX_WRONG_IF);
  say(wrongIf.findings.length === 1, 'a run step with `if: success()` is detected (re-creates the masking)');

  // #3042's second route: a timeout kill ends the runner, every later step reads
  // `skipped`, and GitHub calls the job `cancelled`.
  const noTimeout = analyze(FIX_NO_TIMEOUT);
  say(
    noTimeout.findings.length === 1 && /timeout-minutes/.test(noTimeout.findings[0].msg),
    'a job with run steps and NO `timeout-minutes` is detected (the timeout route to the same masking)',
  );

  // …and it must not fire where there is no verdict to hide.
  const noRunSteps = analyze(FIX_NO_RUN_STEPS);
  say(
    noRunSteps.findings.length === 0,
    'a job with only `uses:` steps needs no budget for this rule (no false positive)',
  );

  console.log(ok ? '[guardrails-observability] self-test OK' : '[guardrails-observability] self-test FAILED');
  return ok ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  if (!existsSync(SUBJECT)) {
    console.error(`[guardrails-observability] FAIL — subject missing: ${SUBJECT}`);
    console.error('   If the guardrails workflow moved, re-point this guard.');
    return 1;
  }
  let res;
  try {
    res = analyze(readFileSync(SUBJECT, 'utf8'));
  } catch (e) {
    console.error(`[guardrails-observability] FAIL — could not parse loom-guardrails.yml: ${e.message}`);
    return 1;
  }
  if (res.runSteps === 0) {
    console.error(
      '[guardrails-observability] FAIL — found ZERO run steps in the guardrails job; a run that examined nothing verified nothing.',
    );
    return 1;
  }
  if (res.findings.length) {
    console.error(
      `[guardrails-observability] FAIL — ${res.findings.length} step(s) can be masked by an earlier failure (#3042):`,
    );
    for (const f of res.findings) {
      console.error(`   - [${f.job}] "${f.name}" (run: at line ${f.line}) ${f.msg}`);
    }
    return 1;
  }
  console.log(
    `[guardrails-observability] OK — all ${res.runSteps} run step(s) carry \`if: \${{ !cancelled() }}\`; ` +
      'two simultaneous guard failures are both visible from a single run.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
