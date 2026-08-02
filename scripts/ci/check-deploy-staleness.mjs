#!/usr/bin/env node
/**
 * Deploy-staleness check — "merged ≠ deployed".
 *
 * WHY THIS EXISTS (#2775). The #2643 Gov security fix merged on 2026-07-31, but
 * the dispatch-only workflow that APPLIES it last ran on 2026-07-15 — so the
 * exposure stayed live while every signal we had read green: code on main, tests
 * passing, guardrails passing, PR closed, issue closed. A sweep then found THREE
 * deploy paths carrying code that had never been applied, one of which had never
 * executed at all.
 *
 * Nothing in CI asserted that a dispatch-only deploy workflow had actually run
 * since its own code changed. This does.
 *
 * It is the deployment sibling of the "gates that measure nothing" class: the
 * control exists, reads as green, and is not executing.
 *
 * DESIGN NOTES
 *  - Compares each watched workflow's newest SUCCESSFUL run against the most
 *    recent commit touching that workflow OR any path it deploys from (the bicep
 *    module / script it invokes), because a stale bicep module is the same bug.
 *  - Reports days of drift; fails only past a per-entry threshold so ordinary
 *    lag does not cry wolf. A workflow that has NEVER run always fails.
 *  - Read-only. Never dispatches anything: deciding to run a multi-hour Gov
 *    deploy is an operator call, not a CI side effect.
 *
 * Usage:  GITHUB_TOKEN=… node scripts/ci/check-deploy-staleness.mjs [--json]
 * Env:    GITHUB_REPOSITORY (owner/repo) — defaults to the CSA Loom repo.
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox';

/**
 * Watched deploy paths. `paths` are the sources whose change should trigger a
 * redeploy — the workflow itself PLUS whatever it applies. `maxDays` is how much
 * drift is tolerable before this fails.
 */
const WATCHED = [
  {
    workflow: 'gov-uc-purview-wire.yml',
    why: 'Deploys loom-unity + Purview wiring into Gov. Carried the #2643 authorization fix undeployed for 15 days.',
    paths: [
      '.github/workflows/gov-uc-purview-wire.yml',
      'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
    ],
    maxDays: 14,
  },
  {
    workflow: 'gov-workspace-identity.yml',
    why: 'The ONLY lane proving workspace-scoped managed identity against real Gov endpoints. Commercial lanes cannot prove it.',
    paths: ['.github/workflows/gov-workspace-identity.yml'],
    maxDays: 30,
  },
  {
    workflow: 'csa-loom-post-deploy-bootstrap.yml',
    why: 'Applies every post-deploy grant + the day-one service wiring (Iceberg catalog, posture Function, Graph app-roles).',
    paths: ['.github/workflows/csa-loom-post-deploy-bootstrap.yml'],
    maxDays: 21,
  },
  {
    workflow: 'deploy-copilot-evaluator.yml',
    // An undeployed evaluator does not fail — it scores. The nightly
    // copilot-quality-evals gate runs against whatever image the job happens to
    // be on, so stale evaluator code means every nightly run reports quality
    // measured by old logic, in green. #2799's probeErrors/rowsAttempted
    // diagnostic is inert until this runs. Before #2814 the deploy path was a
    // local shell script no workflow executed, which is why it could not appear
    // here at all: this watchdog can only see deploy paths that are workflows.
    why: 'Builds + rolls the loom-copilot-evaluator image. Stale here means the nightly Copilot quality gate scores production with old evaluator logic and still reads green — a gate measuring the wrong thing, not a red X.',
    paths: [
      '.github/workflows/deploy-copilot-evaluator.yml',
      'azure-functions/copilot-evaluator/**',
      'scripts/csa-loom/deploy-copilot-evaluator-job.sh',
    ],
    // Tighter than the 21/30-day entries: this is a single image build plus a
    // job update against one already-provisioned estate — minutes, not a
    // multi-hour Gov deploy — so there is no cost argument for tolerating long
    // drift. Matched to the 14 days of the gov-uc-purview-wire entry, which was
    // set by how long an undeployed fix stayed live unnoticed.
    maxDays: 14,
  },
];

const DAY_MS = 86_400_000;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Newest SUCCESSFUL run.
 *   { at: ISO }           — ran successfully
 *   { at: null }          — query worked; the workflow has genuinely never run
 *   { queryFailed: true } — gh/auth/network broke; we do NOT know
 *
 * The third case is kept DISTINCT on purpose. Reporting a broken query as
 * "never run" would send someone chasing a deploy that already happened — and
 * the whole point of this check is that a control must not claim something it
 * did not actually measure. Both still fail (never silently green), but they
 * say different things.
 */
function lastSuccessfulRun(workflow) {
  try {
    const out = gh([
      'run', 'list', '--workflow', workflow, '--status', 'success',
      '--limit', '1', '--json', 'createdAt', '--repo', REPO,
    ]);
    const rows = JSON.parse(out || '[]');
    return { at: rows[0]?.createdAt || null };
  } catch (e) {
    return { queryFailed: true, error: String(e?.stderr || e?.message || e).slice(0, 160) };
  }
}

/** ISO timestamp of the most recent commit touching any of `paths`. */
function lastCodeChange(paths) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...paths], { encoding: 'utf8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}

const rows = [];
for (const entry of WATCHED) {
  const run = lastSuccessfulRun(entry.workflow);
  const codeAt = lastCodeChange(entry.paths);
  if (!codeAt) continue; // path removed from the tree — nothing to compare.

  const queryFailed = run.queryFailed === true;
  const runAt = run.at || null;
  const neverRan = !queryFailed && !runAt;
  const driftDays = (queryFailed || neverRan)
    ? Infinity
    : Math.max(0, Math.round((Date.parse(codeAt) - Date.parse(runAt)) / DAY_MS));
  const stale = queryFailed || neverRan
    || (Date.parse(codeAt) > Date.parse(runAt) && driftDays > entry.maxDays);

  rows.push({ ...entry, runAt, codeAt, driftDays, neverRan, queryFailed, queryError: run.error, stale });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
}

console.log('[deploy-staleness] watched deploy paths:');
for (const r of rows) {
  const when = r.queryFailed ? 'UNKNOWN (run-history query failed)'
    : r.neverRan ? 'NEVER RUN'
      : `last success ${r.runAt.slice(0, 10)}`;
  const drift = (r.queryFailed || r.neverRan) ? '' : `, code ${r.codeAt.slice(0, 10)} (+${r.driftDays}d)`;
  console.log(`  ${r.stale ? 'STALE' : 'ok   '}  ${r.workflow.padEnd(38)} ${when}${drift}`);
}

const stale = rows.filter((r) => r.stale);
if (stale.length === 0) {
  console.log('[deploy-staleness] OK — every watched deploy path has run since its code last changed.');
  process.exit(0);
}

console.error(`\n[deploy-staleness] FAIL — ${stale.length} deploy path(s) carry code that was never applied.\n`);
for (const r of stale) {
  console.error(`  ${r.workflow}`);
  console.error(`    ${r.queryFailed ? `run history UNKNOWN — the gh query failed: ${r.queryError}` : r.neverRan ? 'has NEVER run' : `${r.driftDays} days of undeployed code (limit ${r.maxDays})`}`);
  console.error(`    why it matters: ${r.why}`);
  console.error(`    dispatch: gh workflow run ${r.workflow} --ref main\n`);
}
console.error('  A merged fix is not a deployed fix. If the drift is intentional, raise maxDays');
console.error('  for that entry WITH a reason — that is a deployment review, not a config tweak.\n');
process.exit(1);
