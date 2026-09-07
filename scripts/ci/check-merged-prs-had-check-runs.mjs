#!/usr/bin/env node
/**
 * GUARDRAIL: a commit reached main from a pull request that was NEVER GRADED.
 *
 * THE CLASS (#4046)
 * -----------------
 * 78 pull requests merged into this repo carrying ZERO check runs. Not "a
 * failing check that was overridden" — zero. `GET /commits/{head}/check-runs`
 * returned `total_count: 0`, so every required context was, from GitHub's point
 * of view, never reported, and the merge went through anyway.
 *
 * Measured 2026-09-02 on the real API:
 *   PR #3678, head 6b27f125  -> total_count = 0    (merged blind, 08-17T09:17)
 *   PR #3679, head …         -> graded             (merged 08-17T15:55)
 *   PR #4082, head 904ae9ae  -> total_count = 72   (release 0.102.0)
 *   PR #4288, head e30cd576  -> total_count = 28   (open release PR)
 *
 * The class LOOKS closed at #3679 — the last blind merge is weeks old. Nothing
 * guards it. A class that closed itself can reopen itself, and the shape that
 * produced it is still reachable: a bot-authored PR whose workflow runs park in
 * `action_required` publishes no check run at all (the #3447 deadlock, recorded
 * at length in release-please.yml), and a repository or ruleset change that
 * drops a required context leaves nothing to wait for.
 *
 * WHY THIS RUNS POST-MERGE, ON PUSH, AND NOT ON THE PULL REQUEST
 * --------------------------------------------------------------
 * A job running on `pull_request` cannot observe its own zero: the moment it
 * starts, it IS a check run on that head, so the count it would read is at
 * least one. And on the specific PRs this class is about — bot-authored ones —
 * the job would not run at all, which is the defect wearing the guard's own
 * face. The only vantage point from which "this PR merged with no verdict" is
 * observable is AFTER the merge, from the merge commit, looking back at the
 * head that was graded (or was not).
 *
 * That makes this a DETECTOR, not a blocker, and the header says so rather than
 * implying more: it cannot stop the blind merge, it fails the push-to-main run
 * that follows it, which is the earliest honest signal available. Release PRs
 * are covered before the merge instead, by release-please.yml's own verify
 * loop — it refuses to enable auto-merge until every context in REQUIRED_CHECKS
 * has a real check run on the head SHA, which is this same predicate applied
 * ahead of time.
 *
 * NOTHING HERE CAN READ GREEN OFF A FAILED API CALL
 * -------------------------------------------------
 * "I could not reach the API" and "the API said zero" are different facts and
 * are reported differently (deploy-integrity R7). An unreadable count is a
 * FAILURE, never a pass — the opposite convention is how a `2>/dev/null` turned
 * a permission denial into "the tag does not exist" and sent two investigations
 * the wrong way.
 *
 * The verdict function is additionally pinned by CONTROLS below: recorded
 * observations from the real API, run through the SAME predicate on every
 * invocation. Weaken the comparison — `count < 0`, `count <= -1`, an early
 * `return GRADED` — and the controls disagree and the run fails before it ever
 * reaches the network.
 *
 * USAGE
 *   node scripts/ci/check-merged-prs-had-check-runs.mjs             # audit $GITHUB_SHA
 *   node scripts/ci/check-merged-prs-had-check-runs.mjs --sha <sha> # audit one commit
 *   node scripts/ci/check-merged-prs-had-check-runs.mjs --self-test # controls only
 *
 * Tests: node --test scripts/ci/__tests__/check-merged-prs-had-check-runs.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {'graded'|'blind'|'unreadable'|'no-pr'} Verdict */

export const GRADED = 'graded';
export const BLIND = 'blind';
export const UNREADABLE = 'unreadable';
export const NO_PR = 'no-pr';

/**
 * The whole decision, as a pure function over what was observed.
 *
 * @param {{pr: {number:number, head:string}|null,
 *          checkRuns: {ok:true, total:number}|{ok:false, why:string}}} observed
 * @returns {{verdict:Verdict, why:string}}
 */
export function judge(observed) {
  const pr = observed?.pr ?? null;
  const checkRuns = observed?.checkRuns;

  if (!pr) {
    return {
      verdict: NO_PR,
      why:
        'no pull request is associated with this commit. Nothing about a PR was established here ' +
        'either way — a direct push to main is outside what this detector can see.',
    };
  }
  if (!checkRuns || checkRuns.ok !== true) {
    const why = checkRuns && 'why' in checkRuns ? checkRuns.why : 'no observation was supplied';
    return {
      verdict: UNREADABLE,
      why:
        `the check-run count for PR #${pr.number} (head ${pr.head}) could NOT be read: ${why}. ` +
        'That is not "zero" and it is not "fine" — it is an unmeasured merge, and this guard ' +
        'fails rather than reporting a verdict it did not obtain.',
    };
  }
  if (!Number.isInteger(checkRuns.total) || checkRuns.total < 0) {
    return {
      verdict: UNREADABLE,
      why:
        `the API returned a non-count (${JSON.stringify(checkRuns.total)}) for PR #${pr.number} ` +
        `(head ${pr.head}). A shape this guard cannot interpret is refused, not rounded to zero.`,
    };
  }
  if (checkRuns.total === 0) {
    return {
      verdict: BLIND,
      why:
        `PR #${pr.number} merged into main with ZERO check runs on its head ${pr.head}. Every ` +
        'required context was unreported at the moment of merge, so nothing in CI had a say in ' +
        'whether this commit was fit to land (#4046).',
    };
  }
  return {
    verdict: GRADED,
    why: `PR #${pr.number} carried ${checkRuns.total} check run(s) on head ${pr.head}.`,
  };
}

/**
 * RECORDED OBSERVATIONS FROM THE REAL API, replayed through `judge` on every
 * run. These are the two ends of the class: the merge that happened blind and
 * the merges that did not.
 */
export const CONTROLS = [
  {
    name: '#3678 head 6b27f125 — the blind merge this issue is about',
    observed: { pr: { number: 3678, head: '6b27f125' }, checkRuns: { ok: true, total: 0 } },
    expect: BLIND,
  },
  {
    name: '#4082 head 904ae9ae — release 0.102.0, merged 2026-08-28',
    observed: { pr: { number: 4082, head: '904ae9ae' }, checkRuns: { ok: true, total: 72 } },
    expect: GRADED,
  },
  {
    name: '#4288 head e30cd576 — an open release PR mid-grading',
    observed: { pr: { number: 4288, head: 'e30cd576' }, checkRuns: { ok: true, total: 28 } },
    expect: GRADED,
  },
  {
    name: 'a single check run is still a graded merge (the boundary, not a round number)',
    observed: { pr: { number: 1, head: 'aaaaaaa' }, checkRuns: { ok: true, total: 1 } },
    expect: GRADED,
  },
  {
    name: 'an API that could not be read is NOT a pass',
    observed: { pr: { number: 1, head: 'aaaaaaa' }, checkRuns: { ok: false, why: 'HTTP 403' } },
    expect: UNREADABLE,
  },
  {
    name: 'a commit with no PR is reported as unobserved, not as clean',
    observed: { pr: null, checkRuns: { ok: true, total: 0 } },
    expect: NO_PR,
  },
];

/**
 * Replay every control through `judgeFn`.
 * @param {(o:any)=>{verdict:string}} [judgeFn]
 * @returns {{name:string, expect:string, got:string}[]} disagreements
 */
export function runControls(judgeFn = judge) {
  const failures = [];
  for (const c of CONTROLS) {
    const got = judgeFn(c.observed).verdict;
    if (got !== c.expect) failures.push({ name: c.name, expect: c.expect, got });
  }
  return failures;
}

// ── THE IO HALF ────────────────────────────────────────────────────────────

/**
 * `gh api <path>`, with stderr CAPTURED and surfaced. A discarded stderr here
 * is what turns a permission denial into a false claim about the data.
 * @returns {{ok:true, json:any}|{ok:false, why:string}}
 */
export function ghApi(apiPath, run = defaultRun) {
  try {
    const out = run(['api', '-H', 'Accept: application/vnd.github+json', apiPath]);
    return { ok: true, json: JSON.parse(out) };
  } catch (e) {
    const stderr = e?.stderr ? String(e.stderr).trim() : '';
    const why = [e?.message ? String(e.message).split('\n')[0] : String(e), stderr]
      .filter(Boolean)
      .join(' — ');
    return { ok: false, why: `GET ${apiPath}: ${why}` };
  }
}

function defaultRun(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Resolve the pull request a pushed commit came from.
 * @returns {{ok:true, pr:{number:number, head:string}|null}|{ok:false, why:string}}
 */
export function resolvePr(repo, sha, run = defaultRun) {
  const res = ghApi(`repos/${repo}/commits/${sha}/pulls?per_page=100`, run);
  if (!res.ok) return res;
  const list = Array.isArray(res.json) ? res.json : [];
  // Prefer the PR this commit IS the merge of; fall back to the only one listed.
  const exact = list.find((p) => p?.merge_commit_sha === sha);
  const chosen = exact || (list.length === 1 ? list[0] : null);
  if (!chosen) return { ok: true, pr: null };
  return { ok: true, pr: { number: chosen.number, head: chosen?.head?.sha || 'unknown' } };
}

/**
 * Count the check runs on a head SHA.
 * @returns {{ok:true, total:number}|{ok:false, why:string}}
 */
export function countCheckRuns(repo, head, run = defaultRun) {
  const res = ghApi(`repos/${repo}/commits/${head}/check-runs?per_page=1`, run);
  if (!res.ok) return res;
  const total = res.json?.total_count;
  if (typeof total !== 'number') {
    return { ok: false, why: `the response carried no numeric total_count (got ${JSON.stringify(total)})` };
  }
  return { ok: true, total };
}

function main(argv) {
  const controlFailures = runControls();
  if (controlFailures.length > 0) {
    for (const f of controlFailures) {
      console.error(
        `::error::merged-pr-check-runs: embedded control "${f.name}" expected ${f.expect}, got ${f.got}.`,
      );
    }
    console.error(
      '::error::merged-pr-check-runs: the verdict function no longer agrees with recorded ' +
        'observations from the real API. Refusing to audit anything on a predicate that is ' +
        'demonstrably wrong.',
    );
    process.exit(1);
  }
  console.log(`merged-pr-check-runs: ${CONTROLS.length}/${CONTROLS.length} embedded controls agree.`);

  if (argv.includes('--self-test')) return;

  const repo = process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox';
  const shaFlag = argv.indexOf('--sha');
  const sha = (shaFlag >= 0 ? argv[shaFlag + 1] : process.env.GITHUB_SHA) || '';
  if (!sha) {
    console.error(
      '::error::merged-pr-check-runs: no commit to audit — neither --sha nor GITHUB_SHA was set. ' +
        'A run with no subject has measured nothing, so it fails rather than printing OK.',
    );
    process.exit(1);
  }

  const prRes = resolvePr(repo, sha);
  if (!prRes.ok) {
    console.error(`::error::merged-pr-check-runs: ${prRes.why}`);
    console.error(
      '::error::merged-pr-check-runs: the pull request behind this commit could not be resolved, ' +
        'so whether it was graded is UNKNOWN. This guard does not report unknown as clean.',
    );
    process.exit(1);
  }

  const observed = { pr: prRes.pr, checkRuns: { ok: true, total: 0 } };
  if (prRes.pr) observed.checkRuns = countCheckRuns(repo, prRes.pr.head);

  const { verdict, why } = judge(observed);
  if (verdict === GRADED) {
    console.log(`merged-pr-check-runs: ${why}`);
    return;
  }
  if (verdict === NO_PR) {
    // Stated, not swallowed: this is the one shape the detector genuinely
    // cannot speak to, and saying so is the difference between a gap that is
    // known and a gap that is invisible.
    console.log(`merged-pr-check-runs: commit ${sha} — ${why}`);
    return;
  }
  console.error(`::error::merged-pr-check-runs: ${why}`);
  if (verdict === BLIND) {
    console.error(
      '::error::merged-pr-check-runs: this is #4046. Read the head SHA above against ' +
        `repos/${repo}/commits/<head>/check-runs, then find out what suppressed the runs — a ` +
        'bot-authored PR whose workflows parked in action_required publishes no check run at ' +
        'all, and a required context removed from protection leaves nothing to wait for.',
    );
  }
  process.exit(1);
}

const INVOKED_DIRECTLY =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (INVOKED_DIRECTLY) main(process.argv.slice(2));
