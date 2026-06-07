# adf-hdinsight-activities — parity with ADF HDInsight pipeline activities (F17)

Source UI: ADF Studio → Author → Pipeline → Activities pane → **HDInsight** group
(Hive / Spark / MapReduce / Streaming).
Learn:
- https://learn.microsoft.com/azure/data-factory/transform-data-using-hadoop-hive
- https://learn.microsoft.com/azure/data-factory/transform-data-using-spark
- https://learn.microsoft.com/azure/data-factory/transform-data-using-hadoop-map-reduce
- https://learn.microsoft.com/azure/data-factory/transform-data-using-hadoop-streaming

Backend factory: `adf-loom-*` via ARM REST (`Microsoft.DataFactory/factories`,
api-version `2018-06-01`). All four activity types are **natively executed** by
ADF at this api-version — Loom emits the activity JSON into the pipeline spec
and the existing Save / Validate / Run / Debug toolbar (see `adf-pipeline.md`)
drives them with no per-type backend changes.

## No Fabric / no Power BI dependency

These are pure ADF + an operator-registered **Azure HDInsight** cluster. There
is no Fabric host, no Power BI workspace, and no `fabricWorkspaceId` read on any
path. The activities render and save fully with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset; the only gate is the honest Azure-side one below.

## Real ADF HDInsight activity inventory (grounded in Learn)

Each HDInsight activity carries a **top-level `linkedServiceName`** referencing
an `AzureHDInsight` linked service (the cluster), plus a `typeProperties` block.

| Activity | ADF `type` | Required typeProperties | Optional typeProperties |
| --- | --- | --- | --- |
| Hive | `HDInsightHive` | `scriptPath` | `scriptLinkedService`, `getDebugInfo`, `arguments`, `defines`, `queryTimeout` |
| Spark | `HDInsightSpark` | `rootPath`, `entryFilePath` | `sparkJobLinkedService`, `className`, `getDebugInfo`, `arguments`, `sparkConfig` |
| MapReduce | `HDInsightMapReduce` | `className`, `jarFilePath` | `jarLinkedService`, `getDebugInfo`, `arguments`, `defines`, `jarlibs` |
| Streaming | `HDInsightStreaming` | `mapper`, `reducer`, `filePaths`, `input`, `output` | `combiner`, `fileLinkedService`, `getDebugInfo`, `arguments`, `defines`, `commandEnvironment` |

## Loom coverage

| ADF capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| HDInsight group in the Activities palette | ✅ built — 4 catalog entries in the Orchestration group with distinct Fluent icons (`activity-catalog.ts`, `activity-icons.tsx`) | n/a (client) |
| Drag onto canvas → activity card | ✅ built — palette drag-drop reuses the shared `PipelineCanvas` | n/a (client) |
| **HDI Cluster** picker (top-level `linkedServiceName`) | ✅ built — `HDI_CLUSTER_FIELD` root-path text field; pre-filled from `LOOM_HDINSIGHT_LINKED_SERVICE` | round-trips `linkedServiceName` on `PUT .../pipelines/{name}` |
| Hive — script LS + script path + debug + queryTimeout + arguments | ✅ built — typed form (`HDInsightHive`) | `PUT .../pipelines/{name}` |
| Spark — job LS + rootPath + entryFilePath + className + debug + arguments | ✅ built — typed form (`HDInsightSpark`) | `PUT .../pipelines/{name}` |
| MapReduce — class + jar LS + jar path + debug + arguments | ✅ built — typed form (`HDInsightMapReduce`) | `PUT .../pipelines/{name}` |
| Streaming — mapper/reducer/combiner + file LS + filePaths + input/output + debug + arguments | ✅ built — typed form (`HDInsightStreaming`) | `PUT .../pipelines/{name}` |
| Advanced typeProperties (`defines`, `sparkConfig`, `jarlibs`, `commandEnvironment`) | ✅ built — round-trip via the raw typeProperties JSON accordion in `PropertiesPanel` Settings tab (template seeds `defines: {}`) | `PUT .../pipelines/{name}` |
| Save | ✅ built — shared toolbar | `PUT factories/{f}/pipelines/{name}` |
| Validate | ✅ built — shared toolbar | `POST factories/{f}/validatePipeline` |
| Run / Debug | ✅ built — shared toolbar | `POST .../pipelines/{name}/createRun` |
| No cluster linked service set | ⚠️ honest-gate — Fluent `MessageBar intent="warning"` naming `LOOM_HDINSIGHT_LINKED_SERVICE` + the Manage → Linked services step | n/a |

Zero ❌, zero stub banners. The one ⚠️ is an honest Azure-side infra gate per
`no-vaporware.md` — the full form still renders below the bar.

## Backend per control

All four activity types serialize into the pipeline's `properties.activities[]`
and are persisted/validated/run through the existing ADF client
(`lib/azure/adf-client.ts`: `upsertPipeline` / `validatePipeline` / `createRun`).
ADF executes the HDInsight job on the cluster named by the activity's
`linkedServiceName`. There is no separate Loom BFF route — the HDInsight
activities ride the same `adf-pipeline` editor routes documented in
`adf-pipeline.md`.

## Bicep + bootstrap

- `platform/fiab/bicep/modules/admin-plane/main.bicep` — new param
  `loomHdinsightLinkedService` wired to env vars `LOOM_HDINSIGHT_LINKED_SERVICE`
  (server) + `NEXT_PUBLIC_LOOM_HDINSIGHT_LINKED_SERVICE` (client pre-fill).
- `platform/fiab/bicep/modules/landing-zone/adf.bicep` — bootstrap comment block
  documenting the operator step (register an `AzureHDInsight` linked service +
  set the param). HDInsight clusters are long-lived/cost-significant and are not
  auto-provisioned by the DLZ bootstrap.

## Per-cloud availability

HDInsight + ADF HDInsight activities are available on Commercial, Azure
Government (GCC / GCC-High), and Azure DoD (IL5). The same activity JSON is
emitted on all clouds; the factory's `publicNetworkAccess: Disabled` (enforced
in `adf.bicep`) plus a VNet-injected cluster satisfy the IL5 posture. No Loom
code is cloud-gated.

## Verification

Add a Hive activity referencing a real `AzureHDInsight` linked service → Save →
Validate passes → Run executes the Hive job (`createRun`). With no cluster
linked service, the Settings tab renders the honest MessageBar naming
`LOOM_HDINSIGHT_LINKED_SERVICE` while still showing the full form.
