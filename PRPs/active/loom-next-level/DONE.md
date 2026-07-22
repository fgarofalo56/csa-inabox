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

## Phase 0 remaining

- **In CI:** U10 #2410, test-projects batch #2411 (Phase-1 rider).
- **Wave B in flight (agents):** V1, S1, DR0, C1, I1.
- **Then:** E2 (strictly after E1 — Phase 0 tail), batch roll + G1 receipts,
  FRESH0 re-baseline at the 0→1 boundary.

## Phase boundaries (FRESH0 runs)

| Boundary | Date | Result |
|----------|------|--------|
| (none yet) | | |
