# L0 — Deploy & Estate Trust

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 0 · **BLOCKING — Wave 1 does not start until this lane is green**
**Rigor:** FULL mutation-proof (deploy path)
**Suggested concurrency:** up to **4** agents in this lane simultaneously.
**Inventory:** **62 open issues** (27 bugs, 2 epics, 0 labelled security).

## 1. Thesis

A repo that cannot deploy is a repo whose merges do not exist. Nothing else in this program is trustworthy while a deploy path is red.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `platform/fiab/bicep/**`
- `.github/workflows/*deploy*`
- `.github/workflows/gov-*`
- `.github/workflows/*roll*`
- `.github/workflows/*build*`
- `scripts/ci/*deploy*`
- `scripts/ci/*estate*`
- `scripts/ci/ensure-*`
- `scripts/ci/resolve-*`
- `deploy/**`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `apps/fiab-console/** (any lane L1/L3/L4/L5)`
- `scripts/ci/check-tid-* (L1)`
- `dev-loop/gates/** (L2)`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `actionlint -shellcheck= -pyflakes= <changed workflows>`
- `node --check on any embedded heredoc script`
- `make validate-bicep`
- `a GitHub Actions receipt per boundary — Commercial AND Gov, never local az for Gov`

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- `gh run view --log-failed` returns post-job CLEANUP for some runs, not the error. Pull the full log and grep the step.
- In a full log, `::error::` lines prefixed with ESC[36;1m are the shell ECHOING script source, not emitted errors. Only unprefixed lines are real.
- A preflight must precede the first step that READS a resource, not the first that WRITES it — that is exactly how #3449 stayed broken for **9** consecutive runs (**not 6** — re-measured 2026-08-22). Its ordering fix is **PR #3880, merged 2026-08-22T20:06:18Z**; #3888 (merged 2026-08-23T03:21:31Z) carried the same preflight onto the remaining lanes. **Both are merged, NOT deployed** — #3449 stays open until a Gov Actions run proves it on an estate (`deploy-integrity.md` R2). Do not restate this as "fixed".
- **Before acting on any count or lane-state in this document, read `triage/WAVE0-verdicts-2026-08-22.md`.** The Wave 0 triage pass re-measured this lane and corrected several claims here, including the one immediately above (§1), the deploy-lane health table (§2), and the IL5 ADX-preflight recommendation it later withdrew (§7 item 3). It also records **7 stale** and **1 already-fixed** issue in L0's 62 (§3).
- The compiled ARM template is a SECOND artifact: main.bicep is inert until main.json is rebuilt.
- Gov evidence comes only from Actions runs. Local `az` is a different tenant.

## 5. Fan-out plan

1. **Triage pass first (1 agent, sp:1).** Walk the inventory in §7 and split it into
   `real` / `stale` / `duplicate` / `already-fixed`. Verify "already-fixed" by measurement
   — several issues in this repo claim a current failure that is no longer true, and
   several claim a fix that never deployed. Record the verdict as an issue comment.
2. **Batch the survivors by shared file.** Two items touching the same file become ONE
   work item, or they run sequentially. This is the step that prevents the merge
   treadmill, and it is where most of the wall-clock is won or lost.
3. **Fan out to 4 concurrent agents**, each in its own worktree, each owning a
   disjoint file set from step 2.
4. **Serialize the merges.** Branch protection is `strict`, so every merge invalidates
   the branches behind it. Merge one, re-verify, merge the next. Prefer batching several
   fixes per PR over one PR per issue: with strict protection, N PRs cost N CI cycles.

## 6. Definition of done for this lane

- Every §7 issue is closed, or re-scoped with its reason recorded, or explicitly deferred
  by the operator.
- Every closure is on DEPLOYED-and-verified evidence, never on a merge.
- No guard introduced by this lane passes when its subject is mutated.
- The lane's own landmine list in §4 has been extended with anything new it learned.

## 7. Issue inventory (62)

| # | title | labels |
|---|---|---|
| #3857 | Copilot eval gate fails a PR on an estate measurement it explicitly disclaims, and the help surface is below f |  |
| #3846 | copilot-quality-evals gate: red on every PR head, and eval-floors.json marks unmeasured floors as provisional: |  |
| #3844 | Gov's continuous-deploy roll silently reverts and files nothing; IL5's failure notification is inert (unset re | csa-loom |
| #3839 | postgres-weave.bicep claims its ordering 'guarantees' the server is Ready — run 32341450273 disproves it |  |
| #3822 | reconcile-policy.mjs asserts a 4m45s measurement the run's own record contradicts (real: 1s job-vs-run) | bug,deploy-validation |
| #3809 | setup-routes.test.ts sends a real ARM deployment PUT to management.azure.com, and its verdict is decided by ne | bug,lane:ci |
| #3798 | The #3676 gate equates 'newest revision' with 'what is serving' — a weight-0 roll would read as a false green | bug |
| #3788 | cloud-parity: Weave ontology graph store has no Azure Government implementation — GCC-High/IL5 honest-gate wit | lane:bicep,sprint:next |
| #3787 | check-deploy-paths-coverage is structurally blind to 'node <path>.mjs' — 24 deploy-critical scripts pass vacuo | lane:ci,sprint:next |
| #3786 | deploy-fiab-commercial carries the same latent stopped-ADX and DNS-immutability exposure that broke GCC-High f | lane:ci,sprint:next |
| #3765 | Real-Time dashboards: event-driven refresh (Loom Live Push service) — Fabric 2026 parity, exceeds via estate-w | csa-feature-request,csa-loom,enhancement,lane:dataplane,spri |
| #3754 | P0(cloud-parity): only Commercial has a working infra-deploy path — GCC disabled, GCC-High failing 8 consecuti | lane:ci,sprint:active |
| #3744 | auto-bind §5: svc-databricks-sql and svc-eh-schema-registry are BLOCKED live on 'Set LOOM_X' with no tracking  | lane:bicep,sprint:next |
| #3716 | ci: the new ARM self-reference guard misses the SAME P0 written through a bicep var — measured, and it is the  | bug,deploy-validation,lane:ci,sprint:active |
| #3704 | ci: the two scripts that decide REGION and deploy_apps_enabled hardcode 'az', so the deploy's most consequenti | bug,lane:ci,sprint:next |
| #3695 | eventstream provisioner returns 'created' regardless of whether persistBackendRefs succeeded (and its justifyi | bug,lane:console,sprint:blocked |
| #3683 | GCC-High and IL5 carry BOTH halves of #3676 unmitigated — no re-pin, no estate gate, same lease erasure (cloud | bug,csa-loom,lane:bicep,sprint:active |
| #3682 | /admin/readiness cannot say 'the estate is BEHIND the last successful roll' — only 'behind main' (#3676 residu | bug,csa-loom,lane:console,sprint:next |
| #3633 | Live estate: data-agent grounding 2.00 below its 3.00 floor, and a dead report judge would have published as a | lane:console,sprint:next |
| #3577 | fix(deploy): the Gov DMLZ path deploys a NEW Purview unconditionally, so it fails in any tenant that already h | lane:bicep,sprint:active |
| #3573 | stream-analytics-job: new item never gets its backing ASA job auto-provisioned — persistent 404, misleading 'n | bug,lane:console,sprint:next |
| #3543 | auto-bind: Evaluation editor's 'New evaluation' form requires freeform Dataset ID + Model deployment text | lane:console,sprint:next |
| #3521 | lakebase 'provision a new server' form uses raw text for resource group + location, and doesn't seed the serve | bug,csa-loom,lane:console,sprint:next |
| #3519 | kql-database data-connection wizard requires typing a cluster ARM id / URI by hand for cross-cluster follow/le | bug,csa-loom,lane:console,sprint:next |
| #3518 | AI Foundry hub 'New connection' dialog requires typing an endpoint URL for Loom-native categories the platform | bug,csa-loom,lane:console,sprint:next |
| #3515 | event-grid-topic editor requires typing full ARM resource IDs by hand to wire an event subscription | bug,csa-loom,lane:console,sprint:next |
| #3510 | prompt-flow provisioner tells the customer to create the AI Foundry project by hand — createProject() already  | bug,csa-loom,lane:dataplane,sprint:next |
| #3509 | mirrored-databricks provisioner gates on missing Unity Catalog privileges instead of self-granting them (exist | bug,csa-loom,lane:dataplane,sprint:next |
| #3508 | evaluation item ignores the already-wired AOAI deployment fallback chain, gates install on an env var no bicep | bug,csa-loom,lane:dataplane,sprint:next |
| #3465 | converge-role-assignment: the delete is not transactional with the recreate, only one remediation fires per ru | lane:bicep,sprint:next |
| #3460 | cloud-parity: the silent-revert gate runs on gcch + il5 only — Commercial adopts image tags but is ungated | bug,csa-loom,deploy-validation,lane:ci,sprint:active |
| #3458 | deploy: 36 executed `az role assignment create` sites, none passing --name — every one is a latent permanent d | bug,lane:ci,sprint:next |
| #3449 | deploy: deploy-fiab-gcch is failing | deploy-validation,lane:ci,sprint:active |
| #3446 | Azure Maps BYO adopt input is INERT: producers emit EXISTING_MAPS / EXISTING_AZURE_MAPS, every bicepparam read | lane:bicep,sprint:next |
| #3433 | auto-bind §5 / IL5 compliance: LOOM_CLOUD_TIER is passed by nobody, so the IL5 Fabric-Admin-API block has neve | csa-loom,lane:bicep,sprint:next |
| #3416 | Gov parity: svc-transform-runner and svc-copilot-evaluator have a Commercial image producer and NO Gov produce | bug,lane:ci,sprint:active |
| #3415 | P0: sovereign azd path cannot bind ANY of main.bicep's 22 required params — main.parameters.json does not exis | bug,lane:bicep,sprint:active |
| #3400 | SQL query-cancel declares a precondition the estate does not meet — sticky sessions OR 1 replica, and it has n | bug,csa-loom,lane:console,sprint:next |
| #3380 | Sovereign lanes never run adopt discovery — brownfield + cross-sub grants are Commercial-only by construction | csa-bug,csa-loom,deploy-validation,lane:bicep,sprint:active |
| #3374 | Two remediation scripts are named in-product as 'run this yourself' but never called by the bootstrap — their  | csa-loom,lane:bicep,sprint:next |
| #3372 | auto-bind §5: LOOM_PGVECTOR_HOST and LOOM_COPYJOB_CONTROL_SQL_SERVER are consumed but produced by no template | csa-loom,lane:bicep,sprint:next |
| #3370 | auto-bind §5: bicep hard-codes four H-band LOOM_* env vars to '' and tells the operator to set them by hand | csa-loom,lane:bicep,sprint:next |
| #3355 | Evaluate Azure Deployment Environments as the structural brownfield adopt story | csa-feature-request,csa-loom,deploy-validation,lane:bicep,sp |
| #3350 | EPIC: Fabric-parity items still unbuilt — and for Gov they are not optional | csa-feature-request,csa-loom,epic,lane:console,sprint:blocke |
| #3349 | Gov visibility: re-derive the real readiness score for GCC-High / IL5 / GCC | csa-loom,deploy-validation,lane:bicep,sprint:next |
| #3346 | loom-unity / iceberg-catalog / trino have NO automated roll — rebuilding a tag never lands | csa-loom,deploy-validation,lane:ci,sprint:active |
| #3344 | Guard: a param flipped in bicep must REACH the compiled template and the live app | bicep-drift,csa-loom,deploy-validation,lane:ci,sprint:active |
| #3343 | EPIC: make the estate's ACTUAL state loud — assert on the numbers we already log | csa-loom,epic,lane:ci,sprint:blocked |
| #3342 | The brownfield wizard cannot deploy: every adopt blocks on a fitness verdict with no production producer | csa-bug,csa-loom,deploy-validation,lane:bicep,sprint:active |
| #3341 | loom-directlake: build the image, invoke the bicep, or retire it (#3291) | csa-bug,csa-loom,lane:bicep,sprint:next |
| #3340 | Function Apps execute nothing, and two carry enabled timers duplicating ACA job crons | csa-bug,csa-loom,lane:bicep,sprint:next |
| #3338 | transform-runner is bound but not granted — artifact writes will 403 | csa-bug,csa-loom,lane:bicep,sprint:next |
| #3327 | svc-s3-gateway: the console KNOWS its lake account but the deploy passes loomStorageAccount EMPTY, so loomStor | lane:bicep,sprint:next |
| #3317 | svc-servicebus + svc-batch: the resources EXIST but the console wiring is gated on useSingleDlz, which is FALS | lane:bicep,sprint:next |
| #3191 | bicep-drift (Commercial): 126 unmanaged delta(s) vs live estate | bicep-drift,csa-loom,drift-commercial,lane:bicep,sprint:next |
| #3161 | cloud-parity: Gov deploys ignore appImageTags — LOOM_UNITY_TAG / LOOM_TRINO_TAG are never in the Provision ste | bug,csa-loom,deploy-validation,drift-gov,lane:ci,sprint:next |
| #3078 | gcc.bicepparam never sets deployAppsEnabled — GCC deploys ZERO Container Apps (a green deploy of nothing) | lane:bicep,sprint:next |
| #3060 | Gov loom-unity image lineage shipped with the v0.5.1 #1603 override INERT — re-roll needed after PR #3057 merg | lane:bicep,sprint:next |
| #2958 | admin-plane redeploy: known blockers ARE fixed, but 3 unresolved risks make it unsafe to run (blocks DuckLake  | csa-loom,lane:bicep,sprint:blocked |
| #2874 | bicep-drift (Gov (GCC-High)): 1 unmanaged delta(s) vs live estate | bicep-drift,csa-loom,drift-gov,lane:bicep,sprint:next |
| #2698 | Gov gates: 105/125 — zero critical/recommended blocked; the 20 optional are bucketed and mostly NOT agent-clos | lane:bicep,sprint:next |
| #2642 | Redis retirement residual: migrate the LIVE Commercial Premium cache to AMR before 2028-10-01 + decide the Gov | lane:bicep,sprint:next |

