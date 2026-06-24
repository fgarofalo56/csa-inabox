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

## Coverage matrix (build ✅ / honest-gate ⚠️ / MISSING ❌) — to be filled per wave

| Capability | ADF | Synapse | Loom today | Target |
|---|---|---|---|---|
| Linked service gallery + per-connector config | ✅ | ✅ | ❌ | ✅ |
| Dataset new/select + schema | ✅ | ✅ | ❌ | ✅ |
| Integration runtimes (Azure/SHIR/SSIS) | ✅ | ✅ (Azure/SHIR) | partial | ✅ |
| Copy activity source/sink/mapping/settings | ✅ | ✅ | ❌ | ✅ |
| Dynamic content / expression builder | ✅ | ✅ | ❌ | ✅ |
| Mapping data flows designer | ✅ | ✅ | ❌ | ✅ |
| Control-flow activities (full set) | ✅ | ✅ | partial | ✅ |
| Parameters / variables / triggers / debug | ✅ | ✅ | partial | ✅ |

## Proposed build waves (each grounds in Learn + ships against the real REST)

1. **Authoring foundation** — Linked-service gallery (connector picker → per-connector auth/config form, create-new + select-existing) + Dataset new/select wizard + IR management (Azure auto-resolve / self-hosted / SSIS). Backend mostly exists (`adf-client`); this is the UI. *Everything below depends on this.*
2. **Copy activity** — Source + Sink tabs (dataset ref + per-store settings), column Mapping (auto/manual/type-convert), Settings (DIU/parallelism/staging/fault-tolerance). Source/sink config is per-connector (reuse wave-1 connector metadata).
3. **Dynamic content + expression builder** — the `@{...}` panel: functions catalog, parameters/variables/system-vars/iterator, live in every property field.
4. **Control-flow activity parity** — complete the activity catalog + each activity's settings tabs (Lookup, GetMetadata, ForEach, If/Switch/Until, Web/Webhook, Stored Proc, Script, Notebook, Spark, Databricks, Delete, Validation, Fail, Set/Append Variable, Execute Pipeline, Filter).
5. **Mapping data flows** — the visual transform designer (source → transforms → sink graph, projection, data preview, debug session), distinct from the pipeline canvas.
6. **Pipeline-level** — parameters / variables / triggers (schedule, tumbling, storage-event, custom) / debug run + monitor parity.

Per pipeline FLAVOR the operator named (Synapse / ADF / integrated / "classic"): the UI is one builder that targets the right backend — ADF REST (`adf-client`) vs Synapse artifacts REST (`synapse-dev-client`) — selected by the item type. Same surface, theme-applied; backend differs.

## Status
- 2026-06-24: plan authored; gap-scan done. **Awaiting operator decision on build approach (multi-agent workflow vs wave-by-wave) + first wave** before executing. The VNet subnet-delegation fix (separate ask) is shipped.
