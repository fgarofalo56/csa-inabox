# CSA Loom — Weave Epic

The **Weave** is the CSA Loom thread that delivers Azure-native, sovereign-ready
equivalents of best-in-class proprietary analytics platforms. Each weave thread
achieves **1:1 usable feature parity** using Azure + OSS backends — **never** by
requiring Microsoft Fabric, Power BI, or a proprietary license
(`.claude/rules/no-fabric-dependency.md`, `ui-parity.md`, `no-vaporware.md`).

## Threads

### Tapestry — investigative graph (Palantir Gotham equivalent)

**Status: shipped (audit-t53).**

Tapestry is an investigative link-analysis + geospatial + timeline workspace —
the Azure-native answer to Gotham-class investigation. It composes three
coordinated panes over the **same materialized `Node_*` / `Edge_*` ADX tables**
the graph editors already query (one engine, no duplication):

| Pane | Engine | Route |
|---|---|---|
| **Link** | ADX `make-graph` + `graph-match` / `graph-shortest-paths` / `graph-mark-components` | `POST /api/items/tapestry/[id]/link` |
| **Geo** | ADX node lat/lon → GeoJSON FeatureCollection → `GeoJsonMap` (+ optional live Azure Maps raster) | `POST /api/items/tapestry/[id]/geo` |
| **Timeline** | ADX `summarize count() by bin(ts, window), edgeLabel` over `Edge_*` | `POST /api/items/tapestry/[id]/timeline` |

**Cross-filter:** clicking a node in the Link canvas sets a shared seed id the
Geo + Timeline panes inherit.

**Acceptance:** run link / geo / timeline analysis over real data. Met via
`POST /api/admin/load-sample-data?kind=investigation`, which materializes a real
investigation (people, orgs, locations, events with timestamps + coordinates;
Knows/MemberOf/LocatedAt/Attended edges). With ADX unconfigured, every pane
returns an honest **503** naming `LOOM_KUSTO_CLUSTER_URI` — never a Fabric gate.

**Azure-native + sovereign:**
- Link + timeline (ADX graph operators) are GA in **every** Azure cloud; the
  cluster URI is sovereign-aware.
- Geo renders keyless everywhere; the live Azure Maps raster basemap is an
  Azure-side upgrade in Commercial / GCC (Maps is unavailable in GCC-High / IL5,
  where the vector overlay still renders — no regression).
- **No Microsoft Fabric dependency.** Fabric Graph remains opt-in elsewhere and
  is never on Tapestry's path.

**Key files:**
- Editor: `apps/fiab-console/lib/editors/tapestry-editor.tsx`
- BFF routes: `apps/fiab-console/app/api/items/tapestry/[id]/{link,geo,timeline}/route.ts`
- Shared KQL builders: `apps/fiab-console/lib/azure/tapestry-graph.ts`
- Sample data: `apps/fiab-console/app/api/admin/load-sample-data/route.ts` (`kind=investigation`)
- Viz (reused): `lib/components/graph/force-directed-graph.tsx`, `lib/components/graph/geojson-map.tsx`, `lib/components/adx/kusto-results-grid.tsx`
- Catalog: `apps/fiab-console/lib/catalog/fabric-item-types.ts` (`slug: 'tapestry'`)
- Registry: `apps/fiab-console/lib/editors/registry.ts`
- UAT: `apps/fiab-console/e2e/pp-ml-geo-graph.uat.ts` (`{ type: 'tapestry', family: 'graph' }`)
- Parity doc: `docs/fiab/parity/tapestry.md`
- Bootstrap: `docs/fiab/v3-tenant-bootstrap.md` (#tapestry-investigative-graph)

### Warp — unified visual + code transform / pipeline builder (audit-t54)

**Status: shipped (audit-t54).**

**Warp** is CSA Loom's unified, branded **transform and pipeline builder** — the
"Pipeline Builder + Code Repos" experience that lets a user build a data
transform either **visually** or **in code** and have it **emit and run real
Spark / SQL**.

Warp is **not a new engine.** The string `warp` previously appeared nowhere in
`apps/fiab-console/lib` or `/app` — it is a new *surface* that unifies and
brands three pre-existing, production pillars. Every transform Warp surfaces is
already wired front-to-back (UI → BFF route → real Azure backend) and is
**Azure-native by default** (works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset —
no Microsoft Fabric capacity required, per `.claude/rules/no-fabric-dependency.md`).

#### Acceptance criterion (and how Warp meets it)

> Build a transform visually **or** in code that emits and runs real Spark/SQL.

| Path | Build | Emits | Runs (real backend) |
|------|-------|-------|---------------------|
| **Visual** (Pipeline Builder) | Drag tables + applied steps on the Visual Query canvas | `compileGraph(graph, dialect)` → real `WITH … SELECT` T-SQL **or** Spark SQL | `POST /api/items/[type]/[id]/visual-query` executes against Synapse Dedicated / Serverless TDS or a Databricks SQL Warehouse and returns real rows |
| **Code** (Code Repos) | Author a medallion dbt DAG (sources → bronze/silver/gold) | `generateProject(graph)` → a real dbt Core project (`dbt_project.yml`, `profiles.yml`, `models/**.sql`, `schema.yml`) | `POST /api/items/dbt-job/[id]/run` → Databricks Job `dbt_task` (`source: WORKSPACE`, default) **or** the `loom-dbt-runner` Container App (Synapse / opt-in Fabric) |

Both paths are LIVE today — Warp brands them as one experience.

#### The three pillars (real symbols)

##### Pillar 1 — Visual transform → SQL (Power Query / Fabric Visual Query parity)
- `apps/fiab-console/lib/editors/visual-query-compiler.ts` — pure, side-effect-free
  `compileGraph(graph: VqGraph, dialect: SqlDialect): string`.
  `SqlDialect = 'tsql' | 'sparksql'`. Step kinds:
  `'source' | 'filter' | 'select-columns' | 'keep-top-rows' | 'group-by' | 'sort' | 'join'`.
  Emits a real `WITH <cte>… SELECT` chain with dialect-aware quoting
  (`[name]` vs `` `name` ``) and dead-branch pruning.
- Canvas UI: `apps/fiab-console/lib/editors/components/visual-query-canvas.tsx`
  (React Flow). Every input is a guided control — column checklists, group-by
  pickers, aggregate dropdowns, **sort column + ASC/DESC pickers**, join-kind +
  key pickers. The **only** freeform slot is the Filter step's single WHERE
  expression box — the explicitly-allowed 1:1 builder exception
  (`loom-no-freeform-config`).
- Execution route: `apps/fiab-console/app/api/items/[type]/[id]/visual-query/route.ts`
  — compiles with the SAME pure compiler, then runs against real backends:
  `warehouse` / `synapse-dedicated-sql-pool` → dedicated TDS;
  `synapse-serverless-sql-pool` → serverless TDS;
  `databricks-sql-warehouse` → `executeStatement(...)`. Returns
  `{ ok, generatedSql, columns, rows, rowCount, executionMs }`.

##### Pillar 2 — Code Repos-equiv (dbt project = real code → real SQL on Spark)
- Model: `apps/fiab-console/lib/dbt/dbt-project-model.ts` — `DbtProjectGraph`,
  `DbtModel`, `DbtSource`, `DbtTarget`, `DbtAdapter = 'databricks'|'synapse'|'fabric'`,
  `MedallionLayer = 'bronze'|'silver'|'gold'`. `emptyProjectGraph()` defaults
  `adapter: 'databricks'` (Azure-native default).
- Codegen: `apps/fiab-console/lib/dbt/dbt-codegen.ts` — `generateProject(g): GeneratedFile[]`
  emits real dbt Core files with `{{ config(materialized=…) }}` and `schema.yml`
  tests. `findDanglingRefs()` validates the DAG. Identity-only auth.
- Runner: `apps/fiab-console/lib/dbt/dbt-runner.ts` — `runDbtOnDatabricks()`
  builds a Databricks Job via `buildWorkspaceDbtJobSpec()`
  (`dbt_task: { project_directory, commands, source: 'WORKSPACE' }`,
  `project_directory` = `/Workspace/Shared/loom-dbt/<itemId>` — absolute, exact
  match to MS Learn). Synapse / Fabric → `runDbtOnRunner()` POSTs to the
  `loom-dbt-runner` Container App; `dbtRunnerConfigGate()` returns an honest
  `{ missing: 'LOOM_DBT_RUNNER_URL' }` when undeployed.
- Run route: `apps/fiab-console/app/api/items/dbt-job/[id]/run/route.ts` — three
  paths (A: visual + Databricks default; B: visual + Synapse/Fabric runner;
  C: legacy BYO Git repo via `git_source`).

##### Pillar 3 — Pipeline Builder + Spark job
- Pipeline editors: `lib/editors/pipeline-editor.tsx`, `pipeline-editor-core.tsx`,
  `data-pipeline-editor.tsx`; ADF binding `lib/azure/pipeline-binding.ts`.
- Spark emit: `lib/editors/spark-job-definition-editor.tsx`,
  `synapse-spark-editor.tsx`, `databricks-editors.tsx`, plus Dataflow Gen2
  `lib/editors/dataflow-gen2-editor.tsx` (compiles authored Power Query M into an
  ADF WranglingDataFlow running on ADF Spark; Azure-native default, Fabric opt-in
  via `LOOM_DATAFLOW_BACKEND=fabric`).

#### The Warp surface (this epic)

- **Hub page:** `app/experience/warp/home/page.tsx` (mounted in the left nav at
  `/experience/warp/home`, mirroring the Data Science experience).
- **Shared body:** `lib/components/warp/warp-hub-content.tsx` — two pillar tabs:
  - **Pipeline Builder** — quick-create links to the real `/items/<slug>/new`
    editors (data-pipeline, spark-job-definition, dataflow, notebook) plus a
    **live generated-SQL preview** produced by the *same* `compileGraph` the
    canvas and run route use (a faithful demo of the canvas → SQL contract — not
    hard-coded sample text), with a T-SQL / Spark SQL dialect toggle.
  - **Code Repos** — quick-create link to the real `/items/dbt-job/new` editor.
  - Both tabs list the user's **recent items** from
    `GET /api/experience/warp/home` (real Cosmos `items` query, scoped to the
    signed-in user's workspaces).
- **Aggregator route:** `app/api/experience/warp/home/route.ts` — returns recent
  Pipeline-Builder items (`data-pipeline`, `synapse-pipeline`,
  `spark-job-definition`, `dataflow`, `copy-job`) and Code-Repos items
  (`dbt-job`). 401 when unauthenticated. No mocks; no Fabric host on the default
  path.

The Warp surface **does not fork the engines** — its "build & run" affordances
route to the existing `/visual-query` and `/dbt-job/[id]/run` routes, keeping the
canvas / DAG the single source of truth.

#### Gap-close in this epic (parity)

The dbt-job parity matrix (`docs/fiab/parity/dbt-job.md`) is already **zero ❌**.
The remaining genuine Visual-Query parity gap was the Power Query **"Sort rows"
(ORDER BY)** applied step. This epic adds it as a first-class, guided step:

- Compiler: new `sort` step kind + `VqSortKey { field, dir }` + `VQ_SORT_DIRS`,
  emitting a multi-key, dialect-aware `ORDER BY` (`visual-query-compiler.ts`).
- Canvas: a **Sort** palette button + a "Sort rows" inspector form with a column
  picker + ASC/DESC dropdown per key (`visual-query-canvas.tsx`) — guided
  controls only, no freeform SQL.
- Tests: golden tests for multi-key ORDER BY in both dialects and the empty-keys
  pass-through (`lib/editors/__tests__/visual-query-compiler.test.ts`).

#### Per-cloud reality (no-fabric-dependency)

| Cloud | Visual transform → SQL | dbt (Code Repos) |
|-------|------------------------|------------------|
| **Azure Commercial (default)** | Synapse Dedicated / Serverless or Databricks SQL Warehouse | Databricks Job `dbt_task` (no extra infra) |
| **Synapse / Fabric adapters** | same Synapse / Databricks targets | `loom-dbt-runner` Container App (gated by `LOOM_DBT_RUNNER_URL`); Fabric opt-in only |
| **GCC-High / IL5** | Synapse / Databricks targets | Databricks path works without the runner; the runner is `containerApps`-only, gated by `dbtRunnerActive` |

#### Bicep + bootstrap sync

**Warp introduces no new Azure runtime** — it reuses the existing Databricks /
Synapse bindings and the `loom-dbt-runner` Container App. No new bicep param,
module, env var, Cosmos container, or role assignment is required for Warp
itself. The existing, already-synced wiring it depends on:

- `platform/fiab/bicep/modules/integration/dbt-runner.bicep` — `loom-dbt-runner`
  Container App (dbt-core + dbt-synapse + dbt-fabric + ODBC 18, scale-to-zero,
  VNet-internal, UAMI), output `dbtRunnerInternalEndpoint`.
- `platform/fiab/bicep/modules/admin-plane/main.bicep`:
  - `param dbtRunnerEnabled bool = false` (line 244)
  - `var dbtRunnerActive = dbtRunnerEnabled && containerPlatform == 'containerApps' && deployAppsEnabled` (line 269)
  - Console env `LOOM_DBT_RUNNER_URL = dbtRunnerActive ? dbtRunner!.outputs.dbtRunnerInternalEndpoint : ''` (line 2060)
  - `module dbtRunner '../integration/dbt-runner.bicep' = if (dbtRunnerActive)` (line 3037)

**Checklist for any future Warp runtime** (if one is ever added): add a bicep
param → module → `LOOM_*_URL` Console env in `admin-plane/main.bicep` mirroring
the dbt-runner pattern, plus the `scripts/csa-loom/` bootstrap equivalent.

#### Verification

- `cd apps/fiab-console && npx tsc --noEmit -p tsconfig.json` — Warp files clean.
- `lib/editors/__tests__/visual-query-compiler.test.ts` — golden tests incl. the
  new `sort` step (multi-key ORDER BY, both dialects, empty-keys pass-through).
- Live acceptance (per `no-vaporware.md`): build a transform on the Visual Query
  canvas → it compiles to real Spark/T-SQL and runs via `/visual-query`; author
  a dbt project → it generates real files and runs via `/dbt-job/[id]/run`
  (Databricks default), both with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

#### Design rules honored

`.claude/rules/no-fabric-dependency.md` (Azure-native default, Fabric opt-in
only), `.claude/rules/no-vaporware.md` (real backends, no dead controls, honest
infra-gates), `.claude/rules/ui-parity.md` (guided controls; the Visual Query +
dbt-job parity docs back each pillar), and the inline `loom-no-freeform-config`
allow-list (only the Filter WHERE box + per-dbt-model SQL bodies are freeform).

## Future weave threads

Additional Gotham/Foundry/Palantir-class and proprietary-analytics equivalents
are tracked under the Palantir-class migration surfaces already in the catalog
(`workshop-app`, `slate-app`, `ontology-sdk`, `release-environment`,
`health-check`, `aip-logic`) and grow this epic as they land.
