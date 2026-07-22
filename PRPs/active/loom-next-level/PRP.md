# PRP — Loom Next Level (2026-07-22, rev 2 pass 2 — +UI/UX Excellence +North Star)

**Program:** take CSA Loom from "unbelievably broad B+" to "defensible A" by pointing a
full cycle at the five structural gaps identified in the 2026-07-22 brutally-honest
review: verification depth, convention adoption lag, analyst-surface depth,
blast-radius/isolation, and the product having no eyes on itself in production —
plus the approved repo restructure and the capability additions (Copilot evals,
cost intelligence, column-level lineage, DR drills).

**Rev 2 (same day):** four adversarial critic passes (completeness, SRE/security,
product/competitive, internal-consistency) were applied. Headline changes: a
**BLOCKER** bicep param-cap prerequisite (R0), WS-DR re-scoped to **extend the
existing `dr-drill.yml`** apparatus instead of duplicating it, the L2 OpenLineage
ingest **security redesign**, a new secret/credential-lifecycle workstream (WS-S,
top priority — the 07-19 MSAL outage recurs on a 2-year clock), a new operability
band (WS-O), collab/search/delivery product additions (A14, SRCH1, C5), threat-model
gating before identity enforcement (I9), supply-chain signing gated into the
real deploy path (SC1), the X-section renumbered, and the phase spine corrected
for real dependencies. Item count: **77 → 97**.

**Pass 2 (same day):** two new workstreams from the 2026-07-22 audit + research
fan-out. **WS-U (UI/UX Excellence, U0–U12)** takes the remainder of the
dark-font deep sweep + canvas G3/parity audit — everything NOT already fixed in
PRs #2382/#2389/#2390: structural G3 on the flagship editors (report designer,
notebook cells, Workshop/Slate, the query↔results divider across all 11 Monaco
editors), the three leader-gap builds (mapping-dataflow Debug/Preview, KQL
dashboard depth, full-screen canvas), and systemic hygiene (the `/browse`
renderer-freeze virtualization, a ratcheted 142-site px-grid→TileGrid sweep —
ratchet #13). **WS-N (North Star, N1–N20)** synthesizes the three research
reports (datastack, ai-first, bi-dx-gov) into a Phase-4 program. Item count:
**97 → 130**.

**North-star thesis (pass 2):** the program's end-state is Loom as the **#1
AI-first data & analytics platform**, on three pillars — **(1) OPENNESS:** the
lakehouse speaks the protocols every engine already speaks (Iceberg REST
catalog + Delta/Iceberg dual metadata as the flagship, DuckDB, Arrow
Flight SQL/ADBC, SQLMesh, asset semantics, enforced ODCS contracts) so
Snowflake/Databricks/Trino/DuckDB customers light up against Loom with zero
migration; **(2) TRUST / AI-FIRST:** the agentic analyst is grounded in a
verified semantic contract + an authored knowledge graph (GraphRAG over
Weave/AGE — the headline nobody else has), refuses instead of guessing, and
ships a receipt with every answer; **(3) GOVERNED ANALYTICS:** one headless
metrics layer serves BI + NL2SQL + API from a single definition, reports are
code, and observability is OpenLineage-conformant with a real incident
console. Wrapping all three is the **sovereign moat**: the same agentic
analyst runs disconnected in IL5/air-gap on in-boundary services — the
position Databricks/Snowflake/ThoughtSpot structurally cannot reach. Every
N-item's IL5 note must serve that principle (see the moat block in
[ws-north-star.md](ws-north-star.md)).

**Operator scoping decisions (2026-07-22, recorded verbatim):**

1. **Cloud matrix:** build + validate on the two live estates — **Commercial**
   (centralus, sub `e093f4fd`) and **Azure Government GCC-High** — with
   **IL5/air-gapped as a design constraint**: every item documents its IL5
   adaptation (no public endpoints, offline corpus, alternate services) without
   standing up an IL5 estate now. Azure China out of scope.
2. **Repo restructure:** **in-repo `legacy/` grouping** of the frozen
   CSA-in-a-Box trees (reversible, no new repo), with coordinated
   CI/mkdocs/pyproject path updates. See WS-R Area 5. **Rev 2:** re-sequenced as
   an **independent housekeeping track — execute last, any time** (product
   review: high-risk `git mv` churn with zero grade contribution must not
   compete with depth work for reviewer/CI budget).
3. **Per-workspace identity:** **phased shadow → enforce.** Phase A ships
   provisioning + shadow-mode divergence audit on both clouds; Phase B flips
   enforcement per-workspace behind a gate — now additionally gated on the I9
   threat-model/AppSec review.

## Workstream index (130 items across 7 appendix files)

| WS | Appendix | Items | One-liner |
|----|----------|-------|-----------|
| **WS-V** Verification depth | [ws-verification-dr.md](ws-verification-dr.md) | V1–V5 | Synthetic in-VNet user journeys (incl. TRUE MSAL login probe + git-sync/promotion journey), visual regression light+dark **× wide + narrow viewports** across 25 hubs, axe-core contrast ratchet, page.tsx route-smoke ratchet, live bicep-drift detection (whatif on `platform/fiab/bicep/**` + scheduled what-if vs both live estates) |
| **WS-DR** DR drills as CI | [ws-verification-dr.md](ws-verification-dr.md) | DR0–DR4 | **Extends the EXISTING `.github/workflows/dr-drill.yml` + `docs/DR.md` scenario framework** (cosmos-failover / storage-failover / keyvault-restore / bicep-rollback). DR0 = ADLS versioning enablement (found OFF — the only new enablement); DR1–DR4 map onto the existing scenarios + add `adls-versioning-restore`, validators, the graph/vector Cosmos account, and the admin surface |
| **WS-S** Secret/credential lifecycle | [ws-verification-dr.md](ws-verification-dr.md) | S1–S3 | **TOP priority.** MSAL client-secret expiry inventory + 60/30/7-day burn alerts (the 07-19 outage recurs on a 2-year clock — V1 only *detects* it), federated-credential feasibility spike → `msal-credential-strategy` runbook, auto-rotation workflow fallback |
| **WS-O** Operability & resilience | [ws-verification-dr.md](ws-verification-dr.md) | O1, RUM1, SLO1, DIAG1, CH1, EXP1, CMK1, SC1 | Unified alert-dispatch + on-call standard, client-side RUM, `/admin` SLO error-budget surface, one-click diagnostics/support bundle, dependency-chaos drills (Cosmos/AOAI/ADX/KV), workspace export-import-clone, Cosmos CMK for IL5-readiness, supply-chain signing/scan gated into the REAL deploy path (SC1 — trivy + cosign on every image, ACR enforcement re-enabled) |
| **WS-R** Convention ratchets | [ws-ratchets.md](ws-ratchets.md) | R0–R29 + MIG1 | **R0 (BLOCKER prereq): admin-plane `main.bicep` sits at the 256-param ARM cap — consolidate env params into object params BEFORE any item adds env vars.** Route-toolkit codemod + forbidding ratchet (1,356 hand-rolled routes baselined), editor-size ratchet + decompositions, typed client generation, shared editor-state hook, git-integration-client consolidation (R28), parity-doc-freshness ratchet (R29), Cosmos schema-migration convention (MIG1), `legacy/` repo restructure (R20–R27, housekeeping track — last, any time) |
| **WS-E** Copilot eval harness | [ws-copilot-cost.md](ws-copilot-cost.md) | E1–E6 + SRCH1 | Golden Q/A per surface, copilot-evaluator Function (retrieval hit-rate + LLM-judge grounding), score-floor ratchets, corpus-change gating, /admin/copilot-quality, tier-router evals, federated-search relevance evals (SRCH1 — same machinery over `/catalog`) |
| **WS-C** Cost intelligence | [ws-copilot-cost.md](ws-copilot-cost.md) | C1–C5 | Cost Management hardening, real Forecast API (+fallback), cost-anomaly-monitor Function with alerts, /admin/finops upgrade w/ real (audited) Budgets CRUD, scheduled snapshot delivery for KQL dashboards / scorecards / querysets (C5) |
| **WS-L** Column-level lineage | [ws-lineage-depth.md](ws-lineage-depth.md) | L1–L7 | columnMappings schema foundation, OpenLineage Spark listener (**ingest security redesigned: per-pool Entra auth, workspace-scoped writes, size/rate caps, private ingress**), ADF Copy-mapping derivation, Purview Atlas columnMapping push, column fan-out canvas + impact analysis, dbt manifest, UC/Gov-OSS rebase |
| **WS-A** Analyst-surface depth | [ws-lineage-depth.md](ws-lineage-depth.md) | A1–A14 | Real DAX parser/AST → SQL folding + 20 functions + golden numeric harness vs Power BI; report depth (small-multiples renderer, analytics pane, Gov map fallback, drill-through); Spark reliability (dashboard, FAULTED auto-recovery, quotas, chaos drill); real-time collab push transport + presence/comments on notebook/report/semantic-model/SQL editors (A14) |
| **WS-I** Per-workspace identity | [ws-identity-cloudmatrix.md](ws-identity-cloudmatrix.md) | I1–I9 | Activate the DORMANT scaffolding (workspace-identity-client.ts + workspace-identity.bicep): provision-on-create/delete-cascade, scoped data-plane grants, shadow divergence audit into the live PDP store, credential-factory adoption ratchet, per-workspace enforce + migration runbook, threat-model/AppSec review gate before enforce (I9) |
| **§X** Cloud matrix (cross-cutting) | [ws-identity-cloudmatrix.md](ws-identity-cloudmatrix.md) | X1–X3 | **Renumbered (rev 2):** X1 cloud-endpoints adoption ratchet (module exists, 1,339 lines); X2 structured `availability:{commercial,gccHigh,il5}` on ENV_CHECKS → automatic honest gates (formerly "X.3"); X3 per-cloud CI validation lanes incl. `gov-workspace-identity.yml` (formerly "X.5", previously uncounted). The Learn-verified service-availability matrix (X-MATRIX) and the IL5 checklist (X-IL5) are un-numbered reference blocks, not items |
| **WS-U** UI/UX excellence | [ws-ui-excellence.md](ws-ui-excellence.md) | U0–U12 | **Pass 2.** Remainder of the 07-22 dark-font + canvas-G3 audits (post #2382/#2389/#2390): U0 P0-VERIFY drag+reload receipts on already-PASS canvases (resolves the operator's "nothing resizes" vs code-audit contradiction); structural G3 — report-designer full G3 + Power BI aux panes, notebook per-cell resize, Workshop/Slate, fixed-height stragglers, query↔results divider ×11 Monaco editors; leader-gap builds — mapping-dataflow Debug/Preview/Inspect/column-stats (the largest parity build), KQL dashboard parameters/drillthrough/live-refresh/pages, full-screen canvas kit mode (AHEAD); hygiene — `/browse` VirtualizedGrid (renderer-freeze P0), ratcheted 142-site px-grid→TileGrid sweep (ratchet #13), new-item-dialog token cluster |
| **WS-N** North star (#1 AI-first platform) | [ws-north-star.md](ws-north-star.md) | N1–N20 | **Pass 2, Phase 4.** Three pillars + sovereign moat. **Openness:** Iceberg REST catalog + Delta↔Iceberg dual metadata (flagship N1), DuckDB dual-mode, Flight SQL/ADBC, SQLMesh+dbt, software-defined assets, ODCS contracts enforced at ingest, Tier-2 condensed (RisingWave/Debezium CP/reverse-ETL/data-diff/Trino), labs. **Trust/AI-first:** verified semantic contract + VQR + refuse-not-guess, answer receipts w/ verified badge, GraphRAG over Weave/AGE (headline), self-healing NL2SQL, unified LLMOps (extends WS-E), Tier-2 condensed. **Governed analytics:** headless MetricFlow metrics layer, BI-as-code `code-report` item, OpenLineage incident console (extends WS-L), embedded-analytics SDK w/ RLS, Tier-2 condensed, labs |

## Relationship to sibling PRPs (rev 2 — cross-PRP reconciliation)

Two other active PRPs overlap this program. **Neither previously cross-referenced
this one; these are now the binding decision rules:**

1. **`PRPs/active/enterprise-hardening/`** (07-08) already specs SLOs +
   error-budgets (§1), k6/Locust load + soak on Azure Load Testing (§2), BCDR
   multi-region + DR-drill tooling, Cosmos partition/capacity migration (§4.2),
   rate-limiting/quota, and AOAI 429 retry.
   - **DR decision rule:** loom-next-level WS-DR owns **single-region restore
     drills as CI, extending the existing `dr-drill.yml`**; multi-region
     failover/BCDR remains enterprise-hardening's scope. A reader must not build
     competing quarterly DR workflows.
   - **SLO decision rule:** enterprise-hardening §1 owns the SLO/error-budget
     *program* (RED SLI catalog, multi-window burn-rate alerting); this PRP's
     **SLO1** builds only the concrete `/admin` surface that unifies the SLIs
     this program itself ships (V1 journey verdicts, `copilot-slo.ts`, cost
     cache-hit) and feeds that program.
   - **Load/chaos decision rule:** the full 60k-user soak defers to
     enterprise-hardening §2; this PRP's **CH1** is dependency-*fault-injection*
     (Cosmos/AOAI/ADX/KV) + a circuit-breaker audit, which enterprise-hardening
     does not cover. An optional lightweight k6 hot-path smoke (LT1) and an
     SDK/Terraform drift ratchet (DX1) are noted in the completeness review but
     NOT taken as items here — cite, don't duplicate.
   - **Cosmos migration:** MIG1 (schema-version/on-read-upgrade convention)
     coordinates with enterprise-hardening §4.2 (partition-key migration is the
     first real consumer of the convention).
2. **`PRPs/active/loom-competitive-audit-2026-07-20/`** (Track-C). No pillar
   duplication found. One adjacency: **Track-C WS-11.1 monolith decomposition vs
   WS-R R8–R12** target the same editors. **Decision rule: WS-R OWNS editor
   decomposition; Track-C WS-11.1 is redirected to WS-R** (WS-R is line-ranged,
   plan-driven, ratchet-gated; 2 of 5 editors already done). Also flag to the
   competitive-audit owner: **PARITY-MATRIX §2 "Source control (Git)" grade "C /
   honest-gate" is STALE — actual state is a real Fabric-parity git client;
   re-grade A− (folded into R28's acceptance).**
   - **Pass-2 addition:** WS-N is now the **canonical spec for the
     forward/competitive "north-star" roadmap** (the three-pillar synthesis of
     the 07-22 datastack / ai-first / bi-dx-gov research). Any Track-C forward
     item that overlaps a numbered N-item redirects here; Track-C keeps
     ownership only of items WS-N does not number. Inside this PRP the
     anti-duplication rules are explicit: N13 EXTENDS WS-E (prompt registry +
     token budgets only — the eval harness/gates stay E1–E6), N17 EXTENDS WS-L
     (L2 owns OL ingest; N17 adds emission generalization, export, and the
     incident UX), N19d/N19e EXTEND WS-C (C5 delivery / cost-client), and the
     bi-dx `/browse` virtualization item is owned by WS-U U10.

## Ground-truth corrections the drafting + review audits surfaced (these override stale memory/docs)

1. **Azure Analysis Services IS GA in Azure Government** (FedRAMP High / IL4 / IL5,
   Learn-verified) — the current `isGovCloud()` block and the "AAS not in Gov"
   assumption are WRONG. A4 lifts the block behind verification.
2. **Per-workspace identity is scaffolded, not greenfield** —
   `lib/azure/workspace-identity-client.ts` and
   `platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep` exist dormant.
3. **`lib/azure/cloud-endpoints.ts` already centralizes cloud detection/suffixes**
   (Commercial/GCC/GCC-High/DoD) — X1 is an adoption ratchet, not a build.
4. **The real route-toolkit gap is 1,356 hand-rolled routes** (of 1,541), not ~310.
5. **ADLS `isVersioningEnabled: false` in storage.bicep** — DR0 enables it; Cosmos
   PITR (Continuous7Days) and KV soft-delete + purge protection are already on.
6. **Column lineage exists today only for Databricks UC**; Purview and Weave/Thread
   edges are table-grain (no column fields).
7. **The loom-native DAX "evaluator" is 3 regexes** — everything beyond
   EVALUATE/TOPN/ROW/CALCULATE+simple aggs needs AAS today. WS-A items A1–A5 make
   it a real engine.
8. **The report designer already has 25 visuals + conditional formatting +
   cross-filtering** — depth items target real gaps (small-multiples rendering,
   analytics pane, Gov maps, drill-through), not re-builds.
9. **(rev 2, BLOCKER)** `platform/fiab/bicep/modules/admin-plane/main.bicep` sits at
   **exactly 256 `param` declarations — the ARM hard cap**. Any item adding a
   top-level param breaks the deploy. R0 consolidates env params into object/bag
   params FIRST; every bicep-touching item cites the R0 rule.
10. **(rev 2)** A DR apparatus **already exists**: `.github/workflows/dr-drill.yml`
    (quarterly, scenarios cosmos-failover / storage-failover / keyvault-restore /
    bicep-rollback, scratch-env pre-flight + teardown) plus `docs/DR.md`,
    `docs/runbooks/dr-drill.md`, `docs/fiab/operations/disaster-recovery.md`,
    `docs/fiab/runbooks/cosmos-pitr-restore.md`. WS-DR extends it — it does NOT
    stand up parallel drills.
11. **(rev 2)** `bicep-whatif.yml` covers only `deploy/bicep/**` on PR — it never
    sees `platform/fiab/bicep/**` (where all Loom infra + every new module in
    this PRP lives) and never runs scheduled against the live estates. V5 closes
    this.
12. **(rev 2)** The `report-subscriptions` Function precedent embeds a **storage
    account key** in `AzureWebJobsStorage` and defers role grants to post-deploy
    bootstrap. New Functions must NOT mirror that part — identity-based
    `AzureWebJobsStorage__accountName` + bicep-declared role grants (universal
    standard below). The bicep-module precedent that IS binding:
    `modules/admin-plane/<name>-function.bicep`, wired into
    `admin-plane/main.bicep` (there is no `modules/functions/` directory).
13. **(rev 2)** The MSAL app is a confidential client with a **2-year client
    secret** and **zero expiry monitoring/rotation automation** — the exact 07-19
    outage class recurs on a clock. WS-S closes prevention; V1 remains detection.
14. **(rev 2)** Console telemetry is **server-side only** — no browser SDK, no
    client-side error/timing capture. RUM1 closes the real-user blind spot the
    synthetic-only WS-V leaves.
15. **(rev 2)** Collaboration presence/comments **exist** (`lib/collab/`, 4 canvas
    surfaces) but are poll-based (~5s) with no push transport and no coverage on
    notebook/report/semantic-model/SQL editors (A14). **Two parallel
    `git-integration-client.ts` implementations** (`lib/azure/*` and
    `lib/clients/*`) with two route trees serve the same feature (R28).
16. **(rev 2)** Admin pages are registered via `lib/components/admin-shell.tsx` +
    `lib/panes/admin-overview.tsx` — NOT `NAV_ITEMS` (the rail) — and every new
    nav/admin destination must pass PR #2385's
    `lib/nav/__tests__/nav-registries.test.ts` (no-duplicate hrefs, adminOnly
    flags, label+desc presence).

## Universal acceptance standards (every item, no exceptions¹)

- **G1:** in-browser E2E receipt with real data (minted session + where auth-path
  relevant, the true MSAL probe). tsc + vitest + DOM strings are NOT completion.
- **G2:** every new env var in `lib/admin/env-checks.ts` ENV_CHECKS **and**
  `lib/gates/registry.ts` GATE_META with a Fix-it wizard. Per item: update
  `lib/gates/__tests__/registry.test.ts` (the ENV_CHECKS ⇔ GATE_META parity gate)
  and keep `lib/admin/__tests__/env-config.test.ts` invariants green — this is
  the real per-item gate (the "env-count pin" phrasing in rev 1 was imprecise;
  `env-config.test.ts` is a soft invariant, `registry.test.ts` is the hard one).
  **Every new EnvSpec carries the X2 `availability` field.**
- **Naming convention (rev 2):** ENV_CHECKS ids are `svc-*` for services; app env
  vars are `LOOM_*`; enable flags are `LOOM_<X>_ENABLED`. Function host-setting
  CRONs follow the report-subscriptions precedent (verify its cron var name at
  implementation and match it).
- **G3 + ux-baseline:** SplitPane w/ persisted sizingKey on new panes; node
  compactness; tokens only (no raw px/hex); TileGrid/EmptyState primitives.
- **bicep-sync:** every new Azure resource/role/env lands in
  `platform/fiab/bicep/**` + the appropriate orchestrator + bootstrap workflow.
- **R0 param-cap rule (BLOCKER, rev 2):** `admin-plane/main.bicep` is at the
  256-param ARM cap. New bicep params go via an **object/config param (bag
  pattern)** or a nested-module param — NEVER a new top-level `param`. Applies to
  every bicep-touching item (V1, V5, DR0, DR4, C1, E2, C3, L3, I1, S1, O1, RUM1,
  CMK1, A14, …); R0 must land before any of them adds env/params.
- **Function standard (rev 2, from the SRE review):** every new Azure Function
  (E2, C3, L3, S1, C5-extension) uses (a) the bicep-module precedent
  `modules/admin-plane/<name>-function.bicep` wired into `admin-plane/main.bicep`
  alongside `report-subscriptions-function.bicep`; (b) **identity-based storage**
  — `AzureWebJobsStorage__accountName` + `AzureWebJobsStorage__credential=
  managedidentity` with a Storage Blob Data Owner grant in the module, **no
  storage account key in app settings**; (c) **all role assignments declared in
  bicep** (guarded `guid()` names, `skipRoleGrants`-aware) so a fresh deploy is
  functional with zero operator input; (d) a **Rollback subsection**:
  last-known-good image/package + the `az functionapp` redeploy command, and a
  drill step referencing the existing `bicep-rollback` DR scenario.
- **Alert standard (rev 2):** ALL alerting (V1, V5, DR, C3, A11, S1, O1, CH1)
  routes through ONE shared dispatch module (`lib/azure/alert-dispatch.ts`, built
  by O1) targeting the `monitoring-default-alerts.bicep::defaultActionGroup`, via
  the shared derived var **`LOOM_ALERT_ACTION_GROUP_ID`** (`LOOM_ALERT_*`
  convention). No parallel per-item Logic Apps or unprefixed action-group vars;
  email/webhook are *receivers* on the one action group. Acceptance texts may only
  claim channels that exist (no phantom Teams webhooks until O1 adds one).
- **Audit standard (rev 2, ATO):** every privileged admin **mutation** this PRP
  adds writes an `_auditLog` row via the existing `auditLogContainer()` helper —
  actor (`who`, `oid`), action, target scope, prior/new value, timestamp.
  Explicitly: C4 budget CRUD (`kind:'finops.budget'`) and I6 enforce toggle
  (`kind:'identity.enforce'`). Reviewers reject the PR without the audit row in
  the receipt.
- **Ratchet convention:** every floor/baseline is set from measured reality and
  moves only toward the target; the ratchet file lives in-repo and CI enforces
  it. **The program's ratchet inventory (pass 2 — 13):** vitest coverage
  floor (existing, `14a16d8e`), a11y baseline (V3), route-toolkit baseline (R3),
  file-size allowlist (R7), cloud-endpoint literals (X1), eval floors incl.
  tierAccuracy (E3/E6), route-coverage floor (V4), committed visual baselines
  (V2), credential-adoption count (I5), client-fetch known-route baseline (R17),
  parity-doc-freshness baseline (R29), editor-snapshot-trick advisory count
  (R19), **px-`minmax` grid count (U11 — baseline 142, shrink-only)**.
  **Shared mechanism note:** I5/X1/R17/R3/R19/**U11** are all
  "count-a-forbidden-pattern + ratchet down + `--update-baseline`" guards —
  build/reuse ONE `scripts/ci/_ratchet-count.mjs` helper rather than six copies;
  V2/V3/V4 similarly share an e2e-baseline compare helper.
- **Serialization list (pass 2 — expanded again):** serialize PRs touching
  `lib/admin/env-checks.ts`, `lib/gates/registry.ts`,
  `lib/gates/__tests__/registry.test.ts` / `lib/admin/__tests__/env-config.test.ts`
  (~13 rev-2 items + the env-adding N-items add ENV_CHECKS entries — guaranteed
  conflicts otherwise),
  `playwright.config.ts` (V1/V2/V4/A5/A13/L5 + the U0/U6 `loom-ui-verify` specs
  all add projects — batch or land in dependency order), `cost-client.ts`
  (WS-C + N19e), shared admin nav registries (+N16, `new-item-dialog` with
  WS-U U12), and the same editor. **Pass-2 same-file pairs:**
  `report-designer.tsx` (U1→A6–A9→U2, in that order),
  notebook editor (U3 → A14 → N19a), the 11 Monaco editors (U6 vs R8–R12
  decompositions), `spark-session-pool` (U7 with A11/A12),
  `monitor-client` (U8 alert-create with WS-C), `data-agent-reasoning.ts`
  (N9/N11/N12 serialize among themselves), `aoai-chat-client.ts` hot path
  (N13 with E6), semantic-model editor + contract store (N9/N15 with A1–A5),
  `unified-lineage`/OL ingest (N17 strictly after L2), lakehouse editor
  (N1/N2 with the WS-R decomposition targets), report-subscriptions Function
  (N19d extends C5). **X2 lands before any other env-adding item** so all later
  EnvSpecs adopt its `availability` field on first write, not via rebase.
- **Extend-vs-decompose policy (rev 2):** WS-R's R7/R14 decomposition targets
  collide with items that GROW the same files (L3→`adf-client`, L4→`purview-client`,
  L7→`unity-catalog-client`, A4→`aas-client`, I5→`kusto-client`,
  A11/A12→`spark-session-pool`, C→`monitor-client`, A6/A7→`loom-chart.tsx` +
  `analytics-pane.tsx`, A6/A9→`visual-body.tsx`). Policy: **extend-then-decompose**
  — the feature item lands first and MUST either stay under the file's ratchet
  ceiling or run `check-file-size.mjs --update-baseline` in the same PR with a
  one-line justification; the decomposition item then re-baselines downward.
  Serialize the pairs; never race them.
- **Admin-page registration (rev 2):** new admin surfaces register via
  `lib/components/admin-shell.tsx` + `lib/panes/admin-overview.tsx` (NOT
  `NAV_ITEMS`) and their acceptance includes "passes
  `lib/nav/__tests__/nav-registries.test.ts`". **Hub consolidation:** V1
  journeys, DR drills, A10 Spark pools, and SLO1 land as TABS of ONE **Health &
  Reliability hub** (extend `/admin/health`); `/admin/copilot-quality` (E5, beside
  the existing agent-quality/copilot-usage pages) and `/admin/finops` (C4,
  absorbing chargeback) stay separate. No orphan admin tiles.
- **Per-cloud contract:** each item ships Commercial (live receipt) + GCC-High
  (live receipt or Learn-cited honest gate w/ fallback) + an IL5 design note
  answering the X-IL5 air-gap checklist (7 items).
  ¹ **Carve-out (rev 2, extended pass 2):** cloud-neutral code-health items —
  WS-R Areas 0–4 + R28/R29/MIG1 (except where an item states its own per-cloud
  row, e.g. R21, R28) **and the pure-front-end WS-U items (U0–U6, U9–U12)** —
  are exempt from the per-cloud contract; each carries an explicit
  "Per-cloud: cloud-neutral" declaration instead. WS-U's U7/U8 touch real Azure
  backends and carry full per-cloud rows.
- **no-vaporware / no-fabric-dependency / ui-parity** die-hard rules apply as written.

## Dependency spine & execution phases

**Phase 0 — foundations (parallel, after R0):**
- **R0 param-cap consolidation — FIRST; blocks every bicep/env-adding item**
- V1 synthetic journeys (the single highest-value item in the program)
- **S1 secret-expiry inventory + burn alert; S2 federated-credential feasibility
  spike (TOP priority — prevention for the 07-19 class V1 only detects)**
- DR0 ADLS versioning; R1 toolkit gap-fill (withTenantAdmin/withDlzAccess);
  R7 file-size re-baseline; X2 structured availability on ENV_CHECKS (land
  before all other env-adding items); **E1 golden sets → E2 copilot-evaluator
  Function (E1 strictly first — E2's `loadEvalSets` + receipt consume E1's
  JSONL)**; C1 cost-client hardening; L1 columnMappings schema;
  I1 identity provision-on-create (shadow plumbing prereq); MIG1 Cosmos
  schema-migration convention (so new doc shapes register migrators from day one)
- **U0 P0-VERIFY (pass 2)** — in-browser drag+reload receipts on ≥4
  already-PASS canvases; resolves the operator's "nothing resizes"
  contradiction and gates every later WS-U G3 receipt (a hidden clipping
  regression, if found, is a P0 fix before U1–U6); **U10 `/browse`
  VirtualizedGrid** (confirmed renderer-freeze defect — defect-priority, no
  dependencies)

**Phase 1 — gates online (parallel, after their Phase-0 prereq):**
- V2 visual regression (wide + narrow viewports); V3 a11y ratchet; V4 route-smoke
  ratchet; V5 live bicep-drift detection
- O1 unified alert-dispatch + on-call standard (V1/DR/C3/A11/S1 alert wiring
  rebases onto it); RUM1 client-side RUM; S3 secret auto-rotation (if S2 verdict
  is stay-on-secret)
- R2 codemod → R3 forbidding ratchet; R15 typed client map (Tier 1)
- E3 regression gating + E4 corpus-change gating (E3 before E4 — E4's workflow
  runs E3's `check-eval-regression.mjs`); C2 forecast; L2 Spark OpenLineage
  (redesigned ingest auth); **A10 Spark health dashboard (the visible early win —
  reads existing state, zero dependency)**; I2 scoped grants → **I5 credential
  factory → I3 shadow audit (I5 strictly before/with I3 — the shadow hook lives
  in the factory, not 217 call sites)**; DR1–DR3 drill extensions
- **WS-U structural G3 (pass 2, after U0's verdict):** U1 report-designer G3
  (BEFORE A6–A9 land — same-editor serialization), U3 notebook per-cell
  resize, U4 Workshop/Slate canvases, U5 fixed-height stragglers, U6
  query↔results divider (per-editor, before/with each R8–R12 decomposition)

**Phase 2 — depth + surfaces:**
- A1–A5 DAX engine (A5 lands the harness + seeded reference data FIRST; each
  function's golden row is added in the A1/A2/A3 PR that introduces it — the
  harness gates the numeric result, not its own existence); A6–A9 report depth
  (each stays under its file-size ceiling or re-baselines with justification);
  L3–L5 (ADF mappings, Purview push, column canvas — L5 ships against whatever
  sources have landed and re-verifies after L6/L7); E5 admin quality page;
  SRCH1 federated-search evals; C3 anomaly monitor → C4 finops hub (audited
  budgets CRUD) → C5 dashboard/scorecard/queryset snapshot delivery; I4 shadow
  UI; DR4 orchestration + Health & Reliability hub tabs; SLO1 error-budget
  surface; DIAG1 diagnostics bundle; CH1 dependency-chaos drills; EXP1
  workspace export/import/clone; CMK1 Cosmos CMK; SC1 supply-chain enforcement
  (before I6/enforcement per the ATO-blocking set F2/F7/F9/F12); R4–R6 route
  batches;
  R8–R12 editor decompositions (R18 editor-state hook BEFORE R10); A14 collab
  push transport + editor coverage (AFTER the R8–R12 decomposition of the target
  editors, so the mount lands in the decomposed shell)
- **WS-U leader-gap builds (pass 2):** U2 report-designer aux panes (after U1,
  serialized with A6–A9), U7 mapping-dataflow Debug/Preview/Inspect/stats (3
  PRs; `spark-session-pool` serialization with A11/A12), U8 KQL dashboard
  depth (2 PRs; `monitor-client` serialization; "live" tier upgrades to A14's
  push transport when it lands), U9 full-screen canvas kit mode
- **Near-free WS-N riders (pass 2, may ride Phase 2/3 when their serialization
  windows are open):** N2a duckdb-wasm preview (the Arrow producer already
  exists), N10 answer-receipts substrate (assembly over existing
  turn-trace/cost-estimate/verify pieces)
- **Opportunistic bucket (Phase 2/3, independent/low-priority — placed per the
  consistency review):** R13, R14 (lowest-value churn — after all user-visible
  depth), R16, R17, R19, R28 git-client consolidation, R29 parity-freshness
  ratchet, I8 limits doc, X3 gov-CI plugin guide + `gov-workspace-identity.yml`,
  **U11 px-grid ratchet (guard early — after R3's `_ratchet-count.mjs` helper —
  then batched drain), U12 new-item-dialog token cluster + dead-field cleanup**

**Phase 3 — enforcement + structure:**
- **I9 threat-model/AppSec review gate → I6 per-workspace enforce + I7 migration
  runbook (I6 only after I9 sign-off AND ≥2 weeks of clean shadow data)**;
  L6 dbt + L7 UC rebase; A11–A13 Spark auto-recovery/quota/chaos;
  E6 tier-router evals; X1 cloud-endpoints ratchet drain

**Phase 4 — north star (pass 2, after Phase 3; full specs + intra-phase spines
in [ws-north-star.md](ws-north-star.md)):**
- **Pillar 2 trust chain (start immediately at phase open — it hardens
  everything else):** N9 verified contract + VQR + refuse → (N10 receipts if
  not already ridden earlier) → N11 GraphRAG (the headline) → N12 self-heal →
  N13 unified LLMOps (strictly after the WS-E E-chain completes)
- **Pillar 1 openness:** N1 Iceberg REST catalog + dual metadata (flagship) →
  {N2b DuckDB server tier, N3 Flight SQL/ADBC, N7e Trino opt-in}; N4 SQLMesh →
  N5 software-defined assets; N6 ODCS contracts → {N7b CDC control plane,
  N14c AI data engineering}; N7a/N7c/N7d as scheduling allows; N8 labs
- **Pillar 3 governed analytics:** N9→N15 headless metrics layer →
  {N16 code-report, N18 embedded SDK w/ RLS}; L2→N17 OL incident console →
  N19g catalog interop; N19a–N19f as scheduling allows; N20 labs
- Every N-item's IL5 note must serve the sovereign-moat design principle
  (reviewers check against the moat block in ws-north-star.md)

**Housekeeping track (independent — execute LAST, any time, never blocking):**
- R20–R27 `legacy/` restructure, one tree per PR, `examples/` stays at root per
  recommendation. **Risk note (product review):** 8 high-risk `git mv` PRs
  (Windows case-folding, 33 workflow refs, 65 mkdocs nav lines) with zero grade
  contribution — do not let them compete with depth work for reviewer/CI-stability
  budget; pause the track instantly if it destabilizes CI.

**Hard ordering constraints:** R0 before ANY bicep/env-adding item; X2 before all
other env-adding items; R1→R2→R3; R18 before R10; **E1→E2→E3→E4→E5→E6** (canonical
E-chain); A5 harness before A1–A3 merge (golden rows ride the A1–A3 PRs);
**I1→I2→I5→I3→I4** (I5 before I3); I9 before I6; I6 additionally gated on
shadow-data cleanliness; L5 is the terminal L item — it ships incrementally
against landed sources and re-verifies after L6/L7; A14 after the R8–R12
decomposition of its target editors; V2 baselines land only after #2382
(dark-theme fix) is deployed (else baselines bake the bug in); **U0 before any
WS-U G3 item is declared done (and any clipping regression it finds is a P0 fix
before U1–U6); U1 before A6–A9 before U2 (same editor); U11's guard after R3's
`_ratchet-count.mjs` helper exists; N9 before N12/N15; N11 after N9; N13 after
E1→…→E6; N15 before N16's renderer + N18's RLS; N17 after L2; N19d extends C5
(never a parallel delivery path)**; serialize per the
expanded serialization list above (env-checks/registry + their tests,
playwright.config.ts, cost-client.ts, admin nav registries, same editor, and
every extend-vs-decompose file pair).

## Verification of the program itself

The program is DONE when: all 130 items merged with receipts; the synthetic-journey
job has run green ≥7 consecutive days on BOTH clouds; the secret-expiry monitor
(S1) shows green with >60 days of runway on every tracked credential; the
visual-regression (wide + narrow) and a11y gates have each caught-or-passed a full
release cycle; the scheduled bicep-drift lane (V5) reports zero unmanaged drift on
both estates; shadow-mode identity reports zero unexplained divergences for 2
weeks AND the I9 security review is signed off before any workspace is enforced;
the DAX golden harness passes vs Power BI on the seeded models; and a quarterly DR
drill (the EXTENDED `dr-drill.yml`, all scenarios incl. `adls-versioning-restore`
and the graph/vector Cosmos validation) has completed green end-to-end on
Commercial + Gov. All 13 ratchets enforced in CI and at-or-below their baselines.
**Pass-2 additions:** every WS-U G3 item carries a browser drag+reload receipt
(with U0's live-grip verdict on record); an EXTERNAL engine (pyiceberg/DuckDB/
Trino) has read a real Loom lakehouse table through the N1 IRC endpoint on both
clouds; a multi-hop question has answered with graph-path citations (N11) and
every agentic answer renders a receipt with a verified/refused badge (N9/N10);
the same metric has returned the same number via report visual, NL question,
and `/api/metrics/query` (N15 three-way receipt).
Grade target: every touched surface A/A+ per ux-standards §7, zero ❌ parity rows
introduced.
