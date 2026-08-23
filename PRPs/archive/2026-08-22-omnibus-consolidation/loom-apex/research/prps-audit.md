# All-PRPs completeness audit — 2026-07-24

**Scope:** every file under `PRPs/active/**` (15 program areas, 62 files), cross-checked against
`PRPs/active/loom-next-level/DONE.md` and code-level spot-checks on `main`/HEAD
(branch `docs/reconcile-p2-verification`, HEAD `93aae674`; last main merge `d713354e` #2523).
**Classification legend:** ALREADY-BUILT · REAL-GAP · OPERATOR-GATED · SUPERSEDED · STALE-DOC · FUTURE-PROGRAM.
Every claim cites file evidence gathered in this session; nothing asserted from memory.

**Note:** `model-strategy` and `public-release` (named in the task) are no longer active — they live at
`PRPs/completed/model-strategy/` and `PRPs/completed/public-release/` (verified `ls PRPs/`), consistent
with memory that both shipped. They are excluded from the remaining-gap table.

---

## 1. File inventory under PRPs/active/**

| Program | Files |
|---|---|
| loom-next-level | `DONE.md`, `PRP.md`, `ws-copilot-cost.md`, `ws-identity-cloudmatrix.md`, `ws-lineage-depth.md`, `ws-migration.md`, `ws-north-star.md`, `ws-ratchets.md`, `ws-ui-excellence.md`, `ws-verification-dr.md` |
| reconcile | `PRP.md` |
| foundry-parity | `PRP.md`, `AUDIT.md`, `receipts/nodekit-v4-{dark,light}.png` |
| loom-competitive-audit-2026-07-20 | `PRD.md`, `PARITY-MATRIX.md`, `FINDINGS-REPORT.md`, `README.md`, `research/01..05` |
| weave-powerbi | `PRP.md` |
| access-governance | `PRP.md` |
| domain-mesh | `PRP.md` |
| geo-graph-ml | `PRP.md` |
| bridge-services | `PRP-bridge-services.md` |
| enterprise-hardening | `README.md`, `PHASES.md`, 10 appendix files |
| next-waves | `MASTER-ROLLOUT.md`, `WAVES.md`, 8 `PRP-*.md`, `copilot-ai-G1-G6-verification.md`, `fabric-ux-observations.md` |
| ux-fabric-a | `PRP.md` |
| docs-sweep | `README.md` |
| (register) | `OPEN-REGISTER-2026-07-12.md` |

---

## 2. loom-next-level (139 items; the primary program)

### 2.1 DONE-ledger cross-check — claimed done, code-verified (sample spot-checks all PASS)

`DONE.md` records Phases 0→4 + the §P2 residual wave complete, rolled to both estates through
`b4aac59b` (Phase-4 boundary, DONE.md:283) with #2523 (§P2 wave) merged after. Spot-checks:

| Claimed item | Evidence found | Verdict |
|---|---|---|
| EXP1 export/import/clone | `app/api/workspaces/[id]/{export,import,clone}/` dirs + `lib/workspace/workspace-export.ts` + `lib/components/workspace-portability.tsx` | ALREADY-BUILT |
| A14 collab SSE push | `app/api/items/[type]/[id]/collab/stream/route.ts` + `lib/collab/{collab-stream-model,presence-transport}.ts` | ALREADY-BUILT |
| U8/U9/U13/L5/CH1 | `lib/editors/phase3/kql-dashboard-editor.tsx`, `lib/components/canvas/canvas-fullscreen.tsx`, `lib/components/pipeline/pipeline-debug-overlay.tsx`, `lib/components/catalog/lineage-canvas.tsx` (+ `lineage-canvas-columns.test.tsx`), `lib/resilience/fault-injection.ts` + `lib/components/admin/dependency-chaos-pane.tsx`; runtime flags `u8-kql-dashboard-depth`/`u9-canvas-fullscreen`/`u13-pipeline-run-overlay`/`l5-column-lineage-ui`/`ch1-dependency-chaos` all registered in `lib/admin/runtime-flags.ts` | ALREADY-BUILT |
| SC1 supply chain | `.trivyignore` present with SC1 header ("Trivy CRITICAL-gate baseline (SC1)"); HEAD commit `93aae674 fix(sc1)` (PR #2526 OPEN) refines the gate | ALREADY-BUILT (PR #2526 in flight) |
| N15 metrics layer | `lib/metrics/{metric-compiler,metricflow-spec,run,consumers}.ts` + `__tests__/rls.test.ts`; commit `2eaf8656` (#2511) | ALREADY-BUILT |
| N16 code-report | `lib/code-report/parse.ts`, `lib/editors/code-report-editor.tsx`, `app/api/items/code-report/`; commit `81e8edd4` (#2513); flag `n16-code-report` | ALREADY-BUILT |
| N17 incident console | `app/admin/incident-console/`, `lib/observability/incident-{model,monitor-model,store}.ts`, `lib/panes/incident-console.tsx`; commit `c90099ac` (#2515); flag `n17-incident-console` | ALREADY-BUILT |
| N18 embedded SDK + RLS | `app/api/embed/{query,token}/route.ts`, `lib/embed/embed-token.ts`, `lib/metrics/__tests__/rls.test.ts`, `app/admin/embed-codes/`; flag `n18-embedded-analytics` | ALREADY-BUILT |
| N8 labs | flags `n8-modern-query-prql`, `n8-ducklake-catalog`, `n8-s3-gateway` in `runtime-flags.ts:427-443` | ALREADY-BUILT |
| Access-gov reuse rows (I4, DR4, C5, U2, U11, I8, A4) | matches reconcile §P2 verification (#2521/#2522); e.g. `check-no-raw-px.mjs` live (`scripts/ci/`, baseline 18/5 files, runs green) | ALREADY-BUILT |

**No phantom-done found** — consistent with the reconcile PRP's own audit ground-truth (reconcile PRP.md:22).

### 2.2 loom-next-level — items NOT done (the true program tail)

| Item | Verdict | Evidence |
|---|---|---|
| **N14a** embedding-pipeline item + hybrid pgvector retriever | **REAL-GAP** | zero hits for `embedding-pipeline` in `lib/`; no `hybrid-retriever.ts`; no `n14*` runtime flag; no N14 commit in `git log` (spec: ws-north-star.md:441-447) |
| **N14b** NL governance copilot over the policy graph | **REAL-GAP** | no `nl-governance`/`governance-copilot` module; `app/api/governance/insights/route.ts` is KPI aggregation only ("tenant governance KPIs", route header lines 1-11) — not policy Q&A (spec ws-north-star.md:448-453) |
| **N14c** AI data-eng contract validation in copilots | **REAL-GAP** (explicitly deferred: ws-north-star.md:711 "agentic data prep deferred until N6 contracts + N14c") | no artifact found |
| **N14d** A2A agent cards + agent-memory service | **PARTIAL** | `lib/azure/a2a-{audit,egress-guard,task-store}.ts` exist (shipped via competitive-audit WS-5.2 07-21); the `a2a-agent-card.ts` generator + formalized `agent-memory` service per spec (ws-north-star.md:460-466) not found |
| **N14e** agent-designer publish surface (A2A + M365 manifest export) | **PARTIAL** | aip-logic Studio right-rail has `evals/publish/versions` tabs (`lib/editors/palantir/aip-logic-editor.tsx:637-642`) but no A2A/M365 publish paths found |
| **N19a** reactive notebook (Marimo-style) | **REAL-GAP** | no reactive/dependency-DAG code in notebook editor; no `n19*` flag |
| **N19b** Python SDK (`csa-loom` PyPI) + Go Terraform provider | **REAL-GAP** | no `sdk/`/`packages/` python or terraform-provider tree in repo root |
| **N19c** access-review/recert campaigns | **MOSTLY ALREADY-BUILT** via access-governance W4 — `lib/access/{access-reviews,close-campaign,revoke-assignment,leaver}.ts` + `app/admin/access-reviews/` + `azure-functions/access-governance-sweeper/`. Residual: the N19c "signed evidence record" audit pack (ws-north-star.md:597-598) unverified |
| **N19d** scheduled insights / anomaly narration digest | **REAL-GAP** | `/governance/insights` is a KPI page, not the metric-delta→Copilot-narrated→C5-delivered digest (ws-north-star.md:602-605) |
| **N19e** FOCUS cost-per-query/dashboard attribution | **REAL-GAP** | zero `FOCUS`/`cost-per-query` hits in `lib/azure/cost*.ts` |
| **N19f** webhooks / Event Grid platform events | **ALREADY-BUILT** | `lib/events/{webhook-emitter,webhook-registry,webhook-signing}.ts` (emitter has Event Grid path, webhook-emitter.ts:73-81) + `app/admin/webhooks/` + `app/api/admin/webhooks/` |
| **N19g** DataHub/OpenMetadata catalog interop | **REAL-GAP** | zero `datahub|openmetadata` hits in `lib/` (only `lib/lineage/openlineage.ts`) |
| **N20** Tier-3 labs (Univer sheet [license-review-gated], VS Code ext, `loom dev`, plugin marketplace, DSAR/privacy, evidence packs, dashboards-as-code, pivot grid, "What's new" panel) | **REAL-GAP (opportunistic, Preview-badged)** | ws-north-star.md:619-639; Univer hard-blocked by LIC0 guard until module license review (`check-license-inventory.mjs` blocks minio/univer) |
| **U12** new-item-dialog px cluster + dead `color`/`fg` fields | **REAL-GAP** | `lib/components/new-item-dialog.tsx:155,167` still `gap:'12px'` (17 px-literals in file); `lib/components/pipeline/activity-catalog.ts:173-231` still carries dead `color:`/`fg:` fields the spec says to delete (ws-ui-excellence.md:426-446) |
| **R4–R6** route-toolkit family batches | **SUPERSEDED** by the R3 shrink-only ratchet + touched-file rule (`scripts/ci/check-route-toolkit.mjs`); gap re-baselined 1343→1338 and shrinking (DONE.md:283). Opportunistic drain, not a scheduled wave |
| **R10–R12/R14** editor/module decomposition | **REAL-GAP (housekeeping)** | `lib/editors/phase3/semantic-model-editor.tsx` = 3,025 lines; `lib/editors/foundry-sub-editors.tsx` = 3,272 lines (both above their decomposition targets; competitive-audit WS-11.1 was redirected here — PRP.md:182-186) |
| **R13** report-definition-sanitizer split | **UNVERIFIABLE/likely done or renamed** — file `lib/azure/report-definition-sanitizer.ts` no longer exists |
| **R15–R17** typed API client map + guard | **REAL-GAP** | no `client-map.generated.ts` anywhere; `check-no-bare-client-fetch.mjs` exists but the R17 known-route guard does not |
| **R18/R19** shared editor-state hook | **ALREADY-BUILT (R18)** — `lib/editors/use-editor-state.ts` + test; R19 is a doc/convention (adopted opportunistically during R10-R12 — thus open with them) |
| **R20–R27** `legacy/` repo restructure | **REAL-GAP (housekeeping — execute LAST by design)** | no `legacy/` dir exists; ws-ratchets.md:681 marks it an independent track |
| **R28** git-integration-client consolidation | **LIKELY DONE / verify** — only one client remains (`lib/azure/git-integration-client.ts`, 713 lines, + `git-binding-store.ts`); the "duplicate clients" the item targets are no longer present |
| **R29** parity-doc freshness ratchet | **ALREADY-BUILT** — `scripts/ci/check-parity-doc-freshness.mjs` |
| **X3** per-cloud CI lanes | **PARTIAL** — a large `gov-*.yml` fleet exists (gov-console-roll, gov-bff-verify, gov-gates, gov-exercise, …) but the named `gov-workspace-identity.yml` lane (ws-identity-cloudmatrix.md:872) does not |
| **I6/I7 enforce flip** | **OPERATOR-GATED** — build-complete, enforcement OFF until I9 sign-off + ≥2wk clean shadow (~08-05) (DONE.md:178-181) |
| **S2 FIC migration flip**, S1 Graph `Application.Read.All` consent, SYNTHETIC_LOGIN_* account, Function publishes | **OPERATOR-GATED** — queued operator actions (DONE.md:59-65) |
| **SC1 rider: base-image CVE burn-down** | **REAL-GAP (S)** — `.trivyignore` carries 3 reviewed CVEs each with a "bump the base image" burn-down path: CVE-2026-59873 (node:20 vendored tar — loom-console/copilot-maf/mcp-bridge), CVE-2024-47561 (avro in debezium/connect base — loom-mirroring), CVE-2026-33845 (libgnutls30 — mcp-bridge base) |

**DONE-ledger accuracy note:** the 4c/4d boundary row (DONE.md:283) claims "north-star core
(N1–N18 + M1–M3 …) fully landed", but N14a–e (inside the N1–N18 range) have no DONE row, no
runtime flags, and no commits — the claim should read N1–N13 + N15–N18. Minor STALE-DOC inside DONE.md.

---

## 3. reconcile PRP (`PRPs/active/reconcile/PRP.md`)

The reconcile PRP is itself the consolidated backlog; status verified item-by-item:

| ID | Status now |
|---|---|
| RC-LIC0, RC-4B-ROLL | DONE (recorded in-doc; `check-license-inventory.mjs` + `THIRD_PARTY_LICENSES.md` confirmed on disk) |
| RC-GOV (both-estate validation) | **LARGELY DONE / ongoing** — Phase-4 completion rolled to BOTH estates off `b4aac59b` (DONE.md:283); #2523 (§P2 wave, `d713354e`) has no recorded roll yet — next roll pending (operational, not a build gap) |
| RC-N7BCD / RC-N7AE / RC-N8 / RC-PILLAR3(N15-N18) / RC-MIGRATION(M1-M3) | DONE (PRs #2508/#2519/#2511/#2513/#2515/#2516/#2517; ledger rows present) — **except N19/N20 within RC-PILLAR3, still open (see §2.2)** |
| §P2 real-gap wave (EXP1/A14/CMK1/U8/U9/U13/L5/SC1/CH1) | DONE (#2523, verified §2.1) |
| §P2 "not re-verified": U12 | **REAL-GAP confirmed** (§2.2); WS-R R4-R6/R10-R29 verdicts in §2.2 |
| RC-IA-01/02/05/07..13 | DONE — WS-5 nav reorg #2509 (`7eb2ee94`) shipped 10 of 13 |
| **RC-IA-03** fold `/admin/usage-chargeback` + `/admin/chargeback` into `/admin/finops` | **REAL-GAP** — all three dirs still exist under `app/admin/` (`chargeback`, `usage-chargeback`, `finops`) |
| **RC-IA-04** consolidate `/admin/{copilot-usage,agent-quality,copilot-quality,model-fabric,parity-autopilot}` into one AI-operations hub | **REAL-GAP** — all five dirs still separate under `app/admin/` |
| **RC-IA-06** group the 4 access-governance admin surfaces into one hub | **REAL-GAP** — `access-packages`, `access-report`, `access-requests`, `access-reviews` remain 4 separate `app/admin/` pages |
| RC-DOC-FOUNDRY / RC-DOC-COMPAUDIT | DONE — foundry AUDIT.md:76-81 now says "6.3 ✅ CLOSED (re-verified 2026-07-24)"; PARITY-MATRIX.md:22/45/166/172 carry "CLOSED on main" re-grades for tier-router/feature-store/model-serving (commit `ca1e411d` #2518) |
| RC-R20-27 | open (housekeeping — §2.2) |
| Future programs (domain-mesh / access-gov / geo-graph-ml / bridge-services / next-waves+EH2-4) | see §5-§9; note **access-governance is misfiled here — it is BUILT** (§6) |

---

## 4. foundry-parity

- **PRP.md matrix**: partially STALE — rows 3.3 notepad / 4.4 rules / 4.6 approvals / 6.10 retention still
  say "❌ build" (PRP.md:72,86,88,117) although AUDIT.md's gap register marks all of them "✅ SHIPPED + E2E'd"
  (AUDIT.md:117-124) and the 07-19 final receipt lists them live (AUDIT.md:126-137). **STALE-DOC** (matrix
  re-grade pass never ran = the W9 "final grading" wave).
- **Real residuals** (AUDIT.md:138-140): (a) further widget/card kinds toward Foundry's full ~40/~30
  catalogs — currently 37 workshop / 34 rayfin per the backlog-drain notes (AUDIT.md:235-239) — near-done,
  opportunistic; (b) the operator's **catalog-wide functional E2E** (every item type create→run→use vs real
  backend; tasks #12/#13, AUDIT.md:90-93) — a verification program, not a build; (c) 4.8 process mining —
  explicitly phase-2 backlog (PRP.md:90).
- 5.4 evals-wiring: **ALREADY-BUILT** — `app/api/items/aip-logic/[id]/{eval,publish}/route.ts` +
  `_spindle-eval.ts` + editor `evals/publish` tabs (aip-logic-editor.tsx:637-642), despite AUDIT.md:85 still
  saying "❌ confirmed" (stale batch-3 note superseded by the later gap-register receipts).
- 2.2 object sync: **BUILT (core)** — `app/api/items/ontology/[id]/{bind,datasource}/route.ts` + live
  bind-to-data-source E2E receipt (AUDIT.md:251-263); "backfill progress at scale" (competitive WS-4.4)
  depth unverified — verify-then-close.

---

## 5. loom-competitive-audit-2026-07-20 (burn-the-box)

PARITY-MATRIX re-baselined 07-24 (#2518): tier-router **A (wired via `routeTurnTier`)**, Feature Store
**A− (`feature-table` item)**, Model Serving **A**, A2A/code-interpreter/agent-builder/NL-estate CLOSED
(PARITY-MATRIX.md:45). Fine-tuning (WS-1.3) also now built — `lib/azure/fine-tuning-{client,item}.ts` +
test exist, though the matrix still lists "LLM fine-tuning (F)" as residual (PARITY-MATRIX.md:18) —
**one remaining STALE-DOC row**. WS-N of loom-next-level is the canonical owner of the forward roadmap
(PRP.md:188-197). **Residual true gap the matrix itself names: WS-11.1 monolith decomposition** —
redirected to WS-R R10-R14 (still open, §2.2). Memory's merge-train tail (WS-4.4/3.4/11): WS-3.4
eventstream SQL operator **built** (`transform-menu.ts:41,68` sql-tab); WS-4.4 core built (see §4);
WS-11 = R10-R14.

## 6. access-governance (W1–W4)

**ALREADY-BUILT; PRP is STALE-DOC** (all W1-W4 checkboxes still unchecked, PRP.md:144-181, status still
"DRAFT"). Code: `app/api/access-governance/{assignments,backfill,group-sync,report,reviews,...}`,
`lib/access/{assignment-ledger,approval-policy,access-reviews,close-campaign,expiry,group-sync,leaver,revoke-assignment,access-report}.ts`
(+ full test set), Cosmos containers `access-assignments`/`access-packages` (`cosmos-client.ts:1048-1049,1656-1657`),
and the `azure-functions/access-governance-sweeper/` timer Function. Residual: tick the PRP,
`docs/fiab/parity/access-governance.md` zero-❌ confirmation, Graph-permission gates verify.

## 7. domain-mesh (issue #1483 tail)

**FUTURE-PROGRAM, execution-ready DRAFT** — 18 PR-sized items (A1-A5, B1-B3, C1-C5, D1-D5;
PRP.md:141-281). Validation ledger: DONE 4 · PARTIAL 7 · OPEN 5 (PRP.md:130). Code check: 4 libraries only
(`lib/domains/libraries/` has no `public-sector.ts`), no `scripts/ci/check-domain-libraries.mjs`, Purview
sync still one-directional — the PRP's current-state section is accurate (not stale).

## 8. geo-graph-ml

- **GEO-1 (eventstream geospatial): ALREADY-BUILT** — `lib/components/eventstream/geo-operator-config.tsx`,
  `lib/editors/eventstream/{geo-reference,geo-sql}.ts` (+ tests), plus a Loom-native
  `lib/catalog/item-types/azure-geoanalytics.ts` category (geo-map/geo-dataset/geo-query items).
- **GEO-2 (ArcGIS/Esri engine): REAL-GAP/FUTURE** — zero `arcgis|esri` hits; BYO-license, needs operator
  Esri credentials to E2E (PRP.md:54-76).
- **GEO-3 (GraphFrames): REAL-GAP/FUTURE** — zero `graphframes|pagerank` hits.
- **GEO-4 (SynapseML): REAL-GAP/FUTURE** — zero `synapseml|lightgbm` client hits.

## 9. bridge-services

**FUTURE-PROGRAM (proposed, 23 items)** — none of the four services exists: zero
`loom-sql-gateway|loom-onesecurity|loom-gitsync|loom-pulse` hits in bicep or lib; `platform/runners/`
contains only browser-tool/github-actions/script-runner. All seeds it builds on are real (PDP shadow,
git-integration-client, business-events-store) per its own §sources. Post-H-band sequencing per
OPEN-REGISTER P3.

## 10. enterprise-hardening

- Phase 0: DONE (in-doc STATUS, PHASES.md:19-33). Phase 1: substantially landed (EH-P1-OBO #1922,
  EH-P1-MANIFEST #1923 per OPEN-REGISTER:31-32; PDP shadow default per bridge-services sources).
- **Phases 2-4: FUTURE-PROGRAM** (PHASES.md:166/268/349) — scale tier (Cosmos partition migration — MIG1
  convention shipped as its substrate; query governor; AOAI PTU gateway; rate-limiting/quota — partially
  overlapped by N13 token budgets), BCDR multi-region, ops maturity (SLO catalog + 60k load/soak — SLO1
  surface + CH1 fault-injection shipped by loom-next-level per the decision rules in loom-next-level
  PRP.md:158-179, which shrink but do not close these phases).

## 11. next-waves (8 proposed PRPs + MASTER-ROLLOUT) & OPEN-REGISTER

**FUTURE-PROGRAM catalog, partially STALE.** OPEN-REGISTER P3 (OPEN-REGISTER:61-68) is the live index, but
several of its "unbuilt" entries have since shipped: CTS memory/brain (#2035 "long-term memory + write
guard + nightly consolidation"), G2 AI-functions batch (#1946), data-contract item (superseded by N6,
#2502), webhooks (N19f, §2.2), SDK/Terraform/SCIM (foundry PRP row 7.2 "✅" — conflicting with
OPEN-REGISTER "developer platform" open; needs a one-line grep pass at promotion time). Each next-waves
PRP "merits an item-level code sweep before promotion" (reconcile PRP.md:81) — that re-baseline itself is
the actionable item. OPEN-REGISTER P0 rows (GOV-3 boundary confirm, model-strategy §7 PTU decision, Gov
Postgres quota) are OPERATOR-GATED environment decisions.

## 12. ux-fabric-a, docs-sweep, weave-powerbi

- **weave-powerbi: SHIPPED** (in-doc status, PRP.md:3-8; W1-W6 #1902-#1913 + #1927).
- **ux-fabric-a: SUPERSEDED in practice** by the ux-baseline die-hard rule + WS-U + G-band/item-type-visual
  waves (registry ~45 surfaces, compact-v4 nodes). No wave tracking was ever recorded in the doc. Residual
  worth keeping: the W6 "ux-fidelity checklist gate added to ux-standards §7" (PRP.md:39-40) — unverified.
- **docs-sweep: Batch 0 DONE in-doc; Batches 1-2+ partially superseded** by later docs waves (Loom docs
  publish 07-01, tutorials drains, copilot corpus fix). Residual: a per-category coverage verification pass
  + final grounding regen (README.md:44-49).

---

## 13. CONSOLIDATED TABLE — every remaining REAL-GAP item across all active PRPs

(Excludes OPERATOR-GATED, STALE-DOC ticks, and pure verification passes; those are listed after the table.)

| # | Program / ID | Gap | Build note | Size |
|---|---|---|---|---|
| 1 | LNL N14a | Embedding-pipeline item + hybrid retriever (AI Search ↔ pgvector/DiskANN on AGE Postgres via `LOOM_VECTOR_BACKEND`) | New item + `lib/copilot/hybrid-retriever.ts`; X2 rows per backend; same-RAG-answer-on-both acceptance | M |
| 2 | LNL N14b | NL governance copilot ("who can read PII in EU?") over PDP + classification-59 + lineage | Reuse N11 GraphRAG retriever scoped to the policy graph; cite policy edges | M–L |
| 3 | LNL N14c | Copilot-generated pipelines/SQL validated vs N6 contracts pre-proposal | Hook contract check into pipeline/dataflow/SQL copilots; violation surfaced in receipt | M |
| 4 | LNL N14d (residual) | A2A agent-card generator at well-known endpoint + formalized `agent-memory` service | a2a-{audit,egress-guard,task-store} exist — add card gen + memory service over existing `memory-*-core` | M |
| 5 | LNL N14e | Agent-designer publish surface (knowledge-source picker, publish-as-A2A + M365 manifest) | Extend aip-logic Studio rail (evals/publish tabs already there) | L |
| 6 | LNL N19a | Reactive notebook mode (cell dep-DAG, reactive re-run, .py round-trip, deploy-as-app) | Editor-layer only; serialize on notebook editor (U3/A14 already in) | L |
| 7 | LNL N19b | `csa-loom` PyPI SDK + `terraform-provider-loom` (Go), contract-tested vs `/api/openapi.json` | OpenAPI-generated core; CI drift gate | M–L |
| 8 | LNL N19c (residual) | Signed evidence record / audit pack on the (already-built) access-review campaigns | Small add on `lib/access/access-reviews.ts` close path | S |
| 9 | LNL N19d | Scheduled insights / anomaly-narration digest delivered via C5 subscriptions | Metric/monitor deltas → Copilot narration → EXTEND report-subscriptions Function (don't fork) | M |
| 10 | LNL N19e | FOCUS cost-per-query/dashboard attribution | Tag query runs (item+user+ws), join Synapse/ADX metering, FOCUS mart, panels in chargeback/finops; serialize on `cost-client.ts` | M |
| 11 | LNL N19g | DataHub / OpenMetadata catalog interop (export MCE/OM JSON + ingest backfill) | Rides N17's OL export | M |
| 12 | LNL N20 | Tier-3 labs (VS Code ext, `loom dev`, plugin marketplace [needs versioned item contract first], DSAR slice, evidence packs, dashboards-as-code, pivot grid, "What's new" panel; Univer sheet blocked on LIC0 module review) | Preview-badged, one E2E receipt each; schedule opportunistically | S–L each |
| 13 | LNL U12 | new-item-dialog px→tokens (lines 155/167 + 15 more) + delete dead `color`/`fg` in `activity-catalog.ts:173+` | S sweep + FLAG0 flag per spec; counts toward U11 baseline | S |
| 14 | LNL R10–R12/R14 | Decompose `semantic-model-editor.tsx` (3,025), `foundry-sub-editors.tsx` (3,272) + R14 client/catalog monoliths | One editor per PR, plan-driven, ratchet-dropping; == competitive WS-11.1 | M ×4-6 PRs |
| 15 | LNL R15–R17 | Typed client-map generation + `clientFetch` typed overload + known-route guard | Extend existing route-inventory generator; guard joins the lane | M |
| 16 | LNL R20–R27 | `legacy/` repo restructure | Housekeeping track, one tree per PR, EXECUTE LAST, pause on CI instability | M (8 PRs) |
| 17 | LNL X3 (residual) | `gov-workspace-identity.yml` per-cloud CI lane | gov-*.yml fleet exists; add the identity lane (the Gov E2E receipt for I1-I3) | S |
| 18 | LNL SC1 rider | Base-image CVE burn-down: bump node:20 (CVE-2026-59873), debezium/connect (CVE-2024-47561), mcp-bridge base (CVE-2026-33845), then delete `.trivyignore` entries | 3 Dockerfile base bumps + rebuild/UAT | S |
| 19 | reconcile RC-IA-03 | Fold `/admin/chargeback` + `/admin/usage-chargeback` into `/admin/finops` tabs + redirects | FinOps hub already claims them; move panes, redirect old routes | S–M |
| 20 | reconcile RC-IA-04 | One "AI operations" hub for copilot-usage / agent-quality / copilot-quality / model-fabric / parity-autopilot | Extend copilot-quality tab pattern; redirects | M |
| 21 | reconcile RC-IA-06 | Group the 4 access-gov admin pages under one Access-governance hub | Tabbed hub + sidebar group | S |
| 22 | foundry-parity (residual) | Widget/card catalog last mile (37→~40 workshop, 34→~30 rayfin met) + Fabric per-editor side-by-sides | Opportunistic; operator-partnered side-by-sides | S |
| 23 | foundry/comp WS-4.4 (residual) | Dataset→object sync backfill progress + AI-Search index at scale | Bind route exists; verify then add progress/index depth | M (verify-first) |
| 24 | domain-mesh (16-18 items) | A1-A5 taxonomy accuracy + Public-Sector library + CI validator; B1-B3 picker/canvas G-band; C1-C5 bi-di Purview import, OneLake opt-in mirror, domain-scoped lineage, governance roll-up, federated search; D1-D5 E2E + parity docs + gates | Execution-ready DRAFT; ~1 PR per item | M program (~16 PRs) |
| 25 | geo-graph-ml GEO-2 | ArcGIS GeoAnalytics Engine on Synapse (package wizard, license gate + Fix-it, template gallery, map plotting) | BYO Esri license — needs operator creds to E2E | M–L |
| 26 | geo-graph-ml GEO-3 | GraphFrames batch graph analytics wizard (PageRank/CC/motifs → Delta write-back + canvas overlay) | Zero gate; jar/whl via env editor | M (½ wave) |
| 27 | geo-graph-ml GEO-4 | SynapseML distributed-ML gallery (LightGBM/ONNX/SHAP, AI-services at Spark scale, AutoML bridge) | Zero-gate core; cloud-aware AI endpoints | M |
| 28 | bridge-services (23 items) | loom-sql-gateway (one SQL front door), loom-onesecurity (policy compiler), loom-gitsync (always-on Git spine), loom-pulse (platform event bus) | 4 internal-ingress ACA services on the script-runner template; post-H-band | XL program |
| 29 | enterprise-hardening P2-4 | Scale tier (Cosmos partition migration [MIG1 substrate ready], query governor, PTU gateway, rate-limit/quota), BCDR multi-region, ops maturity (SLO catalog, 60k load/soak) | Future phases; several halves shipped elsewhere (N13 budgets, SLO1, CH1, read-perf) — re-scope before kickoff | L–XL program |
| 30 | next-waves / OPEN-REGISTER P3 | Residual catalog (PSR-B perf tail incl. PSR-6 ADX result-cache, Data-Product DP-set, Phase-7 item types [W10 superseded by N6], collaboration W-items, SVC-FHIR, U-wave adoption long tail) | Each needs an item-level code sweep at promotion (several rows already stale-closed: CTS #2035, G2 #1946, webhooks) | per-item |
| 31 | docs-sweep (residual) | Per-category docs/help coverage verification + final Copilot grounding regen | Verification-weighted batch | M |
| 32 | ux-fabric-a (residual) | `ux-fidelity` checklist gate added to ux-standards §7 | S doc/gate add; rest superseded by ux-baseline execution | S |

### Operator-gated (NOT schedulable as build work)
- I6/I7 workspace-identity enforce flip (I9 sign-off + ≥2wk clean shadow, ~08-05) — DONE.md:178-181
- S2 live FIC migration on the prod app reg; S1 Graph `Application.Read.All` consent; SYNTHETIC_LOGIN_* account; secret-expiry/copilot-evaluator Function publishes + infra deploy pass — DONE.md:59-65
- OPEN-REGISTER P0: GOV-3 boundary posture, PTU/model-quota decisions, Gov Postgres quota, PBI VM-gateway one-time registration
- geo GEO-2 Esri credentials (to E2E the authorized path)

### Stale-doc fixes (docs only, no build)
- loom-next-level DONE.md 4c/4d row: "N1–N18" over-claims N14 (§2.2)
- foundry-parity PRP.md matrix rows 3.3/4.4/4.6/6.10 (+AUDIT.md:85 5.4 note) — re-grade to match AUDIT receipts
- PARITY-MATRIX.md:18 "fine-tuning (F)" — `fine-tuning-client.ts`/`fine-tuning-item.ts` exist
- access-governance PRP.md — flip DRAFT→SHIPPED, tick W1-W4 boxes
- OPEN-REGISTER P3 — strike CTS-memory (#2035), G2 (#1946), data-contract (→N6), webhooks rows
- ux-fabric-a / docs-sweep — record superseded/absorbed status

### Roll/ops note
#2523 (§P2 wave) is merged but no roll receipt is recorded in DONE.md; PR #2526 (SC1 trivy-gate scope fix)
is OPEN on the current branch. Next both-estate roll closes RC-GOV for the current head.
