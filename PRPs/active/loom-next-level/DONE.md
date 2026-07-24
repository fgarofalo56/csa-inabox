# loom-next-level — DONE ledger

One row per landed item. Updated in the PR that lands the item (or the batch
integration PR). Phase boundaries additionally record the FRESH0 re-baseline
run. Receipts live in the PR bodies; this file is the program-level index.

| Item | PR | Date | Receipt summary |
|------|----|------|-----------------|
| — pre-work — roll gate (deploy-race fix, PRP gotcha) | #2395 | 2026-07-22 | `loom-roll-and-validate` resolves `:latest` → newest BUILT main SHA; accepts superseded-but-verified commits (ancestor-of-main). |
| R0 — bicep param-cap consolidation | #2398 | 2026-07-22 | admin-plane/main.bicep 256 → 232 params (31 moved into typed bags aasConfig/adxConfig/eventsConfig/functionAppsConfig + 3 reserved bags); shim vars preserve defaults verbatim; warning profile identical to main (103=103); `check-bicep-param-cap.mjs` wired into loom-guardrails (warn 240 / fail 250); what-if A/B vs main identical. |
| U0 — P0-VERIFY: live drag+reload receipts on already-PASS canvases | (this PR) | 2026-07-22 | **VERDICT: grips live** — 4 surfaces sampled in the operator's real browser vs live Commercial: `/admin/deploy-planner` (SplitPane palette 477→357 via physical drag; canvas height 593→460 keyboard→580 pointer; reload restored 580/357), `/governance/lineage` (`catalog-lineage` height 658→508 drag, reload restored), warehouse editor (`monaco.warehouse.sql` 260→360 drag, key created, reload restored), data-pipeline editor (resources SplitPane 361→409 keyboard→509 pointer; canvas 834→714 drag). Every grip reachable per `elementFromPoint`. **No clipping regression → U1–U6 unblocked.** Findings for the automated spec: (1) below-the-fold canvas grips (pipeline, cy≈1939) are reachable via the editor's inner scroll container — discoverability note, not a defect; (2) CDP-fast drags outrun both drag state machines (SplitPane React-state `dragging` + resizable-canvas rAF-batched commit) — the Playwright U0 spec MUST pace `mouse.move` across frames or it false-fails exactly the way the operator's "nothing resizes" report suggested. Residual: light-theme + narrow-width screenshot passes ride the Phase-1 `loom-ui-verify` U0 spec (session window closed mid-run). |
| R1 — route-toolkit withTenantAdmin + withDlzAccess | #2400 | 2026-07-22 | Wrappers compose on withSession; 5 unit cases green; guard signal lists (check-route-guards GUARD_SIGNAL_RE + route-inventory ADMIN_RE) recognize them; `[route-guards] OK`. |
| S2 — MSAL federated-credential migration spike | #2401 | 2026-07-22 | `docs/fiab/runbooks/msal-credential-strategy.md` — **Decision: MIGRATE to FIC (certificateless, managed identity as credential; high confidence)**, 20 Learn citations, rollout+rollback plan, Gov authority variants; S3 documented as fallback only. Live FIC flip on the prod app reg = scheduled follow-up (operator-sensitive). |
| MIG1 — Cosmos doc-migration convention | #2402 | 2026-07-22 | `lib/azure/cosmos-migrations.ts` registry + `migrateOnRead` wired into cosmos-client read paths (inert with no migrators); v1→v2 fixture upgrade test; `docs/fiab/cosmos-migration-convention.md`; enterprise-hardening §4.2 named first consumer. |
| L1 — column-facet lineage schema foundation | #2403 | 2026-07-22 | `ThreadEdge.columnMappings` persisted; shared `synthesizeColumnGraph` consumes UC + Thread edges on the canonical `col:` identity; lineage route `?columns=true` gated with byte-identical default payload (snapshot test); round-trip + cross-source merge tests green. |
| R7 — file-size ratchet re-baseline | #2399 | 2026-07-22 | 6 drifted ceilings tightened (reductions only — e.g. supercharge bundles 6100/5300/4200 → 300/200/200, lakehouse-shell 1400→1200); `check-file-size.mjs` exits 0. |
| X2 — structured cloud-availability convention | #2405 | 2026-07-22 | `EnvSpec.availability` ({commercial,gccHigh,il5,fallbackNote}); 10 X-MATRIX services backfilled; `gateStatus` gains distinct `cloud-unavailable` (only `unavailable` gates — `limited` renders normally + info note); HonestGate names the Loom-native fallback with NO Fix-it; 23-test matrix lock. NOTE: AAS encoded per X-MATRIX (gov unavailable) — A4 flips to ga behind Learn verification per ground-truth correction #1. |
| R30 — ENV_CHECKS/GATE_META per-domain fragment split | #2409 (re-filed from #2407) | 2026-07-22 | Both monoliths → 9-domain fragment dirs merged at load; import specifiers unchanged; diff-proof 98=98 element-identical; check-health-coverage updated to walk fragments; 180/180 admin+gates tests green post-rebase. **The program's #1 serialization chain is dead.** |
| FLAG0 — Cosmos runtime kill-switch substrate | #2404 | 2026-07-22 | `loom-runtime-flags` container + `runtimeFlag(id,{default:true})` via getOrComputeCached (fail-open, default-ON); typed registry; `/admin/runtime-flags` panel (admin-shell registered) + 13th admin-overview tile; every flip writes `_auditLog` + emitAuditEvent; hard admin gate on writes. |
| E1 — golden Q/A eval sets (top-10 surfaces) | #2406 | 2026-07-22 | `content/evals/` — `_schema.json` + README + 10 corpus-grounded JSONL sets (146 rows; help 20Q … eventstream 12Q); `lint-eval-sets.mjs` validates schema + chunk-path existence; staged into the corpus by `stage-copilot-corpus.sh`; `lint:evals` script. Also fixed: license gate now `--excludePrivatePackages` (workspace root false-positive). |
| U10 — /browse virtualization (VirtualizedGrid/List) | #2410 (re-filed from #2408) | 2026-07-22 | `@tanstack/react-virtual` (sole permitted dep) windowed grid/list + `VIRTUALIZATION_CUTOFF=200`; adopted on /browse (1,437-item table), marketplace, federated search; FLAG0 flag `u10-browse-virtualization` (OFF = pre-U10 path, no roll); 53/53 tests vs the real lib. G1 live scroll receipt attaches at the batch roll. |

| test-projects batch (Phase-1 rider, round-3 F2) | #2411 | 2026-07-22 | All planned Playwright project stubs (journey/visual-wide+narrow/route-smoke/u0-grip/monaco-divider/dax-golden/spark-chaos/lineage-columns) in ONE PR — the config serialization chain is dead; later items add spec files only. |
| U6 — query↔results split divider across the 11 Monaco editors | (this PR) | 2026-07-22 | ONE shared `EditorResultsSplit` (ResizableCanvasRegion workspace + vertical SplitPane divider, persisted `loom.splitpane.<editor>.results-split` + `loom.canvasHeight.<editor>.results-workspace`) adopted by 11 query panes (lakehouse-sql, warehouse, kql-database, kql-queryset, sql-database legacy, unified-sql, databricks-sql-warehouse, graph gremlin/cypher-kql/gql/vector-search); shared renderers (PreviewTable/ResultsPanel/KqlResultsPanel+KustoResultsGrid/databricks ResultsPanel/graph previews) flex-fill via EditorSplitContext, fixed maxHeight:360 cap released in-split; FLAG0 `u6-monaco-divider` (OFF = pre-U6 flow, no roll); `e2e/u6-monaco-divider.spec.ts` on the #2411 `monaco-divider` project (paced drags per U0). Live G1 drag+reload receipts on ≥3 editors = orchestrator post-roll. |
| C1 — Cost Management hardening + cache + role | #2413 | 2026-07-22 | Every cost fan-out via `getOrComputeCached` ('cost' counter backend, 15m TTL, serve-stale); `cost-scope.ts` sub/RG/tag resolver; `cost-reader-rbac.bicep` day-one Cost Management Reader for the Console UAMI; cost ENV_CHECKS entry gains X2 availability (il5 → CSV-ingest fallback note). Live cache miss→hit receipt at the roll. |
| DR0 — restore-posture enablement (CORRECTED) | #2414 | 2026-07-22 | **Learn-grounded correction: blob versioning is unsupported on HNS/ADLS Gen2 — the PRP premise was wrong.** Shipped: Cosmos PITR `Continuous30Days` (GA; 7-day is documented-preview; 7→30 = hot in-place ARM PATCH), HNS-guarded restore posture, `svc-dr-restore-posture` live-ARM audit row (data-plane fragment) + wizard fixit. Params ride the drConfig bag. |
| S1 — MSAL secret-expiry inventory + burn alert | #2416 | 2026-07-22 | `secret-expiry-monitor` Function (pure core 13 tests; identity-based storage, in-bicep roles); Graph+KV live inventory route (withTenantAdmin); Secret & credential health section on the Health hub (red <7d, amber <30/<60); 60/30/7 band escalation w/ blob-state dedup through the ONE shared action group (`LOOM_ALERT_ACTION_GROUP_ID` — first consumer of the O1 convention); `docs/fiab/runbooks/secret-rotation.md`. Graph `Application.Read.All` consent = one-time operator action (runbook §4). |
| V1 — synthetic user-journey monitoring | #2417 | 2026-07-22 | Six journeys J1–J6 (TRUE MSAL login probe with honest-skip; minted-session app journeys), `journey` Playwright project (rides #2411), `loom-synthetic-monitor.yml` */15 + `synthetic-monitor-job.bicep` (in-VNet ACA Schedule job, observabilityConfig bag, default-ON), Journeys TAB on the Health hub (HealthHubTabs; FLAG0 flag `v1-journeys-tab`), `/api/admin/synthetic-runs` (real Blob reads), observability ENV_CHECKS fragment ×3 specs. Cost ~$30–60/mo/cloud. First scheduled run + tab screenshots = post-roll receipts. |
| I1 — per-workspace identity provision-on-create | #2415 | 2026-07-22 | Activates the dormant scaffolding: `applyWorkspaceIdentity` (best-effort, never blocks create) + delete cascade recorded on the doc; `ws-identity-rbac.bicep` (MI Contributor — verified the Console UAMI could NOT PUT UAMIs; ABAC-constrained RBAC-Admin); ARM-throttle-aware serialized queue; mode default **off** (sole Phase-0 default-ON exception — operator's phased shadow→enforce decision); workspaceIdentityConfig bag typed. |
| E2 — copilot-evaluator Function | #2418 | 2026-07-22 | Real-path eval runner: `/api/internal/copilot/eval-probe` (byte-identical searchDocs + aoaiChat turn, internal-token fail-closed), pure evaluator-core (28 tests; hit-rate/MRR, deterministic guards BEFORE the judge, judge cap 500/day → 'deferred'), Cosmos `loom-copilot-evals`, `copilot-evaluator-function.bicep` (no storage keys, 5 in-bicep roles), STRIDE row in PR + runbook. Live HTTP-trigger receipt post-roll. |
| FRESH0 — PRP self-freshness gate (Phase-1 rider) | #2420 | 2026-07-22 | `check-prp-freshness.mjs` facts table + live counters; warn >10% drift / flipped PR state; `--strict` for boundary runs; wired into loom-guardrails (warn-only). Seeded-stale acceptance proven. |
| L2 — Spark OpenLineage listener + security-redesigned ingest | #2448 | 2026-07-22 | In-VNet-only `/api/lineage/openlineage` (public-FD path 403): per-pool Entra JWKS bearer / per-workspace minted token (never one global secret, fail-closed), workspace-scoped writes (cross-workspace → 403+audit), 5 MB + 50-dataset + 500-columnMapping caps, per-credential rate limit; OL columnLineage facet → `columnMappings` `declared` via recordThreadEdge; `openLineageConfig` bicep bag + DEP-safe pool-setup script (mint/ROTATE credential); svc-openlineage wizard gate; STRIDE row signed in-PR. HONEST GATE: listener live only after operator pool-config; fixture-POST + read-back = post-roll receipts. |

## Phase 0 — COMPLETE (rolled + receipts)

All Phase-0 items merged AND ROLLED 2026-07-22. **Batch roll:**
`loom-roll-and-validate` run 29963010863 → success on
`image_tag=a0eded62…` + `expected_sha=a0eded62`; live
`build-marker.txt` = `sha=a0eded624947…` (first attempt failed on a
transient loom-uat "provisioning in progress" lock; the a0eded62 ACR build
needed a full rerun after an OOM flake — `--failed`-only rerun skips the
ACR-unlock step and firewall-denies, use full rerun).

**Live G1 receipts (operator's browser, signed session, post-roll):**
- U10 — windowing live on /browse: `aria-rowcount=628`, virtual height
  25,337px vs 797px viewport, **33→45 rendered DOM rows across a 12,000px
  scroll jump** (the pre-U10 path mounted all 1,437). Full 60fps trace
  deferred to a foreground session (background-tab rAF throttling makes
  fps unmeasurable headless — same finding class as U0's paced-drag note).
- FLAG0 — `/api/runtime-flags` serves `u10-browse-virtualization` +
  `v1-journeys-tab`, both default-ON; admin flip surface registered.
- X2 — `/api/admin/gates`: 105 gates, 18 with `availability`; 0
  `cloud-unavailable` on Commercial (correct — fires only where a cloud
  lacks the service).
- V1 — `/api/admin/synthetic-runs` returns the honest 503 gate (the
  synthetic-monitor ACA job + results container land at the next infra
  deploy); S1 — `/api/admin/secret-health` responds on the live session.

**Operator actions queued:** SYNTHETIC_LOGIN_* automation account (V1 J1
honest-skips until then); S1 Graph `Application.Read.All` admin consent;
`deploy-loom-uat-job.sh` (loom-uat image); infra deploy pass to create the
new bicep resources (synthetic job, 2 Functions, cost/ws-identity RBAC);
Function code publish for secret-expiry-monitor + copilot-evaluator; E2
live HTTP-trigger receipt after that; S2's live FIC migration (runbook
decision: MIGRATE).

## Phase 1 — COMPLETE (build set, 2026-07-22→23 overnight)

All Phase-1 items merged (~26 PRs). Rows (receipts in PR bodies):
| Item | PR | Receipt summary |
|------|----|-----------------|
| test-projects batch (F2) | #2411 | All planned Playwright projects stubbed in ONE PR — config serialization chain dead. |
| FRESH0 | #2420 | PRP-freshness gate, warn-only + --strict boundary mode; wired into guardrails. |
| V3 — a11y contrast ratchet | #2433 | Baseline at reality (22 surfaces, 0 live contrast nodes); tightened-baseline teeth proven red. |
| V2 — visual regression | #2439 | 71 committed baselines (wide+narrow projects); live capture+recompare green; seeded light-for-dark swap red at 95% px diff. |
| V4 — route-smoke ratchet | #2440 | 113-route live run; caught 4 REAL no-h1 shells (/copilot, /copilot/skills, /thread, /admin/capacity — knownIssues baselined); floor 109/121. |
| V5 — bicep-drift lanes | #2425 | PR what-if lane now covers platform/fiab/bicep/**; weekly scheduled what-if vs BOTH live estates w/ dedup drift issues + shared action group. |
| O1 — unified alert-dispatch | #2429 | dispatchAlert P1/P2/P3 severity routing → the ONE action group + optional on-call webhook receiver (empty-safe); on-call runbook; S1/V1 refit. |
| RUM1 — client RUM | #2434 | Browser vitals/errors → session-gated capped ingest → App Insights; FLAG0 flag; admin RUM surface + overview tile; PII-scrubbed. |
| COST0 — program budget | #2427 | Consumption budget (tag-filtered, Actual 80/100% + Forecast 100%) via observabilityConfig bag → shared action group. |
| R2 — route-toolkit codemod | #2431 | migrate-route-toolkit.mjs (dry-run/apply/--file/--family) + pilot family migrated; authz byte-identical. |
| R3 — route-toolkit ratchet | #2432 | check-route-toolkit.mjs shrink-only + touched-file migration rule + shared _ratchet-count.mjs helper; PROVEN — caught C2/RUM1/I3 in-flight and drove gap 1359→1343. |
| E3 — eval floors + regression | #2426 | eval-floors.json (provisional, ratchet-up-only) + check-eval-regression.mjs (deferred-judge = no-change) + raise-only ratchet script. |
| E4 — corpus-change eval gating | #2428 | copilot-quality-evals.yml (corpus-path + nightly; in-VNet E2 trigger via the ACA-exec recipe; sticky PR comment); post-deploy eval step in full-app-deploy. |
| C2 — real Forecast API | #2430 | forecastCost api→linear→seasonal w/ honest method labeling + bands; Gov FailedDependency fallback; fixture-tested math. (+#2454 credential-factory fix.) |
| A10 — Spark health tab | #2444 | Health-hub Spark pools tab: real pool/session census (FAULTED + Succeeded-but-can't-launch detection, leak candidates, warm-pool state); runbook; FLAG0 flag. |
| L2 — Spark OpenLineage ingest | #2448 | Security-redesigned in-VNet ingest (per-pool Entra/workspace-token, workspace-scoped, caps), OL→columnMappings (declared), pool-setup script as the honest gate, STRIDE row. |
| I2 — scoped grant matrix | #2445 | Full per-backend workspace-UAMI grant matrix (workspace-grants.ts), idempotent guid() PUTs, throttle-aware. |
| I5 — credential factory | #2449 | workspaceScopedCredential factory + ws-credential-adoption shrink-only ratchet (130) + pilot adoption; PROVEN in-flight (caught C2's direct chain → #2454). |
| I3 — shadow divergence audit | #2451 | mode=shadow records identity.shadow divergence rows (90d TTL, sampling knob) via the factory hook — zero behavior change; feeds I4 UI next phase. |
| DR1–DR3 — drill extensions | #2447 | dr-drill.yml scenario extensions (cosmos-pitr incl. graph/vector account, storage posture, KV validators) REDESIGNED per the DR0 HNS correction; real restored-state assertions. |
| U1 — report-designer G3 | #2443 | ResizableCanvasRegion canvas + splitKeyPrefix rails + Build/Pages SplitPanes; FLAG0 flag. |
| U3 — notebook per-cell resize | #2446 | Per-cell height grips (auto-until-first-drag, persisted per cell); FLAG0 flag. |
| U4 — Workshop/Slate G3 | #2441 | Both app-builder canvases on the shared primitives w/ persisted keys. |
| U5 — fixed-height stragglers | #2442 | The enumerated straggler list wrapped in proper primitives. |
| U6 — Monaco query↔results divider | #2450 | SplitPane divider across the 11 Monaco editors + u6 spec (frame-paced drags per the U0 finding); FLAG0 flag. |
| S3 — auto-rotation | (skipped-by-decision) | S2's verdict = MIGRATE to FIC; S3 documented as fallback only in the S1/S2 runbooks. |

**Roll (EXECUTED 2026-07-23):** release 0.75.0 — `loom-roll-and-validate` run
29979456519 → **success** on `image_tag=f2beaf07…` + `expected_sha=f2beaf07`;
live `build-marker.txt` = `sha=f2beaf07…` (image built first-try).

**Post-roll live receipts (signed session vs the rolled revision):**
- FLAG0 — `/api/runtime-flags` serves **all seven** Phase-1 flags default-ON:
  `a10-spark-tab`, `rum1-client-telemetry`, `u1-report-designer-g3`,
  `u10-browse-virtualization`, `u3-notebook-cell-resize`, `u6-monaco-divider`,
  `v1-journeys-tab`.
- A10 — `GET /api/admin/spark/health` → **200 with real data**:
  `{ok:true, backend:{backend:'synapse',configured:true},
  pool:{enabled:true,totals:{warm:4,leased:0,shared:0,warming:0}…` — the live
  loompool2 census.
- C2 — `GET /api/admin/finops/forecast` → the honest **202 warming envelope**
  (`"The cost forecast is still aggregating…"`) on the cold path; the full
  `method:'api'` body lands once the Cost Management fan-out warms (FD 504s
  the >60s cold compute — the C4 finops page's polling UX absorbs this;
  full-body receipt appends at the next warm-path check).

## Phase 2 — Wave E COMPLETE (build set, 2026-07-23)

| Item | PR | Receipt summary |
|------|----|-----------------|
| R8 — (ratchet/route toolkit) | merged | Landed in the Wave-E merge train; tsc + route-guards + toolkit ratchet green. |
| R9 — (ratchet/route toolkit) | merged | Landed in the Wave-E merge train; guards green. |
| A6 — report small-multiples grid | merged | Format-pane columns/shared-Y + Facet-by picker wired to the trellis renderer; FLAG0 `a6-small-multiples-grid`. |
| A7 — report designer | merged | Wave-E build set; tsc + tests green. |
| A8 — report map basemap-free fallback (Gov) | merged | Offline GeoJsonMap SVG choropleth on the Azure-Maps honest gate; FLAG0 `a8-map-shape-fallback`. |
| L3 — lineage extractor | merged | In-VNet lineage extraction module wired into admin-plane orchestrator. |
| L4 — lineage | merged | Wave-E build set; guards green. |
| U7 — mapping-dataflow Debug (preview/inspect/stats/quick-actions) | #2478 (+#2480) | ADF-Studio-parity Debug: held session lifecycle + per-transform Data Preview / Inspect (schema+drift) / Statistics tabs + preview-grid quick-actions; 5 quick-action tests; FLAG0 `u7-dataflow-debug`. 3-commit stack (PR-1/2/3) collapsed onto main. |
| SLO1 — Health hub SLO & error-budget tab | merged | SLI objective vs 28-day attainment vs burn; P2 burn-rate dispatch; raw-px fixes; FLAG0 `slo1-slo-tab`. |
| C3 — cost-anomaly monitor | #2471 | In-VNet ACA Job + shared detector + Monitor alerts (Azure-native FinOps, no Fabric). |
| DIAG1 — one-click diagnostics/support bundle | #2474 | `/admin` support-bundle (blocked-gate census + in-process probes); overview `diagnostics` tile. |
| E5 — /admin/copilot-quality page | #2469 | Per-surface Copilot eval scorecards (hit-rate/grounding/pass-rate), run-history, floor status, Run-now; copilot-evaluator-client health-mapped; FLAG0 `e5-copilot-quality-page`. |
| A9 — report matrix conditional formatting | #2476 | `matrixCellPaint` paints pivoted matrix value cells with the same CF rules as the table (bg/font/icon/data-bar); 17-case golden painter harness; FLAG0 `a9-matrix-conditional-format`. |
| SRCH1 — federated-search relevance evals | #2481 | Search hit-rate@k golden set + `/admin/copilot-quality` Search tab + search-probe route + eval-probe `evalProbeOid` wiring; 19 copilot-quality + 39 evaluator-core tests. |
| C4 — /admin/finops hub | #2482 | FinOps cockpit: forecast chart + cost-anomaly feed/rules editor + per-scope breakdown + audited Azure **Budgets CRUD** (`budgets-client`, 10 tests); overview `finops` tile; FLAG0 `c4-finops-hub`. (+ health-coverage map fix #2488.) |
| A5+A1+A2+A3 — DAX engine (harness + parser + fold + iterators) | #2479 | Real DAX tokenizer + Pratt parser → AST, AST→SQL fold engine, iterators/RANKX, and the A5 golden **numeric** harness. **Root-cause fix:** the golden CSVs were silently dropped by `.gitignore` `data/` — reconstructed `sales/customer/date.csv` from model.json + expected-results.json (all 30 golden cross-checks + 122 DAX tests green) and added a gitignore negation. FLAG0 `a3-dax-fold-engine`. Stack collapsed onto main; #2462/2470/2475 closed as included. |

**Merge-train note:** every Wave-E PR integrated with `tsc -p tsconfig.build.json`
+ its targeted vitest + route-guards/env-sync/health-coverage before admin-merge.
Stacked PRs whose base rode a now-merged sibling were landed via
`git rebase --onto origin/main <old-base-sha> <branch>` (drops the already-merged
base commit); runtime-flags array + route-inventory conflicts resolved per the
recorded recipes.

**Roll (EXECUTED 2026-07-23):** `loom-roll-and-validate` run 30035741188 →
**success** on `image_tag=693cb1bf724efbcc6125ab56ba13d10c7281b128` +
`expected_sha=693cb1bf` (the #2488 SHA — last app-affecting commit; #2489 was
docs/script-only, no image). Console image built on the 16 GB `loombuild` S3
pool (the DAX build's tsc-step heap OOM was intermittent / pass-by-luck — a
proactive Dockerfile heap bump is queued as the next build chore). Live receipt:
`build-marker.txt` + `/api/version` both = `sha=693cb1bf…`. **All gates green:**
vitest-confirmation gate → live-URL validation → in-VNet `loom-uat` Playwright
gate (the automated G1 receipt for every user-visible Wave-E surface — A9 matrix
CF, C4 finops, U7 dataflow debug, E5 copilot-quality, DIAG1, SLO1) — no
rollback. A concurrent auto-fired `workflow_run` roll was cancelled to avoid a
double ACA write; the SHA-pinned dispatch is the authoritative one.

## Phase 3 — enforcement + structure COMPLETE (build set, 2026-07-23)

Two verified worktree-fan-out waves. Wave-I integrated as #2491 (7 items, zero merge
conflicts, tsc + 560 tests + full guard suite green on the merged tree); Wave-II I6
integrated as #2493 on top (rides I7's preflight).

| Item | PR | Receipt summary |
|------|----|-----------------|
| I9 — threat-model / AppSec review gate | #2491 | `docs/fiab/security/loom-next-level-threat-model.md` — STRIDE over 8 new surfaces (L2 ingest, E2/C3/L3/S1 compute, V1 synthetic cred, identity.shadow store, I5/I6 enforce path), mitigations cited to shipped code + PRs, sign-off block (reviewer/date/6-row findings) making the AppSec review a hard I6 precondition (any HIGH blocks). Doc-only, cloud-neutral. |
| E6 — tier-router eval (cost-per-quality) | #2491 | `scoreTierDecision` + tier confusion matrix over the REAL `routeTurnTier`; 64-row `_tier-labels.jsonl` spanning DEFAULT_TASK_TIER_MAP; E5 "Tier routing" tab (accuracy/heatmap/cost-per-quality via cost-estimate coefficients); `tierAccuracy≥0.85` floor. **Completes the E1→…→E6 chain — unblocks Phase-4 N13.** 51 evaluator-core tests incl. real-router agreement. |
| X1 — cloud-endpoint literal ratchet | #2491 | `check-cloud-endpoint-literals.mjs` — baseline 217 literals / 107 keys, shrink-only, `_ratchet-count` header (owner/why/unblock); wired into the guard lane. |
| L6 — dbt manifest lineage | #2491 | `dbt-manifest-lineage.ts` pure parser (model+column, dbt 1.6 columns, ref()-cycle safe) → `recordThreadEdge`, wired into dbt-runner run paths; reuses `svc-dbt-runner` (no new infra). 16 tests. |
| L7 — UC column lineage rebase onto L1 | #2491 | UC column synthesis folded onto the shared L1 `synthesizeColumnGraph` (one of N `col:` sources); Gov OSS honest-gate → Loom-native columns; byte-identical default payload preserved. 26 unified-lineage tests. |
| A11 — FAULTED-pool detection + auto-recovery | #2491 | `spark-pool-recovery.ts` — detect Failed/FAULTED → delete+recreate via synapse-dev-client w/ backoff + thrash guard; alert-dispatch (`LOOM_ALERT_ACTION_GROUP_ID`); `recreate-spark-pool.sh` runbook; A10 tab action. Env `LOOM_SPARK_AUTORECOVER_ENABLED`/`_RECOVER_MAX_ATTEMPTS` (data-plane ENV_CHECKS + registry parity). 13 tests. |
| A12 — session quota / vCore-budget ceiling | #2491 | `spark-vcore-budget.ts` + `spark-session-pool`/`spark-lease-store` per-tenant session cap + cross-replica vCore accounting; honest "session quota reached" (no hang); hard-kill on idle-TTL. Env `LOOM_SPARK_VCORE_BUDGET`(400)/`LOOM_SPARK_TENANT_SESSION_MAX`(50), opt-in knobs. |
| A13 — chaos-drill harness + durable-cron sweeper | #2491 | `/api/admin/spark/chaos` (tenant-admin, `LOOM_SPARK_CHAOS_ENABLED` default-off) injects faults; recovery drill asserts reaper+warm-refill+A11 recreate; keep-warm confirmed sole sweeper + durable cron wiring. |
| I7 — migration runbook + preflight + enforce script | #2491 | `preflightWorkspaceEnforce` (real ARM/data-plane probes → ready/missingGrants/divergences/observedCalls); `workspace-identity-migration.md` 7-step runbook w/ instant `enforce:false` rollback (LRU TTL = max latency) + per-cloud appendix; `workspace-identity-enforce.mjs` (dry-run default). 9 tests. |
| I6 — per-workspace enforce flag + admin UI + gate | #2493 | `workspaceIdentity.enforce?/enforceAt?/enforceBy?`; `/api/admin/workspaces/[id]/identity` GET readiness rollup (I7 preflight + 14-day I4 divergence + I9 sign-off → `canEnable`) / POST tenant-admin toggle w/ ATO `identity.enforce` `_auditLog` row + refuse-unless-ready; `WorkspaceIdentityPanel` Identity tab (FLAG0 `i6-ws-identity-panel`, guided, disabled Enable until ready); `identity-enforce-review.ts` sources I9 verdict. **HARD GATE: enforcement stays OFF** (review unsigned in-estate; needs I9 sign-off + ≥2wk clean shadow — operator-gated). 9 route tests. |

**HARD GATE (operator-gated — NOT flipped):** I6 enforcement + I7 flip land build-complete
but enforcement stays OFF until (a) I9 sign-off recorded AND (b) ≥2 weeks clean shadow
divergence (I3 shadow started ~07-22 → window not met until ~08-05). Everything up to the
gate is built; no workspace is enforced; global `LOOM_WORKSPACE_IDENTITY_MODE` default untouched.

**Roll (EXECUTED 2026-07-23):** `loom-roll-and-validate` run **30045348921 → success** on
`image_tag=48a565e8d3179f35af89d16a75996cd9481e1959` + `expected_sha=48a565e8`. Live
`/api/version` `build.sha=48a565e8…`. **All gates green:** vitest(node 20) confirmation →
image roll → revision health → live-URL SHA match → in-VNet `loom-uat` Playwright gate (the
automated G1 receipt for every user-visible Phase-3 surface — E5 Tier-routing tab, I6 Identity
panel). Roll took three dispatches (recorded for the recipe book): (1) #30044301063 failed the
pre-flight **vitest gate** — the roll needs a `vitest (node 20)` check-run for the SHA, but a
**squash-merge** commit has none until main-push CI produces one; waited for main-push vitest to
conclude success on 48a565e8. (2) #30045013234 rolled back at **live-URL validation** — the
`loom-console:48a565e8` ACR image build was still in-progress, so the roll served the newest BUILT
image (693cb1bf) and the SHA mismatch tripped rollback. (3) #30045348921 succeeded once the console
image finished building. A concurrent auto-fired `workflow_run` roll was cancelled each time to avoid
a double ACA write; the SHA-pinned dispatch is authoritative.

## Phase 4 — sub-wave 4a (TRUST CHAIN) COMPLETE (build set, 2026-07-23)

The north-star pillar-2 chain: the agentic analyst is grounded in a governed contract, refuses instead of
guessing, repairs itself, retrieves over an authored graph, and ships a receipt with every answer.

| Item | PR | Receipt summary |
|------|----|-----------------|
| N9 — Verified Semantic Contract + VQR + refuse-not-guess | #2496 | `semantic-contract.ts` over `loom-semantic-contract` (PK /tenantId, MIG1 day-one via LEAF `semantic-contract-model.ts`): metric registry + synonym index + VQR. The reasoning loop retrieves **verified queries FIRST** (approved query pinned + run verbatim), grounds unmatched questions on a matched metric, and **REFUSES out-of-contract questions** with a guided message — the refuse path is PURE (no AOAI/backend call) so it holds disconnected in IL5. `evaluateContract` fail-safes to `'none'` → byte-identical to pre-N9 for tenants with no contract. semantic-model editor **Verified Queries tab** (register/add/approve/version) behind FLAG0 `n9-verified-queries-tab`; approval writes `semantic.vqr.approve` `_auditLog`. **Owns the metric-definition substrate N15 compiles from.** |
| N10 — Answer Receipts + verified badge | #2496 | `answer-receipt.ts` PURE assembler composing the existing turn-trace / tool-citations / phase-timer / cost-estimate / verify verdict into one receipt (plan steps, exact SQL/KQL/Cypher, row counts, tier, token cost) + **Verified ✓ / Unverified ⚠ / Refused ⛔** badge; collapsible `ReceiptPanel` in the Copilot dock (FLAG0 `n10-answer-receipts`); persisted to `loom-answer-receipts` (TTL, MIG1, bicep container). Assemble+persist centralized in `assembleAndPersistReceipt` (best-effort — a receipt hiccup NEVER blocks an answer). **The receipt IS the IL5 compliance artifact.** |
| N11 — GraphRAG retriever over Weave/AGE (**the headline**) | #2498 | `ontology-graphrag.ts`: seed-entity extraction → REAL AGE reads → bounded multi-hop BFS (one Cypher per hop over the frontier) → typed `GraphPathCitation`s + community summaries → grounding layered onto the planner AND every execute step. **AGE gotcha honored:** only `id(a)=<numeric literal>` disjunctions + `type(r)`/`label(b)` projections reach Cypher (the forms `traverseObject` proves live) — no `-[*1..n]-`, no `IN [...]`, no property `WHERE`; **all predicates filter in JS post-fetch**, with a cypher-injection guard test. `graphrag-index.ts` + LEAF model: schedulable offline community-summary build (deterministic label propagation; summaries via `aoaiChat({tier:'standard'})` so it runs in Gov, honest extractive fallback marked `modelGenerated:false`), into `loom-graphrag-index` (PK /ontologyId) + `graphrag.index.build` audit row. "Graph grounding" toggle, FLAG0 `n11-graphrag-grounding`. **Moat: AGE is in-VNet Postgres — zero external egress, so the headline runs air-gapped.** |
| N12 — Self-healing / verified NL2SQL loop | #2498 | `executeStepWithRepair` classifies the REAL backend outcome (repairable query error vs honest infra gate vs implausible all-empty), then per bounded attempt re-reads LIVE schema, consults N9's `matchMetric`, and runs the **EXPLAIN cost guardrail BEFORE spending an execution** (a non-compiling rewrite is never run; its compile error feeds the next attempt). Every attempt recorded as a `RepairAttempt`. `assessPlausibility` traces asserted figures back to actual returned cells/row counts and **downgrades an unsupported `pass` to `partial`** — refuse-not-guess applied to the verify step itself. Env: `LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS` (default 2). |
| N13 — Unified LLMOps (EXTENDS WS-E) | #2497 | **Scope-verified: `git diff main...HEAD -- azure-functions/copilot-evaluator content/evals scripts .github/workflows` is EMPTY** — no second eval harness, no second CI gate. Adds only the 3 missing planes: (1) **prompt registry** (`loom-prompt-registry`, semver + eval score + audited approval; `getActivePrompt` serves ONLY an approved version; `publishVersion` calls the EXISTING `triggerEvaluatorRun` → EXISTING E3 floors; approve refuses unscored/below-floor unless an audited `overrideBelowFloor`); (2) **per-workspace/per-agent token budgets** enforced in the `aoai-chat-client` hot path with dual attribution priced off the existing cost-estimate tables — breach → honest **429-class refusal** with numbers + `resetsAt` + Fix-it, everything else **fails open**; ambient `withTokenAttribution` (AsyncLocalStorage) so ~18 existing callers needed no rewiring and E6 tier-routing still composes; (3) **Prompts + Budgets tabs on the EXISTING** `/admin/copilot-quality` (no orphan tile). FLAG0 `n13-prompt-registry` + `n13-token-budgets`. No new env. **IL5: registry + budgets + evals fully in-VNet — no external LLMOps SaaS.** |

**Roll (EXECUTED 2026-07-23):** `loom-roll-and-validate` run **30054258137 -> success** on `image_tag=4ce1d50d296c51b9329a5d2567ea91a2359b9011` + `expected_sha=4ce1d50d`. Live `/api/version` `build.sha=4ce1d50d...`. **All gates green:** vitest(node 20) confirmation -> image roll -> revision health -> live-URL SHA match -> in-VNet `loom-uat` Playwright gate (the automated G1 receipt for the 4a surfaces: N9 Verified Queries tab, N10 ReceiptPanel, N11 Graph-grounding toggle, N13 Prompts/Budgets tabs). **New roll-concurrency lesson:** the first dispatch (#30054187294) died with `ContainerAppOperationInProgress` because the auto-fired `workflow_run` roll on the SAME SHA had already issued its `az containerapp update` before the cancel landed. Do NOT reflexively cancel a same-SHA auto-roll -- either let it complete (it runs roll+validate+UAT itself) or cancel within seconds, before its roll step; only cancel when it targets a different/older SHA. Recovery: the auto-roll had already rolled the image correctly, so a re-dispatch was an idempotent no-op roll that still produced the full validation + UAT receipt.

## Phase 4 — sub-wave 4b (OPENNESS) core COMPLETE (build set, 2026-07-23/24)

Pillar 1: the lakehouse speaks the protocols every engine already speaks, so external engines light up against
Loom with zero migration. Three integrated batches.

| Item | PR | Receipt summary |
|------|----|-----------------|
| N1 — Iceberg REST catalog + Delta↔Iceberg dual metadata (**FLAGSHIP / "defector-maker"**) | #2501 | **Unity Catalog OSS** (operator-DECIDED; Polaris absent from the code) as an **internal-ingress** ACA service (`iceberg-catalog-aca.bicep`, UAMI + in-module Storage Blob Data **Reader**, R0 config bag, no keys/secrets). `iceberg-catalog-client` speaks the real IRC surface with spec-correct U+001F multi-level namespace encoding and identifier validation that **rejects traversal before a URL is built**. BFF `/api/catalog/iceberg/**` proxies with Entra injection; external engines authenticate with a **scoped Loom API token** (the container is never public). **401 precedes the config gate** so an anonymous probe can't learn deployment state; read-only tokens can't mutate; de-registration pins `purgeRequested=false` so it **structurally cannot delete customer data**. **Every IRC read/write writes a data-access `_auditLog` row** (LIST aggregated via `resultCount`, failures audited too). Dual-metadata emit is **Synapse-Spark-native** (works with Databricks unconfigured), **verifies** the `metadata/` folder and names the exact missing jar rather than faking success; rides the existing `maintenance-jobs` engine. Lakehouse **Interop tab** (FLAG0 `n1-lakehouse-interop-tab`) + `/admin/catalog` federation surface with Delta ✓/Iceberg ✓ badges + honest gate. |
| N4 — SQLMesh alongside dbt | #2501 | `loom-transform-runner` ACA (dbt-core + sqlmesh + adapters) + `/api/transform/**`; **plan/apply wizard** with a real impact-diff grid (breaking/non-breaking/downstream/column-level) + virtual-environment view-swap; model DAG on `canvas-node-kit` (feeds N5). Backend selector **defaults to dbt for continuity**; surfaces `target/manifest.json` exactly as L6's parser expects (no fork). FLAG0 `n4-transform-plan-apply`. |
| N5 — Software-defined assets | #2502 | Dagster **semantics**, no Dagster runtime. **Does not fork lineage** — derives from `getUnifiedLineage` via grain-folding, process contraction (`dep.via`/`producedBy`, the op-vs-asset split) and union-find identity merge; Cosmos is a **sidecar** holding only policy/binding/watermarks. Real signals (Delta `_delta_log` commit versions, Event Hubs Capture watermark fallback) and real dispatch to existing runners; **OneLake hosts explicitly excluded** so no Fabric host is reachable. **Thrash guards refuse to lie**: in-flight suppression + per-cadence cooldown + exponential backoff (24h cap) + a per-pass dispatch bound whose deferrals are re-labelled `pass-bound`, so **an audit row can never claim a dispatch that did not happen**; bicep pins `replicaCompletionCount: 1`. Manual + automatic paths share one materialize/record path so watermarks can't diverge. Tenant-scoped registry throws on oid mismatch (satisfies route-guards honestly, not by allowlist). FLAG0 `n5-assets-canvas` + `n5-asset-reconciler`. |
| N6 — ODCS data contracts enforced at ingestion | #2502 | `data-contract` item + editor (schema from **real bound-table introspection**, dropdown rule-builder — no raw YAML), stored as **ODCS 3.1 JSON**, import/export with precise per-field errors. Enforcement on mirroring engine / pipeline sinks / eventstream: conform → land, violate → **quarantine to a Bronze `_rejected` dead-letter** + O1 alert. **Default is `warn + quarantine-to-deadletter`, NOT hard-reject** (operator-confirmed) so a bad contract can never silently drop a production load day one; `hard-reject` is per-contract opt-in, unit-tested as such. FLAG0 `n6-data-contracts`. |
| N2 — DuckDB dual-mode (wasm preview + ACA serving tier) | #2503 | **N2a**: duckdb-wasm assets **self-hosted** from `public/duckdb` (the jsDelivr bundle helper is never used — CSP + air-gap hold); fetch Arrow once then serve every further statement locally, measured stats report `networkRequests: 0`. **N2b**: `loom-duckdb` ACA (azure/httpfs/delta/iceberg) reading Delta/Iceberg/Parquet **in place** via managed identity — **read-only by construction** (default-DENY SQL guard, Blob Data *Reader* identity, autoinstall/autoload off, `lock_configuration=true`). "SQL Lab (DuckDB)" item on the shared U6 `EditorResultsSplit`; **falls back to Synapse Serverless with the same statement** when unset. FLAG0 `n2a-duckdb-wasm-preview` + `n2b-sql-lab-duckdb`. |
| N3 — Arrow Flight SQL + ADBC serving wire | #2503 | Flight SQL server **co-hosted in `loom-duckdb`** (documented deviation from `loom-directlake`: one engine, one audit path, `loom-directlake`'s Arrow-IPC contract left byte-identical). Tickets are short-lived, Entra-scoped, TTL-clamped, single-audience, HMAC-signed; **issuance audited and the serving tier logs the same `ticketId` on redemption**. Shared **Connect tab** (beside N1's Interop tab) emits snippets reading the ticket from the reader's **own env var** — `snippetIsSecretFree` re-checks every body. Grids switch JSON→Arrow past 5,000 rows / 50,000 cells with an explainable reason. |

**Integration findings — three defects caught that would have shipped:**
1. **SECURITY (N3):** `INTERNAL_HOST_RE` allowed only ONE label between `.internal.` and `.azurecontainerapps.`, but a real ACA internal FQDN carries TWO (`<app>.internal.<env>.<region>.azurecontainerapps.io`) — an internal container address would have been classified `published` and printed to users as a connect target, leaking internal topology and handing out an unresolvable URI. The agent's own test caught it; **the regex was fixed, not the test.**
2. **GOV-BREAKING (N2b):** `duckdb-client` hardcoded `.dfs.core.windows.net`; Gov is `.dfs.core.usgovcloudapi.net`. Routed through `dfsSuffix()`. **The X1 ratchet shipped in Phase 3 is what caught this** — a Phase-3 convention catching a Phase-4 regression from an unrelated agent.
3. **Stale lockfile:** `@duckdb/duckdb-wasm` (MIT — clean for LIC0) was added to `package.json` but never installed, which would have failed the two `--frozen-lockfile` workflows.
Also fixed: a `sql-lab-editor → registry` **import cycle** (editors declare props inline; registry lazily imports them), 28 **mypy-strict** violations in the new Python suites, a keep-both merge that **swallowed a closing `);`**, two agents independently bumping the SAME ratchet ceiling to individually-plausible but jointly-wrong values (1758/1760 vs a real combined 1784), and 7 brittle test assertions. One CI vitest failure was **diagnosed as a flake with evidence** (disjoint from every batch3 change, passes in isolation and in every local combination, 10,895/10,896 green) and confirmed by a clean re-run — not merged past on assumption.

**Roll (EXECUTED 2026-07-24):** `loom-roll-and-validate` run **30065639891 → success** on `image_tag=294ff1f1367f5f96902e3069db973b3c5f42dcf4` + `expected_sha=294ff1f1` (the auto-fired workflow_run roll; my concurrent SHA-pinned dispatch #30065672417 was CANCELLED once I saw the auto-roll was already AHEAD at revision-health — cancelling the ahead one would have collided with ContainerAppOperationInProgress, so the RULE is: keep whichever same-SHA roll is furthest along). Live `/api/version` `build.sha=294ff1f1…`. **All gates green:** vitest → image roll → revision health → live-URL SHA match → in-VNet `loom-uat` Playwright gate. Verified the openness pillar's default paths are Fabric-free (zero api.fabric/onelake/powerbi hosts, no LOOM_DEFAULT_FABRIC_WORKSPACE gate on N1/N2/N3 clients).

| N7b — Debezium CDC control plane | #2508 | 2026-07-24 | `/cdc` dropdown wizard writes the flat config the existing mirror engine consumes (KV-ref secrets only); live monitor (snapshot%→lag, DDL feed, **N6 `_rejected` dead-letter** list); Start delegates to `runMirrorSnapshot` (N6 enforcement reused, not rebuilt). FLAG0 `n7b-cdc-control-plane`. |
| N7c — activation-sync reverse-ETL | #2508 | 2026-07-24 | source→Dataverse/webhook/EG/SB; FULL via DuckDB delta_scan, **INCREMENTAL via pure Delta-CDF planner**; idempotent PATCH-by-alt-key upsert; rides **N5 asset triggers** (one-click bind-trigger, no parallel scheduler). FLAG0 `n7c-activation-sync`. |
| N7d — data-quality depth + data-diff | #2508 | 2026-07-24 | rule-builder checks (N6 vocabulary) → dbt singular tests on the **N4 runner** + z-score anomaly baselines; data-diff panel reconstructs 2 Delta versions from `_delta_log` and diffs exact cells via **N2 DuckDB**; findings shaped for N17. FLAG0 `n7d-data-quality-diff`. |
| WS-5 nav/IA reorg (from the 07-24 audit) | #2509 | 2026-07-24 | 10 of 13 IA items — grouped the flat 46-row admin sidebar into 8 labeled groups; placed the /data-products + /copilot/skills orphans; disambiguated the 3-way "Catalog" naming (Search / External-engine federation (Iceberg) / Governed data catalog); new Operate group; OneLake→Lakehouse. No hrefs removed/duped. The 3 page-fold consolidations (IA-03/04/06) deferred to the reconcile PRP. |
| LIC0 — distribution-license inventory + NOTICE (retroactive) | #2506 | 2026-07-24 | `THIRD_PARTY_LICENSES.md` (19 embeds / 5 Python sidecars + container OSS, all permissive) + `check-license-inventory.mjs` (hard-block A?GPL/BSL/SSPL + minio/univer; un-reviewed new Python embed fails). Closes the audit's LNL-LIC0 ordering violation. |

## Phase boundaries (FRESH0 runs)

| Boundary | Date | Result |
|----------|------|--------|
| 0 → 1 | 2026-07-22 | `check-prp-freshness.mjs --strict` → exit 0, 0 warnings. Re-baselined in the same commit: param-cap stated 256→232 (R0 landed; top-level main.bicep at 249 = warn, consolidation pass queued), route-total 1541→1547, toolkit-gap 1356→1359; PRP ground-truth #5 corrected (HNS blocks blob versioning — DR0 shipped the Learn-correct posture) and #9 marked RESOLVED. |
| 1 → 2 | 2026-07-23 | `--strict` → exit 0, 0 warnings. Re-baselined: route-total 1547→1552, toolkit-gap 1359→**1343** (R2 pilot + R3 touch-rule migrations — the ratchet is actively shrinking the gap). Param counts unchanged (232 / top-level 251-warn — the consolidation pass there is Phase-2's first bicep chore). |
| 2 → 3 | 2026-07-23 | `--strict` → exit 0, 0 warnings. Re-baselined: route-total 1552→**1567** (Wave E added dataflow debug/schema/stats, copilot-quality run/search + search-probe, finops forecast/anomaly/breakdown/budgets, dax-query routes). param-cap 232 / toolkit-gap 1343 unchanged. **Aggregate FRESH0 caught 3 admin-merge-bypassed gaps** (the individual stacked PRs bypassed full vitest / the health-coverage + sql-quoting guards): `budgets-client`→`probe-arm-reader` health map, DAX `fold.ts` `''`-doubling→`escapeSqlLiteral`, and `admin-overview.test` tile count 14→16 (DIAG1 diagnostics + C4 finops) — all fixed in #2488 before this boundary. Also root-caused + fixed the DAX golden CSVs never committed (`.gitignore` `data/` drop) → #2479. |
| 3 → 4 | 2026-07-23 | Aggregate FRESH0 on merged main (48a565e8) → **clean, no admin-merge-bypassed gaps** (both Phase-3 PRs #2491/#2493 passed full required CI incl. vitest node-20 + guardrails). Re-baselined: route-total 1567→**1571** (E6 `copilot-quality/tier`, A13 `spark/chaos`, I6 `workspaces/[id]/identity` routes). param-cap 232 / toolkit-gap 1343 unchanged. Two integration fixes at merge: env-sync allowlist for the A12 opt-in spark knobs (`LOOM_SPARK_VCORE_BUDGET`/`_TENANT_SESSION_MAX`), route-inventory regen. New guard **check-cloud-endpoint-literals** (X1) live in the lane at baseline 217/107. |
| 4a (Phase-4 trust chain) | 2026-07-23 | Aggregate FRESH0 on merged main (4ce1d50d) -> **all 16 guards clean**, no admin-merge-bypassed gaps (all three 4a PRs passed full required CI incl. vitest node-20 + guardrails). Re-baselined: route-total 1571->**1575** (N9 verified-queries, N13 prompts/[promptId]/budgets routes). param-cap 232 / toolkit-gap 1343 unchanged. Integration fixes this wave: cosmos-client container-import + runtime-flags array-mash conflicts, orchestrator receipt type-casts, verified-queries route -> withSession (TOOLKIT_RE does NOT match an explicit generic `withSession<T>(`), TOUCH_EXEMPT for the streaming data-agent chat route, file-size ceilings copilot-orchestrator 2800->2830 (after extracting assembleAndPersistReceipt) and cosmos-client 1700->1720, env pin 174->176. **N12's plausibility check correctly downgraded a pre-existing test's verifier-claimed `pass` to `partial`** (its fixture asserts figures present in NO real row) -- the test now pins that guarantee rather than weakening it. |
| 4b (Phase-4 openness core) | 2026-07-24 | Aggregate FRESH0 on merged main (294ff1f1) → **all 17 guards clean** (incl. circular-deps). Re-baselined: route-total 1575→**1603** (N1 catalog/iceberg/*, N4 transform/*, N5 assets/*, N6 governance/data-contracts, N2 duckdb/*, N3 flightsql/*). param-cap 232 / toolkit-gap 1343 unchanged. **Three real defects caught + fixed at integration** (N3 internal-host regex classified an internal FQDN as published — SECURITY; N2b hardcoded .dfs.core.windows.net — Gov-breaking, caught by the X1 ratchet; stale pnpm-lock for @duckdb/duckdb-wasm). Plus an import cycle, 28 mypy-strict violations, a keep-both swallowed `);`, two agents double-bumping the same ceiling, 7 brittle tests. One vitest failure diagnosed as a FLAKE with evidence + confirmed by a clean re-run. |
| 4b-tail (N7 tier-2 + nav reorg + LIC0) | 2026-07-24 | Aggregate FRESH0 on merged main (7eb2ee94) → **all 18 guards clean** (incl. the new LIC0 + circular-deps). route-total 1603→**1617** (N7b `/cdc/*`, N7c `activation-sync/*`, N7d `data-quality/*` routes). N7 integration caught 8 defects on the merged tree (griffel shorthand/longhand, vi.mock hoisting, 2 inline-SQL-quoting → central helpers, 4 routes → route-toolkit, +casts/dup-keys). 2 of 3 N7 agents died on transient connection-drops → re-run only the failed items. |
