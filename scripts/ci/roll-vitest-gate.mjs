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
import {
  classifyVitestGate,
  checkRunSeconds,
  consoleTouchedFromCommit,
  projectCheckRun,
  VITEST_CHECK_NAME,
} from './roll-gate-decision.mjs';

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
    // execFileSync defaults maxBuffer to 1 MiB and throws ENOBUFS past it.
    // `GET /commits/{sha}` embeds a patch per file, so a large squash blows
    // straight through 1 MiB — and that throw would land in the same catch as
    // a genuine API failure, turning "the response was big" into "unknown".
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Read the FULL check-run list, paging until we have `total_count` of them.
 *
 * `?per_page=100` alone is a latent version of the same bug this script fixes:
 * a busy commit can carry more than 100 check-runs (a CSA Loom main commit was
 * at 67 and climbing as of #2819), and the tail is dropped silently — so
 * `vitest (node 20)` can be absent from the page we read while present on the
 * commit. Returning `complete:false` lets the classifier call that UNKNOWN
 * instead of ABSENT.
 */
function fetchCheckRuns(forSha) {
  const all = [];
  let total = null;
  for (let page = 1; page <= 20; page++) {
    const res = ghJson(`repos/${REPO}/commits/${forSha}/check-runs?per_page=100&page=${page}`);
    if (total === null) total = Number(res.total_count ?? 0);
    const batch = res.check_runs || [];
    all.push(...batch);
    if (batch.length === 0 || all.length >= total) break;
  }
  return { runs: all, complete: total !== null && all.length >= total };
}

/**
 * Does the rolled commit change apps/fiab-console?
 *
 * #2632: the gate needs this to tell a LEGITIMATE fast green (fiab-console-ci
 * reports the check green in ~10s when the console is untouched, so bicep-only
 * commits stay rollable) from the failure mode where the change detector could
 * not resolve its diff range and reported green on a console-wide change.
 *
 * Throws on an API failure rather than returning null, so the caller can tell
 * "ask again next poll" from "asked, and the answer is genuinely unknown"
 * (a file list truncated at the 300-file cap). Never guess `false`: that is the
 * value that waves a fast green through.
 */
function fetchConsoleTouched(forSha) {
  return consoleTouchedFromCommit(ghJson(`repos/${REPO}/commits/${forSha}`));
}

function fetchState() {
  const { runs, complete } = fetchCheckRuns(sha);
  const ci = ghJson(`repos/${REPO}/actions/workflows/${CONSOLE_CI_WORKFLOW}/runs?head_sha=${sha}`);
  return {
    checkRuns: runs.map(projectCheckRun),
    checkRunsComplete: complete,
    ciRuns: (ci.workflow_runs || []).map((r) => ({ status: r.status, conclusion: r.conclusion })),
  };
}

/** Only fetched when the check was CANCELLED — see classifyVitestGate. */
function fetchMainVerification() {
  try {
    const mainSha = ghJson(`repos/${REPO}/branches/main`).commit.sha;
    const cmp = ghJson(`repos/${REPO}/compare/${sha}...${mainSha}`);
    // Paged, for the same reason as fetchState: a truncated read of main's
    // check-runs would report mainConclusion=null and wrongly refuse a commit
    // that main has in fact verified.
    const { runs, complete } = fetchCheckRuns(mainSha);
    if (!complete) {
      console.log('  main-branch check-run list incomplete — not using it as verification.');
      return null;
    }
    const mainVitest = runs
      .map(projectCheckRun)
      .filter((r) => r.name === VITEST_CHECK_NAME)
      .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
      .pop();
    return {
      compareStatus: cmp.status,
      behindBy: cmp.behind_by,
      mainConclusion: mainVitest ? mainVitest.conclusion : null,
      // #2632: borrowing main's verdict is only sound if main's run ACTUALLY
      // executed. Without this the cancelled-path would accept a 10s green.
      mainSeconds: mainVitest ? checkRunSeconds(mainVitest) : null,
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

// Whether the commit touches the console decides whether a FAST green is
// admissible (#2632). Read it before polling — the commit's contents do not
// change — but keep retrying while the API is the reason we do not know, so one
// transient 5xx cannot turn a legitimate path-filtered green into a refusal.
let consoleTouched = null;
let consoleTouchedAnswered = false;
function refreshConsoleTouched() {
  if (consoleTouchedAnswered) return;
  try {
    consoleTouched = fetchConsoleTouched(sha);
    consoleTouchedAnswered = true; // includes a deliberate null (truncated list)
    console.log(
      `  changes apps/fiab-console: ${
        consoleTouched === null
          ? 'UNKNOWN — file list truncated; a fast green will NOT be accepted'
          : consoleTouched
      }`,
    );
  } catch (err) {
    console.log(`  could not read the file list for ${sha} (will retry): ${err.message.split('\n')[0]}`);
  }
}
refreshConsoleTouched();

for (;;) {
  refreshConsoleTouched();
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

  let verdict = classifyVitestGate({ ...state, consoleTouched });
  if (verdict.decision === 'refuse' && /cancelled/.test(verdict.reason)) {
    // Re-adjudicate with the ancestor-of-main evidence before refusing.
    const mainVerification = fetchMainVerification();
    if (mainVerification) verdict = classifyVitestGate({ ...state, consoleTouched, mainVerification });
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
