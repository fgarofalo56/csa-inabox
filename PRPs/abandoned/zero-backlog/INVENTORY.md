# Zero-backlog inventory (generated -- do not hand-edit)

Source: `gh issue list --state open --limit 1000`, 297 issues.
Regenerate: `python tools/drain/build_inventory.py`

| stream | what | issues | sized pts | unsized | epics | blocked |
|---|---|---:|---:|---:|---:|---:|
| `W0-harness` | Harness + gate integrity (the drain's own tooling) | 4 | 0 | 4 | 0 | 0 |
| `W1-deploy` | Deploy-path integrity (R1 preempts all feature work) | 26 | 74 | 15 | 0 | 2 |
| `W2-security` | Security + authz | 20 | 21 | 15 | 0 | 1 |
| `W3-gov` | Sovereign / cloud-parity | 0 | 0 | 0 | 0 | 0 |
| `W4-receipts` | Owed receipts (merged-not-verified) | 15 | 30 | 10 | 1 | 3 |
| `W5-console` | Console surfaces (ui-parity / ux-baseline) | 84 | 408 | 11 | 6 | 5 |
| `W6-ci` | CI guards + lanes | 21 | 76 | 8 | 1 | 1 |
| `W7-bicep` | Bicep / infrastructure | 18 | 102 | 0 | 0 | 0 |
| `W8-dataplane` | Data plane | 19 | 126 | 1 | 2 | 0 |
| `W9-rest` | Unclassified remainder (triage before scheduling) | 90 | 5 | 89 | 0 | 0 |
| **total** | | **297** | **842** | **153** | **10** | **12** |

## `W0-harness` -- Harness + gate integrity (the drain's own tooling)  (4)

- **#4466** `unsized` -- ci: no gate compiles ANY .bicepparam — il5.bicepparam is parsed by no CI step and executed by no dep
- **#4467** `unsized` -- ci: check-route-toolkit matches raw source, so a COMMENT satisfies the guard — one route is cloaked 
- **#4468** `unsized` -- ci: the merge gate that decides GO/NO-GO is gitignored — the whole drain toolchain lives only in tem
- **#4469** `unsized` -- ci: a push into a CONFLICTING window gets ZERO check-runs permanently — same MISSING symptom as a pa

## `W1-deploy` -- Deploy-path integrity (R1 preempts all feature work)  (26)

- **#3191** `13pt` -- bicep-drift (Commercial): 128 unmanaged delta(s) vs live estate
- **#2958** `8pt` `B` -- admin-plane redeploy is NOT unsafe any more — it runs green on schedule; all that remains is an /adm
- **#3342** `8pt` -- The brownfield wizard cannot deploy: every adopt blocks on a fitness verdict with no production prod
- **#3355** `8pt` `B` -- Evaluate Azure Deployment Environments as the structural brownfield adopt story
- **#3380** `8pt` -- Sovereign lanes never run adopt discovery — brownfield + cross-sub grants are Commercial-only by con
- **#3676** `8pt` -- P0: the scheduled deploy silently REVERTS rolled images — PR #3665's security fix was live 9 minutes
- **#3344** `5pt` -- Guard: a param flipped in bicep must REACH the compiled template and the live app
- **#3346** `5pt` -- loom-unity / iceberg-catalog / trino have NO automated roll — rebuilding a tag never lands
- **#3349** `5pt` -- Gov visibility: re-derive the real readiness score for GCC-High / IL5 / GCC
- **#3449** `5pt` -- deploy: deploy-fiab-gcch is failing
- **#2874** `1pt` -- bicep-drift (Gov (GCC-High)): 17 unmanaged delta(s) vs live estate
- **#4072** `unsized` -- deploy: deploy-fiab-gcch — ADX-stopped is now a DECLARED stand-down, not a failure; the live blocker
- **#4073** `unsized` -- cloud-parity: deploy-fiab-il5 has never run once — it is dispatch-only with no cron, and its documen
- **#4086** `unsized` -- Snowflake mirroring is gated on infra: ADF staged copy needs an AzureBlobStorage linked service, and
- **#4144** `unsized` -- six untracked deploy paths are stale or have NEVER run — including deploy-fiab-il5 (zero runs, ever)
- **#4161** `unsized` -- auto-bind §5: svc-posture-refresh is BLOCKED live on an env var the post-deploy bootstrap already kn
- **#4233** `unsized` -- estate-pause/gcch: a DECLARED-PAUSED run stands down and then goes RED anyway (image-tag revert gate
- **#4390** `unsized` -- deploy: loom-dataplane-roll is failing
- **#4424** `unsized` -- deploy: gov-console-roll is failing
- **#4448** `unsized` -- deploy: deploy-fiab-commercial is failing
- **#4451** `unsized` -- The roll's UAT gate reports PASSED over a run in which zero tests passed
- **#4461** `unsized` -- deploy(R7): an ACR firewall denial was reported as a 'Loom defect … not something the operator can f
- **#4464** `unsized` -- build-fiab-images-acr-tasks pushes every image to ACR BEFORE the Trivy CRITICAL gate runs, so a red 
- **#4471** `unsized` -- images(R7): the loom-unity prune authorises an rm -rf from a probe that cannot fail — error and no-m
- **#4472** `unsized` -- deploy: loom-risingwave intermittently times out at the ACR task's 1h ceiling pulling 342MB of apt, 
- **#4473** `unsized` -- gov(deploy): gov-provision-trino deploys loom-trino-lake-rbac.bicep, which does not exist in the rep

## `W2-security` -- Security + authz  (20)

- **#3531** `5pt` `B` -- security: starlette <0.42 cap excludes ALL five fixes — accepted exception pending a fastapi>=0.139 
- **#3706** `5pt` -- security(latent): loadRecycledItem (item-crud.ts:637) is a #2941-shaped owner-only point read — migr
- **#4004** `5pt` -- tid-boundary: withTenantAdmin is an admin chokepoint the census structurally cannot see — 71 route f
- **#3338** `3pt` -- transform-runner is bound but not granted — artifact writes will 403
- **#3580** `3pt` -- The ports route's allowlist reason says 'contract summaries'; it returns every port REF — a 26th ins
- **#3876** `unsized` -- ci: the publication-surface checker has 4 measured enumerator bypasses (follow-up to #3835)
- **#3933** `unsized` -- Loom Brain — self-managing estate intelligence, Visualizer, and the synapses/security layer (parent)
- **#3934** `unsized` -- Loom Brain W8 — synapses view: render security + pruning onto the architecture graph
- **#3937** `unsized` -- Loom Brain W11 — the Brain in Azure Government (cloud-parity is the bar)
- **#3941** `unsized` -- auth: owner-only-workspace-guard is RED and unowned — loadItem needs migrating to the authorized pat
- **#3970** `unsized` -- Loom Brain security detectors: the 25 mutation arms run in no workflow, and C6/C7/C8 assert nothing 
- **#3979** `unsized` -- 218 of 476 workflow action refs float on a tag, and dependabot's style-preservation means the split 
- **#3982** `unsized` -- deps: thrift 0.17.0 -> 0.23.0 in loom-directlake is blocked on cargo tooling, not on the fix
- **#3985** `unsized` -- CodeQL alert triage: js/indirect-command-line-injection at the measure.mjs spawnSync sink — model th
- **#4101** `unsized` -- guard-strength: a caller-controlled value can pick an authorization guard's read/write SCOPE on a mu
- **#4219** `unsized` -- ontology resolve: lakehouse-table and warehouse-table reach buildSqlSelect behind the SHAPE-only reg
- **#4456** `unsized` -- auth: export-check refuses read-only Viewers with 404 and the client reads that as 'not blocked' — l
- **#4457** `unsized` -- auth: impact and lineage flatten a 409 tenant_unconfirmed into 404 — the 409-preserved claim holds f
- **#4458** `unsized` -- Content Safety silently OFF on the adopt/BYO Foundry path — shieldPrompt returns 'not blocked' with 
- **#4460** `unsized` -- APIM AI gateway: llm-token-limit and semantic cache are silently unauthored in GCC-High and IL5 on a

## `W4-receipts` -- Owed receipts (merged-not-verified)  (15)

- **#4442** `13pt` `E` -- Loom AI endpoints route through APIM AI Gateway by default — multi-endpoint/multi-provider, not tied
- **#3720** `8pt` -- slate-app: parity doc self-grades D ("target A once P0+P1 land") — the only doc-confirmed D-grade it
- **#2581** `3pt` `B` -- B-R10 follow-up: in-browser click-walk receipt for the 3 decomposed semantic-model tabs (ux-baseline
- **#2583** `3pt` `B` -- G1 browser E2E receipt for the AOAI target-resolution path (#2557 / #2568)
- **#2626** `3pt` `B` -- LU-8: live E2E receipt for the OpenLineage emitters (G1) — operator walk
- **#3965** `unsized` -- bicep-sync: cost-export.bicep is allowlisted, not wired — routing decision + Gov receipt owed by the
- **#4183** `unsized` -- mirrored-databricks create returns ok:true for a mirror that is not queryable, and its remediation n
- **#4242** `unsized` -- brain Perform: BUILT and DEPLOYED (backend + UI + guards live) — what remains is the G1 estate recei
- **#4361** `unsized` -- slate-app parity row 6 (M): Map widget on Azure Maps (location / heatmap / shape / choropleth)
- **#4387** `unsized` -- Two shipped bicep comments contradict each other on whether ARM rejects a duplicate (scope, principa
- **#4405** `unsized` -- fix(console): install the mongodb driver so the Cosmos vCore vector backend can actually run — in AN
- **#4406** `unsized` -- chore(bicep): ARM-provision sql-cancel-intents so its defaultTtl does not depend on which path creat
- **#4408** `unsized` -- G1 receipt owed: in-browser E2E click-walk of the four highest-risk picker surfaces #4344 rewrote (C
- **#4432** `unsized` -- AI copilot not working
- **#4470** `unsized` -- G1 receipt owed: the rewritten Copilot UAT scoring rule has never been run against a live deployment

## `W5-console` -- Console surfaces (ui-parity / ux-baseline)  (84)

- **#1483** `13pt` `B` -- FEATURE (backlog): multi-library domain designer + federated data-mesh — Federal Civ / Defense & IC 
- **#3350** `13pt` `EB` -- EPIC: Fabric-parity items still unbuilt — and for Gov they are not optional
- **#3361** `13pt` `EB` -- EPIC: end-to-end access management — grant, scope, pause, and revoke CSA Loom access
- **#3527** `13pt` `E` -- V&V Sprint: Item & App Catalog coverage matrix (142 items + 29 apps) — 2026-08-15
- **#3615** `13pt` `B` -- EPIC: the no-freeform program is ~16% done — 176 ratcheted + 34 accepted sites remain, and ~150 are 
- **#3699** `13pt` `E` -- Canvas design surfaces: independently resizable stacked docks + hideable minimap (default for ALL ca
- **#3719** `13pt` -- databricks-pipeline (Lakeflow/DLT): 31 missing capability rows, the worst breadth gap in the catalog
- **#3721** `13pt` -- digital-twin: 27 missing capability rows, untracked despite being the worst gap in Real-Time Intelli
- **#3770** `13pt` `E` -- Fabric 2026 P2 umbrella: SharePoint/OneDrive + cross-warehouse shortcuts, mirror private-link, Airfl
- **#3772** `13pt` `E` -- EPIC — Analysis Spaces: curated NL data-analysis rooms over warehouse/lakehouse/eventhouse (Genie pa
- **#3450** `8pt` -- The 'platform tells you to run it' class is 26 sites, not the 2 in #3374 — ratcheted, but the invent
- **#3513** `8pt` -- 23 opt-in remediation gates (Fabric backends + Purview UC data-plane roles) are plain-text messages 
- **#3637** `8pt` -- There is no rotate-after-compromise path: the MSAL provisioner's REUSE gate keeps serving a disclose
- **#3669** `8pt` -- Layer 1 on databricks-sql-warehouse is a floor, not a bound — needs a server-attested item→warehouse
- **#3694** `8pt` -- auto-bind: eventstream, kql-database and lakehouse carry the same #3549 empty-backing-resource shape
- **#3722** `8pt` -- ai-red-team: parity doc explicitly says "Not A-grade" — untracked
- **#3726** `8pt` -- 15 admin pages have zero parity doc — no audit baseline exists, several high-stakes
- **#3762** `8pt` -- Mirroring: add BigQuery as a mirrored-database source type (Fabric preview 2026 parity)
- **#3763** `8pt` -- Mirroring: add Oracle as a mirrored-database source type (Fabric preview 2026 parity)
- **#3769** `8pt` -- Notebook platform 2026 bundle: runtime selector, custom live pools, Event Hubs streaming source, AI 
- **#3774** `8pt` -- Governed metrics layer: certified KPI definitions consumable by BI + agents (UC Metrics / business-s
- **#3167** `5pt` -- UAT gate: the 20 F-grades were a hydration-timing artifact — the real defects are slow first paint, 
- **#3169** `5pt` -- a11y regressions past baseline on /workspaces and /setup (found by first honest UAT run)
- **#3400** `5pt` -- SQL query-cancel declares a precondition the estate does not meet — sticky sessions OR 1 replica, an
- **#3524** `5pt` -- App-installed items briefly show a scary 'No containers visible to BFF identity' error on first open
- **#3535** `5pt` -- Backlog: add 'Anomaly detector' item type (Fabric parity gap)
- **#3544** `5pt` -- G2 violation: Copilot Studio 'not a member of the organization' is a bare remediation MessageBar, no
- **#3573** `5pt` -- stream-analytics-job: new item never gets its backing ASA job auto-provisioned — persistent 404, mis
- **#3589** `5pt` -- APIM origin fields could offer a picker over discovered Backend entities alongside the free-text BYO
- **#3633** `5pt` -- Live estate: data-agent grounding 2.00 below its 3.00 floor, and a dead report judge would have publ
- **#3718** `5pt` -- lakehouse-shortcut: 13 freeform ARM/path sites (largest untracked footprint in the item catalog)
- **#3725** `5pt` -- 4 Platform & Admin parity docs (rev.5, 2026-06-09) are confirmed stale — real bug fixes landed after
- **#3735** `5pt` -- RUM hub: PAGE LOADS and ROUTE CHANGES both read 0 in the last 24h while Web Vitals reports 55 sample
- **#3751** `5pt` -- Permissions to Workspace access: any workspace not created by the current admin 404s 'workspace not 
- **#3764** `5pt` -- Mirroring: add Azure Monitor Logs as a mirrored source (Fabric GA Build 2026 parity)
- **#3766** `5pt` -- Mirroring: change-feed export to Event Hubs (Fabric June 2026 'Mirrored DB change feed connector' pa
- **#3776** `5pt` -- Governed workspace secrets: Key Vault-backed secret scopes with runtime resolution + audit (UC Secre
- **#3794** `5pt` -- Tenant-settings singleton is written under the caller oid and read under tenantScopeId — the chargeb
- **#3796** `5pt` -- auto-bind §1/no-vaporware: install reported 'created' with counts for 36 pipelines whose backing obj
- **#4091** `5pt` -- fix(data-agent): the chat answered fluently, generated no SQL, and touched no data
- **#4113** `5pt` -- fix(activator): 11 of 13 live action groups have ZERO receivers, and the deployed fix only wires NEW
- **#3515** `3pt` -- event-grid-topic editor requires typing full ARM resource IDs by hand to wire an event subscription
- **#3517** `3pt` -- stream-analytics output wiring shows Loom's own known resource names as placeholders instead of defa
- **#3518** `3pt` -- AI Foundry hub 'New connection' dialog requires typing an endpoint URL for Loom-native categories th
- **#3519** `3pt` -- kql-database data-connection wizard requires typing a cluster ARM id / URI by hand for cross-cluster
- **#3526** `3pt` -- activation-sync destination config requires typing Event Grid/Service Bus endpoints instead of picki
- **#3528** `3pt` -- App-install workspace picker dropdown can become click-dead after a React hydration error (#418) unt
- **#3536** `3pt` -- Backlog: add 'Exploration' item type (Fabric parity gap)
- **#3540** `3pt` -- Databricks Unity Catalog credential dialog requires typing Access Connector ARM id + managed identit
- **#3543** `3pt` -- auto-bind: Evaluation editor's 'New evaluation' form requires freeform Dataset ID + Model deployment
- **#3565** `3pt` -- ai-foundry-hub: selecting a non-Loom AI Foundry account has no recovery path back to the auto-bound 
- **#3567** `3pt` -- mapping-dataflow: every newly created item fails to load with 'invalid data flow name' — item type i
- **#3575** `3pt` -- variable-library: unresolved @{variables.NAME} refs are echoed verbatim with no user-visible signal 
- **#3578** `3pt` -- content-safety: 'Analyze text' consistently fails with bare 'Error fetch failed' — no status, no rea
- **#3588** `3pt` -- Is the git-integration SPN auth path functional? spnTenantId/spnClientId are persisted and read by n
- **#3684** `3pt` -- Studio extension fails to log in
- **#3700** `3pt` `B` -- data-pipeline publish PUTs the canvas-render shape straight to ADF — publishes successfully, does no
- **#3727** `3pt` -- perf(browse): /browse fetches the same 500-item query 8x per load (~1.5 MB, 5.07s) — measured live
- **#3742** `3pt` -- Copilot quality Budgets 'New budget' dialog requires typing a raw workspace/agent Scope id by hand i
- **#3746** `3pt` -- External-engine federation: 'Live' badge shows green success next to the red 'Catalog unreachable' e
- **#3747** `3pt` -- Domains page: 'Federated data-mesh' and the domain List disagree on workspace counts (109 vs 0) — me
- **#3748** `3pt` -- Landing zone map renders empty (React hydration error #418) despite real attached-DLZ data
- **#3767** `3pt` -- Pipeline designer: dbt as an in-canvas activity type (Fabric 2026 parity)
- **#3768** `3pt` -- Data agents: service-principal / app-identity binding UI (Fabric June 2026 GA parity)
- **#3778** `3pt` -- lakebase-postgres: re-audit against Lakebase GA-on-Azure surface and rebuild the parity doc with rea
- **#4011** `3pt` -- copilot/data-agent: legacy documents with no userOid are now unreadable AND undeletable — needs a me
- **#4016** `3pt` -- brain/history: an INCOMPLETE Resource Graph pull is stored as a complete version — completeness is n
- **#4092** `3pt` -- fix(data-agent): the source picker showed 'None found' while its own API returned the item
- **#4093** `3pt` -- fix(casino-analytics): both notebooks read silver tables the bundle never creates
- **#4097** `3pt` -- fix(activator): the High-Roller alert is enabled, fires, and notifies nobody
- **#3538** `1pt` -- Lakehouse ribbon missing 'Update all variables' action (Fabric parity gap)
- **#3541** `1pt` -- Health-check editor requires typing a Logic App resource id by hand for notification wiring
- **#3626** `1pt` -- no-freeform: clear the 4 baselined free-text sites in unified-sql-database-editor.tsx
- **#3832** `unsized` -- auto-bind sweep has no caller — the route exists, nothing schedules it
- **#3838** `unsized` -- bulk-delete: 500-id serial batch has no maxDuration, no aggregate Graph bound, and is non-transactio
- **#3847** `unsized` -- Enable exactOptionalPropertyTypes in apps/fiab-console/tsconfig.json
- **#3962** `unsized` -- mapping-dataflow / notebook editor guards: 4 predicate gaps that survive mutation, + a pre-existing 
- **#3963** `unsized` -- brain-graph: the suite is fixture-only, so cardinality-conditioned bypasses survive it — four measur
- **#3964** `unsized` -- brain: a production-cardinality bypass inside a detector's CLEARED branch still balances the ledger
- **#3967** `unsized` -- brain: 'azure:' node-id prefix is a bare duplicated literal, and its population can be zeroed at pro
- **#4083** `unsized` -- P1 mirroring: Snowflake ADF Copy can never move a row — SnowflakeExportCopyCommand is paired with an
- **#4136** `unsized` -- the KNOWN_CONTAINERS mirror class: 11 hand-copied literals, 5 already drifted, and tsc cannot catch 
- **#4150** `unsized` -- the ADX editor's SKU dropdown offers 6 Commercial-only SKUs — zero of them exist in Azure Government
- **#4381** `unsized` -- Promote AdlsBrowsePanel out of the shared AdlsBrowseDialog and delete foundry-sub-editors' private A

## `W6-ci` -- CI guards + lanes  (21)

- **#3343** `13pt` `EB` -- EPIC: make the estate's ACTUAL state loud — assert on the numbers we already log
- **#3754** `13pt` -- P0(cloud-parity): only Commercial has a working infra-deploy path — GCC disabled, GCC-High failing 8
- **#3352** `8pt` -- Chaos Studio + Load Testing wired into readiness, so "ready" means "survived something"
- **#3458** `8pt` -- deploy: 36 executed `az role assignment create` sites, none passing --name — every one is a latent p
- **#4108** `8pt` -- guard-strength: controls keyed to a LAYER get defeated by moving the narrowing one layer over — asse
- **#3416** `5pt` -- Gov parity: svc-transform-runner and svc-copilot-evaluator have a Commercial image producer and NO G
- **#3464** `5pt` -- D3 role-assignment guard: blind to YAML env: role GUIDs, floor on the wrong population, and checks p
- **#4094** `5pt` -- fix(observability): the synthetic monitor fails with realFails>0 and cannot say which journey broke
- **#3457** `3pt` -- security: Dependabot #94 — Apache Thrift excessive memory allocation; establish reachability before 
- **#3462** `3pt` -- release-please: held action_required runs DO exist — approving them could delete the dispatch fan-ou
- **#3472** `3pt` -- ci: the eval gate fails PRs on a stale docs index it does not control
- **#3490** `1pt` -- chore: prune the branch list — 562 of 566 are provably landed (audit corrects this issue's premise)
- **#4077** `1pt` -- deps: the CI protobuf ceiling exists only because dbt-core 1.8.9 fences protobuf<6 — delete it when 
- **#3815** `unsized` -- fix(copilot): validate_gate_dry_run passes -WhatIf to five gates that all reject it, and its tests l
- **#3846** `unsized` -- copilot-quality-evals gate: red on every PR head, and eval-floors.json marks unmeasured floors as pr
- **#3850** `unsized` -- #3830 residuals: NON_AUTHORIZERS entries are not content-pinned, plus five smaller findings from the
- **#3857** `unsized` -- Copilot eval gate fails a PR on an estate measurement it explicitly disclaims, and the help surface 
- **#3958** `unsized` -- ci: probeGates reads string literals and comments; two population floors are satisfiable without the
- **#3961** `unsized` -- The #3844 notifier ratchet is a floor, not a chokepoint: a 7th caller can stay outside its populatio
- **#3968** `unsized` -- deploy: console-bluegreen-roll is UNVERIFIED (3 weeks unrun, last 3 red) — but the July cause no lon
- **#4386** `unsized` -- the eval latency gate divides by a 0.0 baseline, so CI jitter reads as a +107% regression and the ga

## `W7-bicep` -- Bicep / infrastructure  (18)

- **#3110** `13pt` -- F1 federation residue: amnesiac Iceberg catalog, 30s cold-start 504s, Trino file-ACL, zero credentia
- **#2642** `8pt` -- Redis retirement residual: migrate the LIVE Commercial Premium cache to AMR before 2028-10-01 + deci
- **#3078** `8pt` -- gcc.bicepparam never sets deployAppsEnabled — GCC deploys ZERO Container Apps (a green deploy of not
- **#3683** `8pt` -- GCC-High and IL5 carry BOTH halves of #3676 unmitigated — no re-pin, no estate gate, same lease eras
- **#3788** `8pt` -- cloud-parity: Weave ontology graph store has no Azure Government implementation — GCC-High/IL5 hones
- **#2698** `5pt` -- Gov gates: 105/125 — zero critical/recommended blocked; the 20 optional are bucketed and mostly NOT 
- **#3317** `5pt` -- svc-servicebus + svc-batch: the resources EXIST but the console wiring is gated on useSingleDlz, whi
- **#3327** `5pt` -- svc-s3-gateway: the console KNOWS its lake account but the deploy passes loomStorageAccount EMPTY, s
- **#3340** `5pt` -- Function Apps execute nothing, and two carry enabled timers duplicating ACA job crons
- **#3370** `5pt` -- auto-bind §5: bicep hard-codes four H-band LOOM_* env vars to '' and tells the operator to set them 
- **#3430** `5pt` -- cloud-parity: the Gov console has NEVER held an internal token — loom-internal-token-drift's Gov job
- **#3465** `5pt` -- converge-role-assignment: the delete is not transactional with the recreate, only one remediation fi
- **#3577** `5pt` -- fix(deploy): the Gov DMLZ path deploys a NEW Purview unconditionally, so it fails in any tenant that
- **#3744** `5pt` -- auto-bind §5: svc-databricks-sql and svc-eh-schema-registry are BLOCKED live on 'Set LOOM_X' with no
- **#3060** `3pt` -- Gov loom-unity image lineage shipped with the v0.5.1 #1603 override INERT — re-roll needed after PR 
- **#3341** `3pt` -- loom-directlake: build the image, invoke the bicep, or retire it (#3291)
- **#3372** `3pt` -- auto-bind §5: LOOM_PGVECTOR_HOST and LOOM_COPYJOB_CONTROL_SQL_SERVER are consumed but produced by no
- **#3374** `3pt` -- Two remediation scripts are named in-product as 'run this yourself' but never called by the bootstra

## `W8-dataplane` -- Data plane  (19)

- **#3771** `13pt` `E` -- EPIC — Loom Agent Foundry: declarative agent builder with eval-driven auto-optimization (Agent Brick
- **#3773** `13pt` `E` -- EPIC — Loom Connect: managed ingestion connector hub (Lakeflow Connect parity, exceeds via ADF conne
- **#2678** `8pt` -- svc-loom-trino: default-ON Federated SQL engine + a working Entra posture (split out of #2641)
- **#3351** `8pt` -- Agentic retrieval (AI Search) + Cosmos DB vector as first-class RAG backends
- **#3354** `8pt` -- Purview DSPM / data-security-posture deepening
- **#3549** `8pt` -- P0: data-pipeline activities are silently empty for the vast majority of pipelines in the factory — 
- **#3688** `8pt` -- P0: the entire Power Platform family (6 item types + Copilot Studio) is blocked by ONE missing Datav
- **#3765** `8pt` -- Real-Time dashboards: event-driven refresh (Loom Live Push service) — Fabric 2026 parity, exceeds vi
- **#3775** `8pt` -- OpenSharing management plane: shares, recipients, network policies, cross-boundary approval (Delta S
- **#3777** `8pt` -- Model gateway: per-cloud model registry + capability routing + central cost/safety enforcement (Foun
- **#3339** `5pt` -- Iceberg external-engine federation returns 403 in the UI — root cause unproven
- **#3511** `5pt` -- mirrored-database requires hand-typed source table list; could auto-discover via information_schema.
- **#3530** `5pt` -- App-installed notebooks fail on Run with ModuleNotFoundError — no Spark environment/libraries attach
- **#3537** `5pt` -- Real-Time Dashboard tiles fail with 'table not resolved' even though the exact same query succeeds d
- **#3546** `5pt` -- Streaming SQL 'Materialize' reproducibly times out live; generic timeout message asserts an unverifi
- **#3571** `5pt` -- loom-duckdb serving tier cold start exceeds client's 20s timeout — first query in a session fails
- **#3525** `3pt` -- kql-database provisioner's 5 identical AllDatabasesAdmin remediation gates may be one systemic RBAC 
- **#3640** `3pt` -- Post-exposure rotation remainder: RisingWave root password, DuckLake DSN, and two inert vault entrie
- **#3841** `unsized` -- Gov: OSS Unity federation returns zero metastores — loom-unity workspace errors, and the message ass

## `W9-rest` -- Unclassified remainder (triage before scheduling)  (90)

- **#3736** `5pt` -- Health hub Journeys tab: about 1 in 6 synthetic-journey runs show zero journeys with 'crashed before
- **#3801** `unsized` -- 24 of 32 content-bearing semantic models reference a parent workspace the caller cannot see — editor
- **#3818** `unsized` -- placeholder-oid: 4 sites the #3805 review found, and no ratchet closing the class
- **#3819** `unsized` -- vitest change-detection: floor too low, deriver untested, and two more green-on-zero routes
- **#3821** `unsized` -- vitest change-detection: a PRPs/-only PR still runs ZERO tests — the stale-corpus guard is unreachab
- **#3844** `unsized` -- Gov's continuous-deploy roll silently reverts and files nothing; IL5's failure notification is inert
- **#3883** `unsized` -- cloud-parity: deploy-fiab-il5 carries #3449's ADX-preflight-after-what-if defect unmitigated, and ha
- **#3893** `unsized` -- P1: modules/landing-zone/main.bicep is NEVER instantiated — 24 module invocations / 146 resource dec
- **#3905** `unsized` -- P0: 8 of 9 data provisioners return status:'created' having written nothing, there is NO post-deploy
- **#3908** `unsized` -- flake: a mutation harness writes __control__ artifacts into the tree another suite scans — ENOENT re
- **#3910** `unsized` -- ci: fiab-console-ci's infra path-class is missing PRPs, and its deriver cannot see dynamically-joine
- **#3915** `unsized` -- The PRODUCTION help corpus has NEVER contained a repo-kind code summary — consoleLibRoot points at <
- **#3920** `unsized` -- latent: secondaryIds join(',') breaks on a comma in 10 keys, and one schema-sanitize rule has 3 copi
- **#3922** `unsized` -- pause ownership: loom-estate-id is stamped by nothing — the deploy MANIFEST resolves today (~$3k/mo)
- **#3954** `unsized` -- L5-A guard-strength gaps: six mutations survive the #3930 specs, and #3739 has no second ratchet
- **#4023** `unsized` -- ADX preflight follow-ups from the #4013 review: an uncharged retry budget, three messages that descr
- **#4029** `unsized` -- GUARD-STRENGTH: the brain security-graph drift gate is not a required context, so it cannot block a 
- **#4035** `unsized` -- GATES-THAT-CANNOT-FAIL: CodeQL, Checkov, IaC Security Scan and Bicep Lint run but cannot block a mer
- **#4036** `unsized` -- OneLake security ACL: the enable flag is dead at BOTH ends of the bicep chain, so the gate can never
- **#4038** `unsized` -- release-please: the REQUIRED_CHECKS drift control cannot fire, and denies drift while drift is prese
- **#4039** `unsized` -- mirroring: three source-type/connection guards are correct but unwitnessed (R4/R7/R8) — need a route
- **#4045** `unsized` -- 155 PRs merged over a hard-red advisory check, 19 of them CodeQL
- **#4046** `unsized` -- 78 PRs merged with ZERO check runs; the class looks closed at #3679 but nothing guards it
- **#4047** `unsized` -- 13 PRs merged past a RED required context under enforce_admins:false; four hard-red
- **#4051** `unsized` -- Gov has no nightly Brain scan: no in-boundary runner can reach the Gov Cosmos private endpoint (need
- **#4184** `unsized` -- six untyped redirect_request overrides hide the argument shape from strict mypy (#3717 follow-up)
- **#4191** `unsized` -- gov-provision-runner-images: the boundary selector does not select a boundary — gcc-high and il5 res
- **#4196** `unsized` -- loom-dataplane-roll reverts a HEALTHY, VERIFIED roll when it cannot READ the digest — an unknown spe
- **#4201** `unsized` -- two Spark editors carry baselined free-text infra inputs — pickers needed, TOUCH_EXEMPT entries to b
- **#4209** `unsized` -- #4017 digest half: the tagKeys canonical form is not injective, but fixing it rewrites every stored 
- **#4235** `unsized` -- cloud-parity: Gov has no estate resume path — estate-resume.mjs hard-codes the Commercial estate, so
- **#4241** `unsized` -- brain: recommendations are unreadable, and so is the node-select detail (operator live report)
- **#4243** `unsized` -- estate power: Pause ERRORS OUT live — the button the pause mandate depends on fails when pressed (op
- **#4251** `unsized` -- brain graph: the default view renders 112 nodes at 36x15px (fitView zooms to 20%), with 6 overlappin
- **#4255** `unsized` -- Brain ownership + applicability: nothing carries loom-estate-id, so 0 of 17 recommendations are appr
- **#4258** `unsized` -- The Brain's unreachable detector judges 65 apps through a 20-name env allowlist — loom-risingwave is
- **#4264** `unsized` -- cloud-parity: Loom Unity has NO durable metastore in GCC-High / IL5 — the catalog deploys on an ephe
- **#4270** `unsized` -- loom-capacity-broker cannot authenticate to AMR (Entra-only bicep, key-only Go); TLS heuristic only 
- **#4277** `unsized` -- the eval delta baseline fetch is set +e / exit 0, so an unfetchable baseline silently disables half 
- **#4282** `unsized` -- the REQUIRED lane checks three integers while only the ADVISORY lane checks the graph — a renamed fi
- **#4285** `unsized` -- ACR firewall lease: ~13 Commercial claimants on one per-registry mutex, none serialized, with a 25-m
- **#4290** `unsized` -- roll-plan.mjs states a v0.1 tag as fact while deriving the env var from the table — no single litera
- **#4294** `unsized` -- deploy-fiab-il5 has never been dispatched — its credentials and target IL5 estate are unverified
- **#4298** `unsized` -- deploy-integrity R3: a CANCELLED image build strands the roll into a `skipped` run, and nothing anyw
- **#4306** `unsized` -- deploy-integrity R3: /admin/readiness must surface estate-behind-main, and loom-dataplane-roll has t
- **#4309** `unsized` -- stranded-roll: two mutations survive the suite — a 'skipped' console conclusion reads as benign, and
- **#4340** `unsized` -- GATE THAT CANNOT FAIL: Python Tests (x3, REQUIRED) go green over failed first-party installs — test.
- **#4345** `unsized` -- ci: the required guardrails lane reds ~2 runs in 3 on a race between estate-preflight's temporary co
- **#4346** `unsized` -- eval-probe answers HTTP 403, so corpus provenance can never resolve to 'match' (#3857 report-only ar
- **#4358** `unsized` -- check-tid-boundary docblock figures are stale at head, and four #4349 ratchets sit on a non-required
- **#4359** `unsized` -- check-honest-gate-coverage: one <HonestGate> masks EVERY other bare G2 bar in the same file, and for
- **#4360** `unsized` -- slate-app parity row 8+9 (M): control / input and action widgets (text, numeric, date, dropdown, but
- **#4362** `unsized` -- slate-app parity row 7 (M): graph / tree / image-gallery widgets
- **#4363** `unsized` -- slate-app parity rows 2+11 (M): multi-page apps and real container nesting
- **#4364** `unsized` -- slate-app parity rows 14+15+16+17 (M): Handlebars query helpers, partials, conditional triggers, ser
- **#4365** `unsized` -- slate-app parity rows 19+20 (M): variable transformations, object-set filter variables, per-user per
- **#4366** `unsized` -- slate-app parity rows 25+26 (M): per-widget styles, global stylesheet, custom HTML/Handlebars widget
- **#4367** `unsized` -- slate-app parity rows 27+28+29 (M): app parameters / module interface, public apps, import-export-du
- **#4368** `unsized` -- slate-app parity rows 31+32 (M): dependency/debug inspector and usage metrics / edit history
- **#4374** `unsized` -- slate-app: inspector hint promises {{variable}} interpolation in text widgets that the renderer neve
- **#4375** `unsized` -- estate-pause register: rule 6 says record a renewal in renewedOn, and the shipped-register classifie
- **#4376** `unsized` -- the eval baseline pointer can wedge permanently: an artifact-less newest success makes every later r
- **#4377** `unsized` -- bicep-whatif.yml: a green tick over properties what-if never compared, and unresolved-list.txt never
- **#4378** `unsized` -- N13 token budgets enforce nothing: no production path populates a TokenAttribution
- **#4379** `unsized` -- brain: the /admin/brain route's four detectors have no disposition ledger, so the #3964 guard does n
- **#4384** `unsized` -- docs(parity): slate-app rows 5 and 24 are BUILT over bundled inventory rows whose sub-capabilities a
- **#4385** `unsized` -- fix(bicep): swa-publish-rbac boundary @description restates a diagnosis the same file's header retra
- **#4388** `unsized` -- no-freeform: delete the stream-analytics-editor TOUCH_EXEMPT entry (self-expiry depends on PR #4344,
- **#4389** `unsized` -- console(kql): the ingest wizard's "Target table" is still free text although the editor already list
- **#4391** `unsized` -- cloud-parity: deploy-fiab-il5 has the same UNGATED sovereign image phase #4372 just closed on GCC-Hi
- **#4392** `unsized` -- hygiene: response bodies are logged to Actions output in a public repo (NOT the CodeQL finding — tha
- **#4393** `unsized` -- ux-baseline: firstOpen lands on 1 of 6 Power Platform editors — the other five are blocked by a 10-l
- **#4404** `unsized` -- no-freeform: AzureResourcePicker's manual-entry Input is invisible to the classifier, so an adoption
- **#4407** `unsized` -- fix(console): the SQL query-cancel endpoint has no ownership check, and cross-replica cancel widens 
- **#4411** `unsized` -- security-graph extractor silently DROPS files when a directory's on-disk case differs from git's — l
- **#4414** `unsized` -- deploy: an ARM 400 on a Consumption budget leaf still classifies as 'unknown' — the taxonomy gap #42
- **#4420** `unsized` -- IngestionMappingPicker keeps a mapping selected after the target table changes, so it can be submitt
- **#4421** `unsized` -- A tid-less or count-unavailable workspace inventory renders its remediation at severity 'none' — val
- **#4425** `unsized` -- ci: Link Check times out at 10m and reports 'cancelled' — a timeout that reads as 'superseded', and 
- **#4427** `unsized` -- Notebook Error when useing AML Compute
- **#4428** `unsized` -- build(deps): dependabot splits exact-pin pairs into PRs that cannot resolve in any merge order
- **#4431** `unsized` -- app-gateway.bicep hardcodes requestTimeout: 30 on ALL FOUR boundaries that enable it — below what 54
- **#4433** `unsized` -- fix(harness): merge-gate documents an artifact-only APPROVE carry-forward (clause 5) that it never i
- **#4435** `unsized` -- Issue with Estate Power in Consual
- **#4441** `unsized` -- Link Check: no test sets OFFLINE on the zero-contacted guard, so an offline exemption survives the s
- **#4444** `unsized` -- no-freeform: clear the 4 free-text sites in copilot-agents-config.tsx (TOUCH_EXEMPT acceptance for #
- **#4445** `unsized` -- Decompose foundry-client.ts + foundry-cs-client.ts back under their file-size ceilings (#4443 bump a
- **#4447** `unsized` -- loom-vscode: vitest.config.ts uses ESM syntax in a CJS-loaded file — breaks when Vite's configLoader
- **#4452** `unsized` -- R7: two eventstream routes still attach the false LOOM_ASA_RG hint to a generic 502
- **#4453** `unsized` -- An omitted shortName RENAMES the operator's existing action group (derived value laundered into inpu
