#!/usr/bin/env node
/**
 * Roll gate — wait for, then adjudicate, the `vitest (node 20)` check-run.
 *
 * Thin I/O shell around classifyVitestGate() in ./roll-gate-decision.mjs; all
 * the decision logic (and all the tests) live there.
 *
 * WHY IT POLLS (#2819). The previous gate read the check-run conclusion ONCE.
 * The roll is triggered by the image build completing, and vitest is slower
 * than the image build — measured ~10 minutes slower on the commits in #2819 —
 * so the single read landed while vitest was still in_progress, saw a null
 * conclusion, and reported "no check-run found … re-run CI". The check was
 * running fine and went on to pass. Waiting is the fix; giving up is not.
 *
 * EXIT CODES
 *   0  verified — proceed with the roll
 *   1  refused  — including "timed out waiting for a verdict". A timeout is NOT
 *                 a pass. If this gate cannot obtain proof, nothing ships.
 *
 * Usage:
 *   GH_TOKEN=… node scripts/ci/roll-vitest-gate.mjs <40-hex-sha>
 * Env:
 *   GITHUB_REPOSITORY        owner/repo (default: the CSA Loom repo)
 *   ROLL_VITEST_WAIT_MINUTES how long to wait for a verdict (default 50 —
 *                            fiab-console-ci caps the vitest job at 45m, plus
 *                            queue time; past that the job itself fails and we
 *                            get a real conclusion to refuse on)
 *   ROLL_VITEST_POLL_SECONDS poll interval (default 30)
 */
import { execFileSync } from 'node:child_process';
import { classifyVitestGate, VITEST_CHECK_NAME } from './roll-gate-decision.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox';
const CONSOLE_CI_WORKFLOW = 'fiab-console-ci.yml';
const WAIT_MINUTES = Number(process.env.ROLL_VITEST_WAIT_MINUTES || 50);
const POLL_SECONDS = Number(process.env.ROLL_VITEST_POLL_SECONDS || 30);

const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) {
  console.error(`::error::roll-vitest-gate: expected a 40-hex commit SHA, got '${sha}'.`);
  process.exit(1);
}

/**
 * Call `gh api`. Throws on failure — deliberately NOT swallowed: a failed API
 * call is an unknown, and unknowns must not be silently turned into negatives
 * (that is the #2819 bug in its other half).
 */
function ghJson(path) {
  const out = execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function fetchState() {
  const checks = ghJson(`repos/${REPO}/commits/${sha}/check-runs?per_page=100`);
  const ci = ghJson(`repos/${REPO}/actions/workflows/${CONSOLE_CI_WORKFLOW}/runs?head_sha=${sha}`);
  return {
    checkRuns: (checks.check_runs || []).map((r) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      started_at: r.started_at,
    })),
    ciRuns: (ci.workflow_runs || []).map((r) => ({ status: r.status, conclusion: r.conclusion })),
  };
}

/** Only fetched when the check was CANCELLED — see classifyVitestGate. */
function fetchMainVerification() {
  try {
    const mainSha = ghJson(`repos/${REPO}/branches/main`).commit.sha;
    const cmp = ghJson(`repos/${REPO}/compare/${sha}...${mainSha}`);
    const mainChecks = ghJson(`repos/${REPO}/commits/${mainSha}/check-runs?per_page=100`);
    const mainVitest = (mainChecks.check_runs || [])
      .filter((r) => r.name === VITEST_CHECK_NAME)
      .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
      .pop();
    return {
      compareStatus: cmp.status,
      behindBy: cmp.behind_by,
      mainConclusion: mainVitest ? mainVitest.conclusion : null,
    };
  } catch (err) {
    console.log(`  main-branch verification unavailable: ${err.message.split('\n')[0]}`);
    return null;
  }
}

const deadline = Date.now() + WAIT_MINUTES * 60_000;
let last = 'no observation yet';

console.log(
  `Adjudicating '${VITEST_CHECK_NAME}' for ${sha} (waiting up to ${WAIT_MINUTES}m; a timeout REFUSES).`,
);

for (;;) {
  let state;
  try {
    state = fetchState();
  } catch (err) {
    // An API failure is an unknown. Keep waiting; if it never clears we time
    // out into a refusal. We never convert it into a verdict either way.
    last = `GitHub API call failed: ${err.message.split('\n')[0]}`;
    console.log(`  ${last}`);
    if (Date.now() >= deadline) break;
    sleep(POLL_SECONDS * 1000);
    continue;
  }

  let verdict = classifyVitestGate(state);
  if (verdict.decision === 'refuse' && /cancelled/.test(verdict.reason)) {
    // Re-adjudicate with the ancestor-of-main evidence before refusing.
    const mainVerification = fetchMainVerification();
    if (mainVerification) verdict = classifyVitestGate({ ...state, mainVerification });
  }

  last = verdict.reason;
  console.log(`  [${new Date().toISOString().slice(11, 19)}] ${verdict.decision}: ${verdict.reason}`);

  if (verdict.decision === 'pass') {
    console.log(`::notice::vitest gate PASSED for ${sha} — ${verdict.reason}. Proceeding to roll.`);
    process.exit(0);
  }
  if (verdict.decision === 'refuse') {
    console.log(
      `::error::vitest gate REFUSED for ${sha} — ${verdict.reason}. Fix CI and re-roll, roll a tested SHA, or (emergency only) dispatch with skip_uat=true.`,
    );
    process.exit(1);
  }
  if (Date.now() >= deadline) break;
  sleep(POLL_SECONDS * 1000);
}

console.log(
  `::error::vitest gate TIMED OUT after ${WAIT_MINUTES}m waiting for a verdict on ${sha} (last state: ${last}). A timeout is a REFUSAL, not a pass — nothing was rolled. Investigate fiab-console-ci for this commit, then re-run this roll.`,
);
process.exit(1);
