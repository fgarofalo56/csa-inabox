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
    // apps/loom-unity IS a deploy source of this workflow, not a bystander: the
    // `Build loom-unity image on the Gov ACR` step runs
    //   az acr build --file apps/loom-unity/Dockerfile apps/loom-unity
    // so the image the Gov catalog runs is built from that directory and reaches
    // production through this workflow and no other.
    //
    // It was MISSING here until #2775's follow-up, which is the sharpest possible
    // version of this bug: the watchdog written because a #2643 fix sat merged
    // and undeployed did not watch the directory the #2643 fix lives in. Commit
    // b4dcf1e4 (2026-08-04) changed apps/loom-unity for #2643/#2680 and could not
    // have registered as drift. check-deploy-paths-coverage.mjs now asserts this
    // list stays complete.
    paths: [
      '.github/workflows/gov-uc-purview-wire.yml',
      'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
      'apps/loom-unity/**',
    ],
    maxDays: 14,
  },
  {
    workflow: 'gov-workspace-identity.yml',
    why: 'The ONLY lane proving workspace-scoped managed identity against real Gov endpoints. Commercial lanes cannot prove it.',
    // This lane APPLIES nothing — it exercises a running Gov Console and records
    // a receipt — so check-deploy-paths-coverage.mjs finds no executable deploy
    // source in it. That is not the same as "nothing to watch".
    //
    // Its `Derive the expected grant matrix from workspace-grants.ts` step does
    //   const SRC = 'apps/fiab-console/lib/azure/workspace-grants.ts';
    //   fs.readFileSync(SRC, 'utf-8')  →  WORKSPACE_GRANTS
    // and then asserts every backend in that matrix was evaluated against live
    // Gov RBAC. So the file IS what this lane certifies: add a backend to
    // WORKSPACE_GRANTS and the last run certified a DIFFERENT matrix — the new
    // backend has never been proven in Gov, which is consequence #2 of #2775.
    // Listed by hand because a readFileSync-of-a-const is not a mechanically
    // detectable deploy shape.
    paths: [
      '.github/workflows/gov-workspace-identity.yml',
      'apps/fiab-console/lib/azure/workspace-grants.ts',
    ],
    maxDays: 30,
  },
  {
    workflow: 'csa-loom-post-deploy-bootstrap.yml',
    why: 'Applies every post-deploy grant + the day-one service wiring (Iceberg catalog, posture Function, Graph app-roles).',
    // This entry watched exactly ONE path — its own YAML — while the workflow
    // executes ~28 scripts/csa-loom/*.sh, applies two bicep templates and
    // publishes two Function-App codebases. Every one of those is a way the
    // estate diverges from main without this entry noticing.
    //
    // Named explicitly rather than as a bare `scripts/csa-loom/**` glob: that
    // directory holds ~90 scripts, most of which this workflow never runs, and a
    // glob would mark this entry stale on edits it does not deploy — cry-wolf,
    // which trains people to ignore the signal (the failure mode of this whole
    // class). check-deploy-paths-coverage.mjs keeps the list honest in the other
    // direction, failing if a NEW source is executed but not listed here.
    //
    // iceberg-catalog-aca.bicep is the #2757 Iceberg deploy #2775 names as never
    // having executed; it was invisible to this watchdog until now.
    paths: [
      '.github/workflows/csa-loom-post-deploy-bootstrap.yml',
      'platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep',
      'platform/fiab/grafana/**',
      'azure-functions/posture-refresh/**',
      'azure-functions/report-subscriptions/**',
      'scripts/csa-loom/bootstrap-msal-app-reg.sh',
      'scripts/csa-loom/bootstrap-weave-pg.sh',
      'scripts/csa-loom/dataverse-add-appuser.sh',
      'scripts/csa-loom/enable-all-diagnostics.sh',
      'scripts/csa-loom/enable-unity-catalog.sh',
      'scripts/csa-loom/ensure-ai-private-endpoints.sh',
      'scripts/csa-loom/ensure-search-index.sh',
      // #2929 — the bootstrap refreshes the `loom-docs` Copilot index through
      // this shared driver, so a change to it changes what the bootstrap does.
      'scripts/ci/reindex-loom-docs.sh',
      'scripts/csa-loom/ensure-vpn-dns-resolver.sh',
      'scripts/csa-loom/fix-synapse-spark-storage-access.sh',
      'scripts/csa-loom/grant-console-rbac.sh',
      'scripts/csa-loom/grant-identity-graph-approles.sh',
      'scripts/csa-loom/grant-purview-datamap-role.sh',
      'scripts/csa-loom/grant-purview-uc-role.sh',
      'scripts/csa-loom/grant-shortcut-graph-approles.sh',
      // #2681 — the bootstrap resolves the estate's Entra app registration
      // through this script when unsealing the DEFAULT-ON loom-unity catalog.
      'scripts/csa-loom/resolve-msal-client-id.sh',
      'scripts/csa-loom/grant-synapse-rbac-invnet-job.sh',
      'scripts/csa-loom/grant-uami-graph-roles.sh',
      'scripts/csa-loom/patch-navigator-env.sh',
      'scripts/csa-loom/provision-databricks-compute.sh',
      'scripts/csa-loom/provision-scc-labels-sidecar.sh',
      'scripts/csa-loom/run-spark-storage-fix-invnet-job.sh',
      'scripts/csa-loom/seed-governance.sh',
      'scripts/csa-loom/upsert-hub-dns-arecords.sh',
      'scripts/csa-loom/wire-spark-telemetry.sh',
    ],
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
      // refs #2958 — the image preflight this lane now runs before applying.
      // Both are genuine deploy sources: assert-acr-image-tags.sh decides
      // whether the apply proceeds at all, and resolve-image-preflight-refs.mjs
      // decides WHICH tags it proves. A change to either can flip this lane from
      // applying to refusing (or, worse, from refusing to applying), so a commit
      // that touches them without a subsequent successful run IS drift.
      'scripts/ci/assert-acr-image-tags.sh',
      'scripts/ci/resolve-image-preflight-refs.mjs',
      // #2681 — this lane now resolves the estate's existing Entra app
      // registration into LOOM_MSAL_CLIENT_ID before applying, because that id is
      // both the sign-in client AND the audience admin-plane/main.bicep pins on
      // the DEFAULT-ON loom-unity catalog. If this script starts returning
      // nothing, the apply blanks sign-in and RE-SEALS a working catalog — so a
      // commit touching it without a subsequent successful run is drift.
      'scripts/csa-loom/resolve-msal-client-id.sh',
    ],
    maxDays: 7,
  },
  // ── The APP-IMAGE path (the second silently-broken lane) ─────────────────
  // no-vaporware.md names the canonical from-scratch Commercial path as THREE
  // phases: (1) `az deployment sub create` with deployAppsEnabled=false, (2)
  // full-app-deploy-commercial.yml to build every app image and roll the
  // Container Apps onto them, (3) the post-deploy bootstrap. Phase 1 is the
  // deploy-fiab-commercial entry above. Phase 2 was watched by NOTHING.
  //
  // Its state on 2026-08-05, which no signal anywhere surfaced: last success
  // 2026-06-19, then SIX consecutive failures (2026-07-16, 07-20, 07-28 ×2,
  // 07-31 ×2) plus a startup_failure. Six weeks of a red from-scratch app path,
  // invisible. It is also the ONLY producer of five images —
  // loom-wrangler-host, loom-dbt-runner, loom-transform-runner, loom-duckdb and
  // loom-uat — because build-fiab-images-acr-tasks.yml's `all` matrix carries
  // eleven apps and not those. loom-duckdb:v0.1 is absent from the Commercial
  // ACR today for exactly that reason, which in turn blocks the phase-1 image
  // preflight: the two lanes deadlock, and neither said so.
  //
  // WHY THESE PATHS. Deliberately NOT `apps/**`: the eleven images in the
  // push-triggered builder are rebuilt on every merge, so listing them here
  // would mark this entry stale on changes another lane already deployed —
  // cry-wolf, which trains people to ignore the signal (the failure mode of
  // this whole class). Listed instead are exactly the sources this lane and no
  // other applies: the five orphan image contexts (minus loom-uat, already
  // covered by its own deploy-loom-uat entry), the corpus-staging script that
  // bakes the Copilot RAG index INTO the console image, and main.bicep — which
  // this workflow compiles and PUBLISHES as main.json to the admin storage
  // account, wiring LOOM_DLZ_TEMPLATE_URI. A stale published main.json is the
  // day-one "Add landing zone" deploy running a template that is not main.
  {
    workflow: 'full-app-deploy-commercial.yml',
    why: 'Phase 2 of the documented from-scratch Commercial path — the ONLY lane that builds every app image and rolls the Container Apps onto them, and the ONLY producer of loom-wrangler-host / loom-dbt-runner / loom-transform-runner / loom-duckdb / loom-uat. It is also the Commercial half of the #2682 upstream-image mirror. Stale or failing here means a from-scratch deploy CANNOT complete, and the images those five apps run — plus every mirrored third-party image — are whatever was last pushed, with no signal anywhere that the path is red.',
    paths: [
      '.github/workflows/full-app-deploy-commercial.yml',
      'scripts/csa-loom/stage-copilot-corpus.sh',
      'platform/fiab/bicep/main.bicep',
      // refs #2958/#3001 — this lane now runs the same ACR image preflight the
      // phase-1 reconcile does, so the script that decides whether the deploy
      // proceeds is a deploy source of THIS lane too. check-deploy-paths-coverage
      // caught its absence the moment #3001 landed underneath this entry.
      'scripts/ci/assert-acr-image-tags.sh',
      // refs #2682 — the upstream-image ACR mirror. BOTH halves are deploy
      // sources of this lane and BOTH must be watched:
      //   * the SCRIPT is what the workflow executes (check-deploy-paths-coverage
      //     detects this one mechanically, and did — it flagged the gap the
      //     moment the mirror moved out of the inline bash array);
      //   * the MANIFEST is the data that decides WHAT lands in the ACR. A digest
      //     or tag bump there changes the deployed bits without touching a single
      //     line of executable code, so it is invisible to mechanical detection
      //     and has to be listed by hand. Omitting it would let a mirror bump sit
      //     undeployed while this entry read green — the exact "cannot ever
      //     register as drift" hole this file exists to close.
      'scripts/ci/mirror-upstream-images.sh',
      'platform/fiab/images/upstream-images.json',
      'apps/fiab-wrangler-host/**',
      'apps/fiab-dbt-runner/**',
      'apps/loom-transform-runner/**',
      'apps/loom-duckdb/**',
    ],
    maxDays: 21,
  },
];

/**
 * Live estates whose RUNNING build this check compares against main.
 *
 * WHY THIS EXISTS (the operator, 2026-08-05): "nothing surfaces 'the estate is
 * N commits behind'". Every entry in WATCHED above compares a workflow's RUN
 * HISTORY against GIT — it never looks at what is actually serving traffic. So
 * a lane could be green while the estate ran a six-week-old image, and the two
 * facts never met.
 *
 * `/build-marker.txt` is the console's own build fingerprint, written by the
 * Dockerfile from the LOOM_BUILD_SHA build-arg and served from Next's public/
 * dir. loom-roll-and-validate already probes it, so it is a load-bearing,
 * deliberately-unauthenticated artifact — which is what makes this check
 * possible with no credentials, no `az`, and no Azure login on the lane.
 *
 * GOV IS NOT LISTED, AND THAT IS REPORTED, NOT SILENT. The Gov console has no
 * publicly-reachable marker (private ingress), so this check cannot see it.
 * main() prints that omission explicitly: an estate we cannot measure must
 * never read as an estate that is current — the "UNKNOWN reported as a result"
 * trap this repo has been burned by three times.
 */
export const ESTATES = [
  {
    name: 'Commercial',
    markerUrl: process.env.LOOM_ESTATE_MARKER_URL
      || 'https://csa-loom.limitlessdata.ai/build-marker.txt',
    // THERE IS NO COMMIT-COUNT TOLERANCE, and the first cut of this entry having
    // one is the point. It shipped `maxCommitsBehind: 20` while the live estate
    // was 13 behind — so the control written because "nothing surfaces 'the
    // estate is N commits behind'" classified the actual estate `ok`, and the
    // exit-1 came entirely from the WATCHED rows. A signal that cannot fire on
    // the condition it was written for is not a signal. A 20-commit band also
    // lets an estate sit two thirds of the way to a fortnight's divergence and
    // read green — the exact state that went unnoticed for two weeks. Per the
    // deploy-integrity rule (#3004, R3), drift is a defect with an owner,
    // not a tolerance band.
    //
    // BEHIND AT ALL IS THE CONDITION. The only tolerance is a small TIME window
    // for a roll that is legitimately in flight, measured against the OLDEST
    // commit the estate is missing — "how long has merged code been undeployed"
    // — never against a count.
    //
    // WHY NOT "AGE OF THE RUNNING BUILD": a healthy estate that rolled three
    // hours ago and takes a merge one minute ago is behind by 1 with a
    // three-hour-old build. Grading on build age would fire on every merge into
    // a healthy estate; grading on the missing commit's age says "one minute"
    // and correctly waits.
    //
    // WHY 90 MINUTES — measured from this repo's own merge→estate cycle on
    // 2026-08-05: build-fiab-images-acr-tasks successes ran 7–38 min,
    // loom-roll-and-validate successes 8–18 min ⇒ ~56 min observed worst case.
    // 90 is ~1.6× headroom and nothing more.
    behindGraceMinutes: 90,
    // Independent second bound, kept from the first cut: an image older than
    // this means the image-build lane has produced nothing for a week, which is
    // a dead roll path even on a quiet branch where commitsBehind stays low.
    maxAgeDays: 7,
  },
];

/**
 * Marker a deploy workflow puts in its `run-name` when dispatched with
 * dry_run=true. A dry run resolves coordinates and touches nothing, so counting
 * one as a deploy would let this watchdog be silenced by a run that deployed
 * NOTHING — the precise "green on nothing" shape this file exists to catch.
 */
const DRY_RUN_MARKER = 'DRY RUN';

/**
 * Consecutive completed failures that make a deploy path "failing".
 *
 * WHY A STREAK AND NOT ONE. A single red run is ordinary (a transient ACR agent
 * hiccup, a lease collision). Three in a row is a broken path, not weather.
 *
 * WHY THIS IS SEPARATE FROM DRIFT AT ALL. classifyDrift only ever asked "when
 * did this last SUCCEED?", so a lane that succeeded yesterday and has failed on
 * every run since reads `ok` — the last-success timestamp is recent and nothing
 * looks at the failures. That is precisely how full-app-deploy-commercial went
 * six weeks and deploy-fiab-commercial eight consecutive nights unnoticed.
 */
export const FAILING_STREAK = 3;

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

// ── "has this deploy path been FAILING?" ────────────────────────────────────
// classifyDrift asks only "when did this last succeed?". A lane that succeeded
// recently and has failed on every run since therefore reads `ok`. These two
// pure functions close that blind spot.

/**
 * Consecutive completed FAILURES at the head of a run history. PURE.
 *
 * `rows` are `gh run list` rows, newest first, UNFILTERED by status.
 *
 * WHAT COUNTS. Only a COMPLETED run with conclusion `failure` / `timed_out` /
 * `startup_failure` extends the streak; a `success` ends it. `cancelled`,
 * `skipped`, `action_required`, `neutral` and any still-running row (conclusion
 * null) are SKIPPED — they are not evidence either way, and counting an
 * in-flight run as a failure is the mirror of the 2026-08-02 trap where an
 * in-progress check was read as "not found". Skipping, rather than terminating
 * the streak, is deliberate: a cancelled run in the middle of six failures does
 * not make the path healthy.
 *
 * `queryFailed` is NOT modelled here — an unknown history cannot show a streak,
 * and classifyDrift already fails that case loudly. Inventing a streak from a
 * broken query would be an UNKNOWN reported as a NEGATIVE.
 *
 * @param {{conclusion?:string|null}[]} rows newest-first run rows
 * @param {number} threshold consecutive failures that mean "failing"
 * @returns {{failureStreak:number, lastConclusion:string|null, failing:boolean}}
 */
export function classifyRunHealth(rows, threshold = FAILING_STREAK) {
  const FAIL = new Set(['failure', 'timed_out', 'startup_failure']);
  let streak = 0;
  let lastConclusion = null;
  for (const r of rows || []) {
    const c = r?.conclusion || null;
    if (c === 'success') { lastConclusion ??= c; break; }
    if (!FAIL.has(c)) continue; // cancelled / skipped / in-flight → no evidence
    lastConclusion ??= c;
    streak += 1;
  }
  return { failureStreak: streak, lastConclusion, failing: streak >= threshold };
}

/**
 * Is a watched deploy workflow switched OFF? PURE.
 *
 * WHY THIS MATTERS SEPARATELY FROM DRIFT. deploy-fiab-commercial.yml — the ONLY
 * lane that applies main.bicep to the Commercial estate — is
 * `disabled_manually` today. Its daily cron therefore cannot fire at all, so it
 * will accrue drift forever and the drift row alone reads like ordinary lag.
 * "The reconcile is switched off" is a different fact with a different fix, and
 * it has to be said out loud.
 *
 * `state === undefined` means the workflow was not in the listing we fetched.
 * That is UNKNOWN, not active: `gh workflow list` defaults to 50 rows and this
 * repo has 117 workflows, so a truncated page silently omitted
 * full-app-deploy-commercial.yml when this was first written. Reporting that
 * omission as "active" would be a false green produced by pagination — the
 * per_page truncation trap, again.
 *
 * @param {string|undefined} state gh workflow `state` field
 * @returns {{state:string, disabled:boolean, unknown:boolean}}
 */
export function classifyWorkflowState(state) {
  if (state === undefined || state === null || state === '') {
    return { state: 'unknown', disabled: false, unknown: true };
  }
  return { state, disabled: state !== 'active', unknown: false };
}

// ── "is the LIVE estate behind main?" ───────────────────────────────────────

/**
 * Estate-drift verdict for one live deployment. PURE.
 *
 * Inputs are already-measured facts: the sha the estate reports serving, how
 * many commits main is ahead of it, how old that build's commit is, and how long
 * the OLDEST commit it is missing has been waiting.
 *
 *   error / liveSha null / commitsBehind null  → UNKNOWN, and UNKNOWN IS STALE.
 *       We could not measure the estate, so we must not report it current. This
 *       repo has been burned three separate times by an unmeasured thing
 *       rendering as a negative result; the fix is always the same — give the
 *       unknown its own state and let it fail.
 *   commitsBehind === 0                        → current (stale only if the
 *       running image is older than maxAgeDays, i.e. nothing has built in a
 *       week — a dead build lane a quiet branch would otherwise hide).
 *   behind, oldest missing commit within the
 *       grace                                  → behind but tolerated (ok).
 *   behind, past the grace                     → STALE.
 *   behind, grace UNMEASURABLE                 → STALE. An unmeasured wait is
 *       not a short wait; the allowance exists for a roll that is demonstrably
 *       in flight, and with no date there is nothing demonstrating it.
 *
 * THERE IS NO COMMIT-COUNT THRESHOLD — see the ESTATES entry for why the
 * 20-commit band was removed (it classified a 13-behind live estate as `ok`,
 * i.e. it could not fire on the condition this control exists for).
 *
 * `ancestor:false` is called out separately: a live sha that is not an ancestor
 * of main is not "behind", it is a DIVERGENT build (a force-push, a revert, or
 * an image built off a branch). Reporting a commit distance for it would be
 * arithmetic on two unrelated histories.
 *
 * @param {{name:string, liveSha?:string|null, commitsBehind?:number|null,
 *          ageDays?:number|null, ancestor?:boolean, error?:string|null,
 *          behindSince?:string|null, behindForMinutes?:number|null,
 *          behindGraceMinutes:number, maxAgeDays:number}} a
 */
export function classifyEstate({
  name, liveSha, commitsBehind, ageDays, ancestor, error,
  behindSince, behindForMinutes,
  behindGraceMinutes, maxAgeDays,
}) {
  if (error || !liveSha) {
    return {
      name, state: 'unknown', stale: true, liveSha: liveSha || null,
      commitsBehind: null, ageDays: null, behindSince: null, behindForMinutes: null,
      detail: `could not measure the live estate — ${error || 'no build sha in the marker'}`,
    };
  }
  if (ancestor === false) {
    return {
      name, state: 'divergent', stale: true, liveSha, commitsBehind: null, ageDays: ageDays ?? null,
      behindSince: null, behindForMinutes: null,
      detail: `the running build ${liveSha.slice(0, 8)} is NOT an ancestor of main — it was built from a branch, a revert, or a force-pushed history`,
    };
  }
  if (commitsBehind === null || commitsBehind === undefined) {
    return {
      name, state: 'unknown', stale: true, liveSha, commitsBehind: null, ageDays: ageDays ?? null,
      behindSince: null, behindForMinutes: null,
      detail: `the running build ${liveSha.slice(0, 8)} is not in this checkout — the commit distance to main could not be computed`,
    };
  }

  const overAge = (ageDays ?? 0) > maxAgeDays;
  const shell = {
    name, liveSha, commitsBehind, ageDays: ageDays ?? null,
    behindSince: behindSince ?? null, behindForMinutes: behindForMinutes ?? null,
  };

  if (commitsBehind === 0) {
    return {
      ...shell,
      state: 'current',
      stale: overAge,
      detail: overAge
        ? `on main, but the running image is ${ageDays}d old (limit ${maxAgeDays}d) — nothing has built for a week`
        : `on main (0 commits behind), build ${ageDays ?? '?'}d old`,
    };
  }

  // Behind at all. The ONLY thing that can tolerate it is a demonstrably
  // in-flight roll, and that has to be demonstrated with a timestamp.
  if (behindForMinutes === null || behindForMinutes === undefined) {
    return {
      ...shell,
      state: 'behind',
      stale: true,
      detail: `${commitsBehind} commit(s) behind main, and HOW LONG they have been waiting could not be measured `
        + `— the ${behindGraceMinutes}min roll-in-flight allowance cannot apply. Unmeasured is not "recent"`,
    };
  }
  const pastGrace = behindForMinutes > behindGraceMinutes;
  return {
    ...shell,
    state: 'behind',
    stale: pastGrace || overAge,
    detail: pastGrace
      ? `${commitsBehind} commit(s) behind main, oldest unapplied for ${behindForMinutes}min (allowance ${behindGraceMinutes}min) `
        + '— longer than a build and roll take, so the roll path has stopped applying main to this estate'
      : overAge
        ? `${commitsBehind} commit(s) behind main and the running image is ${ageDays}d old (limit ${maxAgeDays}d)`
        : `${commitsBehind} commit(s) behind main, oldest unapplied only ${behindForMinutes}min ago — a roll is plausibly in flight`,
  };
}

/** Recent runs of `workflow`, ANY conclusion, newest first. */
function recentRuns(workflow) {
  try {
    const out = gh([
      'run', 'list', '--workflow', workflow, '--limit', '30',
      '--json', 'conclusion,status,createdAt', '--repo', REPO,
    ]);
    return { rows: JSON.parse(out || '[]') };
  } catch (e) {
    return { rows: [], queryFailed: true, error: String(e?.stderr || e?.message || e).slice(0, 160) };
  }
}

/**
 * path → state for every workflow in the repo.
 *
 * `--limit 300` is load-bearing, not padding: the default is 50 and this repo
 * has 117 workflows, so the default silently omitted the lane this check was
 * extended to cover. An omitted workflow becomes UNKNOWN downstream, never
 * "active".
 */
function workflowStates() {
  try {
    const out = gh(['workflow', 'list', '--all', '--limit', '300', '--json', 'path,state', '--repo', REPO]);
    const map = new Map();
    for (const w of JSON.parse(out || '[]')) map.set(String(w.path || '').split('/').pop(), w.state);
    return map;
  } catch {
    return new Map(); // every lookup → undefined → UNKNOWN, which fails loudly
  }
}

/**
 * Measure one live estate: fetch its /build-marker.txt, then ask GIT how far
 * main is ahead of the sha it reports AND how long the oldest commit it is
 * missing has been waiting.
 *
 * No credentials, no `az`, no Azure login. The marker is served unauthenticated
 * because loom-roll-and-validate already probes it.
 */
async function probeEstate(estate) {
  let liveSha = null;
  try {
    const res = await fetch(estate.markerUrl, { redirect: 'follow' });
    if (!res.ok) {
      return classifyEstate({ ...estate, error: `marker fetch HTTP ${res.status}` });
    }
    const txt = await res.text();
    liveSha = txt.match(/sha=([0-9a-f]{7,40})/i)?.[1] || null;
    if (!liveSha) return classifyEstate({ ...estate, error: 'marker carried no sha= field' });
  } catch (e) {
    return classifyEstate({ ...estate, error: `marker unreachable — ${String(e?.message || e).slice(0, 120)}` });
  }

  const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  let ancestor;
  let commitsBehind = null;
  let ageDays = null;
  let behindSince = null;
  let behindForMinutes = null;
  try {
    git(['cat-file', '-e', `${liveSha}^{commit}`]);
    ancestor = (() => {
      try { git(['merge-base', '--is-ancestor', liveSha, 'HEAD']); return true; } catch { return false; }
    })();
    if (ancestor) {
      commitsBehind = Number(git(['rev-list', '--count', `${liveSha}..HEAD`]));
      if (commitsBehind > 0) {
        // The OLDEST unapplied commit's date — "how long has merged code been
        // sitting undeployed". Reduced rather than indexed so it does not depend
        // on git's output ordering, and reduced rather than Math.min(...spread)
        // so a badly-behind estate cannot blow the argument limit.
        const oldest = git(['log', '--format=%cI', `${liveSha}..HEAD`])
          .split('\n')
          .map((s) => Date.parse(s.trim()))
          .reduce((min, t) => (Number.isFinite(t) && t < min ? t : min), Number.POSITIVE_INFINITY);
        if (Number.isFinite(oldest)) {
          behindSince = new Date(oldest).toISOString();
          behindForMinutes = Math.max(0, Math.round((Date.now() - oldest) / 60_000));
        }
        // A null behindForMinutes here is left null on purpose: classifyEstate
        // treats an unmeasurable wait as stale, never as a fresh one.
      }
    }
    ageDays = Math.max(0, Math.round((Date.now() - Date.parse(git(['log', '-1', '--format=%cI', liveSha]))) / DAY_MS));
  } catch {
    // The sha is not in this checkout (shallow clone, or a build off a deleted
    // branch). UNKNOWN — classifyEstate turns that into a loud stale, not a green.
    return classifyEstate({ ...estate, liveSha, commitsBehind: null, ageDays: null });
  }
  return classifyEstate({ ...estate, liveSha, commitsBehind, ageDays, ancestor, behindSince, behindForMinutes });
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
 *
 * `stale` is the union of ALL the ways a deploy path can be broken, not just
 * undeployed-code drift: a lane whose recent runs are a failure streak, a lane
 * that has been switched off, and an estate running a build too far behind main
 * are each set stale by their own classifier before they reach here. One exit
 * decision over every signal means no signal can be added and then forgotten to
 * be wired into the exit code — a control that computes a verdict and discards
 * it is the "gate that cannot fail" shape.
 *
 * @param {{stale:boolean}[]} rows
 * @returns {{stale:object[], code:number}}
 */
export function decide(rows) {
  const stale = rows.filter((r) => r.stale);
  return { stale, code: stale.length ? 1 : 0 };
}

/** Build the classified rows from the live IO (gh run-history + git log). */
function buildRows() {
  const states = workflowStates();
  const rows = [];
  for (const entry of WATCHED) {
    const run = lastSuccessfulRun(entry.workflow);
    const codeAt = lastCodeChange(entry.paths);
    if (!codeAt) continue; // path removed from the tree — nothing to compare.
    const drift = classifyDrift({ codeAt, run, maxDays: entry.maxDays });
    const history = recentRuns(entry.workflow);
    const health = classifyRunHealth(history.rows, entry.maxFailureStreak || FAILING_STREAK);
    const wf = classifyWorkflowState(states.get(entry.workflow));
    rows.push({
      ...entry,
      codeAt,
      ...drift,
      ...health,
      workflowState: wf.state,
      disabled: wf.disabled,
      stateUnknown: wf.unknown,
      // Any ONE of the three is enough to fail. Drift already had teeth; the
      // other two are what six weeks of red full-app-deploy-commercial and
      // eight consecutive red nightly reconciles needed and did not have.
      stale: drift.stale || health.failing || wf.disabled || wf.unknown,
    });
  }
  return rows;
}

/** One line per row, for both the ok and the fail report. */
function describeRow(r) {
  const when = r.queryFailed ? 'UNKNOWN (run-history query failed)'
    : r.neverRan ? 'NEVER RUN'
      : `last success ${r.runAt.slice(0, 10)}`;
  const drift = (r.queryFailed || r.neverRan) ? '' : `, code ${r.codeAt.slice(0, 10)} (+${r.driftDays}d)`;
  // Named, not silent: a dry run that was skipped is the difference between
  // "nobody dispatched this" and "somebody dispatched it and it deployed
  // nothing", and those need different responses.
  const dry = r.dryRunsSkipped ? `  [${r.dryRunsSkipped} dry run(s) ignored]` : '';
  const fail = r.failureStreak ? `  [${r.failureStreak} consecutive FAILURE(s) since]` : '';
  const off = r.stateUnknown ? '  [workflow state UNKNOWN]' : r.disabled ? `  [workflow ${r.workflowState}]` : '';
  return `${when}${drift}${dry}${fail}${off}`;
}

/** Everything wrong with one row, as operator-readable lines. */
function reasonsFor(r) {
  const out = [];
  if (r.queryFailed) out.push(`run history UNKNOWN — the gh query failed: ${r.queryError}`);
  else if (r.neverRan) out.push(`has NEVER run${r.dryRunsSkipped ? ` for real (${r.dryRunsSkipped} dry run(s) ignored — a dry run deploys nothing)` : ''}`);
  else if (r.stale && r.driftDays > r.maxDays) out.push(`${r.driftDays} days of undeployed code (limit ${r.maxDays})`);
  if (r.failing) out.push(`THE DEPLOY PATH IS FAILING — ${r.failureStreak} consecutive failed run(s), newest conclusion "${r.lastConclusion}". A recent last-success does NOT mean this path works.`);
  if (r.disabled) out.push(`THE WORKFLOW IS SWITCHED OFF (state "${r.workflowState}") — it cannot run on its schedule or on dispatch until re-enabled: gh workflow enable ${r.workflow}`);
  if (r.stateUnknown) out.push('workflow state UNKNOWN — it was not in the `gh workflow list` page we read, so we cannot say whether it is enabled. Not the same as active.');
  return out;
}

async function main() {
  const rows = buildRows();
  const estates = [];
  for (const e of ESTATES) estates.push(await probeEstate(e));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows, estates }, null, 2));
  }

  // ── the LIVE estate, first: it is the fact the operator was missing ───────
  console.log('[deploy-staleness] live estate vs main:');
  for (const e of estates) {
    // The verdict word is STALE/ok, not BEHIND/ok: an estate can be exactly on
    // main and still stale (nothing has built for a week), and one that is
    // behind by a few minutes is not. Printing the classifier's own state next
    // to it keeps the two facts from being conflated.
    const verdict = e.stale ? 'STALE' : 'ok   ';
    console.log(`  ${verdict}  ${e.name.padEnd(12)} ${e.liveSha ? e.liveSha.slice(0, 8) : '????????'}  [${e.state}] ${e.detail}`);
  }
  // An estate we cannot see must never read as an estate that is current.
  console.log('  note: Azure Government is NOT measured here — its console has no publicly');
  console.log('        reachable /build-marker.txt. Its drift is UNKNOWN, not zero.');

  console.log('[deploy-staleness] watched deploy paths:');
  for (const r of rows) {
    console.log(`  ${r.stale ? 'STALE' : 'ok   '}  ${r.workflow.padEnd(38)} ${describeRow(r)}`);
  }

  const { stale, code } = decide(rows);
  const badEstates = estates.filter((e) => e.stale);
  if (stale.length === 0 && badEstates.length === 0) {
    console.log('[deploy-staleness] OK — every watched deploy path has run since its code last');
    console.log('  changed, none is failing or disabled, and every measured estate is current.');
    return 0;
  }

  if (badEstates.length) {
    console.error(`\n[deploy-staleness] FAIL — ${badEstates.length} live estate(s) are not running main.\n`);
    for (const e of badEstates) {
      console.error(`  ${e.name} — ${e.detail}`);
      console.error(`    running: ${e.liveSha ? e.liveSha.slice(0, 12) : 'unknown'}   marker: ${ESTATES.find((x) => x.name === e.name)?.markerUrl}`);
      console.error('    roll it: gh workflow run loom-roll-and-validate.yml --ref main\n');
    }
  }

  if (stale.length) {
    console.error(`\n[deploy-staleness] FAIL — ${stale.length} deploy path(s) are stale, failing or disabled.\n`);
    for (const r of stale) {
      console.error(`  ${r.workflow}`);
      for (const reason of reasonsFor(r)) console.error(`    ${reason}`);
      console.error(`    why it matters: ${r.why}`);
      console.error(`    dispatch: gh workflow run ${r.workflow} --ref main\n`);
    }
    console.error('  A merged fix is not a deployed fix. If the drift is intentional, raise maxDays');
    console.error('  for that entry WITH a reason — that is a deployment review, not a config tweak.');
    console.error('  A FAILING or DISABLED path is never signed off that way: fix or re-enable it.\n');
  }
  return code || 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((c) => process.exit(c));
}
