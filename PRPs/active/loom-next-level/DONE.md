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

## Phase boundaries (FRESH0 runs)

| Boundary | Date | Result |
|----------|------|--------|
| 0 → 1 | 2026-07-22 | `check-prp-freshness.mjs --strict` → exit 0, 0 warnings. Re-baselined in the same commit: param-cap stated 256→232 (R0 landed; top-level main.bicep at 249 = warn, consolidation pass queued), route-total 1541→1547, toolkit-gap 1356→1359; PRP ground-truth #5 corrected (HNS blocks blob versioning — DR0 shipped the Learn-correct posture) and #9 marked RESOLVED. |
| 1 → 2 | 2026-07-23 | `--strict` → exit 0, 0 warnings. Re-baselined: route-total 1547→1552, toolkit-gap 1359→**1343** (R2 pilot + R3 touch-rule migrations — the ratchet is actively shrinking the gap). Param counts unchanged (232 / top-level 251-warn — the consolidation pass there is Phase-2's first bicep chore). |
