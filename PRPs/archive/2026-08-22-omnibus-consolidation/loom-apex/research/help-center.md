# Help Center / Learning Hub — deep-gap matrix (AUDIT-2, 2026-07-24)

Read/research audit vs main `87f281e5` (branch `docs/reconcile-p2-verification`).
Every claim cites file:line. Verdicts: **REAL-GAP** / **OPERATOR-GATED** / **ALREADY-BUILT** / **STALE-DOC**.

---

## 1. Inventory of help/learn surfaces (what exists today)

| Surface | Location | Evidence |
|---|---|---|
| **/learn Learning Hub** (5 tabs: Gallery, Notebooks, Samples, Tours, Guides + hub Copilot) | `apps/fiab-console/app/learn/page.tsx` | Header comment `app/learn/page.tsx:5-34`; tab type `:68`; tab pool wiring `:204-236` |
| **Learn catalog engine** (56 legacy entries + item-type learnContent, USE_CASES, 9 numbered tutorials, 3 service guides, reference topics) | `apps/fiab-console/lib/learn/content.ts` (1,099 lines) | `getLearn` `content.ts:733`, `getWalkthrough` `:793`, `USE_CASES` `:854`, `NUMBERED_TUTORIALS` `:944`, `SERVICE_GUIDES` `:977` |
| **Per-editor guide docs** | `docs/fiab/tutorials/editor-<slug>.md` — **124 files on disk** | dir listing; surfaced set `EDITOR_DOC_SLUGS` (117 slugs) `content.ts:133-165` |
| **Numbered end-to-end tutorials** | `docs/fiab/tutorials/01..09-*.md` (9 walkthroughs) | `content.ts:944-975` |
| **Visual-tutorial lane** (screenshot tutorials) | expected at `docs/fiab/tutorials/items/<slug>/tutorial.md`; capture = `apps/fiab-console/e2e/tutorial-capture.uat.ts` + `.github/workflows/csa-loom-tutorial-capture.yml`; publish = `scripts/csa-loom/publish-tutorials.mjs`; audit = `scripts/csa-loom/check-tutorial-coverage.mjs` (CI job `fiab-console-ci.yml:201-238`, non-blocking) | coverage run below |
| **In-product item help** (side-panel Learn per item type) | `lib/components/item-side-panel.tsx:29,75,280` calls `getLearn(type)`; content lives as `learnContent` blocks in `lib/catalog/item-types/*.ts` (e.g. sql-lab full 4-step learnContent `data-engineering.ts:220-233`) | |
| **LearnPopover / SectionExplainer** contextual help | `lib/components/ui/learn-popover.tsx:169`; **46 files** use it (16 admin pages, 15 admin cards, 8 editors incl. sql-lab/streaming-sql/code-report/ducklake/s3-gateway, shared connect-tab) | `rg -l LearnPopover` listing |
| **Help Copilot (RAG)** | routes `app/api/help-copilot/{chat,reindex,sessions}`; index `lib/azure/loom-docs-index.ts:2-17` (AI Search `loom-docs` / Cosmos fallback); corpus staged by `scripts/csa-loom/stage-copilot-corpus.sh:31-35` from **`docs/**` + `PRPs/completed/csa-loom-pillar` + `PRPs/active`** (markdown-only, incremental) | |
| **docs/learn/** tree (10 numbered sections + tutorials/beginner-intermediate-advanced + code-labs) | **STALE-DOC**: pre-Loom Azure-services curriculum (HDInsight/Synapse/ADLS quickstarts). Last commit to `docs/learn/tutorials` = **2026-05-29** (`3956d6fc`), `docs/learn` = **2026-06-02** (`d0022897`) — predates the entire console-era wave program | `git log -1` |
| **Parity docs** (authoring source, not tutorials) | `docs/fiab/parity/` — **461 files**, incl. new-wave items (`iceberg-catalog-interop.md`, `sql-lab-duckdb.md`, `streaming-sql.md`, `cdc-control-plane.md`, `activation-sync.md`, `data-contracts.md`, `code-report.md`, `migration-code-translation.md`, `transformation-project.md`, `feature-store.md`, `fine-tuning-job.md`, `dax-golden.md`, `assets.md`, `data-quality-run-results.md`) | dir grep |

Corpus note: because `PRPs/active/**` is staged (`stage-copilot-corpus.sh:35`), the Help Copilot can retrieve
`PRPs/active/loom-next-level/DONE.md` program text about new features — engineering-ledger framing, **not** user guidance.
That masks gaps in retrieval evals while the user-facing doc is still missing.

---

## 2. Target matrix — dimension totals

`node scripts/csa-loom/check-tutorial-coverage.mjs --apps-catalog scripts/csa-loom/fixtures/apps-catalog.json` (run 2026-07-24):

```
items    : 0/142 published
features : 0/17  published
apps     : 0/29  published
total    : 0/188 published   (docs/fiab/tutorials/items/ contains only index.md)
```

| Dimension | Total | Text guide | Visual tutorial | In-product help |
|---|---|---|---|---|
| Item types (`lib/editors/registry.ts:52-315`, 142 `reg(` slugs) | 142 | **124/142** editor-*.md on disk; **117/142** surfaced in hub (`EDITOR_DOC_SLUGS` `content.ts:133`) | **0/142** | **140/142** learnContent (`notebook`, `azure-sql-database` fall back to legacy REGISTRY entries in content.ts) |
| Features (NAV_PAGES `e2e/_lib/uat.ts:159-177` — 17 top-level pages) | 17 | partial (Tours/Reference cards) | **0/17** | admin pages have LearnPopovers |
| Apps (`lib/apps/content-bundles/catalog-meta.ts:21-56` + fixture `scripts/csa-loom/fixtures/apps-catalog.json` = 29) | 29 | **14/29** have a Learn Gallery use-case card + walkthrough doc | **0/29** | Notebooks tab surfaces bundle notebooks (`app/learn/page.tsx:14-19`) |

**Visual lane status = OPERATOR-GATED, not merely missing**: CI comment `fiab-console-ci.yml:210-218` — captures
require a credentialed operator run of `csa-loom-tutorial-capture.yml` against the live console + privacy review
(`publish-tutorials.mjs`); the coverage gate stays non-blocking until the first reviewed captures land under
`docs/fiab/tutorials/items/`, then `--strict` flips it hard.

---

## 3. Item-type gap matrix (the 18 REAL-GAP editors with NO editor guide)

`comm` of registry slugs vs `docs/fiab/tutorials/editor-*.md` (temp/audit2-reg-slugs.txt vs -guide-slugs.txt):

| Item type | Shipped in (DONE.md) | Parity/authoring source | In-product learnContent | Verdict |
|---|---|---|---|---|
| `sql-lab` | N2b `DONE.md:223` | `docs/fiab/parity/sql-lab-duckdb.md` | yes (`data-engineering.ts:220`) + LearnPopover ×2 | REAL-GAP (guide+tutorial) |
| `streaming-sql` | N7a `DONE.md:283` | `docs/fiab/parity/streaming-sql.md` | yes + LearnPopover ×2 | REAL-GAP |
| `code-report` | N16 `DONE.md:283` (registry `registry.ts:121`) | `docs/fiab/parity/code-report.md` | yes + LearnPopover ×2 | REAL-GAP |
| `transformation-project` | N4 `DONE.md:220` | `docs/fiab/parity/transformation-project.md` | yes; **no LearnPopover** | REAL-GAP |
| `data-contract` | N6 `DONE.md:222` (registry `registry.ts:194`) | `docs/fiab/parity/data-contracts.md` | yes; no LearnPopover | REAL-GAP |
| `activation-sync` | N7c `DONE.md:235` | `docs/fiab/parity/activation-sync.md` | yes; no LearnPopover | REAL-GAP |
| `feature-table` | WS-2.1 (registry `registry.ts:134`) | `docs/fiab/parity/feature-store.md` | yes; no LearnPopover | REAL-GAP |
| `model-serving-endpoint` | WS-1.2 (`registry.ts:131`) | — | yes; no LearnPopover | REAL-GAP |
| `fine-tuning-job` | WS-1.3 (`registry.ts:138`) | `docs/fiab/parity/fine-tuning-job.md` | yes; no LearnPopover | REAL-GAP |
| `ai-red-team` | AIF-15 (`registry.ts:142`) | — | yes; no LearnPopover | REAL-GAP |
| `synthetic-data` | W12 (`registry.ts:311`) | — | yes; no LearnPopover | REAL-GAP |
| `data-quality` | W11 (`registry.ts:314`) + N7d depth `DONE.md:236` | `docs/fiab/parity/data-quality-run-results.md` | yes; no LearnPopover | REAL-GAP |
| `ducklake-catalog` | N8 lab `DONE.md:283` (`registry.ts:89`) | — (Preview lab) | yes + LearnPopover ×2 | REAL-GAP (Preview-tagged) |
| `s3-gateway` | N8 lab (`registry.ts:90`) | — (Preview lab) | yes + LearnPopover ×2 | REAL-GAP (Preview-tagged) |
| `agent-flow` | W9 (`registry.ts:161`) | — | yes | REAL-GAP |
| `analysis-board` | Fabric IQ (`registry.ts:147`) | — | yes | REAL-GAP |
| `fusion-sheet` | Fabric IQ (`registry.ts:148`) | — | yes | REAL-GAP |
| `notepad` | Fabric IQ (`registry.ts:149`) | — | yes | REAL-GAP |

### 3b. STALE-DOC wiring defects (authored but not surfaced — cheapest wins in the repo)

1. **7 editor guides exist on disk but are NOT in `EDITOR_DOC_SLUGS`** (`content.ts:133-165`), so the Learning Hub
   shows "MS Learn" primary link + "Loom guide coming" for: `ai-enrichment`, `batch-pool`, `databricks-pipeline`,
   `digital-twin`, `lakebase-postgres`, `loom-app`, `loom-app-runtime` (files `docs/fiab/tutorials/editor-<slug>.md`
   all present; landed in #2024 per `git log docs/fiab/tutorials`).
2. **Same 7 slugs have captured screenshots** (`docs/fiab/tutorials/img/editor-<slug>-1.png` verified on disk) but
   are absent from `EDITOR_THUMB_SLUGS` (`content.ts:176`) — placeholder tiles render instead of real thumbnails.
3. **3 slugs are IN `EDITOR_THUMB_SLUGS` with NO png on disk** → the hub emits a URL to a nonexistent image
   (**broken thumbnail**): `mapping-dataflow`, `materialized-lake-view`, `mounted-adf` (121 `editor-*-1.png`
   on disk vs 117-slug set; node diff above). Contradicts the set's own contract comment `content.ts:170-178`.
4. **`EDITOR_STEP_IMAGE_COUNTS` is empty** (`content.ts:120-123`) — every `getWalkthrough` renders step 1 with a
   landing shot and steps 2..N as "screenshot coming" placeholders. Honest, but means **zero multi-step visual
   walkthroughs exist product-wide**.
5. **docs/learn/** tree is pre-Loom (2026-06-02) Azure-services curriculum; only `docs/learn/08-solutions/*` and
   `docs/learn/08-reference/limits-quotas` (I8, `DONE.md:252`) are referenced by the hub (`content.ts:833-835`).
   The beginner/intermediate/advanced tutorials (`docs/learn/tutorials/beginner/*` = HDInsight/ADLS quickstarts)
   never mention the Loom console — STALE-DOC in the copilot corpus.

---

## 4. App × coverage matrix (29 catalog apps)

Source: `CATALOG_META` `catalog-meta.ts:21-56` (= fixture, 29 apps). "Learn card" = `appId` present in `USE_CASES`
(`content.ts:854-901`) → Gallery card with Install-live-example (`content.ts:207` installable filter). Visual
tutorial dimension = 0/29 for ALL apps (coverage run §2).

**Covered (14) — Learn card + own walkthrough doc:**
`app-healthcare-popmgt`, `app-iot-realtime`, `app-casino-analytics` (docs/use-cases/*), `app-federal-data-mesh`,
`app-multi-agency-onboarding`, `app-direct-lake-replacement`, `app-sovereign-ai-agents`, `app-hybrid-topology`
(docs/fiab/use-cases/*), `app-azure-realtime-analytics`, `app-change-feed-processor`, `app-data-governance`,
`app-logic-apps-integration`, `app-ml-pipeline`, `app-real-time-dashboards` (docs/learn/08-solutions/*).

**REAL-GAP (15) — NO from-scratch-to-working deep-dive tutorial, no Learn Gallery card:**

| App | Best existing material (grep) | Gap severity |
|---|---|---|
| `app-fedramp-tracker` | none user-facing (only ops/audit mentions) | HIGH — Compliance flagship |
| `app-rag-builder` | only `docs/fiab/operations/app-install-provisioning.md` + uat-coverage | HIGH — AI flagship |
| `app-data-steward` | parity `docs/fiab/parity/app-data-steward.md` (compliance doc, not a tutorial) | HIGH |
| `app-lakehouse-inspector` | audit sweeps only | MED |
| `app-pipeline-designer` | ADF parity docs only | MED |
| `app-finops-cost` | ops chargeback doc only | HIGH (pairs with C4 FinOps hub gap) |
| `app-fabric-mirror-onboard` | parity `app-fabric-mirror-onboard.md` | MED |
| `app-workspace-monitoring` | parity `workspace-monitor.md` | MED |
| `app-supercharge-{bronze,silver,gold,ml,streaming,utils,guide}` (7) | parity `supercharge-notebooks.md`; notebooks reachable via hub Notebooks tab (`app/learn/page.tsx:14-19`) | MED — 117 notebooks with no guided path |

---

## 5. Recent-wave features (DONE.md Phases 0-4 + §P2) with NO help-center coverage

Grep base: `docs/learn/**` + `docs/fiab/tutorials/**` ("learn+tutorials") and all `docs/` (rg -il, 2026-07-24).
"Parity" = authoring source exists in `docs/fiab/parity/`. In-product = learnContent/LearnPopover/tab help.

| Feature (item, DONE.md line) | learn+tutorials | Any user doc in docs/ | In-product | Verdict |
|---|---|---|---|---|
| **GraphRAG grounding** (N11, `DONE.md:206` — "the headline") | **0** | only `parity/reasoning-mode-data-agents.md`; GETTING_STARTED mention | toggle only | **REAL-GAP (P0)** |
| **Answer receipts / Verified badge** (N10, `:205`) | **0** | `parity/reasoning-mode-data-agents.md` only | ReceiptPanel | **REAL-GAP (P0)** — "the receipt IS the IL5 compliance artifact" and it has no doc |
| **Verified queries / semantic contract (metrics layer)** (N9, `:204`) | **0** ("verified quer" hits = research + archive only) | none | Verified Queries tab | **REAL-GAP (P0)** |
| **Self-healing NL2SQL** (N12, `:207`) | 0 | none (23 "self-heal" hits are other features) | invisible | REAL-GAP (concept doc) |
| **Prompt registry + token budgets** (N13, `:208`) | **0** | none | admin tabs | REAL-GAP |
| **DAX engine** (A1-A5, `:137`) | 16 generic-DAX hits, none about the Loom engine | `parity/dax-golden.md`, `parity/dax-query-view.md` | — | REAL-GAP (user doc) |
| **FinOps hub** (C4, `:136`) | 0 hub-specific | ops/chargeback docs only | admin page | REAL-GAP |
| **Code report (BI-as-code)** (N16, `:283`) | **0** | `parity/code-report.md` | learnContent+Popover | REAL-GAP (no editor guide, §3) |
| **Embedded analytics SDK / embed-RLS** (N18, `:283`) | 0 | `parity/embed-codes.md`, dashboard-parity-spec | — | REAL-GAP |
| **Migration M1 estate assessment** (`:283`, #2516) | 0 in docs/fiab ("estate assessment" = 0 fiab hits) | `parity/sql-migration-*.md` | wizard | **REAL-GAP (P1)** — inbound-migration on-ramp undocumented |
| **Migration M2 copy-in / M3 code translation** (#2517) | 1 stale hit (`docs/learn/resources/competitive-analysis.md`) | `parity/migration-code-translation.md` | wizard | REAL-GAP |
| **Iceberg REST catalog + interop** (N1 "defector-maker", `:219`) | 2 (old ADR 0003 mentions) | `parity/iceberg-catalog-interop.md`, `parity/lakehouse-iceberg-endpoint.md` | Interop tab (LearnPopover in `lakehouse/panes/interop-pane.tsx`) | **REAL-GAP (P0)** — external-engine connect tutorial is the whole point |
| **SQL Lab / DuckDB dual-mode** (N2, `:223`) | **0** | `parity/sql-lab-duckdb.md` | rich learnContent (`data-engineering.ts:220-233`) | REAL-GAP (guide, §3) |
| **Arrow Flight SQL / ADBC connect** (N3, `:224`) | **0** | 2 docs hits total | Connect tab LearnPopover (`shared/connect-tab.tsx`) | REAL-GAP |
| **SQLMesh / transformation project** (N4, `:220`) | 0 | `parity/transformation-project.md` | learnContent | REAL-GAP (guide, §3) |
| **Software-defined assets** (N5, `:221`) | 0 | `parity/assets.md` (1 "software-defined asset" hit) | canvas | REAL-GAP |
| **ODCS data contracts** (N6, `:222`) | 2 generic | `parity/data-contracts.md` | editor | REAL-GAP (guide, §3) |
| **Debezium CDC control plane** (N7b, `:234`) | 1 | `parity/cdc-control-plane.md`, `parity/eventstream-cdc.md` | /cdc wizard | REAL-GAP |
| **Activation sync (reverse ETL)** (N7c, `:235`) | 0 | `parity/activation-sync.md` | editor | REAL-GAP (guide, §3) |
| **Data-quality depth + data-diff** (N7d, `:236`) | 0 | `parity/data-quality-run-results.md` | editor | REAL-GAP |
| **Streaming SQL (RisingWave)** (N7a, `:283`) | **0** (docs "RisingWave" = 1 hit) | `parity/streaming-sql.md` | learnContent+Popover | REAL-GAP (guide, §3) |
| **Trino federation (opt-in)** (N7e, `:283`) | **0** | arch-level mentions only (`docs/fiab/architecture.md`, `governance/catalog.md`); no parity doc found | — | **REAL-GAP** (also needs opt-in/honest-gate doc) |
| **N8 labs: PRQL / DuckLake / s3-gateway** (`:283`) | **0** (PRQL = **0 hits in all docs/**) | DuckLake 1 hit, s3-gateway 1 hit | learnContent+Popovers | REAL-GAP (Preview-tagged) |
| **Dataflow debug sessions** (U7, `:129`) | **0** ("dataflow debug" = 0 hits in ALL docs/) | none | Debug UI | **REAL-GAP** |
| **Workspace portability (.loomws export/import/clone)** (EXP1, `:260`) | **0** ("workspace portab|.loomws" = 0 hits) | none | Settings→Portability tab | **REAL-GAP (P1)** |
| **Collab presence + push (SSE)** (A14, `:261`) | 0 specific (EditorCollabBar/"collab push" = 0 docs hits) | none | presence chip | REAL-GAP |
| **Chaos harness** (A13 `:174` + CH1 `:268`) | 0 user-facing | `docs/fiab/resilience-matrix.md` mention | Health-hub Chaos tab (opt-in) | REAL-GAP (admin runbook) |
| **Column-level lineage UI** (L1/L5/L7, `:266`) | 3 generic lineage | `docs/learn/08-solutions/data-governance/lineage` (table-grain era) | canvas | REAL-GAP (update stale lineage doc) |
| **Canvas full-screen** (U9, `:264`) | 0 (26 "fullscreen" hits are copilot/geo-map parity) | none | kit rail button | REAL-GAP (minor — fold into canvas doc) |
| **KQL dashboard pages/text-tiles/drillthrough** (U8, `:263`) | 0 ("dashboard page" hits unrelated) | `editor-kql-dashboard.md` predates U8 | editor | **STALE-DOC** — guide exists but pre-U8 |
| **Pipeline in-canvas Debug/Output overlay** (U13, `:265`) | 0 | `editor-data-pipeline.md` predates U13 | canvas overlay | STALE-DOC |
| **OpenLineage ingest + incident console** (L2 `:87`, N17 `:283`) | 1 | 15 docs hits (mostly PRP/threat-model) | — | REAL-GAP (pool-setup is operator-gated; doc still needed) |

Pattern: **the parity tree (docs/fiab/parity) kept pace with the waves; the tutorials/learn tree did not.** Nearly
every Phase-4 feature has a compliance/parity artifact but no "how do I use this from scratch" doc, and none of the
34 features above appears in the 9 numbered tutorials (`content.ts:944-975` — newest is 09-tenant-topology).

---

## 6. Prioritized authoring plan

### P0 — wiring fixes (hours, one PR, no new prose)
1. Add the 7 authored slugs to `EDITOR_DOC_SLUGS` + `EDITOR_THUMB_SLUGS` (`content.ts:133,176`):
   `ai-enrichment, batch-pool, databricks-pipeline, digital-twin, lakebase-postgres, loom-app, loom-app-runtime`.
2. Remove `mapping-dataflow`, `materialized-lake-view`, `mounted-adf` from `EDITOR_THUMB_SLUGS` (or capture their
   pngs) — fixes live broken thumbnails.
3. Regenerate mkdocs nav for the 7 newly-surfaced guides (per the `content.ts:135` sync contract).

### P1 — trust-chain + flagship feature tutorials (the operator-visible headline gaps)
Each spec: title / steps outline / screenshots needed. Format = numbered tutorial under `docs/fiab/tutorials/`
(continue 10-, 11-, …) + card in `NUMBERED_TUTORIALS` (`content.ts:944`) + corpus auto-staged.

1. **"10 — Trusted answers: verified queries, GraphRAG grounding, and receipts"** (N9+N10+N11+N12)
   Steps: create semantic model → register+approve a verified query (Verified Queries tab, audit row) → ask the
   Copilot the matched question (Verified ✓ badge) → ask an out-of-contract question (Refused ⛔, guided message) →
   toggle Graph grounding on an ontology-bound workspace → open the ReceiptPanel (plan, SQL, rows, tier, cost) →
   export the receipt as the IL5 compliance artifact.
   Screenshots (7): Verified Queries tab, approve dialog, verified answer + badge, refusal, grounding toggle,
   receipt panel expanded, graph-path citation.
2. **"11 — Open lakehouse: Iceberg REST catalog + external engines"** (N1+N3+N2)
   Steps: open Lakehouse → Interop tab → enable dual metadata → verify Delta ✓ / Iceberg ✓ badges → mint a scoped
   token → connect Spark/Trino/DuckDB via IRC snippet → Connect tab ADBC/Flight ticket → query from an external
   client → show the data-access audit rows.
   Screenshots (6): Interop tab, /admin/catalog federation page, token mint, connect snippet, external query
   result, audit log rows.
3. **"12 — Migrate an estate in: assessment → copy-in → code translation"** (M1+M2+M3)
   Steps: run M1 estate assessment → review scorecard → M2 schema+data copy (ADF Copy → Bronze/managed Delta) →
   M3 translate SQL/DAX/report → review the honest needs-review diff → run translated asset.
   Screenshots (6): assessment wizard, scorecard, copy-in monitor, translation diff, needs-review flags, working
   translated report.
4. **"13 — SQL Lab: sub-second lake SQL with DuckDB"** (N2a/N2b + N8 PRQL toggle + N7e Trino picker)
   Steps: create SQL Lab item → delta_scan a lakehouse table → read the engine/timing status bar → Local-analysis
   tab (wasm, networkRequests:0) → Serverless fallback demo → PRQL toggle → Trino engine (opt-in gate shown
   honestly). Screenshots (5).
5. **"14 — Export, import, and clone a workspace (.loomws)"** (EXP1)
   Steps: Settings→Portability → export (scrubbedPaths callout) → import wizard validate/plan (new-ids vs
   overwrite) → clone dialog → verify cloned items provision against the target estate. Screenshots (4).
6. **`editor-<slug>.md` for the 18 guide-less item types** (§3 table) — derive from parity docs + learnContent
   steps (already-authored 4-step outlines exist in `lib/catalog/item-types/*` for all 18); add each to
   `EDITOR_DOC_SLUGS`. Priority order: sql-lab, code-report, data-contract, transformation-project, streaming-sql,
   feature-table, model-serving-endpoint, fine-tuning-job, activation-sync, data-quality, synthetic-data,
   ai-red-team, agent-flow, analysis-board, fusion-sheet, notepad, ducklake-catalog, s3-gateway.

### P2 — refresh stale guides for depth shipped after authoring
- `editor-kql-dashboard.md` — add U8 pages/text-tiles/page-drillthrough section (`DONE.md:263`).
- `editor-data-pipeline.md` — add U13 in-canvas Debug/Output overlay (`DONE.md:265`).
- `editor-mapping-dataflow.md` — add U7 Debug sessions (preview/inspect/statistics) (`DONE.md:129`).
- `docs/learn/08-solutions/data-governance/lineage` — add L5 column-level expand/impact-analysis (`DONE.md:266`).
- Shared canvas doc — one paragraph on U9 full-screen (Esc/F11) reused by every kit canvas (`DONE.md:264`).
- Admin docs: FinOps hub (C4), copilot-quality Prompts/Budgets tabs (N13), Chaos tab (A13/CH1 — opt-in flags),
  Health-hub tab census (DR4 rider, `DONE.md:253`).

### P3 — app deep-dives (15 uncovered apps)
Template per app (source = bundle `lib/apps/content-bundles/app-<x>.ts` items + `app-install-provisioning.md`):
title "From install to working <outcome>", steps: install from /apps → watch provisioning receipts → open each
provisioned item → run the primary action → seeded-data verification → teardown. Screenshots: catalog card,
install dialog, provisioning progress, each item's money-shot, final dashboard/result (≈5-7/app).
Order: rag-builder, fedramp-tracker, finops-cost, data-steward, pipeline-designer, lakehouse-inspector,
fabric-mirror-onboard, workspace-monitoring, then one combined "Supercharge medallion journey" covering the 7
supercharge apps as a single bronze→silver→gold→ML→streaming path (117 notebooks).
Also: add USE_CASES entries (+`appId`) so each gets a Gallery card — the install-wiring invariant test
(`content.ts:846-853`) enforces bundle+catalog registration automatically.

### P4 — visual-tutorial capture program (OPERATOR-GATED)
Run `csa-loom-tutorial-capture.yml` against live → privacy-review → `publish-tutorials.mjs` →
`docs/fiab/tutorials/items/<slug>/tutorial.md` → flip `--strict` in `fiab-console-ci.yml:238` (single-edit
permanent gate per `:216-218`). Until this runs, items/features/apps visual coverage stays 0/188 by design.
Then populate `EDITOR_STEP_IMAGE_COUNTS` (`content.ts:120`) so `getWalkthrough` steps 2..N stop rendering
"screenshot coming".

### P5 — retire/quarantine the stale docs/learn curriculum
Move the pre-Loom HDInsight/quickstart tutorials (`docs/learn/tutorials/{beginner,intermediate,advanced}`,
last touched 2026-05-29) out of the copilot corpus or annotate them as Azure-generic, so RAG answers about
"tutorials" stop preferring pre-console content over Loom guidance.

---

## Appendix — verification commands run
- `node scripts/csa-loom/check-tutorial-coverage.mjs --apps-catalog scripts/csa-loom/fixtures/apps-catalog.json` → 0/188.
- registry-vs-guides comm diff (18 missing; 0 orphan guides) — temp/audit2-reg-slugs.txt / -guide-slugs.txt.
- learnContent presence scan over `lib/catalog/item-types/*.ts` → 140/142 (notebook, azure-sql-database via legacy fallback).
- THUMB/DOC set vs on-disk png/md diffs (7 unsurfaced, 3 broken-thumb).
- rg feature-term sweeps over `docs/`, `docs/learn`, `docs/fiab/tutorials` (counts in §5).
