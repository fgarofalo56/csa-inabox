#!/usr/bin/env node
/**
 * Resolve `image_tag: latest` to an immutable, actually-built commit SHA.
 *
 * Thin I/O shell around resolveImageTag() + classifyAcrProbeError() in
 * ./roll-gate-decision.mjs; the decision logic and its tests live there.
 *
 * WHY IT EXISTS (#2819). The inline version of this walked recent successful
 * builds, probed ACR with `az … >/dev/null 2>&1`, and on failure declared:
 *
 *     "No recent main commit has a loom-console image in <acr>"
 *
 * — a statement about the REGISTRY derived from an unexamined error. In the
 * observed failure the registry was never contacted: the candidate list came
 * from `gh api` in a step with no GH_TOKEN, the call failed, `2>/dev/null` ate
 * the error, the loop ran zero times, and the workflow reported the registry
 * empty. The whole step took 164ms. Meanwhile `loom-console:902455d5…` had been
 * pushed 29 minutes earlier and was sitting in the registry.
 *
 * So this script keeps the three states apart:
 *   - the registry answered "here it is"       → resolved (authoritative)
 *   - the registry answered "not here"         → absent, and we may say so
 *   - we could not ask the registry            → UNKNOWN. Fall back to the
 *     build run's own job list (what a human checks), clearly labelled as the
 *     weaker evidence; if that is silent too, refuse saying we do not know.
 *
 * The fallback is safe to trust *provisionally* because it is re-checked
 * downstream: the cosign gate resolves the manifest digest with a proper ACR
 * firewall lease and fails the roll if the tag is not really there.
 *
 * EXIT CODES
 *   0  resolved — writes `sha=` and `evidence=` to $GITHUB_OUTPUT (and stdout)
 *   1  refused  — could not establish that any candidate image exists
 *
 * Usage:
 *   GH_TOKEN=… node scripts/ci/roll-resolve-image-tag.mjs --acr <name> --app <name>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { classifyAcrProbeError, resolveImageTag } from './roll-gate-decision.mjs';
import { classifyOutcome } from './run-outcome.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox';
const BUILD_WORKFLOW = 'build-fiab-images-acr-tasks.yml';
const MAX_CANDIDATES = 20;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ACR = arg('--acr');
const APP = arg('--app');
if (!ACR || !APP) {
  console.error('::error::roll-resolve-image-tag: --acr and --app are required.');
  process.exit(1);
}

/** Recent successful main builds, newest first. Failure here is UNKNOWN. */
function listCandidates() {
  const out = execFileSync(
    'gh',
    [
      'api',
      `repos/${REPO}/actions/workflows/${BUILD_WORKFLOW}/runs?branch=main&status=success&per_page=${MAX_CANDIDATES}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return (JSON.parse(out).workflow_runs || [])
    .filter((r) => /^[0-9a-f]{40}$/.test(String(r.head_sha)))
    .map((r) => ({ sha: r.head_sha, runId: r.id }));
}

/**
 * `az` is a shell script on the Linux runners this executes on. On a Windows
 * workstation it is an `az.cmd` shim that Node refuses to spawn without a
 * shell (CVE-2024-27980 hardening), so a local run classifies every probe as
 * 'unreachable' and falls back to build-job evidence. That is the correct
 * fail-closed answer, not a bug — but it does mean the registry-confirmed path
 * can only be exercised on Linux/CI. Deliberately NOT using `shell: true`: it
 * would put an interpolated tag on a command line for no benefit in CI.
 */
/** Ask the registry. Returns 'found' | 'absent' | 'unreachable'. */
function probeAcr(sha) {
  try {
    execFileSync(
      'az',
      ['acr', 'repository', 'show', '--name', ACR, '--image', `${APP}:${sha}`, '--query', 'digest', '-o', 'tsv'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return 'found';
  } catch (err) {
    const stderr = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
    const kind = classifyAcrProbeError(stderr);
    console.log(`  ${sha.slice(0, 8)}: registry probe → ${kind} (${stderr.trim().split('\n')[0] || 'no stderr'})`);
    return kind;
  }
}

/** Weaker evidence: did THIS app's build job in that run conclude success? */
function probeBuildJob(runId) {
  try {
    const out = execFileSync('gh', ['api', `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const jobs = JSON.parse(out).jobs || [];
    const job = jobs.find((j) => j.name === `Build ${APP} via ACR Tasks`);
    if (!job) return 'absent';
    // #3368 — this WAS `job.conclusion === 'success' ? 'success' : 'failure'`,
    // which labelled a CANCELLED or still-running build job as a FAILED one.
    // The documented contract here already has an `unknown` state; that
    // ternary made it unreachable. resolveImageTag only ever tests for
    // `'success'`, so behaviour is unchanged either way — but the contract is
    // now true, and a future reader of this value is not misled about whether
    // the build was measured to fail or simply never finished.
    const c = classifyOutcome(job.conclusion);
    if (c.category === 'success') return 'success';
    if (c.genuineFailure) return 'failure';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

let candidates = [];
let listComplete = true;
try {
  candidates = listCandidates();
} catch (err) {
  // NOT swallowed. This is the exact call that failed silently in #2819.
  console.log(`::warning::could not list image builds: ${String(err.message).split('\n')[0]}`);
  listComplete = false;
}

const observed = [];
for (const c of candidates) {
  const acr = probeAcr(c.sha);
  if (acr === 'found') {
    observed.push({ sha: c.sha, acr });
    break; // Authoritative; no need to look further back.
  }
  const entry = { sha: c.sha, acr };
  if (acr === 'unreachable') entry.buildJob = probeBuildJob(c.runId);
  observed.push(entry);
}

const result = resolveImageTag({ candidates: observed, listComplete });

if (result.decision === 'refuse') {
  console.log(
    `::error::Cannot resolve ':latest' to a built ${APP} image — ${result.reason} Refusing to roll ':latest' blind.`,
  );
  process.exit(1);
}

if (result.evidence === 'build-job') {
  console.log(
    `::warning::Resolved ':latest' → ${result.sha} from BUILD-JOB evidence, not a registry read (${result.reason}). The cosign gate below re-checks the manifest digest with an ACR firewall lease and will fail the roll if the tag is not really present.`,
  );
} else {
  console.log(`::notice::Resolved ':latest' → ${result.sha} (${result.reason}).`);
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${result.sha}\nevidence=${result.evidence}\n`);
}
console.log(result.sha);
