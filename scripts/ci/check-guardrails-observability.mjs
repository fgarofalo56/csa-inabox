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
    steps:
      - name: guard one
        if: success()
        run: node scripts/ci/one.mjs
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
