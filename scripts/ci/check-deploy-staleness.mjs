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
 *
 * TESTABILITY. The drift comparison is the whole point of this control, so it
 * lives in PURE functions ({@link pickLastRealSuccess}, {@link classifyDrift},
 * {@link decide}) that the self-test drives with fixtures — no gh, no git, no
 * network. The IO (gh run-history, git log) and the reporting stay in main(),
 * which runs only on direct invocation. A guard that has never been SHOWN to
 * fail on real drift is itself the "gate that measures nothing" defect this file
 * exists to catch, so scripts/ci/__tests__/deploy-staleness.test.mjs proves the
 * teeth: run<code ⇒ STALE, run>code ⇒ ok, never-run ⇒ STALE, gh-query-failed ⇒
 * UNKNOWN (never a false green), and the maxDays boundary in both directions.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox';

/**
 * Watched deploy paths. `paths` are the sources whose change should trigger a
 * redeploy — the workflow itself PLUS whatever it applies. `maxDays` is how much
 * drift is tolerable before this fails.
 */
export const WATCHED = [
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
  // ── The other four deploy-*-job.sh paths (#2816) ─────────────────────────
  // #2815 gave the copilot-evaluator a workflow. It was one of FIVE scripts in
  // the same state; the remaining four were reachable only from a workstation
  // with `az` write access, so they could not appear here at all — this
  // watchdog can only see deploy paths that are workflows. Same 14-day bound
  // as the evaluator, for the same reason: one image build plus a job update
  // against an already-provisioned estate is minutes of work.
  {
    workflow: 'deploy-lineage-extractor.yml',
    why: 'Builds + rolls the loom-lineage-extractor image. bicep creates the JOB but never builds the IMAGE, so stale here means the scheduled extractor keeps running old logic (or no image at all) while every execution still reports Succeeded and lineage quietly stops updating.',
    paths: [
      '.github/workflows/deploy-lineage-extractor.yml',
      'azure-functions/lineage-extractor/**',
      'scripts/csa-loom/deploy-lineage-extractor-job.sh',
    ],
    maxDays: 14,
  },
  {
    workflow: 'deploy-secret-expiry.yml',
    why: 'Builds + rolls the loom-secret-expiry-monitor image — the job that warns BEFORE an MSAL/Key Vault credential expires. Stale here is what the 2026-07-19 sign-in outage looked like from the inside: the credential lapsed, and the thing that should have said so was not running current code.',
    paths: [
      '.github/workflows/deploy-secret-expiry.yml',
      'azure-functions/secret-expiry-monitor/**',
      'scripts/csa-loom/deploy-secret-expiry-job.sh',
    ],
    maxDays: 14,
  },
  {
    workflow: 'deploy-loom-uat.yml',
    // The sharpest of the four: a VALIDATION capability that was itself
    // undeployable. When the job is absent or stale, loom-roll-and-validate
    // either SKIPS its UAT gate outright or grades the roll with an old suite —
    // green either way.
    why: 'Builds + rolls the loom-uat image (the in-VNet Playwright UAT harness). Stale here means loom-roll-and-validate grades every roll with an out-of-date suite, or skips the gate entirely — a roll gate reading green on tests that no longer match the app.',
    paths: [
      '.github/workflows/deploy-loom-uat.yml',
      'apps/fiab-console/Dockerfile.uat',
      'apps/fiab-console/e2e/**',
      'scripts/csa-loom/deploy-loom-uat-job.sh',
    ],
    maxDays: 14,
  },
  {
    workflow: 'deploy-loom-verify.yml',
    why: 'Refreshes the loom-verify job. scripts/csa-loom/loom-verify.js is base64-embedded into the job at deploy time, so THIS workflow is the only way that file reaches production — stale here means the API verifier is probing production with a route list that no longer matches it, and passing.',
    paths: [
      '.github/workflows/deploy-loom-verify.yml',
      'scripts/csa-loom/loom-verify.js',
      'scripts/csa-loom/deploy-loom-verify-job.sh',
    ],
    maxDays: 14,
  },
  // ── The loom-sharing IMAGE (#2619) ───────────────────────────────────────
  // A rung below the deploy-script class: there, deploy scripts no workflow ran;
  // here, an app IMAGE no workflow built. LU-9 shipped a Dockerfile, a bicep
  // module, a threat model and an entrypoint unit-test job — and nothing ever
  // produced the artifact, so the Container App could not have been created
  // (MANIFEST_UNKNOWN) and every merged byte of the sharing BFF was inert.
  //
  // NOTE ON THE DRY-RUN FILTER: this workflow has no dry-run mode to skip. All
  // three `apply` modes build and push a real image; `build-only` is the mode
  // that closes the prerequisite, not a no-op. So a successful run here always
  // means an artifact was produced, which is exactly what this watchdog should
  // be measuring.
  {
    workflow: 'deploy-loom-sharing.yml',
    why: 'The ONLY thing that builds the loom-sharing image (the OSS Delta Sharing server that gives Azure Government an open-protocol endpoint). Stale here means the deployed sharing server is running packaging that no longer matches the entrypoint/Dockerfile on main — including its fail-closed bearer handling, which is the sole thing standing between a VNet-reachable port and every published share.',
    paths: [
      '.github/workflows/deploy-loom-sharing.yml',
      'apps/loom-sharing/**',
      'platform/fiab/bicep/modules/compute/loom-sharing-app.bicep',
    ],
    maxDays: 14,
  },
  // ── The estate reconcile ITSELF (refs #2775) ─────────────────────────────
  // Every entry above watches one app or job. This one watches the thing that
  // applies the TEMPLATE: deploy-fiab-commercial.yml is the only workflow that
  // runs `az deployment sub create -f platform/fiab/bicep/main.bicep`.
  // full-app-deploy-commercial.yml states in-line that it deliberately does not
  // run the bicep, and console-bluegreen-roll.yml only swaps `--image`. So when
  // this path stops applying, NOTHING is reconciling the estate against main --
  // every bicep change merged since then is inert, and the only visible symptom
  // is a nightly red X that looks identical to the previous night's.
  //
  // That is what happened: the workflow carries a daily `cron: '0 6 * * *'`, and
  // every scheduled run it has ever had failed inside the topology guard in
  // ~30-80s, because the guard tested `inputs.allow_existing_hub` -- an input
  // that does not exist on a schedule event. The last actual application of the
  // admin-plane template was 2026-07-23, and that deployment Failed.
  //
  // WHY 7 DAYS. The other entries are dispatch-only lanes where a couple of
  // weeks of lag is ordinary. This one is SCHEDULED DAILY: if the schedule is
  // working at all, a successful run exists every day and drift sits near zero.
  // 7 days is therefore not a tolerance for normal lag -- it is the assertion
  // that the daily reconcile is running. A week of drift means the cron is dead
  // again, which is precisely the condition that went unnoticed here.
  //
  // NOTE ON THE DRY-RUN FILTER: this workflow's `Provision (idempotent)` step is
  // gated `if: github.event_name == 'schedule' || inputs.run_mode == 'full'`, and
  // run_mode DEFAULTS to whatif-only. So a default dispatch succeeds having
  // applied nothing. Without a marker such a run would clear this entry while
  // deploying nothing -- the exact "green on nothing" shape this file exists to
  // catch. deploy-fiab-commercial.yml therefore sets a `run-name` carrying
  // DRY_RUN_MARKER on whatif-only dispatches, so only real applies count here.
  {
    workflow: 'deploy-fiab-commercial.yml',
    why: 'The ONLY workflow that applies platform/fiab/bicep/main.bicep to the Commercial estate — every env var, role grant and module the Console depends on reaches production through this path and no other. Stale here means main and the running estate have silently diverged: merged bicep is inert, and the daily cron that should be reconciling it is failing in a way that looks like yesterday.',
    paths: [
      '.github/workflows/deploy-fiab-commercial.yml',
      'platform/fiab/bicep/main.bicep',
      'platform/fiab/bicep/modules/admin-plane/**',
      'platform/fiab/bicep/params/commercial.bicepparam',
    ],
    maxDays: 7,
  },
];

/**
 * Marker a deploy workflow puts in its `run-name` when dispatched with
 * dry_run=true. A dry run resolves coordinates and touches nothing, so counting
 * one as a deploy would let this watchdog be silenced by a run that deployed
 * NOTHING — the precise "green on nothing" shape this file exists to catch.
 */
const DRY_RUN_MARKER = 'DRY RUN';

export const DAY_MS = 86_400_000;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Pick the newest run that actually DEPLOYED from `gh run list` JSON rows
 * (already filtered to `--status success`, newest first). PURE — no IO — so the
 * self-test can prove the dry-run filter without shelling gh.
 *
 * Runs whose display title carries the DRY_RUN_MARKER are SKIPPED. Those runs
 * succeed having deployed NOTHING; treating one as a deploy would let a dry run
 * clear the drift it did not fix — the exact "green on nothing" shape this file
 * exists to catch. A history of ONLY dry runs therefore returns { at: null }
 * (never ran for real), NOT the dry run's timestamp.
 *
 * @param {{createdAt?:string, displayTitle?:string}[]} rows
 * @returns {{at:string|null, dryRunsSkipped:number}}
 */
export function pickLastRealSuccess(rows) {
  const real = rows.filter((r) => !String(r.displayTitle || '').includes(DRY_RUN_MARKER));
  return { at: real[0]?.createdAt || null, dryRunsSkipped: rows.length - real.length };
}

/**
 * Newest SUCCESSFUL run that actually DEPLOYED.
 *   { at: ISO }           — ran successfully
 *   { at: null }          — query worked; the workflow has genuinely never run
 *   { queryFailed: true } — gh/auth/network broke; we do NOT know
 *
 * The third case is kept DISTINCT on purpose. Reporting a broken query as
 * "never run" would send someone chasing a deploy that already happened — and
 * the whole point of this check is that a control must not claim something it
 * did not actually measure. Both still fail (never silently green), but they
 * say different things.
 *
 * Runs whose display title carries the DRY_RUN_MARKER are SKIPPED. Those runs
 * succeed having deployed nothing; treating one as a deploy would let a dry run
 * clear the drift it did not fix. Hence `--limit 20` and a client-side filter
 * rather than `--limit 1` — the newest success may well be a dry run.
 */
function lastSuccessfulRun(workflow) {
  try {
    const out = gh([
      'run', 'list', '--workflow', workflow, '--status', 'success',
      '--limit', '20', '--json', 'createdAt,displayTitle', '--repo', REPO,
    ]);
    return pickLastRealSuccess(JSON.parse(out || '[]'));
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

/**
 * Classify one watched entry. PURE — the entire drift decision lives here so the
 * self-test drives every branch with fixtures. `run` is the shape
 * {@link lastSuccessfulRun} returns.
 *
 *   queryFailed  — gh/auth/network broke: we do NOT know → ALWAYS stale, never a
 *                  false green (the 2026-08-02 "UNKNOWN reported as fresh" trap).
 *   neverRan     — the workflow has genuinely never run for real → ALWAYS stale.
 *   otherwise    — stale iff code is newer than the last real run AND the drift
 *                  exceeds this entry's maxDays tolerance (ordinary lag is ok).
 *
 * `maxDays` is BOTH the fail threshold and the acknowledgment mechanism: raising
 * it for an entry (with a reason, in the WATCHED table) is how a known-pending
 * deploy is signed off — a deployment review, not a silent allowlist.
 *
 * @param {{codeAt:string, run:{at?:string|null, queryFailed?:boolean, error?:string, dryRunsSkipped?:number}, maxDays:number}} args
 */
export function classifyDrift({ codeAt, run, maxDays }) {
  const queryFailed = run.queryFailed === true;
  const runAt = run.at || null;
  const neverRan = !queryFailed && !runAt;
  const driftDays = (queryFailed || neverRan)
    ? Infinity
    : Math.max(0, Math.round((Date.parse(codeAt) - Date.parse(runAt)) / DAY_MS));
  const stale = queryFailed || neverRan
    || (Date.parse(codeAt) > Date.parse(runAt) && driftDays > maxDays);
  return { runAt, driftDays, neverRan, queryFailed, queryError: run.error, dryRunsSkipped: run.dryRunsSkipped || 0, stale };
}

/**
 * The exit decision over classified rows. PURE. Any stale row ⇒ exit 1.
 * @param {{stale:boolean}[]} rows
 * @returns {{stale:object[], code:number}}
 */
export function decide(rows) {
  const stale = rows.filter((r) => r.stale);
  return { stale, code: stale.length ? 1 : 0 };
}

/** Build the classified rows from the live IO (gh run-history + git log). */
function buildRows() {
  const rows = [];
  for (const entry of WATCHED) {
    const run = lastSuccessfulRun(entry.workflow);
    const codeAt = lastCodeChange(entry.paths);
    if (!codeAt) continue; // path removed from the tree — nothing to compare.
    rows.push({ ...entry, codeAt, ...classifyDrift({ codeAt, run, maxDays: entry.maxDays }) });
  }
  return rows;
}

function main() {
  const rows = buildRows();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  }

  console.log('[deploy-staleness] watched deploy paths:');
  for (const r of rows) {
    const when = r.queryFailed ? 'UNKNOWN (run-history query failed)'
      : r.neverRan ? 'NEVER RUN'
        : `last success ${r.runAt.slice(0, 10)}`;
    const drift = (r.queryFailed || r.neverRan) ? '' : `, code ${r.codeAt.slice(0, 10)} (+${r.driftDays}d)`;
    // Named, not silent: a dry run that was skipped is the difference between
    // "nobody dispatched this" and "somebody dispatched it and it deployed
    // nothing", and those need different responses.
    const dry = r.dryRunsSkipped ? `  [${r.dryRunsSkipped} dry run(s) ignored]` : '';
    console.log(`  ${r.stale ? 'STALE' : 'ok   '}  ${r.workflow.padEnd(38)} ${when}${drift}${dry}`);
  }

  const { stale, code } = decide(rows);
  if (stale.length === 0) {
    console.log('[deploy-staleness] OK — every watched deploy path has run since its code last changed.');
    return code;
  }

  console.error(`\n[deploy-staleness] FAIL — ${stale.length} deploy path(s) carry code that was never applied.\n`);
  for (const r of stale) {
    console.error(`  ${r.workflow}`);
    console.error(`    ${r.queryFailed ? `run history UNKNOWN — the gh query failed: ${r.queryError}` : r.neverRan ? `has NEVER run${r.dryRunsSkipped ? ` for real (${r.dryRunsSkipped} dry run(s) ignored — a dry run deploys nothing)` : ''}` : `${r.driftDays} days of undeployed code (limit ${r.maxDays})`}`);
    console.error(`    why it matters: ${r.why}`);
    console.error(`    dispatch: gh workflow run ${r.workflow} --ref main\n`);
  }
  console.error('  A merged fix is not a deployed fix. If the drift is intentional, raise maxDays');
  console.error('  for that entry WITH a reason — that is a deployment review, not a config tweak.\n');
  return code;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main());
}
