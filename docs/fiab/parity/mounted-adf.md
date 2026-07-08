# mounted-adf — parity with a mounted/attached Azure Data Factory (Fabric "Mounted Data Factory")

Source UI: **Fabric Mounted Data Factory** — attach an existing Azure Data
Factory and run its pipelines from Fabric
(<https://learn.microsoft.com/fabric/data-factory/mounted-data-factory>) — plus
the **Azure Data Factory Studio** authoring surface it references
(<https://adf.azure.com>, <https://learn.microsoft.com/azure/data-factory/author-visually>).
Mapping data flows: <https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview>.

A Mounted Data Factory is a **read-only attachment** of an existing ADF. The
Fabric surface is deliberately thin: reference the factory, list its pipelines,
trigger them, and watch the runs — the authoring of the factory itself still
happens in ADF Studio. Loom implements the read-only attachment **and** layers a
real Mapping Data Flow designer over the deployment-default factory. Backend is
100% Azure-native ARM (`Microsoft.DataFactory/factories`, api-version
`2018-06-01`); no Microsoft Fabric dependency (`no-fabric-dependency.md`).

Editor: `apps/fiab-console/lib/editors/mounted-adf-editor.tsx` (tabs: Pipelines ·
Triggers · Runs · Data flows · Settings).

## Azure/Fabric feature inventory

1. **Reference an existing factory** by (subscriptionId, resourceGroup, factoryName).
2. **List the factory's pipelines** and read their definitions.
3. **Trigger a pipeline run** (with parameters) on the referenced factory.
4. **List triggers** and their runtime state.
5. **Monitor pipeline runs** (status, start, duration, error message).
6. **Author Mapping Data Flows** (source → transforms → sink graph) — the ADF Studio Author capability.
7. **Pick source/sink datasets** for the data-flow graph.
8. **Delete / unmount** the attachment.
9. (ADF Studio, broader) Trigger management create/start/stop, Copy Data Tool wizard, expression builder, connector galleries + Test Connection, source control / Publish, factory-wide Monitor hub.

## Loom coverage    (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Reference existing factory | ✅ | "New mount" dialog captures sub/rg/factory; persisted to Cosmos item state. |
| 2 | List pipelines | ✅ | Pipelines tab lists real pipelines from the referenced factory. |
| 3 | Trigger a run (with params) | ✅ | Per-pipeline **Run** button → cross-factory `createRun`; run id surfaced. |
| 4 | List triggers | ✅ | Triggers tab shows name / type / runtime state. |
| 5 | Monitor runs | ✅ | Runs tab shows status / start / duration / message; partial-load MessageBar if some queries fail. |
| 6 | Mapping Data Flow designer | ✅ / ⚠️ | Real React-Flow source→transform→sink graph round-tripping Data Flow Script (see [`adf-mapping-data-flow.md`](./adf-mapping-data-flow.md)); ~7 of ~25 transforms, no visual expression builder, live preview honest-gated. |
| 7 | Source/sink dataset pickers | ✅ | Populated from `/api/adf/datasets`. |
| 8 | Delete / unmount | ✅ | Settings tab delete button. |
| 9 | Copy Data Tool, expression builder, connector galleries + Test Connection, source control/Publish, factory Monitor hub | ❌ | Out of scope for the mount surface; tracked under the broader [`adf-data-factory.md`](./adf-data-factory.md) Studio baseline. |

## Backend per control

- Mount CRUD + pipelines/triggers/runs/run → `/api/items/mounted-adf/**`
  (`route.ts`, `[id]/route.ts`, `[id]/run/route.ts`) via `adf-client`
  (`runMountedFactoryPipeline`, ARM `Microsoft.DataFactory/factories`
  api-version `2018-06-01`, cross-factory `createRun`).
- Mapping Data Flow CRUD (list/create/get/save/delete) → `/api/adf/dataflows/**`;
  dataset pickers → `/api/adf/datasets`.
- **Honest gates:** if the console UAMI lacks **Data Factory Contributor** on the
  referenced factory, the ARM 401/403 is surfaced verbatim in a MessageBar. The
  data-flow designer targets the env-pinned default factory
  (`LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` / `LOOM_ADF_NAME`) and shows a precise
  "Data Factory not configured" MessageBar naming those vars when unset — the
  full tab surface still renders (`no-vaporware.md`).
