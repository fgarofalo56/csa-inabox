# Report Builder → Power BI Desktop 100% Authoring Parity — Build Backlog

> Source: `loom-pbi-parity-research` workflow (10 agents, MS-Learn-grounded, 2026-06-26).
> Coverage across the 6 fully-parsed areas + partial canvas: **68 built / 27 honest-gate / 61 missing**.
> Azure-native per `no-fabric-dependency.md` (no Fabric capacity, no Power BI service, no on-prem gateway on the default path). Fabric/OneLake + Power BI semantic models are **opt-in only** (`LOOM_BI_BACKEND=fabric`).

## Key reuse findings (do NOT rebuild)
- `lib/pipeline/connector-catalog.ts` — **32 ConnectorDefs** (Azure/Database/File/NoSQL/protocol) + `CATEGORY_ORDER`. Drive the Get Data gallery from this.
- `lib/azure/connections-store.ts` + `connectable-types.ts` + `lib/components/connections/add-existing-wizard.tsx` — **KV-backed Connections store**. No new credential code.
- Existing data-plane clients: `azure-sql-client`, `kusto-client`, `cosmos-data-client`, `postgres-flex-client`, `databricks-client`, `adls-client`, `synapse-sql-client`, `spark-format-detect`, `delta-schema`.
- `lib/components/pipeline/dataflow/power-query-host.tsx` (Dataflow Gen2 PQ host) — reuse for the report Transform-Data layer (W4).

## Azure-native connector set to cover
Azure SQL DB, Azure SQL MI, Synapse serverless+dedicated, Azure Databricks/Delta, ADLS Gen2/Blob (CSV/Parquet/JSON/Delta), Azure Data Explorer/KQL, Cosmos DB, PostgreSQL/MySQL flexible servers, generic OData/REST/Web, file upload (Excel/CSV/JSON/Parquet/XML), OSS SQL Server/Postgres/MySQL.

## Intentionally OUT (with Azure-native substitute)
3rd-party SaaS needing proprietary gateways / cross-cloud / gov-disallowed: Salesforce, Dynamics 365 SaaS, SharePoint Online list, Google/Adobe Analytics, BigQuery, Snowflake-as-SaaS, SAP HANA/BW, Redshift/S3, Palantir, AppSource `.pbiviz` custom visuals, on-prem-gateway sources. Substitute: ingest via Synapse/ADF pipeline or Dataflow Gen2 → Delta in ADLS → report off the lakehouse; generic OData/REST/Web for HTTP APIs; OSS Vega-Lite/ECharts code-visual instead of `.pbiviz`.

## Doc defects to fix in-flight
`docs/fiab/parity/report-designer.md` over-claims the X/Y axis card and lists the AI visuals (decomposition/key-influencers/smart-narrative/Q&A) as MISSING though they exist.

---

## Waves (ordered by operator priority; report-designer.tsx owned by W5 ONLY)

### W1 (P0) — Get Data connector gallery + connection-backed report sources
- chunk-A (UI/types): NEW `lib/editors/report/get-data-gallery.tsx`; EDIT `data-source-picker.tsx` (mount gallery, bind to a `LoomConnection`, OneLake/Fabric as opt-in group); EDIT `report-data-source.ts` (4th union kind `{kind:'connection';connectionId;connType;objectRef}` + `file-upload`/`adls-file` kinds).
- chunk-B (resolver/query): EDIT `report-model-resolver.ts` (`backend:'connection'` dispatch); EDIT `wells-to-sql.ts` (per-engine dialect quoting/LIMIT); NEW `wells-to-kql.ts`; EDIT `fields/route.ts` (per-connType introspection); EDIT `query/route.ts` (per-source query).
- chunk-C (preview/persist/file): NEW `connector-preview/route.ts` (real TOP-N, honest 412); EDIT `data-source/route.ts` (persist connection/file sources); file-upload → ADLS → OPENROWSET view → scaffold semantic-model.
- **Gaps**: only 3 hard-coded source kinds; rich catalog+connections unused; no file-upload; no ADLS folder source; no Web/OData/REST.

### W2 (P0) — Connectivity & storage modes (Import/DirectQuery/Dual/Direct Lake) + fix Power-BI-only refresh
- NEW `storage-mode-pane.tsx`, `navigator-dialog.tsx`, `refresh-pane.tsx`; EDIT `report-model-resolver.ts` (per-table relation/cache), `wells-to-sql.ts` (cache vs live), `refresh/route.ts` (**fix no-fabric violation** → Azure-native re-materialize via `materialized-lake-view-engine`), `connector-catalog.ts` (directQueryCapable flag).
- Runs **after** W1 (shares resolver/wells).

### W3 (P0) — Data modeling (Model view): Azure-native RLS/OLS, What-if, Quick measures, Synonyms/Q&A, Mark-as-date-table, Assume-RI/Autodetect, calc-table dialog
- NEW `rls-compiler.ts` (DAX row-filter → Synapse/Azure SQL SECURITY POLICY + TVF; Databricks UC ROW FILTER/COLUMN MASK); EDIT semantic-model `roles/route.ts`; NEW what-if/quick-measure/synonyms/calc-table dialogs; EDIT `model-view-canvas.tsx`, `aas-tmsl.ts`, semantic-model `model/route.ts`.
- **P0 driver**: RLS/OLS currently only via AAS/PBI XMLA (no-fabric gate). Route new tabs through a sibling to avoid `phase3-editors.tsx` thrash.

### W4 (P1) — Power Query "Transform Data" in the report builder (reuse Dataflow Gen2 PQ host)
- NEW `transform-data.tsx`, `pq-transform-dialogs.tsx`, `data-profiling.tsx`, `manage-parameters.tsx`, profile/native-query routes; EDIT `m-script.ts`, `power-query-host.tsx`.
- **Gaps**: no Transform/Applied-Steps layer; RIBBON_TRANSFORMS (16) far short; no profiling; no folding indicators.

### W5 (P0) — Visual catalog + TRUE chart geometry — **OWNS report-designer.tsx**
- EDIT `report-designer.tsx` (gallery/VisualBody, remove APPROX_GEOMETRY), `loom-chart.tsx` (real stacked/100%/area/combo-dual-axis/ribbon/waterfall/funnel/treemap/gauge/KPI geometry + small-multiples + tooltip hover), `wells-to-sql.ts` (2nd GROUP BY); NEW `slicer-visual.tsx`, `map-visual.tsx` + `maps-client.ts` + `map-token/route.ts` + `azure-maps.bicep`; EDIT `analytics-pane.tsx` (anomaly), `report-designer.md` (fix doc).
- **~10 visuals render approximate geometry today** (real rows, wrong shape).

### W6 (P1) — Visual Format pane parity (X/Y axis card = biggest gap) — via NEW adapter, never report-designer.tsx
- EDIT `format-pane.tsx` (axis/title/search/labels/effects/legend/number-format cards); NEW `loom-chart-format.ts` adapter + `visual-chrome.tsx`; EDIT `conditional-format.tsx` (field-value/web-URL), `themes-pane.tsx`+`themes.ts` (text-classes/presets). After W5.

### W7 (P2) — Canvas elements (Text/Image/Shapes/Buttons/Page+Bookmark navigators) — client-only on free-form-canvas
- NEW `canvas-elements.tsx`; EDIT `free-form-canvas.tsx`, `use-canvas-layout.ts` (z-step). No backend.

### W8 (P2, PROVISIONAL) — Interactivity & analytics (drill/drillthrough/sync-slicers/tooltip-runtime/Q&A)
- Research input was truncated in synthesis — **pull full `areas[7]` from the output file before launch.** Files: EDIT `interactions.tsx`; NEW `drillthrough-pane.tsx`, `sync-slicers-pane.tsx`, `tooltip-runtime.tsx`.

### W9 (P2, PROVISIONAL) — Publish/export/enterprise (PDF/PPTX/PNG/CSV, subscriptions, MIP labels, paginated+scorecard visuals)
- Research input truncated — **pull full `areas[8]` before launch.** Power BI service publish stays opt-in. Files: EDIT `export-report.tsx`; NEW `paginated-visual.tsx`, `metrics-scorecard-visual.tsx`, `subscriptions-pane.tsx`.

---
## Sequencing
W1 ∥ (Wave-4 script-visual) [no file overlap] → W2 → W3 → W4 → **W5 (after script-visual releases report-designer.tsx)** → W6 → W7 → W8 → W9.
Each wave: chunk-3 per-file build → adversarial verify → build-gate (`grep '✓ Compiled successfully'`, NOT pnpm exit) → roll (`bash temp/roll-acrbuild.sh <sha>`) → live E2E verify.
Full research output: `tasks/w3dl6rvve.output` (areas[] has the per-area inventories incl. the truncated 7,8).
