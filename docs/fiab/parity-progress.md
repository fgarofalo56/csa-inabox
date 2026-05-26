# Fabric-parity loop — running progress

Live log of the multi-agent `fabric-parity-loop` workflow. Most recent at top.

## 2026-05-26 — Build Phase 1 complete — vaporware cleared + D/C-grade upgrades shipped

After the catalog phase wrapped, ran the prioritized Build sequence end-to-end:

**F-fixes (vaporware cleared)**
- `data-product` — Cosmos-state editor + Purview-pending MessageBar gate. Removed hardcoded `customer-360` / `alice@contoso` / fixed bundle grid.
- `gql-graph` — Run button now dispatches to `/api/items/gql-graph/[id]/query`; 3 backends (persist-only / fabric-graph / cosmos-gremlin-translate).

**Quick wins (dead ribbon buttons wired)**
- `cosmos-gremlin-graph` Edges/Vertices, `cross-item-copilot` View registry + Session New/Refresh, `data-product-instance` Health column + ribbon Health button.

**D-fixes**
- `usql-job` — deprecation MessageBar (ADLA EOL 2024-02-29) + heuristic U-SQL→PySpark translator.
- `vector-store` — added Microsoft-recommended `cosmos-nosql` backend (now default).
- `ontology` — **Materialize as graph-model** button creates a graph-model item from parsed class hierarchy.
- `plan` — status badges (todo/doing/done/overdue) + progress meter.
- `map` — Azure Maps Static-API tile preview when `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` is set.

**C-enhancements**
- Notebook **Phase 2** — Data items pane + Lakehouse attach modal in left rail.
- APIM Policy — **Operation scope** added (`apis/{aid}/operations/{oid}` resolver in backend + form fields in UI).
- **Shared pipeline DAG canvas** — new `lib/components/pipeline/pipeline-dag-view.tsx` (read-only topological layout + activity-type color coding + success/failure/completion/skip edge legend); wired into adf-pipeline, synapse-pipeline, and data-pipeline editors as a "Graph" tab.

After these: zero F-grade items remain in the wiring-audit. Branch is ~30 commits ahead of `origin/access-patterns-vpn-agw-fd`.

**Still deferred** (truly multi-session work)
- Pipeline DAG **Phase 2** (drag-drop authoring, activity library palette, properties pane for the selected node) — currently read-only.
- Foundry Agent Service runtime for `operations-agent` / `data-agent` (per their parity specs — 4-6 sessions each).
- Purview Unified Catalog wiring for `data-product` — needs new `lib/azure/purview-client.ts` + Bicep module + role assignments.
- Notebook **Phase 3** (HistoryDrawer, per-cell edge toolbars, AI tools tab) and Phase 1B Monaco upgrade.

## 2026-05-26 — ✅ CATALOG PHASE COMPLETE — 85 / 85 UIs cataloged

**All 85 Loom editors have a parity spec on disk under `docs/fiab/<name>-parity-spec.md`.**

Wave-by-wave tally:
- Wave 1 (previous session): 2 (notebook, lakehouse)
- Wave 2: 10 (eventstream, eventhouse, dataflow, copy-job, warehouse, semantic-model, report, kql-database, kql-queryset, data-pipeline)
- Wave 3: 13 (dashboard, paginated-report, scorecard, ml-experiment, ml-model, spark-job-definition, environment, graphql-api, user-data-function, kql-dashboard, activator, mirrored-database, dbt-job)
- Wave 4: 21 (variable-library, plan, ontology, graph-model, map, operations-agent, data-agent, synapse-{ded,serverless,spark}-sql-pool, synapse-pipeline, adf-{pipeline,dataset,trigger}, databricks-{notebook,job,cluster,sql-warehouse})
- Wave 5: 21 (apim-{api,product,policy}, data-product, ai-foundry-{hub,project}, compute, dataset, prompt-flow, evaluation, content-safety, tracing, copilot-studio-{agent,knowledge,topic,action,channel,analytics}, ai-search-index, usql-job, ai-search-skillset)
- Wave 6: 18 (copilot-template-library, powerplatform-environment, dataverse-table, power-app, power-automate-flow, power-page, ai-builder-model, azure-sql-{server,database,managed-instance}, sql-server-2025-vector-index, geo-{map,dataset,query,pipeline}, cosmos-gremlin-graph, cypher-graph, gql-graph, vector-store, data-product-{template,instance}, cross-item-copilot)

**Notable findings from the catalog**:
1. **`data-product` is F-grade vaporware** — hardcoded `productId='customer-360'`, owner `'alice@contoso'`, fixed bundle grid. "Publish to APIM" creates an APIM Product (wrong backend). Needs Purview Unified Catalog wiring. Reclassified in `wiring-audit.md`.
2. **`usql-job` is unreachable** — Azure Data Lake Analytics retired 2024-02-29. Recommendation: graceful deprecation + Spark-translation helper.
3. **`sql-server-2025-vector-index` editor has a real DDL bug** — `DIMENSIONS` is a column-level property (`VECTOR(N)`), not an index `WITH` option.
4. **Copilot Studio 6-pack** is real and wired through Dataverse `msdyn_copilots` / `msdyn_knowledgesources` / etc., gated by per-env Copilot Studio enablement.
5. **AI Search Skillset / Indexer / DataSource items don't exist in registry** — gap that blocks enterprise-search ingest.
6. **APIM Policy operation scope is unwired** — only Global/API/Product scopes; missing `/apis/{aid}/operations/{oid}/policies/policy`.
7. **All four Geo items are Loom-native** (no Fabric equivalent); specs pivot to Azure-native references (Azure Maps Studio, KQL `geo_*`, Synapse spatial extensions).

**Next phase**: with 85 specs in hand, Phase 2 (Build) can now be sequenced. Suggested ordering per the no-vaporware rule:
1. **F-grade fixes** (vaporware violations must clear first): `data-product` MessageBar gate + Purview wiring
2. **D-grade upgrades**: `usql-job` deprecation MessageBar, `ontology`/`map`/`plan` runtime wiring
3. **C-grade enhancements**: `notebook` Phase 2 (ExplorerPane / Lakehouse attach), `apim-policy` operation scope, the DAG canvas (shared by `data-pipeline` / `adf-pipeline` / `synapse-pipeline`)
4. **A-grade polish**: Monaco upgrades, multi-tab, query history, etc.

## 2026-05-26 — Catalog phase ~73% complete (62 / 85 UIs cataloged)

**Today's full output**:
- Waves 1+2 (12 UIs) — closed previous session + data-pipeline added today
- Wave 3 (13 UIs) — completed
- Wave 4 (21 UIs) — all 6 agents complete
- Wave 5 (21 UIs) — 4 of 5 agents complete; tracing + ai-foundry dataset still pending
- Wave 6 (22 UIs) — 1 of 4 agents complete (geo 4-pack); Power Platform 7-pack, Azure SQL 4-pack, graphs+misc 7-pack still running

**Build phase progress** (alongside catalog):
- ✓ **Notebook Phase 1A** — cell-based scaffold shipped: CodeCell + MarkdownCell + CellAdder; per-cell Run via Cosmos `pendingRuns[runId]` transient map; language picker (PySpark / Spark / SparkSQL / SparkR / Python / T-SQL); back-compat with legacy `{code, lang}` blob (commit `3e1b32b6`)
- ✓ **Variable Library** — extended from 4 to 9 variable types: + Integer, DateTime, Guid, ItemReference, ConnectionReference (in addition to existing String/Number/Boolean/SecretReference); added Description column; per-cell value validation regex per type

**Remaining catalog work**: tracing, ai-foundry-dataset (waiting on partial agent finish), plus 5 still-running agents covering: Copilot Studio 6-pack, Power Platform 7-pack (copilot-template-library + powerplatform-environment + dataverse-table + power-app + power-automate-flow + power-page + ai-builder-model), Azure SQL 4-pack, and graphs/misc 6-pack (cypher-graph + gql-graph + vector-store + data-product-template + data-product-instance + cross-item-copilot).

## 2026-05-26 — Wave 4 catalog launched (21 UIs in 6 parallel agents) + Notebook Phase 1A shipped

**Wave 4 agents kicked off**:

| Agent | UIs |
|---|---|
| `a2433a6acd1482965` | variable-library, plan |
| `ae995b89188aa4e58` | ontology, graph-model, map |
| `a748958dbf3da3721` | operations-agent, data-agent |
| `a5984cea98c72082f` | synapse-dedicated-sql-pool, synapse-serverless-sql-pool, synapse-spark-pool |
| `a898bc142c4bf4488` | synapse-pipeline, adf-pipeline, adf-dataset, adf-trigger |
| `abe32b64e154c734e` | databricks-notebook, databricks-job, databricks-cluster, databricks-sql-warehouse |

Target after wave 4: **46 / 85 UIs cataloged**.

**Notebook editor Phase 1A landed** (commit `3e1b32b6`):
- `NotebookCell` type + state migration in `lib/types/notebook-cell.ts`
- `lib/components/notebook/{code-cell,markdown-cell,cell-adder}.tsx` — Fluent UI cell shells with per-cell Run, lang picker, move up/down, delete
- Cell-based load/save with backward compat for legacy `{code, lang}` blob
- Per-cell run dispatch via Cosmos `pendingRuns[runId]` transient map (each cell's source is cached at dispatch; poll endpoint reads from there when Livy session reaches `idle`)
- Markdown minimal renderer (headings/bold/italic/code/lists/links) — no Monaco/react-markdown deps added yet
- `.gitignore` carve-out for the previously-eaten `runs/[runId]/` dynamic route segment

**Honest scope**: Phase 1A is the cell scaffold only. Phase 2 (ExplorerPane / Lakehouse attach), Phase 3 (HistoryDrawer / cell toolbars) still pending per `notebook-parity-spec.md`. The notebook editor now visibly looks like Fabric (cell-based) but doesn't yet have OneLake browsing or the Connect menu.

## 2026-05-26 — Wave 3 catalog launched (12 UIs in 6 parallel agents)

**Wave 3 catalog kicked off** — 6 general-purpose agents running in parallel, each owning 1-3 UIs:

| Agent | UIs |
|---|---|
| `ab63f02fd92b935c8` | dashboard, paginated-report, scorecard |
| `a1402587cb2c6e0d7` | ml-experiment, ml-model |
| `a67c4b66eb7808477` | spark-job-definition, environment |
| `aa402e5fa7f4b0b6f` | graphql-api, user-data-function |
| `a22495e60e0256876` | kql-dashboard, activator |
| `a588b40b0dd792de0` | mirrored-database, dbt-job |

After wave 3 lands: **24 / 85 UIs cataloged**. Then Phase 2 (Build) waves.

**Catalog format change**: switched from read-only `Explore` agents to `general-purpose` agents so they can `Write` spec files directly (no more I-write-back-from-text). Faster end-to-end.

## 2026-05-26 — Wave 2 catalog COMPLETE (12 UIs cataloged total)

**Specs written** to `docs/fiab/<name>-parity-spec.md` for the next 10 Fabric UIs:

| UI | Agent | Status |
|---|---|---|
| eventstream | `a8260c3697beb6c69` | ✓ |
| eventhouse | `a8260c3697beb6c69` | ✓ |
| dataflow | `a30c2872e59523af4` | ✓ |
| copy-job | `a30c2872e59523af4` | ✓ |
| warehouse | `a25d745464518b765` | ✓ (rewritten — agent confused with eventhouse) |
| semantic-model | `a6112853cd6c023e5` | ✓ |
| report | `a6112853cd6c023e5` | ✓ |
| kql-database | `ad6a393dd34fd232c` | ✓ |
| kql-queryset | `ad6a393dd34fd232c` | ✓ |
| data-pipeline | `aff49f5c28912ff78` | ✓ (manually written from agent text; was read-only) |

**Cumulative**: 12/85 UIs cataloged. Notebook + Lakehouse from wave 1, plus the above 10.

## 2026-05-26 — Workflow scaffold + first parallel catalog run

**Workflow infrastructure shipped:**
- `.claude/workflows/fabric-parity-loop.md` — 3-agent pipeline design
- `.claude/commands/fabric-parity-loop.md` — slash command orchestrator
- `docs/fiab/fabric-parity-tasks.json` — 15-UI prioritized task list

**First parallel catalog run** (Phase 1 only, Phase 2 + 3 pending):

| UI | Agent | Status | Output |
|---|---|---|---|
| notebook | `af6f80e466901eecf` (Explore) | ✓ complete | Validated existing `notebook-parity-spec.md`; added 3 ribbon items (AutoML / Pipeline / VS Code), "Ask Copilot" on cell toolbar, execution count badge `[N]` |
| lakehouse | `a4f93461062e0e80c` (Explore) | ✓ complete | New `lakehouse-parity-spec.md` written — auto-paired SQL endpoint pattern confirmed, ribbon (Open notebook / Add to data agent / Manage OneLake security / Update all variables), 6 real bronze tables discovered |

**Build phase queued for next session:**
- `/fabric-parity-loop notebook` → cell-based editor rewrite, language picker, OneLake explorer panel
- `/fabric-parity-loop lakehouse` → auto-paired SQL endpoint + ribbon + data grid + Open-in-notebook flow

**Validate phase** runs immediately after each Build via the `verify-app` subagent.

---

## Known limitations the catalog agents surfaced

1. The Playwright MCP can't reliably navigate Fabric's portaled overlays (modals close before screenshot, kebab menus dismiss on focus loss). Specs are written from snapshot-tree inspection instead of pixel-perfect screenshots.
2. The Explore agent is read-only, so it documents findings in markdown rather than committing screenshots to git. Build agents read the markdown.
3. Fabric workspaces with F-capacity (like casino-fabric-poc F64) have ALL Fabric items enabled; specs derived from there are upper bound. Some items (like AutoML, VS Code integration) may not have full Loom equivalents in v1.

---

## Cumulative Loom shipping log (background)

| Loom v | Released | Key changes |
|---|---|---|
| v3.18 | 2026-05-26 | `/api/cosmos-items` fix for editor hydration bug + tab strip Fabric parity |
| v3.19 | 2026-05-26 | Dataverse-scope tokens route through MSAL Web App SP |
| v3.20 | 2026-05-26 | Power Pages schema fix + Copilot Studio gate + AppUser bootstrap |
| v3.21–22 | 2026-05-26 | `/api/loom/workspaces` + `/api/loom/compute-targets` + 4-editor Fabric→Loom swap |
| v3.23–24 | 2026-05-26 | Async notebook Run dispatch (beats FD 30s timeout) |
| v3.25 | 2026-05-26 | data-pipeline → ADF redirect, dataflow + mirrored to Cosmos, bicep Spark pool |
