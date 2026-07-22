# loom-next-level PRP — Workstreams L (Column-Level Lineage) & A (Analyst-Surface Depth)

> Draft owned by the lineage-depth agent. Two workstreams of the master
> `loom-next-level` PRP. Every item is PR-sized with an ID (`L*` lineage, `A*`
> analyst-depth). Die-hard rules in force: `no-fabric-dependency` (Azure-native
> default, Fabric strictly opt-in), `ui-parity`, `ux-baseline` (G1 browser E2E /
> G2 zero-day-one-gates-with-Fix-it / G3 SplitPane resizable), `no-vaporware`,
> `no-scaffold`, `loom-default-on-opt-out`.
>
> **Per-cloud contract for every item** (unless noted):
> - **Commercial** — live, verified with a real Azure backend receipt.
> - **Gov (GCC-High)** — live, `.us` endpoints; service availability confirmed
>   against Microsoft Learn (citations inline). Purview in Gov is the classic
>   Data Map (per project memory).
> - **IL5** — **design-constraint documentation only** (no live run); each item
>   carries an IL5 note in `docs/fiab/parity/<slug>.md`.

---

## Grounding: verified current state (read before editing)

**Lineage (WS-L).** Column-level lineage exists **today only for the Databricks
Unity Catalog source**: `unified-lineage.ts` calls
`getColumnLineageSystemTables()` (`unity-catalog-client.ts:1032`, querying
`system.access.column_lineage`) and, when `columnLineage=true` (driven by
`?columns=true` + `LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID`), synthesizes
`col:<table>::<column>` nodes (`type:'column'`) and column→column edges
(`unified-lineage.ts:451-468`). **Purview and Weave/Thread contribute zero
column grain.** Specifics:
- `LineageNode` (route `app/api/catalog/lineage/route.ts:32-48`) has no column
  field; `CanvasLineageNode` (`lib/components/catalog/lineage-canvas.tsx:69-104`)
  already carries `columns?: string[]` but only as a detail-panel badge list —
  no per-column nodes/edges rendered.
- `ThreadEdge` (`lib/thread/thread-edges.ts:18-51`, container `thread-edges`, PK
  `/tenantId`) is item→item only — **no `fromColumn`/`toColumn`/`columnMappings`
  field.** `recordThreadEdge` already mirrors each edge into Purview as an Atlas
  `Process` (entity-grain `inputs[]`/`outputs[]`) when `LOOM_PURVIEW_ACCOUNT` is
  set.
- Purview `createAtlasLineage` (`purview-client.ts:918-945`) posts a `Process`
  with entity-GUID `inputs`/`outputs` only — **no `columnMapping` attribute, no
  column sub-entities.** `getLineageSubgraph` (`:714-738`) reads only
  `qualifiedName`/`name`.
- ADF/Synapse Copy-activity `translator.mappings` (source→sink column map) is
  present in the pipeline definition JSON and activity-run output but **currently
  unparsed** — `adf-client.ts` / `synapse-dev-client.ts` fetch runs but type
  `input`/`output` as `unknown`.
- **No post-run reaction exists** (pull-only). The Function to mirror is the
  **timer** `azure-functions/report-subscriptions` (pure `schedule.ts` +
  IO-isolated `clients.ts` + `app.timer(...)` entrypoint).
- dbt lineage is **authored in-console** (`DbtProjectGraph.models[].refs`) — **no
  `manifest.json` parsing** exists anywhere; that is greenfield.
- LIN-GC (`lineage-gc.ts`) already reconciles deleted items across Purview +
  thread-edges + access artifacts — the delete-time choke point column facets
  must not regress.

**Analyst depth (WS-A).**
- **DAX is NOT generally evaluated.** The loom-native "evaluator"
  (`tabular-model.ts:171-191`, `translateDaxToSql`) is **3 hard-coded regexes**
  handling only `EVALUATE <Table>`, `EVALUATE TOPN(N,<Table>)`, and
  `EVALUATE ROW("L", CALCULATE(<AGG>(T[C])))` with `AGG ∈ {SUM, COUNT, AVERAGE→AVG,
  MIN, MAX}`. Everything else returns `null → unsupportedDaxError()`. The AAS
  path (`aas-client.ts:executeAasQuery` / XMLA) runs **raw DAX** on a real
  Vertipaq engine (opt-in via `LOOM_SEMANTIC_BACKEND=analysis-services`;
  currently **blocked in Gov** by `isGovCloud()`). Reports on the native path
  bypass DAX entirely and compile **field wells → SQL** (`wells-to-sql.ts`).
  The UI already **generates** `SUMMARIZECOLUMNS/COUNTROWS/DISTINCT/DISTINCTCOUNT/
  COUNTA` (`semantic-link.ts`, `dax-query-view.tsx`) that the native engine
  **rejects** — the most visible parity gap.
- **Report designer is already rich** (`report-designer/constants.tsx:29-58`):
  **25 visual types** incl. matrix (with drill), waterfall, scatter (size + play
  wells), map, decomposition tree, key influencers, KPI, gauge, treemap, ribbon,
  funnel, combo, Q&A, smart narrative, Python/R script visuals. Conditional
  formatting is full (`conditional-format.tsx`: rules / colorScale / dataBars /
  icons / fieldValue / webUrl). Cross-filtering exists
  (`interactions.tsx`: highlight / filter / none). So report items below target
  **depth/parity gaps** (small multiples rendering, analytics-pane lines, Gov map
  fallback, drill-through) — not net-new galleries.
- **Spark reliability is substantially built** (`spark-session-pool.ts`): leaked-
  Livy reaper with 4 guards + busy-zombie rule (#1796), per-group circuit
  breaker, cross-replica lease store (`spark-lease-store.ts`), external keep-warm
  heartbeat (`/api/internal/spark/keep-warm`), idle-TTL eviction, learned-
  schedule autoscale, prove-warm probe, telemetry audit. **Gaps:** no
  `provisioningState==='Failed'` FAULTED detection/auto-recreate; **no admin UI
  dashboard** (status is API-only); no vCore-quota ceiling; sweeper depends on an
  in-process `setInterval` unreliable on ACA; no drain/recreate runbook.

**Per-cloud service availability (verified via Microsoft Learn):**
- Event Hubs, Azure Functions, Event Grid, Azure Monitor, Cosmos DB, Logic Apps:
  **GA in Gov (FedRAMP High / DoD IL4 / IL5)** — the lineage ingest (Event Hubs +
  timer Function) and extractor run in Gov.
  (learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap)
- **Azure Analysis Services: GA in Gov (FedRAMP High / IL4 / IL5)** per the Gov
  product roadmap — **this contradicts the current code's `isGovCloud()` block
  and the older project memory.** A5/A4 revisit this: AAS is available in Gov via
  `.asazure.usgovcloudapi.net`; the loom-native DAX expansion remains the
  cloud-agnostic default regardless.
- Synapse Spark pools support **pool-level Spark configuration + workspace
  libraries** (`az synapse spark pool update`) — the mechanism for the
  OpenLineage listener jar. DEP-enabled workspaces cannot pull from public repos,
  so the jar is uploaded as a workspace library.
  (learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-azure-create-spark-configuration)
- Purview classic Data Map supports **column-level lineage**: column mappings on
  DataSet→DataSet relationships (`POST /datamap/api/atlas/v2/relationship`) and
  **process column lineage** on Process nodes (`columnMapping`).
  (learn.microsoft.com/purview/data-gov-classic-lineage-user-guide)
- **Azure Maps: not available in GCC/Gov** (project memory) → honest-gate + a
  basemap-free choropleth fallback (A8).

---

# WORKSTREAM L — COLUMN-LEVEL LINEAGE

Dependency spine: **L1 → {L2, L3, L4, L6, L7} → L5**. L1 is the schema
foundation; capture items (L2/L3/L6) and the Purview push (L4) all write the L1
column model; L5 renders it. L7 rebases the existing UC column path onto L1.

## L1 — Column-facet schema foundation (the enabling PR)

**Goal.** Make column-level lineage a first-class, cross-source facet of the
lineage model so every source (Purview, Weave/Thread, UC, dbt, Spark, ADF) writes
and reads the same shape. No behavior change yet — this is the schema + merge
plumbing every downstream item builds on.

**Exact files.**
- `apps/fiab-console/lib/thread/thread-edges.ts` — extend `ThreadEdge` (`:18-51`)
  and `RecordEdgeInput` (`:53-63`) with:
  ```ts
  /** Optional column-grain mappings for this item→item edge. Absent = table-grain
   *  edge (the pre-existing shape; fully backward compatible). */
  columnMappings?: Array<{
    fromColumn: string;
    toColumn: string;
    transform?: string;      // e.g. "UPPER(x)", "CAST(...)", "1:1"
    confidence?: 'declared' | 'derived';  // OpenLineage/UC = declared; heuristic = derived
  }>;
  ```
  `recordThreadEdge` upsert already round-trips unknown fields; add
  `columnMappings` to the persisted body. No Cosmos container change (still
  `thread-edges`, PK `/tenantId`).
- `apps/fiab-console/lib/azure/unified-lineage.ts` — make `col:` nodes + column
  edges source-agnostic: lift the UC-only synthesis (`:451-468`) into a shared
  `synthesizeColumnGraph(members, edges)` that also consumes `ThreadEdge.columnMappings`
  and Purview column facets (L4). Keep `normalizeIdentity`'s existing
  `col:<table>::<column>` key (`:78-92`) as the canonical column identity so
  cross-source column nodes merge in the same UnionFind.
- `apps/fiab-console/lib/components/catalog/lineage-canvas.tsx` — extend
  `CanvasLineageEdge` (`:106-110`) with `kind?: 'table' | 'column'` and
  `CanvasLineageNode` (`:69-104`) with `parentTableId?: string` (a column node's
  owning table) + `columnOf?: string`. Non-breaking (all optional).
- `apps/fiab-console/app/api/catalog/lineage/route.ts` — add `columns?: string[]`
  to `LineageNode` and a `columnEdges?: CanvasLineageEdge[]` array to the
  response envelope, gated behind `?columns=true` (default false → identical to
  today's payload).
- Tests: `apps/fiab-console/lib/thread/__tests__/thread-edges.test.ts` (round-trip
  `columnMappings`), `apps/fiab-console/lib/azure/__tests__/unified-lineage.test.ts`
  (cross-source column merge via shared `col:` identity).

**Backend/infra.** None new. Reuses Cosmos `thread-edges`. No bicep change.

**Env vars / gates.** None. (L1 is pure schema; capture gates land in L2/L3.)

**Acceptance.**
- Unit: `columnMappings` round-trips through Cosmos; a Weave edge + a UC column
  edge for the same physical column collapse to one `col:` node in the merge.
- Back-compat: `GET /api/catalog/lineage?...` **without** `?columns=true` returns
  byte-identical payload to `main` (snapshot test).
- LIN-GC regression: `cleanupItemMetadata` still removes an edge that now carries
  `columnMappings` (`lineage-gc.test.ts` extended).
- G1: n/a (no UI surface changes; covered by L5). Receipt = green
  `pnpm --filter fiab-console test` for the three touched test files +
  `tsc -p tsconfig.build.json`.

**Per-cloud.** Cloud-agnostic (Cosmos only). Commercial + Gov identical. IL5:
note in parity doc that the schema is metadata-plane only (no data movement).

---

## L2 — OpenLineage capture from Synapse Spark (declared column lineage)

**Goal.** Emit OpenLineage `RunEvent`s (with the `columnLineage` facet) from
Synapse Spark jobs and ingest them into the L1 column model — real, declared
column lineage from Spark transforms, Azure-native, no Fabric.

**Exact files.**
- New BFF ingest route `apps/fiab-console/app/api/lineage/openlineage/route.ts`
  (mirrors the per-item ingest pattern at
  `app/api/items/eventhouse/[id]/ingest/route.ts`): validates a bearer shared
  token (`LOOM_OPENLINEAGE_INGEST_TOKEN`), parses an OpenLineage RunEvent, maps
  its `inputs[]`/`outputs[]` datasets + `columnLineage` facet
  (`fields.<col>.inputFields[]`) into `RecordEdgeInput.columnMappings` (L1), and
  calls `recordThreadEdge`. Resolves ADLS `abfss://` paths → Loom item ids via
  the existing identity resolver (`unified-lineage.normalizeIdentity` `path:` key).
- New `apps/fiab-console/lib/azure/openlineage-ingest.ts` — pure mapper
  (OpenLineage RunEvent → `RecordEdgeInput[]`), fully unit-testable, SDK-free.
- `platform/fiab/bicep/modules/landing-zone/synapse-spark-pools.bicep` — add
  `sparkConfigProperties` to the pool: `spark.extraListeners =
  io.openlineage.spark.agent.OpenLineageSparkListener`,
  `spark.openlineage.transport.type = http`,
  `spark.openlineage.transport.url = <LOOM console ingest URL>`,
  `spark.openlineage.transport.auth.type = api_key`,
  `spark.openlineage.transport.auth.apiKey = <token>`,
  `spark.openlineage.namespace = loom`.
- New `scripts/csa-loom/openlineage-pool-setup.sh` — idempotent
  `az synapse spark pool update` that uploads the OpenLineage listener jar as a
  **workspace library** (required for DEP-enabled workspaces — Learn: public-repo
  installs unsupported in DEP workspaces) and sets the Spark config. Mirrors
  `ai-functions-pool-setup.sh`.
- Tests: `apps/fiab-console/lib/azure/__tests__/openlineage-ingest.test.ts` (golden
  RunEvent fixtures → expected `columnMappings`).

**Backend/infra.** Synapse Spark pool config + workspace library (bicep +
script). Transport = **direct HTTP to the console ingest route** (simplest, no new
resource). *Opt-in enhancement noted in parity doc:* Event Hubs transport
(`transport.type=kafka`/http→EH) for high-volume estates — Event Hubs is GA in
Gov; not required for v1.

**Env vars / gates.**
- `LOOM_OPENLINEAGE_INGEST_TOKEN` (**secret**, `secretRef` in `apps[]` env — mirror
  the MSAL secret pattern) — validates the ingest route.
- `LOOM_OPENLINEAGE_ENDPOINT` (informational; the URL stamped onto the pool).
- `ENV_CHECKS` entry (`lib/admin/env-checks.ts:380+`), following the verbatim
  shape:
  ```ts
  { id: 'svc-openlineage', category: 'catalog-governance',
    title: 'Spark column lineage (OpenLineage)', severity: 'optional',
    required: ['LOOM_OPENLINEAGE_INGEST_TOKEN'], warnOnMiss: true,
    optionalDefault: true,
    optionalDefaultDetail: 'Column lineage still flows from Databricks UC, dbt, and ADF Copy mappings; the Synapse-Spark OpenLineage feed is an additive source.',
    remediation: 'Set LOOM_OPENLINEAGE_INGEST_TOKEN and run scripts/csa-loom/openlineage-pool-setup.sh to install the listener on the Spark pool.',
    provisionedBy: 'modules/landing-zone/synapse-spark-pools.bicep (sparkConfigProperties + workspace library) → apps[] env',
    role: 'Synapse Spark pool contributor (to upload the workspace library)' },
  ```
  Add `LOOM_OPENLINEAGE_INGEST_TOKEN: '<shared-secret>'` to `VALUE_HINT`
  (`env-checks.ts:77`).
- `GATE_META` entry (`lib/gates/registry.ts:198`) — `id:'svc-openlineage'`:
  ```ts
  'svc-openlineage': {
    surfaces: [{ path: '/items/lakehouse', label: 'Lakehouse lineage tab' },
               { path: '/catalog', label: 'Unified Catalog → Lineage' }],
    fixit: { kind: 'wizard' },   // wizard: mint token + run the pool-setup script
    legacyCodes: ['openlineage_not_configured'],
  },
  ```
  (Registry test enforces GATE_META ⇔ ENV_CHECKS parity — both updated together.)

**Acceptance.**
- Real Spark job (a seeded notebook doing a `df.select(...).join(...).write`)
  produces a RunEvent whose `columnLineage` facet ingests into `thread-edges`
  with correct `columnMappings`; verified by reading back
  `GET /api/catalog/lineage?...&columns=true`.
- G1 receipt: browser walk of the Lakehouse → Lineage tab showing the Spark-
  derived column edges on real data; endpoint 200 body first 300 chars in PR.
- Honest gate: token unset → the OpenLineage source is silently absent (default-
  ON of the OTHER sources preserved), with a Fix-it wizard on the gate registry
  page (G2).

**Per-cloud.** Commercial: live. Gov: live — Synapse Spark + workspace libraries
GA in Gov; ingest route is in-cluster (no external host). IL5: design-doc only —
note DEP-workspace jar-upload requirement and no public-repo pull.

---

## L3 — ADF / Synapse pipeline Copy-activity column lineage (timer Function)

**Goal.** Derive column lineage from Copy-activity `translator.mappings` on
completed ADF/Synapse pipeline runs and write it into the L1 model — covering the
no-code ingestion path where OpenLineage isn't emitted.

**Exact files.**
- New Function app `azure-functions/lineage-extractor/` — clone the
  `report-subscriptions` structure exactly (`host.json`, `package.json` with
  `@azure/functions ^4.5` + `@azure/identity` + `@azure/cosmos`, `tsconfig.json`,
  `vitest.config.ts`):
  - `src/functions/extractLineage.ts` — `app.timer('extractLineage', { schedule:
    process.env.LINEAGE_EXTRACTOR_CRON || '0 */15 * * * *', handler })`.
  - `src/extract.ts` — **pure, SDK-free, unit-tested** mapper: given a pipeline
    definition + activity-run list, walk `pipeline.properties.activities[]` for
    `type==='Copy'`, read `typeProperties.translator.mappings[]`
    (`{source:{name}, sink:{name}}`) and the source/sink dataset references,
    produce `RecordEdgeInput[]` with `columnMappings` (`confidence:'declared'`).
  - `src/clients.ts` — Cosmos (`thread-edges`) + ADF/Synapse run queries via
    `DefaultAzureCredential`; a minute-resolution idempotency guard
    (`alreadyProcessed(runId)`) mirroring `report-subscriptions`' `alreadyRanThisMinute`.
  - `src/extract.test.ts` — golden pipeline JSON → expected column mappings.
- `apps/fiab-console/lib/azure/adf-client.ts` / `synapse-dev-client.ts` — export a
  typed `CopyActivityTranslator` shape + a `readCopyColumnMappings(pipelineDef)`
  helper reused by the Function and any BFF backfill route.
- `platform/fiab/bicep/modules/admin-plane/lineage-extractor-function.bicep` —
  new Function App (Linux Y1 consumption, per the gates-zero recipe), MI with
  Cosmos + Data Factory Reader + Synapse Artifacts Reader, App Insights, wired
  into `admin-plane/main.bicep` alongside `report-subscriptions-function.bicep`.

**Backend/infra.** New timer Function + its bicep module. Reuses ADF/Synapse
management + Cosmos. *Opt-in enhancement (parity doc):* an Event Grid subscription
on ADF `Microsoft.DataFactory` run-completion for near-real-time extraction
(Event Grid GA in Gov) — timer is the v1 default (matches existing pattern, no
new event plumbing).

**Env vars / gates.**
- Function app settings: `LINEAGE_EXTRACTOR_CRON`, `LOOM_COSMOS_ENDPOINT`,
  `LOOM_COSMOS_DATABASE`, `LOOM_ADF_FACTORY` / `LOOM_SYNAPSE_WORKSPACE` (reused,
  already in ENV_CHECKS). No new **console** gate (the Function is infra); its
  health surfaces on the Spark/lineage admin page.
- If desired, an ENV_CHECKS `optional` marker `svc-lineage-extractor` with
  `optionalDefault:true` so the Admin env page reports whether the extractor is
  deployed — same verbatim shape as L2.

**Acceptance.**
- A seeded Copy pipeline (SQL table → lakehouse Delta with an explicit column
  mapping) runs; within one cron tick the extractor writes `columnMappings` to
  `thread-edges`; verified via `?columns=true`.
- Unit: `extract.test.ts` golden fixtures (explicit mapping, implicit/auto mapping
  → `confidence:'derived'`, no-mapping Copy → table-grain edge only).
- G1 receipt: lineage tab shows the pipeline's column edges on real data.
- Idempotency: re-running the same completed run does not duplicate edges.

**Per-cloud.** Commercial + Gov: live (Functions + ADF/Synapse GA in Gov). IL5:
design-doc only.

---

## L4 — Purview column-level push + read (Atlas columnMapping)

**Goal.** Push Loom column lineage into Purview and read Purview-native column
lineage back — closing the metadata-plane loop bi-directionally on the classic
Data Map (Commercial + Gov).

**Exact files.**
- `apps/fiab-console/lib/azure/purview-client.ts` — add:
  - `ensureColumnEntities(datasetTypeName, datasetQN, columns[])` — bulk-create
    column sub-entities (`POST /datamap/api/atlas/v2/entity/bulk`), per the Learn
    example (hive_column-style children under a DataSet).
  - `createAtlasColumnLineage(opts)` — set the `columnMapping` attribute on the
    Process entity in `createAtlasLineage` (`:918-945`) — a JSON string
    `[{DatasetMapping:{Source,Sink}, ColumnMapping:[{Source,Sink}]}]` — the
    Atlas-standard column-map shape; OR (for direct DataSet→DataSet, no process)
    `POST /datamap/api/atlas/v2/relationship` with the column mapping (Learn:
    "Create direct lineage between table 2 and table 3, with column mapping").
  - Extend `getLineageSubgraph` (`:714-738`) to parse the Process `columnMapping`
    attribute + process column lineage into `columnEdges` (L1).
- `apps/fiab-console/lib/thread/thread-edges.ts` — in `recordThreadEdge`'s Purview
  mirror block (`:109-151`), when `columnMappings` is present, call
  `createAtlasColumnLineage` instead of the entity-grain `createAtlasLineage`.
- `apps/fiab-console/lib/azure/purview-autoonboard.ts` — when onboarding a
  lakehouse/warehouse/table item, best-effort register its column sub-entities so
  column lineage has endpoints to attach to.
- Tests: `apps/fiab-console/lib/azure/__tests__/purview-column-lineage.test.ts`
  (mock Atlas; assert the `columnMapping` payload shape + read parse).

**Backend/infra.** None new — reuses `LOOM_PURVIEW_ACCOUNT` / the classic Data
Map data-plane. All best-effort / fire-and-forget (never blocks a save), matching
the existing Purview mirror.

**Env vars / gates.** None new (reuses the existing `svc-purview` gate). The
column push is silently skipped when Purview is unconfigured — the Loom-native
column lineage (L1/L5) is the default and remains fully functional without
Purview (`no-fabric-dependency`, `no-vaporware` honest-gate).

**Acceptance.**
- With Purview configured, a Weave edge carrying `columnMappings` produces a
  Purview Process with a `columnMapping` attribute visible in the Purview portal
  lineage tab (screenshot in PR) **and** re-read by `getLineageSubgraph`.
- With Purview unconfigured, column lineage still renders from the Loom-native
  store — no gate, no error (default-ON).
- LIN-GC: deleting an item purges its column sub-entities + Process (extend
  `offboardFromPurview`); `lineage-gc.test.ts` covers the column entities.

**Per-cloud.** Commercial: live. Gov: live — classic Data Map (project memory);
same Atlas REST, `.purview.azure.us` host. IL5: design-doc — note Purview
availability + the classic-vs-unified distinction.

---

## L5 — Column-level lineage UI: table→column fan-out + impact analysis

**Goal.** Render the L1 column model on the lineage canvas: expand a table node
into its columns, draw column→column edges, and support **column impact
analysis** (select a column → highlight its downstream column chain). Meets
`ux-baseline` canvas standards.

**Exact files.**
- `apps/fiab-console/lib/components/catalog/lineage-canvas.tsx` — add:
  - An **expand/collapse affordance** on table nodes (chevron, hover-revealed per
    node-compactness) that toggles rendering of child `col:` nodes (grouped under
    the table via `parentTableId`) and their column edges (`kind:'column'`,
    thinner, tinted stroke distinct from table edges).
  - **Column focus**: clicking a column node runs the existing `connectedTo`
    chain walk (`:451-465`) restricted to `kind:'column'` edges → downstream
    column impact highlight; detail panel lists upstream/downstream columns +
    transform expressions.
  - Keep the existing `ResizableCanvasRegion` / `CanvasRightRail` / node-kit
    styling; ensure the new column badges use `flexWrap`+`minWidth:0` (no overlap
    at narrow width).
- `apps/fiab-console/lib/components/catalog/lineage-graph.tsx` (the parent that
  calls `/api/catalog/lineage`) — pass `?columns=true`; add a "Show column
  lineage" toggle + an "Impact analysis" mode toggle in the toolbar.
- `docs/fiab/parity/lineage.md` — parity doc vs Purview lineage tab + Databricks
  Catalog Explorer column lineage (zero ❌).
- Tests: component render test (expand → column nodes present); Playwright
  minted-session walk added to `loom-ui-verify`.

**Backend/infra.** None (renders L1). `?columns=true` already wired in L1.

**Env vars / gates.** None. Empty column data → honest empty affordance ("No
column-level lineage captured yet" with a Fix-it linking L2/L3 setup), never a red
error on a clean node (ux-baseline first-open-clean).

**Acceptance.**
- G1 (BLOCKING): full in-browser E2E — open Unified Catalog → Lineage on a real
  asset, expand a table, see real column nodes + edges, run impact analysis on a
  column and confirm the downstream column chain highlights. Dark + light
  screenshots; narrow-width badge-overlap pass; first-open-clean pass on a fresh
  item. Receipt in PR.
- Parity doc `docs/fiab/parity/lineage.md` shows zero ❌ vs the Databricks column
  lineage graph.
- G3: canvas height/width resizable via `SplitPane`/`ResizableCanvasRegion` with
  persisted `sizingKey` (already present — verify column mode inherits it).

**Per-cloud.** Cloud-agnostic (renders merged model). Commercial + Gov identical.
IL5: design-doc.

---

## L6 — dbt manifest lineage (model + column) — greenfield

**Goal.** Parse the dbt-compiled `target/manifest.json` after a dbt run and derive
model→model + column lineage into the L1 model. (No manifest parsing exists
today; lineage is currently hand-authored via `ref()`.)

**Exact files.**
- New `apps/fiab-console/lib/dbt/dbt-manifest-lineage.ts` — pure parser: read
  `manifest.json` `nodes[]` (`depends_on.nodes`, `columns`) + `child_map` → emit
  `RecordEdgeInput[]` with table-grain edges and, where `manifest` carries
  column-level info (dbt 1.6+ `nodes[].columns` + `catalog.json` join), column
  mappings. Handles `ref()`/`source()` resolution to physical relations.
- `apps/fiab-console/lib/dbt/dbt-runner.ts` — after `runDbtOnDatabricks` /
  `runDbtOnRunner` (`:116`/`:192`) complete, fetch the run's `target/manifest.json`
  artifact and call the parser → `recordThreadEdge`.
- Tests: `apps/fiab-console/lib/dbt/__tests__/dbt-manifest-lineage.test.ts` (a
  real small manifest fixture → expected edges).

**Backend/infra.** None new — reuses the `loom-dbt-runner` Container App
(`modules/integration/dbt-runner.bicep`) which already runs dbt and can surface
`target/` artifacts. `LOOM_DBT_RUNNER_URL` gate already exists.

**Env vars / gates.** None new (reuses `svc-dbt-runner` / `LOOM_DBT_RUNNER_URL`).

**Acceptance.**
- A seeded dbt project run produces manifest-derived edges in `thread-edges`,
  visible on the lineage canvas (L5) with real model DAG + columns.
- Unit: fixture manifest → deterministic edges; `ref()` cycles handled.
- G1: lineage tab shows the dbt DAG merged with warehouse lineage on real data.

**Per-cloud.** Commercial: live. Gov: live (dbt runner Container App runs
in-VNet; on Gov the runner targets Synapse/OSS-UC per `uc-backend`). IL5:
design-doc.

## L7 — Rebase Databricks UC column lineage onto L1 + Gov OSS honest-gate

**Goal.** Fold the existing UC-only column path into the shared L1 model, promote
it to default (drop the `?columns=true`-only gating where a warehouse id is
configured), and add the honest Gov OSS-UC gate.

**Exact files.**
- `apps/fiab-console/lib/azure/unified-lineage.ts` — replace the inline UC column
  synthesis (`:451-468`) with the shared `synthesizeColumnGraph` from L1 (UC now
  one of N column sources).
- `apps/fiab-console/lib/azure/unity-catalog-client.ts` — `getColumnLineageSystemTables`
  (`:1032`) unchanged; ensure its output maps to L1 `columnMappings`.
- `apps/fiab-console/lib/azure/uc-backend.ts` — `ossUcUnsupportedPath` (`:119`)
  already gates `/lineage-tracking/` on OSS; ensure the honest-gate message
  points at the Loom-native unified column lineage (L1/L2/L3) as the OSS/Gov
  equivalent (`UC_CAPABILITIES.lineage` note).
- Tests: extend `unified-lineage.test.ts` (UC column edges merge with Weave/Purview
  column edges on the same `col:` identity).

**Backend/infra.** None. `LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID` already exists.

**Env vars / gates.** No new var. On Gov OSS-UC, `system.access.column_lineage` is
absent → honest gate delegating to Loom unified column lineage (default-ON, no
red state).

**Acceptance.**
- Commercial with Databricks: UC column edges appear via the shared path; no
  regression vs today.
- Gov OSS-UC: UC column path honestly gated; Loom-native column lineage (Spark/
  dbt/ADF) fills the same surface. G1 receipt on both.

**Per-cloud.** Commercial: live (Databricks). Gov: live (OSS-UC honest-gate +
Loom-native columns). IL5: design-doc.

---

# WORKSTREAM A — ANALYST-SURFACE DEPTH

Three sub-tracks: **DAX depth (A1–A5)**, **report visuals depth (A6–A9)**,
**Spark reliability (A10–A13)**.

## Sub-track: Semantic model / DAX depth

Dependency spine: **A1 → A2 → A3**; A4 (AAS) and A5 (golden harness) are parallel
to A2/A3.

### A1 — Real DAX→SQL fold engine (replace the 3-regex translator)

**Goal.** Replace `translateDaxToSql`'s 3 hard-coded regexes with a proper
tokenizer + AST + SQL-fold planner in `tabular-model.ts`, so arbitrary supported
DAX folds to Synapse serverless SQL on the Azure-native default backend. This is
the foundation A2/A3 extend.

**Exact files.**
- `apps/fiab-console/lib/azure/tabular-model.ts` — new `parseDax(text)` (tokenizer
  + Pratt parser → AST) and `foldAstToSql(ast, model)` replacing `translateDaxToSql`
  (`:171-191`). Support the query skeleton first: `EVALUATE`, `DEFINE` +
  `VAR`/`RETURN` + `MEASURE`, table expressions, and measure-reference resolution
  (measure → its stored expression → inline). Unknown/unfoldable nodes → the same
  `unsupportedDaxError()` (never fabricate a result).
- `apps/fiab-console/lib/azure/tabular-eval-client.ts` — `evalDax` (`:205-230`)
  unchanged externally; it just calls the new planner. Result cache
  (`buildQueryCacheKey`) unchanged.
- New `apps/fiab-console/lib/azure/__tests__/dax-parser.test.ts` — AST + fold unit
  tests; keep the existing `tabular-eval-client.test.ts` boundary assertions but
  update the "returns null" cases that A2/A3 now support.

**Backend/infra.** None — folds to existing Synapse serverless (`executeQuery`).
Reuses the accel/result-cache orchestrator on the report path.

**Env vars / gates.** None. Default-ON; no backend change.

**Acceptance.**
- All existing golden assertions in `tabular-eval-client.test.ts` still pass
  (EVALUATE/TOPN/ROW/CALCULATE + SUM/COUNT/AVERAGE/MIN/MAX).
- New: `EVALUATE SUMMARIZECOLUMNS(...)` and a `DEFINE MEASURE ... EVALUATE ROW(...)`
  fold to correct SQL (moved from the "null" boundary).
- Golden numeric parity: results match a Power BI reference on the seeded
  Sales/Date model (A5 harness).
- G1: DAX query view (`dax-query-view.tsx`) runs a previously-unsupported query on
  real data on the native backend; receipt in PR.

**Per-cloud.** Cloud-agnostic (Synapse serverless everywhere). Commercial + Gov +
IL5 identical logic (IL5 design-doc only).

### A2 — DAX coverage batch 1: filter-context + aggregation (~10 functions)

**Goal.** Fold the highest-value non-time functions the UI already emits but the
engine rejects today.

**Functions (10).** `SUMMARIZECOLUMNS` (→ GROUP BY), `COUNTROWS` (→ COUNT(*)),
`DISTINCTCOUNT` (→ COUNT(DISTINCT)), `COUNTA` (→ COUNT(col)), `DISTINCT`/`VALUES`
(→ SELECT DISTINCT), `FILTER` (→ WHERE), `CALCULATETABLE` (→ subquery + filter),
`ALL`/`ALLEXCEPT` (→ drop filter predicates), `RELATED` (→ join via model
relationship), `ADDCOLUMNS` (→ projected expressions).

**Exact files.** `tabular-model.ts` (fold rules per function, using the model's
`relationships` for `RELATED`), `dax-parser.test.ts` (per-function golden),
`tabular-eval-client.test.ts` (flip the `FILTER`/`SUMMARIZECOLUMNS` boundary
cases to pass).

**Backend/infra / env / gates.** None.

**Acceptance.** Each function has a golden test asserting SQL + numeric result on
seeded data; `dax-query-view` quick-queries (`table-preview`/`row-count`/
`column-distinct`/`column-summary`) that emit these now **execute on the native
backend** (they currently only run on AAS). G1 receipt: run each quick-query in
the browser on real data.

**Per-cloud.** Cloud-agnostic. IL5 design-doc.

### A3 — DAX coverage batch 2: time-intelligence + iterators (~10 functions)

**Goal.** Fold time-intelligence and iterator functions — the analyst-defining
DAX tier — to SQL over a Date-table relationship.

**Functions (10).** Time-intelligence: `TOTALYTD`, `DATESYTD`,
`SAMEPERIODLASTYEAR`, `DATEADD`, `DATESINPERIOD`, `PREVIOUSMONTH`/`PREVIOUSYEAR`,
`ENDOFMONTH`/`STARTOFMONTH`, `DATESBETWEEN`. Iterators: `SUMX`, `AVERAGEX`,
`COUNTX`, `MINX`/`MAXX` (→ aggregate over a per-row projected expression),
`RANKX` (→ window `RANK() OVER`).

**Exact files.** `tabular-model.ts` (date-fold rules using the model's marked
Date table + window functions), `dax-parser.test.ts`, a seeded multi-year Date
dimension in the golden fixture (A5).

**Backend/infra / env / gates.** None. Requires a Date-table relationship in the
model; absent → honest `unsupportedDaxError()` naming the missing Date table
(never a wrong number).

**Acceptance.** Golden numeric parity vs Power BI reference for YTD / SPLY /
moving-window measures on seeded multi-year data. G1: author a YTD measure in the
Measures tab, run it in DAX query view on real data, correct result. This
completes the ~20-function target across A2+A3.

**Per-cloud.** Cloud-agnostic. IL5 design-doc.

### A4 — Optional AAS backend parity + Gov enablement revisit

**Goal.** Keep AAS as the opt-in high-fidelity backend for DAX beyond the SQL-
foldable set, decide fold-vs-route per expression, and **revisit the Gov block**
(AAS is GA in Gov).

**Exact files.**
- `apps/fiab-console/lib/azure/tabular-model.ts` — `resolveBackend` (`:75-94`):
  keep loom-native default; when a DAX expr is unfoldable **and**
  `LOOM_SEMANTIC_BACKEND=analysis-services` + `LOOM_AAS_SERVER` set, route to AAS
  instead of erroring (graceful fold→AAS fallback).
- `apps/fiab-console/lib/azure/aas-client.ts` — `aasConfigGate`/`aasAvailabilityGate`
  (`:448-475`/`:1079-1094`): gate on `.asazure.usgovcloudapi.net` in Gov rather
  than a blanket `isGovCloud() → unavailable`. **Cite the Gov roadmap** (AAS GA in
  FedRAMP High/IL4/IL5) in the code comment + parity doc. Still opt-in; loom-
  native remains default.
- Tests: `tabular-eval-client.test.ts` (gov no longer forces `unavailable` when
  a gov AAS server is set; still defaults to loom-native when unset).

**Backend/infra.** Optional AAS server (opt-in). No default-path change.

**Env vars / gates.** Existing `svc-aas` gate; add `.us` endpoint validation.
Optional `LOOM_AAS_XMLA_ENDPOINT` gov variant hint in `VALUE_HINT`.

**Acceptance.** Unfoldable DAX (e.g. complex `EARLIER`/`PATH`) routes to AAS when
configured and returns real rows; when AAS unset, the honest
`unsupportedDaxError()` still fires (no fabrication). Gov: with a gov AAS server,
DAX executes; screenshot in PR. Default (no AAS) unchanged.

**Per-cloud.** Commercial: live opt-in. Gov: live opt-in (AAS GA in Gov —
corrects prior "not in Gov" assumption). IL5: design-doc (AAS GA at IL5 per
roadmap; documented, not run).

### A5 — DAX golden-result test harness + seeded reference data

**Goal.** A dedicated golden suite that asserts each supported DAX function's
**numeric result** matches a Power BI reference, over seeded warehouse data — the
G1-grade correctness gate for A1–A4.

**Exact files.**
- New `apps/fiab-console/lib/azure/__tests__/dax-golden/` — fixtures: a seeded
  Sales/Date/Customer star schema (CSV → Delta/serverless) + a
  `expected-results.json` captured from Power BI Desktop for each function.
- New `scripts/csa-loom/seed-dax-golden.sh` — provisions the seeded tables in the
  live Synapse serverless DB used by the loom-ui-verify project (CI-gated live
  test), so goldens run against a **real backend** (not a mock).
- CI wiring: a `dax-golden` vitest project that runs against the minted-session
  live env (mirrors `loom-ui-verify`).

**Backend/infra.** Reuses Synapse serverless + the UAT harness env. No new
resource.

**Env vars / gates.** None (test infra).

**Acceptance.** Every function in A1–A3 has a golden row; the suite is green in CI
against real Synapse serverless; a deliberate wrong-fold fails the suite (proves
it's real). Receipt: CI run link + the `expected-results.json` provenance note.

**Per-cloud.** Commercial live (CI). Gov: goldens re-run in the Gov UAT harness.
IL5: design-doc.

## Sub-track: Report visuals depth

The designer already ships 25 visuals + conditional formatting + cross-filtering.
These items close **depth/parity gaps**, not new galleries.

### A6 — Small multiples (trellis) rendering completion

**Goal.** Wire the existing "Small multiples" format-pane section
(`format-pane.tsx:1084`) to real trellis rendering across cartesian visuals — it's
a format section today without a renderer (vaporware risk).

**Exact files.** `lib/components/charts/loom-chart.tsx` (trellis layout wrapper:
facet by the small-multiples field well, N×M grid of mini-charts sharing axes),
`lib/editors/report-designer/visual-body.tsx` (pass the facet well),
`lib/editors/report/format-pane.tsx` (grid rows/cols, shared-axis toggle).

**Backend/infra / env / gates.** None (client render over the same query — add a
facet column to the wells→SQL GROUP BY).

**Acceptance.** A column/line/bar visual with a small-multiples field renders a
real faceted grid bound to real data; format-pane grid controls work. G1: browser
walk, dark+light screenshots, narrow-width pass. Parity doc row flips ✅.

**Per-cloud.** Cloud-agnostic. IL5 design-doc.

### A7 — Analytics-pane depth: reference/statistical lines + anomaly band

**Goal.** Extend the analytics pane (`analytics-pane.tsx`, today reference/trend +
forecast) with the full Power BI line set: constant, min, max, average, median,
percentile lines, error bars, and an anomaly-detection band — across cartesian
visuals, real data.

**Exact files.** `lib/editors/report/analytics-pane.tsx` (new line types + config
UI), `lib/components/charts/loom-chart.tsx` (render overlays;
`CARTESIAN_VISUAL_TYPES`), the analytics compute (percentile/median/anomaly over
the visual's result set — server-side in the query route or client over returned
rows).

**Backend/infra / env / gates.** None new.

**Acceptance.** Each line type computes from real data and renders; anomaly band
flags real outliers on seeded series. G1 receipt + screenshots. Parity doc rows ✅.

**Per-cloud.** Cloud-agnostic. IL5 design-doc.

### A8 — Map hardening + Gov honest-gate + basemap-free choropleth fallback

**Goal.** The map visual uses Azure Maps (`map-visual.tsx` + map-token route).
**Azure Maps is unavailable in GCC/Gov** (project memory) — today that is a
silent gap. Add an honest Gov gate **and** a basemap-free filled-shape
(choropleth over GeoJSON) fallback so maps still render in Gov (`no-vaporware`,
`no-fabric-dependency` parity-on-Azure).

**Exact files.** `lib/editors/report/map-visual.tsx` (choropleth renderer over
bundled GeoJSON — states/countries — when Azure Maps unavailable),
`app/api/items/report/[id]/map-token/route.ts` (honest gate when the Maps env
unset / Gov), `lib/gates/registry.ts` (`svc-azure-maps` Fix-it already in the gate
registry per memory — ensure the map visual surfaces it).

**Backend/infra.** Azure Maps (Commercial). Gov: no Azure Maps → GeoJSON
choropleth (client-only, no external tiles). Bundled GeoJSON asset.

**Env vars / gates.** Existing `svc-azure-maps` gate (Fix-it env-picker); on Gov
the gate resolves to "unavailable in this cloud — using shape-map fallback"
(honest, not red).

**Acceptance.** Commercial: full Azure Maps bubble/filled map on real data. Gov:
choropleth fallback renders real per-region values with no external tile calls
(no `atlas.microsoft.com` hit on the Gov path). G1 both clouds; screenshots.

**Per-cloud.** Commercial: live Azure Maps. Gov: live choropleth fallback (Azure
Maps GCC-unavailable — honest-gated). IL5: design-doc (fallback only).

### A9 — Drill-through pages + cross-visual interaction/conditional-format parity

**Goal.** Complete the interaction model: drill-through pages (right-click →
drill-through with carried filters), drill-down on matrix/hierarchies, and extend
conditional formatting (backgrounds, font color, icons, data bars) to matrix +
table cells uniformly.

**Exact files.** `lib/editors/report/interactions.tsx` (drill-through target
pages + filter carry), `lib/editors/report/drillthrough-pane.tsx` (new),
`lib/editors/report-designer/visual-body.tsx` (matrix/table drill + CF painters),
`lib/editors/report/conditional-format.tsx` (ensure `applyConditionalFormat` /
`cellStyleFor` cover matrix + all cell types).

**Backend/infra / env / gates.** None new (filters fold into the existing query
route).

**Acceptance.** Right-click drill-through navigates to a target page with the
source filter applied on real data; matrix drill-down expands real hierarchy
levels; conditional formatting renders on matrix/table cells. G1 receipt; parity
doc `docs/fiab/parity/report.md` shows zero ❌ vs Power BI interactions.

**Per-cloud.** Cloud-agnostic. IL5 design-doc.

## Sub-track: Spark reliability hardening

Builds on the existing reaper/circuit-breaker/lease-store/keep-warm stack.

### A10 — Spark pool health telemetry + admin dashboard page

**Goal.** Close the biggest observability gap: warm/leased/warming counts,
circuit-breaker state, reaper activity, and pool `provisioningState` are **API-
only** today — build the operator dashboard.

**Exact files.** New `apps/fiab-console/app/admin/spark-pools/page.tsx` (or a tab
on `app/admin/capacity/page.tsx` next to `SparkTelemetryAuditPanel`); new
`app/api/admin/spark/health/route.ts` aggregating `getPoolStatus()`
(`spark-session-pool.ts:1442`) + Synapse pool `provisioningState`
(`synapse-dev-client.ts`) + reaper counters; a `SparkPoolHealthPanel` component
(TileGrid + status cards per `web3-ui`).

**Backend/infra.** None new — reads existing state.

**Env vars / gates.** None (tenant-admin gated route).

**Acceptance.** Dashboard shows live warm/leased/warming/circuit-breaker/
provisioningState from a real pool; prove-warm probe surfaced. G1: browser walk,
dark+light, real data. ux-baseline §7 checklist checked.

**Per-cloud.** Commercial + Gov: live. IL5: design-doc.

### A11 — FAULTED-pool detection + auto-recovery runbook

**Goal.** Detect `provisioningState==='Failed'`/faulted Spark pools (the "Succeeded
but can't launch" + FAULTED incidents) and auto delete+recreate via ARM with
exponential backoff + admin notification.

**Exact files.** New `apps/fiab-console/lib/azure/spark-pool-recovery.ts`
(poll → detect FAULTED → `deleteSparkPool` + `createSparkPool` via
`synapse-dev-client.ts` with backoff + a self-heal guard against thrash); wire
into the keep-warm heartbeat (`/api/internal/spark/keep-warm`) and the A10
dashboard (manual "Recreate pool" action + auto toggle); notification via the
existing notifications container. New `scripts/csa-loom/recreate-spark-pool.sh`
runbook (the missing drain/recreate script).

**Backend/infra.** ARM Spark pool CRUD (existing client). No new resource.

**Env vars / gates.** `LOOM_SPARK_AUTORECOVER` (default-ON per
`loom-default-on-opt-out`; opt-out env), `LOOM_SPARK_RECOVER_MAX_ATTEMPTS`.
ENV_CHECKS `optional`, `optionalDefault:true`.

**Acceptance.** A deliberately faulted pool (chaos action from A13) is detected
and recreated automatically; admins notified; no thrash loop (backoff verified).
G1: dashboard shows the detect→recreate→healthy transition on a real pool.

**Per-cloud.** Commercial + Gov: live (Synapse GA in Gov). IL5: design-doc.

### A12 — Session quota / lease hygiene + vCore-budget ceiling

**Goal.** Enforce server-side the limits that the #1889/#1796 incidents exposed:
max-idle, per-tenant session quota, and a **vCore-budget ceiling** against the
Synapse workspace quota (leaked sessions holding executors was the root cause).

**Exact files.** `apps/fiab-console/lib/azure/spark-session-pool.ts` (per-tenant
active-session cap + a vCore accounting guard before `warmPool`/lease grant that
refuses to exceed `LOOM_SPARK_VCORE_BUDGET`), `spark-lease-store.ts` (cross-
replica vCore tally), max-idle already enforced (`LOOM_SPARK_POOL_IDLE_TTL`) —
extend to hard-kill on breach.

**Backend/infra.** None new.

**Env vars / gates.** `LOOM_SPARK_VCORE_BUDGET`, `LOOM_SPARK_TENANT_SESSION_MAX`
(both with safe defaults; opt-out/tunable). ENV_CHECKS `optional`.

**Acceptance.** Exceeding the per-tenant cap returns an honest "session quota
reached" MessageBar (not a hang); vCore budget prevents over-allocation against a
real workspace quota. Unit + a live test acquiring past the cap. G1 on the
notebook/session surface.

**Per-cloud.** Commercial + Gov: live. IL5: design-doc.

### A13 — Chaos-drill harness + durable-cron sweeper

**Goal.** Prove recovery: a chaos action that kills sessions mid-run and asserts
reaper + warm-pool + A11 recovery; and move the sweeper off the unreliable in-
process `setInterval` onto the durable external cron.

**Exact files.** New `app/api/admin/spark/chaos/route.ts` (tenant-admin: inject
faults — kill N sessions, mark a pool faulted) + a Playwright/vitest drill in
`loom-ui-verify` asserting recovery; confirm `/api/internal/spark/keep-warm` is
the sole sweeper driver on ACA (document + a GitHub Actions `schedule:` or ACA
cron job wiring the tick, per the existing scheduler-tick pattern).

**Backend/infra.** Reuses keep-warm route; add the cron wiring (Actions workflow
or ACA cron job) — no new Azure resource beyond the schedule.

**Env vars / gates.** `LOOM_INTERNAL_TOKEN` (exists). Chaos route gated to admin +
a `LOOM_SPARK_CHAOS_ENABLED` safety flag (default off in prod).

**Acceptance.** Drill kills sessions mid-notebook-run; the harness asserts the
run recovers (warm pool refills, reaper cleans zombies, faulted pool recreates).
Receipt: drill output + the recovery timeline. Sweeper proven to run on the
external cron (not setInterval) via a log receipt.

**Per-cloud.** Commercial + Gov: live drill in each UAT harness. IL5: design-doc.

---

## Cross-workstream notes

- **Bicep-sync (per `no-vaporware`).** New modules:
  `admin-plane/lineage-extractor-function.bicep` (L3); edits to
  `landing-zone/synapse-spark-pools.bicep` (L2 Spark config + library). New
  `apps[]` env in `admin-plane/main.bicep`: `LOOM_OPENLINEAGE_INGEST_TOKEN`
  (secretRef), `LOOM_OPENLINEAGE_ENDPOINT`, `LOOM_SPARK_VCORE_BUDGET`,
  `LOOM_SPARK_TENANT_SESSION_MAX`, `LOOM_SPARK_AUTORECOVER` — each a computed
  `eff*` var with an honest-gate `''` default.
- **Gate registry (per G2).** Every new gate (`svc-openlineage`, optional
  `svc-lineage-extractor`, Spark tunables) lands in `ENV_CHECKS` **and**
  `GATE_META` together (registry test enforces parity) with an inline **Fix-it**
  (`kind:'wizard'` for OpenLineage pool setup, `env-picker` for tunables) and an
  Admin gate-page row.
- **Default-ON (per `loom-default-on-opt-out`).** Column lineage renders from
  whatever sources are configured with **no day-one gate**; DAX A1–A3 folds run on
  the default native backend with no opt-in; Spark auto-recovery is opt-out.
  Fabric/AAS/Purview remain strictly opt-in alternatives, never required.
- **Verification (per `no-scaffold`/G1).** Every UI item (L5, A6–A10) ships a
  browser E2E receipt (real data, dark+light, narrow-width, first-open-clean) and,
  for 1:1 surfaces, a `docs/fiab/parity/<slug>.md` with zero ❌. DOM strings are
  not parity.
