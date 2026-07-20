# CSA Loom — MASTER ROLLOUT (single authoritative phased plan)

> **⚠ DOC-CURRENCY (2026-07-20):** this plan is a 07-09 snapshot; ~40 listed
> items have since SHIPPED (loom-apps APP-W1–W6 complete, Foundry-parity
> governance+greenfield suite, widget catalogs 37/34, compact-v4 canvas,
> G-band gates 100, read-perf program, v0.72.x). Cross-check
> `PRPs/active/OPEN-REGISTER-2026-07-12.md` (RE-BASELINE 2026-07-20 header)
> before planning from this file. A standing operator P1 sits ABOVE phase
> order: catalog-wide functional E2E (create→publish→RUN→USE per item type).

> **Date:** 2026-07-09 · **This is the canonical build sequence.**
> **Supersedes** the scattered numbering schemes in `WAVES.md` (numeric 1–20, fractional 6.5,
> lettered U0–U13, PSR-A/PSR-B, H1–H3). Those schemes stay in `WAVES.md` and the 10 per-PRP files
> **as the detailed specs**; this document is the **index + ordered sequence** that folds all of them
> into one dependency-correct plan. When the two disagree on *order*, **MASTER-ROLLOUT wins.**

---

## ✅ RE-BASELINE 2026-07-14 — live open-work tracker is now `PRPs/active/OPEN-REGISTER-2026-07-12.md`

A 2026-07-14 verification pass re-confirmed the 2026-07-09 reconciliation below: the ~40 items
this phased plan lists as forward work that were **already BUILT** remain shipped on `main`, and
more has landed since (through release `0.68.0` / PRs up to #2028). **This document stays the
canonical dependency-ordered *sequence*, but it is no longer the source of truth for what is still
open.** For current open work, read **`PRPs/active/OPEN-REGISTER-2026-07-12.md`** (the deduped
single register); its P1 code-gap items 1-8 were all verified **CLOSED** on 2026-07-14. When
grading any item below as "to build," check OPEN-REGISTER and `gh pr list --state merged` first —
the phase callouts here already flag large blocks as shipped, and the true remaining scope is
OPEN-REGISTER's P2/P3 programs.

## ⚠️ RECONCILIATION 2026-07-09 EVE — read `docs/fiab/prp/PRP-AUDIT-2026-07-09.md` FIRST

A full per-item audit against `main` @ `835d2145` found **~40 items below are BUILT but still
listed as forward work** (the repo raced ahead of this plan during the 07-09 rollout session):
Phases 0, 1, and 2 are **COMPLETE and live-verified** (U0/SC-1..10, PSR-A with a real benchmark
run, CAP-R2, the Phase-2 RAG-spine/G1/G5/W19 set), and much of Phases 3/5/6 pre-shipped
(FGC-12..22/25/28/30, DBX-3..7/11, SVC-1/8, CTS-01/02/04/05/10, W6/W8/W11/W18/W19). The
Hyperscale Phase-12 gate (PSR-1+PSR-2 green) is **met**; H-band skeletons (HYP-1/5/9/16) started
2026-07-09 eve. **Before building ANY item below, check the audit doc's per-item tables** — the
true remaining work is the audit's partial/missing lists, plus two dangling enterprise-hardening
foundations with no phase owner (EH-P1-OBO per-user data-plane; EH-P1-MANIFEST item-type
manifest registry — needs operator steer).

## Status — read this first (disambiguation)

**Prior wave programs are SHIPPED and are NOT in scope here.** The operator's earlier, already-built
programs — the 108-item public-release PRP (**Waves 0–7 LANDED**), the Web-5.0 8-wave visual program,
the fabric-parity Wave-6 Round-1/2, and the enhancement programs — are **live at `rev 0000211` / release
`0.60.0`**. Anyone recalling "Wave 1…Wave 7" from memory is recalling *that shipped work*.

**Everything in this document is the REMAINING, entirely-UNBUILT backlog** drawn from the 10
`next-waves` PRPs. Every source PRP header reads *"Status: proposed"* — **nothing below is built yet.**
The `WAVES.md` numeric labels ("Wave 1…20") are a *new* proposal that reuses old vocabulary; to end that
collision, **this plan drops the colliding numbers and sequences by PHASE instead.**

**Already-done / excluded from the forward count (do NOT re-plan):**
`FGC-24` (variable-library promotion) ✅ · `BR-APPROVAL` (approval-gated promotion) ✅ ·
`LIN-GC-1/2/3` (lineage garbage-collection) ✅ **DELIVERED** (`feat/lin-gc-lineage-cleanup`). Their code
change is done; the only residual is the **operator run** of the LIN-GC-2 reconcile to purge live debris
(Phase 0).

---

## The die-hard rules that govern every phase

These sit **above convenience** and are the definition of "done" for every item. No phase closes if any
is violated (see `.claude/rules/`):

1. **`no-vaporware.md`** — nothing ships unless functional front-to-back: real Azure backend call (no
   mock arrays / `return []`), a validating BFF route (`{ok,data,error}`), and a rendered surface or an
   **honest** `MessageBar intent="warning"` naming the exact env var / role / resource to provision. Each
   merge carries a real-data E2E receipt.
2. **`no-fabric-dependency.md`** — every item is **100% functional Azure-native by default**. A real
   Fabric / Power BI backend is **strictly opt-IN** (`LOOM_<ITEM>_BACKEND=fabric` + a bound workspace);
   never gate on `fabricWorkspaceId`; never call `api.fabric.microsoft.com` / `api.powerbi.com` /
   `onelake.dfs.fabric` on a default path.
3. **Default-ON / opt-out (standing operator directive)** — every Loom-native feature ships **enabled by
   default**; no spend/enablement gate. Cost is bounded by **scale-to-zero / idle-stop defaults**, and
   admins get **disable / kill-switch** controls (remove a running default, not a prerequisite to turn it
   on). The lone exception is the opt-IN Fabric/Power BI backend above.
4. **`ui-parity.md` + the UX-baseline program** — every surface is one-for-one with the real Azure/Fabric
   UI (only the Fluent v9 + Loom theme differs), lifted to or above the Fabric UX baseline via the U0
   shared component library.
5. **No-scaffold / no-scaffold-claims (BLOCKING)** — **DOM strings ≠ parity.** Every per-surface item's
   receipt is a real-backend screenshot **and** a physical click-walk with `LOOM_DEFAULT_FABRIC_WORKSPACE`
   **unset**, plus a `docs/fiab/parity/<slug>.md` note. Nothing is "shipped" on a smoke test alone.

---

## Duplicate themes — collapsed to one owner

The 10 PRPs independently reinvented several capabilities. Build order below respects these owners; do
**not** fork a second implementation:

| Theme | **Canonical owner** | Riders (reference, do not rebuild) |
|-------|---------------------|-------------------------------------|
| Warm compute / Spark pools | **PSR-3** (default-ON, cross-replica lease store) | FGC-09 / FGC-10 "coordinate, don't fork"; **HYP-14** rides PSR-3's Redis lease store |
| Result / query cache | **PSR-5 / PSR-6** (upgrade existing `query-cache.ts`) | **HYP-15** rides them as the shared-Redis backing store |
| Data-contract / breaking-change gate | **W10** (Data Contract item) + **BR-CONTRACT-GATE** (publish gate) | **DP-9** adds only version-history + deprecation glue |
| Chargeback / cost attribution | **FGC-28** (chargeback report) | **BR-COSTATTR**, **DP-14**, **CTS-17**, **W14** all extend the *same* report — **enforce build order** (FGC-28 → BR-COSTATTR → CTS-17 → DP-14) |
| External / cross-tenant sharing | **FGC-30** (Entra B2B + scoped ADLS grant) | **DP-16** adds a "Share externally" action only |
| Marketplace / subscriber webhooks | **BR-WEBHOOK** (Event Grid + Service Bus registry) | **W18** and **DP-11** both ride it |
| AI-functions-at-scale (scope split) | **SVC-1** = pipeline AI *activities* (Doc Intel/Vision/Language/Translator) · **FGC-19** = model-tier selector · **G2** = "Add AI column" at-scale grids/T-SQL/Dataflow/multimodal | keep the three scopes distinct — no shared AI-column UI without arbitration |
| Model routing | **AIF-12** (Model Router + Loom-native tier router) | **CTS-16** adds circuit-breaker + learned routing |
| Blue-green / canary | **BR-BLUEGREEN** | **PSR-18** adds canary + error-budget cutover |
| Control-plane DR | **BR-CONTROLPLANE-DR** | **PSR-19** adds the measured RTO/RPO drill |
| Chaos / fault testing | **SVC-11** (Chaos Studio panel) | **PSR-20** adds benchmark-under-fault |
| Tracing / eval / replay | **AIF-13** + **CTS-14** (shared trace store + redactor) | **DBX-10** MLflow trace tab is a *separate* surface — keep it linked, don't duplicate the store |
| Ambient / proactive AI | **BR-AMBIENT-FEED** (home-surface feed) | **CTS-15** feeds it; **W19** "Explain this" is the cross-item piece |

**Rename pass (confusable, not duplicate):** `AIF-7` ("`ai-enrichment` workflow item") vs `SVC-1`
("AI-enrichment pipeline activities") — rename one before build tickets are cut.

---

## The phases (ordered — build top to bottom)

Each phase is a coherent campaign of a few waves. UX per-surface sweeps (U-waves) interleave with feature
work so the product visibly improves every phase. The **Hyperscale H-band is dead last**, hard-gated on
the benchmark harness. Every phase ends with **roll + browser-verify** (the no-scaffold receipt).

---

### Phase 0 — Owed cleanup *(operational debris; no new PRP items)*

Close the loose ends from prior sessions before opening new scope.

- **Finish the RTA / UAT E2E** — bring the in-VNet Playwright UAT harness (tracker **#1549**) to a clean
  green full-visual run (this is also **PSR-17**'s continuous-canary substrate; do it once here).
- **Fabric side-by-side capture round 2 (CAP-R2)** — live Fabric walks of the 7 un-captured surfaces
  (Real-Time Dashboard, Report editor, Semantic-model view, KQL Queryset, Copy job, Map, task flows) →
  extend `scratchpad/fabric-ux-observations.md` PART 3. **Prerequisite for the final grading of U-waves.**
- **Delete diagnostic / UAT debris workspaces** — run the already-shipped **LIN-GC-2** reconcile
  (`POST /api/admin/lineage/reconcile`, non-dry-run) to purge the 160-workspace / 435-item debris still
  serving lineage; confirm `/governance/lineage` is clean.

**Operator action:** none new (uses shipped code + existing UAT infra).
**Acceptance gate:** UAT run green · CAP-R2 PART 3 written · lineage debris gone (dry-run diff empty).

---

### Phase 1 — Foundations & P0 correctness *(the sub-DAG roots — unblock the most)*

The roots the rest of the DAG stands on, plus the release-truth docs fixes (fast, high blast-radius).
Build these **first**; almost everything later rides one of them.

> **⚠️ ALREADY SHIPPED (2026-07-09, rev 0000211 / 0.60.0) — DO NOT REBUILD:** the consolidation analysis
> graded from PRP `Status: proposed` headers and did not reconcile against what shipped on 07-08/07-09.
> These Phase-1 items are **already merged + live**: **Wave 1 docs/compliance** (DOC-1…DOC-5 + BR-SIEM,
> PRs #1720–#1723), **BR-PAT** scoped API tokens (#1743), **DBX-1** loom-app-runtime (#1745), and **W1**
> undo/redo `useCanvasHistory` (#1728, plus W2/W3/W20/W21). Also fully shipped: **Waves 1–10** (fabric-gap,
> RAG spine, AI-enrichment, multi-agent, app-runtime, RTI depth, ALM/capacity, data-science, Databricks),
> the pipeline-UI + notebook-backend + lineage-GC fix programs, node-kit v2 (#1767) and the pipeline/
> eventstream Fabric-UX upgrades (#1768/#1765). **The GENUINELY-UNBUILT Phase-1 roots are just U0 and
> PSR-A.** Verify each item's real state (grep the repo / `gh pr list --state merged`) before building.

> **R-band notebook parity (R4, task #38) — inventory landed 2026-07-10.** The three notebook
> flavors diverged (each editor exposes a different feature subset). Learn-grounded per-flavor
> parity inventories with prioritized R4 build lists now live at
> `docs/fiab/parity/notebook-synapse.md` (R4-SYN-1…12), `docs/fiab/parity/notebook-databricks.md`
> (R4-DBX-1…10), and `docs/fiab/parity/notebook-loom.md` (R4-NB-1…8). Top cross-flavor gaps:
> wire the shared `RichDisplay` viz builder + `VariablesPane` into the Synapse flavor; add
> schedule-as-a-job + dbutils widgets to Databricks; add scheduling + parameters + a resources
> pane to the regular flavor. Reliability of the regular flavor is the separate **R3** track (#37).

- **U0 — shared UX component library** *(PRP-ux-baseline-program, SC-1…SC-10)* — `node-kit v2`,
  `<DetailsPanel>`, `<DockedInspector>`, `<GuidedEmptyState>`, `<PreviewTable>`, `useTeachingToast`,
  `<ExplorerTree>`, `<ItemTabStrip>`/`<ToolbarCrossLinks>`, `<CommandSearch>`, `<EntityDiagram>`.
  **Hard prerequisite for every later U-wave.**
- **PSR-A — benchmark harness** *(PRP-performance-scale-parity)* — **PSR-1** repeatable perf suite +
  `/admin/performance` page + persisted trend; **PSR-2** CI perf gate + per-roll regression budget.
  **The measured number IS the receipt** for every later PSR/HYP item, and **PSR-1+PSR-2 green on main is
  the hard gate for the whole H-band (Phase 12).**
- **BR-PAT — scoped API tokens** *(PRP-surface/BREADTH)* — `loomPatTokens` + `resolvePat()` middleware +
  `/admin/developer/tokens`. **Foundation for BR-OPENAPI / BR-TERRAFORM / BR-SCIM (Phase 4).**
- **DBX-1 — `loom-app-runtime`** *(PRP-databricks-parity, P0/XL)* — one-click hosted Python/Node apps on
  ACA (autoscale-to-zero, OAuth-scoped, admin per-app disable + tenant kill switch). **Foundation for
  DBX-2 / DBX-9 (Phase 4).**
- **W1 — undo/redo history hook** *(PRP-surface, `useCanvasHistory`)* — the shared foundation every other
  canvas-power item (W2/W3/W4/W6/W7/W20/W21) reuses.
- **Wave 1 docs/compliance truth** *(DOCS/BREADTH)* — **DOC-1** (Power BI Premium → opt-in), **DOC-2**
  (`publicNetworkAccess` param + soften compliance claims), **DOC-3** (finish rel-T77 Deploy button
  removal), **DOC-4** (semantic-model parity spec), **DOC-5** (DR honesty + opt-in DR tier), **BR-SIEM**
  (continuous SIEM-exportable audit stream).

**Operator action:** DOC-2 → bicep redeploy of flagged data-plane modules · BR-SIEM → DCR + `LoomAudit_CL`
(+ optional Sentinel) · PSR-A → `perf-benchmarks` Cosmos container (+ optional `LoomPerf_CL` DCR) ·
BR-PAT → `loomPatTokens` Cosmos container · DBX-1 → Console UAMI **Container Apps Contributor + AcrPush**
on a `loom-apps` sub-RG + `LOOM_APPS_CAE_ID` / `LOOM_APPS_ACR_LOGIN_SERVER`.
**Acceptance gate:** roll + browser-verify — undo/redo works on a canvas · `/admin/performance` shows a
real measured number · a PAT authenticates a non-interactive request · a hosted app deploys and serves ·
the flagged docs pages read true.

---

### Phase 2 — Visible UX wins + RAG spine *(fast, felt improvements + the intelligence foundation)*

Cheap client-side canvas power (rides W1) makes the product visibly better immediately, in parallel with
the embedding path that turns "a Search editor" into Loom's intelligence layer.

- **Canvas power layer** *(Wave 2 remainder, PRP-surface)* — **W2** copy/paste + duplicate · **W3**
  align/distribute · **W20** shortcut cheat-sheet · **W21** command-palette canvas coverage · **W19**
  cross-item "Explain this" Copilot · **W8** cross-catalog impact analysis · **W6** version-history +
  visual diff. *(W1 already in Phase 1; LIN-GC rode W8's lineage plumbing — already DELIVERED.)*
- **RAG spine** *(Wave 3, PRP-azure-ai-foundry — AIF-9/AIF-2 land first; AIF-1/AIF-3 stand on them)* —
  **AIF-9** Foundry Connections CRUD · **AIF-2** embedding client + integrated-vectorization · **AIF-1**
  Knowledge Sources + Knowledge Bases · **AIF-10** indexer scheduling/history/mappings · **AIF-16**
  scoring-profile/analyzer/CORS/CMK designers · **AIF-17** AI Search service admin.
- **Copilot depth (merged from the G-addendum)** — **G1** Copilot builders on the 7 remaining surfaces +
  shared `<CopilotBuilderPane>` primitive · **G5** semantic-model Prep-for-AI / Verified Answers.

**Operator action:** grant the Search service system identity **Cognitive Services OpenAI User** on the
Foundry AOAI account (AIF-2). Canvas layer needs none (reuses AOAI/lineage/git/Cosmos).
**Acceptance gate:** roll + browser-verify — undo/paste/align/diff/Explain-this all fire · an index is
built end-to-end with integrated vectorization · a Knowledge Base answers with grounded citations.

---

### Phase 3 — Intelligence spine II: enrichment → agents → transparency → memory *(AI/Copilot subsystem)*

The cognitive-client family, the multi-agent stack, ATLAS-class Copilot transparency, and the long-term
memory brain — all one subsystem. Roots first: **SVC-1** before its consumers; **AIF-5** before AIF-4/6/18.

- **AI-enrichment spine** *(Wave 4)* — **SVC-1** 4 cognitive clients (doc-intel/vision/language/translator)
  + canvas nodes **[foundation]** · **SVC-2** cognitive skillsets · **SVC-8** Content Safety activity ·
  **AIF-3** index-my-estate wizard (rides AIF-2) · **AIF-7** `ai-enrichment` workflow item · **FGC-19**
  AI Functions breadth + model-tier selector · **G2** AI-column-at-scale (warehouse/lakehouse grids, T-SQL,
  Dataflow AI step, multimodal).
- **Multi-agent spine** *(Wave 5)* — **AIF-5** typed agent tool catalog **[prereq for 4/6/18]** · **AIF-4**
  connected-agent composition · **AIF-6** visual multi-agent canvas · **AIF-8** Microsoft Agent Framework
  1.0 OSS Gov runtime **[backstops every agent item]** · **AIF-14** durable cross-session agent memory ·
  **AIF-18** browser-automation tool (Playwright ACA) · **G3** Operations Agent re-arch to Azure Monitor +
  Logic App · **G6** agentic-publish depth.
- **Copilot transparency + skills (merged from the CTS-addendum)** — **CTS-01** per-message status bar ·
  **CTS-02** detail badge · **CTS-04** sources/grounding attribution · **CTS-05** context-window meter ·
  **CTS-07** skills library (default-ON/opt-out) · **CTS-03** admin deep-trace panel · **CTS-10**
  transparency on every AI surface · **CTS-09** MCP-in-chat visibility (pairs with the MCP default-ON flip) ·
  **G4** Data Wrangler AI tab (rides G2's batch endpoint).
- **Memory & Brain** *(the "Wave 6.5" cluster — from-scratch on Cosmos + AI Search)* — **CTS-08** long-term
  memory brain **[foundation]** · **CTS-12** memory-write security guard **[Gov-critical hard dependency —
  same wave as CTS-08, not after]** · **CTS-06** dump-conversation-to-memory · **CTS-13** nightly
  consolidation pass.

**Operator action:** deploy 4 single-kind Cognitive accounts + `Cognitive Services User` grant (SVC-1) ·
reuse the Phase-2 Search→AOAI grant (AIF-3) · deploy `copilot/maf.bicep` Container App + UAMI (AIF-8) ·
Cosmos containers via `createIfNotExists` (AIF-14 + the 8 CTS containers) · Azure AI Search vector index
`copilot-memory-vec` (honest-gates to Cosmos keyword fallback) · ACA Job / Function timer (CTS-13).
**Acceptance gate:** roll + browser-verify — index-my-estate wizard runs to a live index · the multi-agent
canvas executes a connected-agent flow · the per-message bar shows real tokens/cost/latency · memory recall
returns a fact and the security guard blocks a poisoned write.

---

### Phase 4 — Platform, apps, developer surface & speed closures *(rides Phase-1 roots)*

The hosted-app dependents, the API-surface build-out (all riding BR-PAT), and the PSR-B speed wins that
benefit every surface (each acceptance = a PSR-1 delta).

- **App-runtime dependents** *(Wave 6 remainder)* — **DBX-2** custom agent hosting (rides DBX-1) · **DBX-9**
  publish a Data Agent as a Managed MCP Server (rides DBX-1) · **BR-WEBHOOK** outbound webhook /
  event-subscription registry **[feeds W18 — which now lands in Phase 7, after W11]**.
- **Developer platform** *(Wave 16, all ride BR-PAT)* — **BR-OPENAPI** versioned OpenAPI 3.1 + generated
  SDKs · **BR-TERRAFORM** `terraform-provider-loom` · **BR-SCIM** SCIM 2.0 provisioning · **DBX-8** Clean
  Rooms · **DBX-12** Lakeflow Connect → UC managed table · **DBX-13** Catalog Federation (honest-gate) ·
  **DBX-14** Feature Store + Online Tables.
- **PSR-B — speed closures** — **PSR-3** warm Spark pool DEFAULT-ON + cross-replica lease store **[canonical
  warm-pool owner]** · **PSR-4** Databricks/AML warm fast-path · **PSR-5** AAS warm/result-cache · **PSR-6**
  ADX result-cache + paging · **PSR-7** dashboard tile parallelization · **PSR-8** Copilot turn SLO ·
  **PSR-9** route-level code-splitting.
- **UX sweep** — **U5** apps / Palantir / compute-tail surfaces (pairs with the App-Runtime + dev-platform
  subsystem).

**Operator action:** Event Grid topic + Service Bus DLQ (BR-WEBHOOK) · `spark-warm-leases` Cosmos container
+ confirm Synapse pool auto-pause / AML CI idle-shutdown defaults (PSR-B, warm resting cost ~$0) · (opt-in)
APIM product fronting (BR-OPENAPI) · Terraform Registry publish (BR-TERRAFORM).
**Acceptance gate:** roll + browser-verify — a custom agent + a Data-Agent-MCP host serve traffic · a
webhook fires on an event · the OpenAPI SDK round-trips a PAT-auth call · a warm Spark run beats the cold
baseline on `/admin/performance`.

---

### Phase 5 — Real-Time Intelligence depth + Governance / ALM / capacity / sharing

RTI depth plus the P1 admin/ALM/governance cluster (every item release-relevant). Folds in the
operator-authored domain-designer backlog item.

- **RTI depth** *(Wave 7)* — **FGC-12** Digital Twin Builder (ADX-native default, ADT opt-in) · **FGC-13**
  Activator trigger-model depth · **FGC-14** Real-Time hub connectors + samples · **FGC-15** Eventstream
  DeltaFlow CDC · **AIF-11** PTU + Batch deployment types · **AIF-13** AgentOps eval-linked tracing ·
  **CTS-14** Copilot replay → eval-suite (shares AIF-13's trace store + redactor).
- **Governance / ALM / capacity / sharing** *(Wave 8; FGC-24 + BR-APPROVAL already ✅ DONE)* — **FGC-20**
  Azure SQL PITR · **FGC-25** capacity surge/admission control · **FGC-28** chargeback report **[canonical
  chargeback base]** · **FGC-30** external cross-tenant sharing (Entra B2B + scoped ADLS) **[canonical
  sharing owner]** · **BR-COSTATTR** cost-per-query attribution (extends FGC-28).
- **Operator-authored backlog (folded in here)** — **gh #1483** multi-library domain designer + federated
  data-mesh (epic #1470). **⚠ Prerequisite: depends on gh #1481 (FedCiv domain library)** — confirm #1481
  is shipped or schedule it in this phase first; otherwise **park #1483** and note the block.
- **UX sweeps** — **U6** governance pages · **U11** B-sweep canvases / RTI / modeling editors (pairs with
  RTI depth).

**Operator action:** FGC-12 ADT path only if exercised (`adt-instance.bicep` + Data Owner) — default
ADX-native path needs none · Cost Management Reader for Console UAMI (FGC-25/28) · scoped ADLS grant +
Entra B2B guest config (FGC-30).
**Acceptance gate:** roll + browser-verify — a Digital Twin renders on ADX · the chargeback report shows
real per-query cost · an external B2B recipient reads a scoped share · the domain designer lists a real
curated library (or #1483 is parked with the reason recorded).

---

### Phase 6 — Data science depth + Databricks data platform + scale tuning

- **Data science depth** *(Wave 9)* — **FGC-16** Data Wrangler · **FGC-17** SemPy `LoomDataFrame` · **FGC-18**
  batch model scoring · **FGC-22** Copilot model-health scan · **FGC-21** standalone DAX view · **AIF-12**
  Model Router **[canonical routing owner]** · **CTS-16** circuit-breaker + learned routing (deepens AIF-12) ·
  **CTS-11** skills self-evolution (rides CTS-07).
- **Databricks data platform** *(Wave 10; DBX-3+DBX-7 ship together, DBX-5 follows DBX-6)* — **DBX-3**
  Lakeflow DLT visual editor · **DBX-7** streaming tables + MVs · **DBX-4** Lakebase Postgres OLTP · **DBX-6**
  UC Metric Views · **DBX-5** Genie metric-view grounding (after DBX-6) · **DBX-11** Iceberg/UniForm dropdown.
- **PSR scale closures** — **PSR-10** Cosmos RU/partition autoscale advisory · **PSR-11** ACA autoscale +
  KEDA tuning (consumes PSR-14) · **PSR-14** concurrent-user load tests (feeds PSR-11) · **PSR-15** quota
  preflight advisor. *(PSR-12/PSR-13 may ride here or Phase 9.)*
- **UX sweep** — **U3** databases & migration tail.

**Operator action:** `postgres-flexible.bicep` metered server (DBX-4) · optional Azure Load Testing resource
(k6-in-CI fallback where not GA in Gov) for PSR-14. Others reuse provisioned AOAI/AAS/Synapse/AML.
**Acceptance gate:** roll + browser-verify — a DLT pipeline runs · Metric Views ground a Genie answer ·
a load test drives the autoscale tuning number on `/admin/performance`.

---

### Phase 7 — New item types: governance, quality, agent-flow + Data-Product model-truth

The new item types that create downstream dependencies, plus the 3 P0 data-product model-truth fixes that
must precede any DP depth. **W18 lands here (not Phase 4) — it consumes W11 (DQ engine).**

- **New item types** *(Wave 11)* — **W9** Agent Flow Designer · **W10** Data Contract item **[canonical
  contract owner]** · **W11** DQ Rule Engine **[must precede W18]** · **W12** Synthetic Data Generator ·
  **AIF-15** AI Red Teaming Agent · **BR-CONTRACT-GATE** publish-time schema-diff gate (folds into W10) ·
  **DOC-6** typed replacements for 3 raw-JSON `no-freeform-config` violations.
- **Data-product model-truth (folded from the DP-addendum)** — **DP-1** unify the data-product model
  **[keystone — DP-3/5/8/16 assume it]** · **DP-2** item-type taxonomy cleanup · **DP-17** fix the 3
  freeform-config violations.
- **Marketplace analytics (moved here to fix the ordering inversion)** — **W18** marketplace listing
  analytics + subscriber SLA webhooks (rides BR-WEBHOOK from Phase 4 **and** W11 from this phase).

**Operator action:** Durable Functions app + task-hub storage (`LOOM_AGENTFLOW_ORCHESTRATOR`) for W9 · DQ
Cosmos container for W11.
**Acceptance gate:** roll + browser-verify — an agent flow chains real MCP tools · a breaking schema change
is blocked at publish · the unified data-product model shows one status vocabulary · W18 emits an SLA webhook
driven by a real W11 DQ result.

---

### Phase 8 — Collaboration / IA + Health, media & batch AI services

- **Collaboration layer** *(Wave 12)* — **W5** real-time co-authoring (canvases + notebooks) · **W4** canvas
  comments · **W7** ambient Copilot ghost-nodes · **BR-COMMENTS** threaded comments + @mentions · **W22**
  Learning Hub sandbox labs.
- **Health / media / batch services** *(Wave 13)* — **SVC-3** Azure Health Data Services (real FHIR + DICOM +
  de-id) · **SVC-4** Content Understanding · **SVC-5** Azure Batch · **SVC-6** Video Indexer · **SVC-7**
  Planetary Computer shortcuts · **DBX-10** MLflow 3.x GenAI tracing (linked to the AIF-13/CTS-14 trace
  store, not a duplicate).
- **UX sweeps** — **U10** hubs / launchers / shell pages · **U2** streaming/messaging/RTI thin surfaces ·
  **U12** B-sweep SQL / data / ML / Foundry / Palantir / apps.

**Operator action:** `Microsoft.SignalRService/webPubSub` + UAMI Service Owner + `LOOM_WEBPUBSUB_ENDPOINT`
(W5; honest-gates to single-editor fallback) · Automation/Logic-App TTL teardown (W22) · `health-data-
services.bicep` metered FHIR workspace, default-off (SVC-3) · Video Indexer account (SVC-6).
**Acceptance gate:** roll + browser-verify — two live cursors co-edit a canvas · a real FHIR resource loads ·
a Video Indexer analysis lands in Delta.

---

### Phase 9 — Data engineering & Data Factory depth + Admin / FinOps / app lifecycle

- **Data engineering depth** *(Wave 14)* — **FGC-01** T-SQL Notebook · **FGC-02** Python single-node
  Notebook · **FGC-03** Materialized Lake Views (incremental + lineage) · **FGC-04** Semantic-model refresh
  activity · **FGC-05** Airflow Loom-item operators · **FGC-08** Spark billing + max-spend cap · **FGC-11**
  `loom-cli` + VS Code extension · **FGC-31** workspace create wizard + settings flyout.
- **Admin / FinOps / lifecycle** *(Wave 15)* — **FGC-26** capacity overage toggle · **FGC-27** capacity
  health/timepoint · **FGC-29** Copilot capacity designation · **W14** FinOps what-if simulator · **W15**
  app clone/fork · **W16** app version-upgrade · **W13** Incident/Runbook item · **W17** report mobile
  layout · **CTS-17** AI spend burn-rate projection (extends FGC-28/W14 — build after BR-COSTATTR).
- **PSR interleave** — **PSR-12** Front Door immutable caching · **PSR-13** session-store hardening (if not
  taken in Phase 6).
- **UX sweeps** — **U1** data-integration navigators · **U8** admin identity/security/platform · **U9**
  admin data-governance / labeling / ops.

**Operator action:** Cost Management Reader for the Spark spend cap (FGC-08, shared) · W13 action-group
webhook → Function + Automation account · Front Door rules-engine caching rule (PSR-12).
**Acceptance gate:** roll + browser-verify — a T-SQL notebook executes · the FinOps simulator prices a
what-if from the Retail Prices API · the burn-rate alert fires on a real spend threshold.

---

### Phase 10 — Data Product marquee & mesh-class end-state

The full data-product experience, gated on the Phase-7 model-truth fixes and the Phase-5 sharing/chargeback
owners it rides.

- **Guided creation & certification** *(Wave 19)* — **DP-3** guided creation wizard · **DP-5** certification
  pipeline · **DP-4** template gallery + provenance · **DP-6** walkthroughs + LearnPopovers · **DP-7** Copilot
  data-product builder · **DP-8** input/output/management ports.
- **Mesh-class depth & shareable end-state** *(Wave 20)* — **DP-9** versioning + deprecation (rides
  W10/BR-CONTRACT-GATE) · **DP-10** subscription approval + automated fulfillment · **DP-16** shareable end
  state (rides FGC-30 + Delta Sharing PR #1578) · **DP-11** feedback/ratings/usage (rides W18) · **DP-12**
  sample data + starter notebook · **DP-13** live SLO monitoring · **DP-14** value metrics (rides
  FGC-28/BR-COSTATTR) · **DP-15** governed↔infra cross-linking.
- **UX sweep** — **U7** catalog / marketplace / data-product tail.

**Operator action:** Console UAMI **User Access Administrator** (or scoped custom role) on the data-plane RG
for DP-10 automated fulfillment (default-off, honest-gated) · Azure Monitor scheduled-query alert for DP-13
(reuses the RTI Activator substitute) · Cosmos containers via `createIfNotExists` (DP-11/DP-12).
**Acceptance gate:** roll + browser-verify — the guided wizard creates a certified data product end-to-end ·
a subscriber's request is auto-fulfilled with a real scoped grant · SLO monitoring shows a live number.

---

### Phase 11 — Reliability, DR, chaos & remaining Fabric/service/breadth tail

- **Fabric / service tail** *(Wave 17)* — **FGC-06** Dataflow Gen2 Fast Copy · **FGC-07** OneLake
  cross-workspace security roles · **FGC-09** NEE honest-gate + Photon opt-in (coordinate with PSR-3) ·
  **FGC-10** high-concurrency Spark pooling (coordinate with PSR-3) · **FGC-23** mirrored-DB CDC copy-job ·
  **SVC-9** Confidential Ledger · **SVC-10** Graph Data Connect · **SVC-11** Chaos Studio panel **[canonical
  chaos owner]**.
- **Net-new breadth + resilience** *(Wave 18)* — **BR-REVERSEETL** reverse-ETL · **BR-DBT** dbt Core ·
  **BR-DQANOMALY** ML DQ anomaly detection · **BR-CONTROLPLANE-DR** control-plane multi-region **[canonical
  DR owner]** · **BR-AIDOCS** AI-generated data docs · **BR-ICEBERG-WRITE** writable Iceberg · **BR-AMBIENT-
  FEED** ambient insight feed **[canonical ambient owner]** · **BR-BLUEGREEN** blue-green console rolls
  **[canonical blue-green owner]** · **CTS-15** proactive/ambient context injection (feeds BR-AMBIENT-FEED).
- **PSR reliability (ride the owners above)** — **PSR-16** SLO definitions + burn-rate alerts · **PSR-17**
  synthetic-probe canary (the Phase-0 UAT harness, now continuous) · **PSR-18** blue-green canary (REF
  BR-BLUEGREEN) · **PSR-19** control-plane DR drill (REF BR-CONTROLPLANE-DR) · **PSR-20** chaos-under-fault
  (REF SVC-11).
- **UX sweep** — **U13** B-sweep catalog / marketplace / monitor / admin / hub pages.

**Operator action:** Confidential Ledger deploy (SVC-9) · Chaos Studio targets (SVC-11) · GDC app consent +
M365 E5/GDC add-on (SVC-10) · Cosmos multi-region write + secondary ACA behind Front Door
(BR-CONTROLPLANE-DR) · OSS Iceberg REST catalog Container App (BR-ICEBERG-WRITE) · Azure Monitor burn-rate
alert rules + action group (PSR-16) · scheduled ACA Job for the PSR-17 canary.
**Acceptance gate:** roll + browser-verify — a reverse-ETL job writes to Azure SQL · a measured DR failover
drill produces a real RTO/RPO number · a chaos experiment runs under a benchmark and the SLO burn-rate alert
fires.

---

### Phase 12 — Hyperscale structural band *(LAST — hard-gated on PSR-A green on main)*

The three custom Loom-native structural services that replace per-item glue with owned substrate. **Do not
start until PSR-1 + PSR-2 are green on main.** For this band the no-vaporware receipt **is** a PSR-1
benchmark number.

- **Wave H1 — Loom OneLake** (unified `loom://` namespace/shortcut/security/catalog over ADLS Gen2) —
  **HYP-1** namespace/catalog service skeleton · **HYP-2** shortcut engine as a service · **HYP-3**
  OneLake-security enforcement service · **HYP-4** 7 residual UI/BFF gaps · **HYP-16** cross-cutting
  platform (per-service bicep + UAMIs + honest-503 + diag + env wiring).
- **Wave H2 — Loom Direct Lake** (Rust + Arrow + `delta-rs` + DuckDB columnar cache/scan engine, the
  Gov-capable VertiPaq outcome-equivalent) — **HYP-5** columnar service skeleton · **HYP-6** segment-
  residency cache + Redis cross-replica coherence · **HYP-7** DAX-lite → Arrow/SQL compiler · **HYP-8**
  DirectQuery-class cold fallback. **Riders land here:** **HYP-14** (rides PSR-3's Redis lease store) ·
  **HYP-15** (rides PSR-5/PSR-6's Redis result-cache).
- **Wave H3 — Loom Capacity Broker** (Rust/Go admission-control service + Redis timepoint ledger
  implementing smoothing/bursting math) — **HYP-9** broker skeleton (`POST /admit`) · **HYP-10**
  smoothing/bursting + throttle (extends FGC-25) · **HYP-11** choke-point wiring (Spark/Databricks/ADX/AML/
  Direct-Lake → `/admit`) · **HYP-12** Capacity-Metrics admin page · **HYP-13** throttle events → Event Grid
  → Activator.

**Operator action:** `compute/loom-onelake-app.bicep` + UAMI (Storage Blob Data Contributor on DLZ lake +
Cosmos registry) · `compute/loom-directlake-app.bicep` (per-tenant `minReplicas`, NOT scale-to-zero) +
**one shared Azure Cache for Redis Premium** (amortized across Direct Lake residency, Broker ledger, Spark
lease store, result-cache) + UAMI (Storage Blob Data Reader) · `compute/loom-capacity-broker-app.bicep`
(`minReplicas: 2`, HA) + Event Grid custom topic + UAMI (zero data-plane roles).
**Acceptance gate:** PSR-1 numbers — `loom://` resolve p95 ≤ 25 ms · sub-second aggregate on a warm Direct
Lake frame · `/admit` p99 ≤ 10 ms + smoothing golden test green.

**Future / post-H-band backlog (not yet scheduled):** **Bridge services band** — four custom
control-plane services (loom-sql-gateway · loom-onesecurity · loom-gitsync · loom-pulse, 23 items BR-SQL/BR-SEC/BR-GIT/BR-PULSE) that close the Fabric *coherence* gap (one SQL front door, one policy truth, one Git spine, one event backbone), Azure-native, same standalone-service + honest-503 pattern as the H-band — see `PRPs/active/bridge-services/PRP-bridge-services.md`.

---

## Counts

**Honest deduped total ≈ 350–370 distinct forward work items** — every source PRP reads *"Status:
proposed"*; **nothing below is built.** The `WAVES.md` running totals (~116 / 133 / 166) are stale by ~3×
because each addendum re-based off a different prior count; this table is the reconciled union.

| PRP source | Fwd items | Notes |
|------------|-----------|-------|
| Fabric gap closure (FGC-01…31) | 30 | FGC-24 ✅ DONE excluded |
| AI Foundry integration (AIF-1…18) | 18 | — |
| Azure service integrations (SVC-1…11) | 11 | — |
| Databricks parity (DBX-1…14) | 14 | — |
| Surface max-enhancements (W1…22) | 22 | — |
| Docs-drift (DOC-1…6) | 6 | — |
| Breadth-critic (BR-*) | 14 | ~14 scheduled of 21 (7 dedup/deferred); BR-APPROVAL ✅ excluded |
| Copilot G-verify (G1…6) | 6 | merged into Phases 2–3 |
| Copilot transparency/skills/memory (CTS-01…17) | 17 | merged into Phase 3 (+ CTS-14/15/16/17/11 ride later phases) |
| Data Product (DP-1…17) | 17 | 3 fold into Phase 7, 14 in Phase 10 |
| UX baseline (SC-1…10 + CAP-R2 + 170 surfaces) | 181 | 10 shared + 1 capture + 170 per-surface |
| Performance/scale (PSR-1…20) | 17 | net-new; PSR-18/19/20 are REF glue on BR/SVC owners |
| Hyperscale (HYP-1…16) | 16 | HYP-14/15 ride PSR-3/5/6 (still 2 distinct deployables) |
| **Total (forward, deduped)** | **≈ 369** | LIN-GC (3) DELIVERED + gh #1483 (unsized) excluded from count |

**Rough per-phase distribution** (indicative — the authoritative per-item lists are above):

| Phase | Theme | ~Items | Waves folded |
|-------|-------|--------|--------------|
| 0 | Owed cleanup | 3 tasks | (RTA E2E · CAP-R2 · debris purge) |
| 1 | Foundations & correctness | ~21 | Wave 1 · U0 · PSR-A · roots W1/BR-PAT/DBX-1 |
| 2 | Visible UX + RAG spine | ~15 | Wave 2 · Wave 3 · G1/G5 |
| 3 | Enrichment → agents → transparency → memory | ~28 | Wave 4 · Wave 5 · Wave 6-copilot · Wave 6.5 · G2/G3/G4/G6 · CTS |
| 4 | Platform, apps, dev surface, speed | ~27 | Wave 6-rem · Wave 16 · PSR-B · U5 |
| 5 | RTI depth + governance/ALM/sharing | ~40 | Wave 7 · Wave 8 · gh #1483 · U6 · U11 · CTS-14 |
| 6 | Data science + Databricks + scale | ~24 | Wave 9 · Wave 10 · PSR scale · U3 · CTS-11/16 |
| 7 | New item types + DP model-truth | ~11 | Wave 11 · DP-1/2/17 · W18 |
| 8 | Collaboration + health/media/batch | ~58 | Wave 12 · Wave 13 · U10 · U2 · U12 |
| 9 | Data-eng depth + admin/FinOps | ~48 | Wave 14 · Wave 15 · PSR-12/13 · U1 · U8 · U9 · CTS-17 |
| 10 | Data Product marquee | ~24 | Wave 19 · Wave 20 · U7 |
| 11 | Reliability / DR / chaos / tail | ~49 | Wave 17 · Wave 18 · PSR-16…20 · CTS-15 · U13 |
| 12 | Hyperscale structural band (LAST) | 16 | H1 · H2 · H3 |

**Wave labels collapsed:** ~40 distinct labels across 6 old numbering schemes (numeric 1–20, fractional
6.5, U0–U13, PSR-A/B, H1–H3) → **13 ordered phases.** Effort band: **XL multi-quarter program** even at
aggressive multi-agent throughput, driven by the hard gates (U0 before all UX; PSR-A green before the
H-band; AIF-2 / AIF-5 / SVC-1 / DBX-1 / W1 / BR-PAT as sub-DAG roots).

---

## HOW TO START

Run this verbatim at the start of a fresh session (after a context clear) to begin Phase 0, then Phase 1:

```
Read PRPs/active/next-waves/MASTER-ROLLOUT.md and the die-hard rules in .claude/rules/ (no-vaporware.md,
no-fabric-dependency.md, ui-parity.md). We are executing the MASTER ROLLOUT in phase order — phases
supersede the old WAVES.md numbering.

FIRST do Phase 0 (owed cleanup), all three in parallel:
  1. Bring the in-VNet Playwright UAT harness (tracker #1549) to a clean green full-visual run.
  2. CAP-R2: live Fabric walks of the 7 un-captured surfaces (Real-Time Dashboard, Report editor,
     Semantic-model view, KQL Queryset, Copy job, Map, task flows) -> extend
     scratchpad/fabric-ux-observations.md PART 3.
  3. Run the shipped LIN-GC-2 reconcile (POST /api/admin/lineage/reconcile, non-dry-run) to purge the
     UAT/diagnostic workspace debris; confirm /governance/lineage is clean.
Do not open Phase 1 until Phase 0's gate is green (UAT green, CAP-R2 PART 3 written, lineage clean).

THEN do Phase 1 (foundations & P0 correctness) as one multi-agent build session, one agent per item,
built in parallel off fresh worktrees on origin/main, single build-gate + roll at the end:
  - U0 shared UX library: SC-1..SC-10 (per PRP-ux-baseline-program.md).
  - PSR-A: PSR-1 benchmark harness + /admin/performance page, PSR-2 CI perf gate
    (per PRP-performance-scale-parity.md). PSR-1+PSR-2 green on main is the hard gate for Phase 12.
  - BR-PAT scoped API tokens (loomPatTokens + resolvePat() + /admin/developer/tokens).
  - DBX-1 loom-app-runtime on ACA (per PRP-databricks-parity.md).
  - W1 undo/redo useCanvasHistory hook (per PRP-surface-max-enhancements.md).
  - Wave 1 docs/compliance truth: DOC-1, DOC-2, DOC-3, DOC-4, DOC-5, BR-SIEM.
Honor every die-hard rule: default-ON/opt-out, Azure-native by default (Fabric/Power BI strictly opt-in),
and the no-scaffold receipt (real-backend screenshot + physical click-walk with
LOOM_DEFAULT_FABRIC_WORKSPACE unset) for every surface. Roll and browser-verify the Phase-1 gate before
advancing to Phase 2.
```

## Azure Government day-one parity

See `docs/fiab/gov-parity-audit.md` — per-service MAG availability (grounded in
Microsoft Learn), endpoint-coverage audit (`cloud-endpoints.ts` SSOT is largely
done; provision-time bicep break GOV-1 in `ai-search.bicep`), Gov substitutions
(Databricks UC has NO Gov backend → loom-unity OSS service; Fabric/OneLake
absent → Azure-native default; Digital Twins/AAS absent → substitutes), and the
prioritized GOV-1..12 fix list. Tracked under the GOV-PARITY task.
