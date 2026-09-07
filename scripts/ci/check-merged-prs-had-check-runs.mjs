#!/usr/bin/env node
/**
 * A PR MUST NOT BE MERGEABLE WITH ZERO CHECK RUNS (#4046).
 *
 * ── THE MEASUREMENT THAT OPENED THIS ─────────────────────────────────────
 *
 * 78 PRs in this repository were merged into `main` with `total_count = 0` on
 * `commits/<head-sha>/check-runs` — nothing graded them at all. Not "a check
 * failed and was overridden": nothing ran. The most-cited case is #3678, merged
 * 2026-08-17T09:17Z at head `6b27f125`, whose head SHA still reports 0. The very
 * next PR, #3679, merged the same afternoon WITH coverage, and the class has not
 * recurred since — #4082 (release 0.102.0) reports 72 check runs on its head.
 *
 * A class that stopped on its own is not a class that is closed. Nothing in this
 * repo asserted it, so the only evidence it stayed shut was that nobody had
 * looked. This guard looks, on every push to `main`.
 *
 * ── WHY THIS CANNOT BE A PULL_REQUEST-EVENT CHECK ────────────────────────
 *
 * The obvious shape — "fail the PR when its head has no check runs" — cannot
 * work, and the reason is the defect itself. A job running ON the pull_request
 * event IS a check run, so by the time it can ask the question the answer is
 * never zero: it can only ever observe its own presence. And in the case that
 * matters most, a bot-authored PR, the `pull_request` workflows are held at
 * `conclusion: action_required` — CREATED but never EXECUTED, so they publish no
 * check run at all and there is no job available to ask anything (the same
 * mechanism release-please.yml records for #3447, head `3a21f6e0`: ten runs, and
 * `total_count = 0`).
 *
 * So the question is asked AFTER the merge, from the push event, about the PR
 * that produced the pushed commit. That is late — the merge has happened — but a
 * post-merge alarm that fires is worth more than a pre-merge alarm that
 * structurally cannot.
 *
 * ── WHY AN API FAILURE CANNOT READ GREEN ─────────────────────────────────
 *
 * The whole verdict is "a number the GitHub API gave me was not zero", so a
 * broken read, an expired token or a rate limit would otherwise be indexed as
 * SILENCE — the exact shape this repo has recorded more than any other. Two
 * embedded controls with FIXED, already-measured answers run FIRST, on every
 * invocation, and their failure is fatal:
 *
 *   #3678 head 6b27f125…  MUST read 0  and MUST be flagged   (the defect)
 *   #4082 head 904ae9ae…  MUST read >= 72 and MUST be clean  (the API works)
 *
 * The covered control is the one that makes a zero mean something: if the query
 * path were broken it would read 0 too, and the run fails saying so rather than
 * reporting a clean audit.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 *
 *   node scripts/ci/check-merged-prs-had-check-runs.mjs
 *       Audit the merge that produced `GITHUB_SHA` (a push to main).
 *
 *   node scripts/ci/check-merged-prs-had-check-runs.mjs --sha <sha>
 *       Audit the merge that produced <sha>.
 *
 *   node scripts/ci/check-merged-prs-had-check-runs.mjs --pr <n>
 *       Audit one PR by number — used by release-please.yml before it hands a
 *       release PR to the merge, and by hand when triaging.
 *
 *   node scripts/ci/check-merged-prs-had-check-runs.mjs --controls-only
 *       Run the embedded controls and stop.
 *
 * NO RESULT IS DISCARDED. Every `gh` invocation's stderr is captured and
 * reported; there is no `|| true` and no `2>/dev/null`. A read that fails exits
 * non-zero with git/gh's own text, never with a cause this script did not
 * establish (deploy-integrity R7).
 */

import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox';

/**
 * The floor a PR's head must clear. ZERO is the defect; one check run is enough
 * to prove something graded it, and judging WHICH checks ran is branch
 * protection's job, not this one's. Keeping the claim that narrow is deliberate:
 * a guard that also had opinions about coverage would be arguing with protection
 * from a place that cannot see protection.
 */
const MIN_CHECK_RUNS = 1;

class GhError extends Error {}

function gh(args) {
  try {
    return execFileSync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const detail = [e && e.stderr, e && e.message].filter(Boolean).join(' | ').trim();
    throw new GhError(`gh ${args.join(' ')} FAILED: ${detail || 'no error text'}`);
  }
}

/** `total_count` on a commit's check runs. Throws rather than returning 0. */
export function checkRunCount(sha) {
  const raw = gh(['api', `repos/${REPO}/commits/${sha}/check-runs`, '--jq', '.total_count']).trim();
  if (!/^\d+$/.test(raw)) {
    throw new GhError(
      `the check-runs count for ${sha} came back as ${JSON.stringify(raw)}, which is not a number. ` +
        'That is an unreadable answer, not a zero.',
    );
  }
  return Number(raw);
}

/** `{number, headSha, mergedAt}` for a PR. */
export function prFacts(number) {
  const raw = gh([
    'api', `repos/${REPO}/pulls/${number}`,
    '--jq', '[.number, .head.sha, (.merged_at // ""), .base.ref] | @tsv',
  ]).trim();
  const [n, headSha, mergedAt, baseRef] = raw.split('\t');
  if (!headSha) throw new GhError(`PR #${number}: the API returned no head SHA (got ${JSON.stringify(raw)}).`);
  return { number: Number(n), headSha, mergedAt: mergedAt || null, baseRef };
}

/** The PR numbers a commit belongs to, per GitHub's own association. */
export function prNumbersForCommit(sha) {
  const raw = gh([
    'api', `repos/${REPO}/commits/${sha}/pulls`,
    '-H', 'Accept: application/vnd.github+json',
    '--jq', '.[] | [.number, (.merged_at // "")] | @tsv',
  ]).trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [n, mergedAt] = line.split('\t');
      return { number: Number(n), mergedAt: mergedAt || null };
    });
}

// ── EMBEDDED CONTROLS ───────────────────────────────────────────────────────

export const CONTROLS = [
  {
    why: 'PR #3678 — merged 2026-08-17 with NOTHING graded; the shape this guard exists for',
    pr: 3678,
    sha: '6b27f125acadcca9b8a1996002b69d53e183055d',
    expectCount: 0,
    expectFlagged: true,
  },
  {
    // The count is asserted as a FLOOR, not an equality: a re-run can add a
    // check run to an old head and that would be a true fact, not drift. What
    // must never happen is this reading COLLAPSING toward zero, because that is
    // indistinguishable from the broken-query failure the controls exist to
    // catch. Measured 2026-09-06: 72.
    why: 'PR #4082 (release 0.102.0) — 72 check runs on its head; proves the query path is alive',
    pr: 4082,
    sha: '904ae9ae815233325e76b0d265ba9080441e9005',
    expectAtLeast: 72,
    expectFlagged: false,
  },
];

/**
 * The only judgement this guard makes. Isolated and exported so it can be
 * exercised without the network — and so the mutation that proves the guard
 * bites (`< MIN_CHECK_RUNS` -> `< 0`) has exactly one place to land.
 */
export function isBlind(count) {
  return count < MIN_CHECK_RUNS;
}

/**
 * @param {(sha: string) => number} read injectable so a test can simulate the
 *   failure mode the controls exist for: a query path that returns 0 for
 *   everything. Under that reader the COVERED control must fail, which is what
 *   stops a broken read from being reported as a clean audit.
 * @returns {string[]} control failures — empty when the query path is proven.
 */
export function runControls(read = checkRunCount) {
  const failures = [];
  for (const c of CONTROLS) {
    let count;
    try {
      count = read(c.sha);
    } catch (e) {
      failures.push(`${c.why}: ${e.message}`);
      continue;
    }
    if (c.expectCount !== undefined && count !== c.expectCount) {
      failures.push(`expected ${c.expectCount} check run(s) on ${c.sha}, read ${count} — ${c.why}`);
    }
    if (c.expectAtLeast !== undefined && count < c.expectAtLeast) {
      failures.push(
        `expected at least ${c.expectAtLeast} check run(s) on ${c.sha}, read ${count} — ${c.why}. ` +
          'A collapsing reading here is what a broken query looks like, so this refuses rather than ' +
          'reporting a clean audit.',
      );
    }
    const flagged = isBlind(count);
    if (flagged !== c.expectFlagged) {
      failures.push(`expected flagged=${c.expectFlagged}, got ${flagged} (count ${count}) — ${c.why}`);
    }
  }
  return failures;
}

// ── DRIVER ──────────────────────────────────────────────────────────────────

function auditPr(number) {
  const facts = prFacts(number);
  const count = checkRunCount(facts.headSha);
  return { ...facts, count, flagged: isBlind(count) };
}

export function report(results) {
  let bad = 0;
  for (const r of results) {
    const state = r.flagged ? 'BLIND' : 'ok';
    console.log(
      `  ${state.padEnd(5)} PR #${r.number} head ${r.headSha.slice(0, 12)} — ${r.count} check run(s)` +
        `${r.mergedAt ? ` (merged ${r.mergedAt})` : ' (not merged)'}`,
    );
    if (r.flagged) bad += 1;
  }
  if (bad > 0) {
    console.error(
      `\n::error::merged-prs-had-check-runs: ${bad} PR(s) reached main with FEWER than ${MIN_CHECK_RUNS} ` +
        'check run(s) on their head — nothing graded them. That is #4046, the class 78 PRs fell into ' +
        'before it stopped on its own in August 2026.',
    );
    for (const r of results.filter((x) => x.flagged)) {
      console.error(
        `   - PR #${r.number}: https://github.com/${REPO}/pull/${r.number} (head ${r.headSha}) — ` +
          'check whether its workflows were held at `action_required`, whether a paths filter excluded ' +
          'every one of them, or whether the merge bypassed protection.',
      );
    }
    return 1;
  }
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };

  // CONTROLS FIRST, ALWAYS — including on `--controls-only`. A verdict from an
  // unproven query path is not a verdict.
  const controlFailures = runControls();
  if (controlFailures.length) {
    console.error(
      '::error::merged-prs-had-check-runs: the embedded controls FAILED, so this run cannot tell a real ' +
        'zero from an unreadable one and refuses to report an audit.',
    );
    for (const f of controlFailures) console.error(`   - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `merged-prs-had-check-runs: ${CONTROLS.length} embedded control(s) passed — a known-blind head still ` +
      'reads 0 and a known-covered head still reads its full count, so a zero below means a zero.',
  );

  if (argv.includes('--controls-only')) return;

  const prArg = flag('--pr');
  if (prArg) {
    process.exitCode = report([auditPr(Number(prArg))]);
    return;
  }

  const sha = flag('--sha') || process.env.GITHUB_SHA || null;
  if (!sha) {
    console.log(
      'merged-prs-had-check-runs: no SHA to audit (neither --sha nor GITHUB_SHA is set). This is a ' +
        'POST-MERGE question and nothing was measured about a merge here — that is an ABSENCE of a ' +
        'subject, not a clean audit.',
    );
    return;
  }

  const event = process.env.GITHUB_EVENT_NAME || null;
  if (event && event !== 'push') {
    console.log(
      `merged-prs-had-check-runs: event is \`${event}\`, not \`push\`. A job running on a pull_request ` +
        'IS a check run, so it can only ever observe its own presence; the audit is asked after the ' +
        'merge instead. Controls above still ran, so this step is not a hollow green.',
    );
    return;
  }

  const associated = prNumbersForCommit(sha);
  const merged = associated.filter((p) => p.mergedAt);
  if (merged.length === 0) {
    console.log(
      `merged-prs-had-check-runs: ${sha} is associated with ${associated.length} pull request(s), none ` +
        'of them merged — a direct push, or a commit whose PR is still open. Nothing to audit.',
    );
    return;
  }

  console.log(`merged-prs-had-check-runs: auditing ${merged.length} merged PR(s) behind ${sha}:`);
  process.exitCode = report(merged.map((p) => auditPr(p.number)));
}

// The default is UNCONDITIONAL: no CLI shape can silently exit 0 without the
// audit running. The single opt-out lets the unit test import the pure
// predicates without making four live API calls, and it announces itself on
// stderr so a run that took it cannot be mistaken for a run that audited.
if (process.env.LOOM_MERGED_PR_AUDIT_IMPORT_ONLY === '1') {
  console.error(
    '[merged-prs-had-check-runs] main() NOT RUN: LOOM_MERGED_PR_AUDIT_IMPORT_ONLY=1 — this process ' +
      'imported the module for its predicates and audited nothing.',
  );
} else {
  try {
    main();
  } catch (e) {
    if (e instanceof GhError) {
      console.error(`::error::merged-prs-had-check-runs: ${e.message}`);
      console.error(
        '   This is a READ failure, not a verdict about any PR. Nothing was established about check-run ' +
          'coverage on this commit.',
      );
      process.exit(1);
    }
    throw e;
  }
}
