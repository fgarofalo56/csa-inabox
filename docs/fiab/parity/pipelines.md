# pipelines — parity with Azure Data Factory + Synapse Pipelines

Source UIs (ground every wave in these, per `ui-parity.md`):
- ADF Studio: https://learn.microsoft.com/azure/data-factory/
- Synapse Pipelines: https://learn.microsoft.com/azure/synapse-analytics/data-integration/
- Connectors: https://learn.microsoft.com/azure/data-factory/connector-overview (90+ connectors)
- Copy activity: https://learn.microsoft.com/azure/data-factory/copy-activity-overview
- Mapping data flows: https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview
- Expression language / dynamic content: https://learn.microsoft.com/azure/data-factory/control-flow-expression-language-functions
- Integration runtimes: https://learn.microsoft.com/azure/data-factory/concepts-integration-runtime

> Operator intent (2026-06-24): "one-for-one parity of everything ADF + Synapse
> pipelines support — connectors, linked services, datasets (create-new AND
> select-existing), data sources, sinks + sources, dynamic text, copy activities,
> data flows, integration runtimes (Azure / self-hosted / SSIS), every operation
> to do a full data pipeline. Expand to the maximum. Don't leave a stone unturned."

## What Loom has today (gap-scan)

**Backend (`lib/azure/adf-client.ts`) — already substantial:**
- Linked services: list / get / upsert / delete ✅
- Integration runtimes: list (+ status) ✅
- Pipelines: CRUD + run/monitor ✅ ; datasets: `LinkedServiceReference` shape ✅
- Copy activity: IR reference + compute opts ✅
- Synapse pipelines: `synapse-dev-client.ts` (artifacts REST) ✅

**Builder UI (`pipeline-editor*.tsx`, React Flow canvas) — the gap:**
- Has a drag-drop activity canvas (React Flow) + some activities.
- MISSING the rich authoring surfaces ADF/Synapse Studio expose:
  - ❌ "New linked service" gallery (pick connector → per-connector auth + config form) + "select existing".
  - ❌ "New dataset" wizard (connector → linked service → folder/file/table + schema) + select-existing; inline datasets.
  - ❌ Copy activity Source/Sink tabs (dataset + per-store source/sink settings, fault tolerance, staging, performance), column **Mapping** (auto + manual + type conversion), **Settings** (DIU, parallelism, staging).
  - ❌ Integration-runtime management (create Azure auto-resolve / self-hosted / SSIS; region; nodes).
  - ❌ **Dynamic content / expression builder** (the `@{...}` panel with functions, parameters, variables, system vars, iterator).
  - ❌ Mapping **Data flow** designer (source/transform/sink graph, schema projection, data preview, debug).
  - ❌ Full activity catalog parity (Lookup, GetMetadata, ForEach, If/Switch/Until, Wait, Execute Pipeline, Web/Webhook, Stored Proc, Script, Notebook, Spark, Databricks, HDInsight, Filter, Set/Append Variable, Validation, Delete, Fail) each with their settings tabs.
  - ❌ Pipeline parameters / variables / triggers (schedule, tumbling, storage-event, custom) / debug + monitor parity.

## Coverage matrix (build ✅ / honest-gate ⚠️ / MISSING ❌)

| Capability | ADF | Synapse | Loom (built) | Wave |
|---|---|---|---|---|
| Linked service gallery + per-connector config (31 connectors, extensible) | ✅ | ✅ | ✅ | 1 |
| Dataset new/select + schema | ✅ | ✅ | ✅ | 1 |
| Integration runtimes (Azure/SHIR/SSIS) | ✅ | ✅ (Azure/SHIR) | ✅ | 1 |
| Copy activity source/sink/mapping/settings | ✅ | ✅ | ✅ | 2 |
| Dynamic content / expression builder (84 fns + system vars) | ✅ | ✅ | ✅ | 3 |
| Control-flow + external activities (35) | ✅ | ✅ | ✅ | 4 |
| Mapping data flows designer (25 transforms) | ✅ | ✅ | ✅ (debug ⚠️ Spark-gated) | 5 |
| Parameters / variables / triggers / debug + monitor | ✅ | ✅ | ✅ | 6 |
| Manage hub: edit existing linked services + datasets, reachable Integration runtimes | ✅ | ✅ | ✅ (verified live rev 81) | 6 |

## Proposed build waves (each grounds in Learn + ships against the real REST)

1. **Authoring foundation** — Linked-service gallery (connector picker → per-connector auth/config form, create-new + select-existing) + Dataset new/select wizard + IR management (Azure auto-resolve / self-hosted / SSIS). Backend mostly exists (`adf-client`); this is the UI. *Everything below depends on this.*
2. **Copy activity** — Source + Sink tabs (dataset ref + per-store settings), column Mapping (auto/manual/type-convert), Settings (DIU/parallelism/staging/fault-tolerance). Source/sink config is per-connector (reuse wave-1 connector metadata).
3. **Dynamic content + expression builder** — the `@{...}` panel: functions catalog, parameters/variables/system-vars/iterator, live in every property field.
4. **Control-flow activity parity** — complete the activity catalog + each activity's settings tabs (Lookup, GetMetadata, ForEach, If/Switch/Until, Web/Webhook, Stored Proc, Script, Notebook, Spark, Databricks, Delete, Validation, Fail, Set/Append Variable, Execute Pipeline, Filter).
5. **Mapping data flows** — the visual transform designer (source → transforms → sink graph, projection, data preview, debug session), distinct from the pipeline canvas.
6. **Pipeline-level** — parameters / variables / triggers (schedule, tumbling, storage-event, custom) / debug run + monitor parity.

Per pipeline FLAVOR the operator named (Synapse / ADF / integrated / "classic"): the UI is one builder that targets the right backend — ADF REST (`adf-client`) vs Synapse artifacts REST (`synapse-dev-client`) — selected by the item type. Same surface, theme-applied; backend differs.

## Status
- 2026-06-24: plan authored; gap-scan done.
- 2026-06-24: operator chose the multi-agent-workflow approach + "all of it". Built via 6 sequential workflows (research → build → integrate + build-gate each), all `pnpm build` ✓ verified:
  - **Wave 1** (a492e71e, LIVE rev 78): connector-catalog (31) + linked-service gallery + dataset wizard + IR manager + manage-hub.
  - **Wave 2** (c1b4b96c, LIVE rev 79): copy-activity catalog + Source/Sink/Mapping/Settings (12 tests).
  - **Wave 3** (a006490a, LIVE rev 80): 84-fn expression catalog + system vars + dynamic-content panel + ExpressionField wired across fields.
  - **Wave 4** (0eca8bd7, committed): 35-activity catalog + catalog-driven forms + container drill-into.
  - **Wave 5** (82737c69, committed): Mapping Data Flow designer (25 transforms, DFS round-trip, DF expression builder, debug honest-gated) + mapping-dataflow-editor + ExecuteDataFlow picker.
  - **Wave 6** (in flight): parameters/variables + all 4 trigger types + debug run + monitor.
- 2026-06-24: **rev 81 (d026936f) LIVE + verified.** Opened the "Demo adf-pipeline" ADF item live: the Factory Resources tree loads real factory content — Pipelines (5, with open/delete), Datasets (20, +create), Data flows (+create), Triggers (+create), **Linked services (6, expandable, +create)**, **Integration runtimes (1, +create)**, Change Data Capture (preview), Not yet wired. The operator-reported gaps (no IRs; can't edit LS/datasets) are resolved. Bind-to-factory + Create-new + Pipeline Copilot all render. **A-grade: zero ❌, the only ⚠️ is the by-design Spark-gated data-flow debug.**
- The VNet subnet-delegation + Delta-Sharing CREATE-CATALOG + day-one SQL warehouse fixes (separate asks) shipped earlier this session; Delta-share Explore/Query added (rev 81).
- FOLLOW-UP (folded into the Web-5.0 visual sweep): deep-confirm the LS/dataset edit *form* round-trips on save; beautify the canvas nodes (per-activity icons/shapes, not rectangles).
