# data-pipeline-empty-state — parity with Fabric Data Pipeline "start" experience

Source UI: Microsoft Fabric → Data pipeline → new/empty pipeline canvas
(`https://learn.microsoft.com/fabric/data-factory/create-first-pipeline-with-sample-data`).
When a Fabric data pipeline is empty, Fabric presents start cards:
**Add pipeline activity**, **Copy data assistant**, and
**Choose a task to start** (sample/template gallery). The
"Practice with sample data" / sample-data quickstart seeds a real dataset and
runs a copy so the user sees output immediately.

## Fabric feature inventory (empty-state / start surface)

| # | Capability | Notes |
|---|------------|-------|
| 1 | Start with blank canvas (add activity) | Opens the empty designer to drag activities |
| 2 | Sample-data quickstart | Loads a real sample dataset, builds a copy, runs it, surfaces output |
| 3 | Templates / "choose a task to start" gallery | Curated copy/transform templates |
| 4 | Output / run monitoring after the quickstart runs | Run + per-activity rows |

## Loom coverage

| # | Capability | Status | How |
|---|------------|--------|-----|
| 1 | Start with blank canvas | ✅ built | Landing card → `New pipeline` create dialog (existing flow) |
| 2 | Practice with sample data | ✅ built | Landing card → `POST /api/items/data-pipeline/practice-seed`: uploads a real CSV to `landing/samples/loom-sales-2026.csv` on ADLS Gen2, upserts ADF linked service + 2 datasets + `loom_practice_copy` pipeline, runs it (`createRun`), upserts a Cosmos `data-pipeline` item, then navigates to it and opens the **Output** tab |
| 3 | Templates gallery | ⚠️ honest "Coming soon" | Badged card, no dead control; tracked for a follow-up template-gallery surface |
| 4 | Output after quickstart | ✅ built | Editor switches to Output tab; `OutputPane` reads `/api/items/data-pipeline/[id]/output` which resolves `state.adfPipelineName=loom_practice_copy` and returns real `queryPipelineRuns` + `queryActivityRuns` rows |

Azure-native default (no Microsoft Fabric required, per
`.claude/rules/no-fabric-dependency.md`): the seed targets **ADLS Gen2 + ADF**.
Nothing reads `fabricWorkspaceId`.

## Honest gates (no-vaporware)

- `LOOM_SAMPLE_ADLS` unset → `503 { gate: { missing: 'LOOM_SAMPLE_ADLS', remediation } }`;
  the card renders a Fluent `MessageBar intent="warning"` with the exact env var
  + the RBAC the ADF factory MSI needs (Storage Blob Data Contributor).
- ADF unconfigured (`adfConfigGate`) → `503` naming `LOOM_ADF_NAME` /
  `LOOM_DLZ_RG` / `LOOM_SUBSCRIPTION_ID` + the "Data Factory Contributor" grant.
- No workspace selected → in-client `MessageBar intent="warning"` "Select a
  workspace first" (no network call).
- Any ADLS/ADF/Cosmos failure bubbles the real Azure error verbatim (502/404);
  the card never reports simulated success.

## Backend per control

- Seed: `POST /api/items/data-pipeline/practice-seed`
  → `adls-client.getServiceClientFor(LOOM_SAMPLE_ADLS).getFileSystemClient('landing').getFileClient('samples/loom-sales-2026.csv').upload(...)`
  → `adf-client.upsertLinkedService('LS_Loom_ADLS_Sample')`
  → `adf-client.upsertDataset('DS_Loom_Sample_CSV' | 'DS_Loom_Sample_Bronze')`
  → `adf-client.upsertPipeline('loom_practice_copy')`
  → `adf-client.runPipeline('loom_practice_copy')`
  → `cosmos itemsContainer` upsert (find-or-create by `state.adfPipelineName`).
- Output: `GET /api/items/data-pipeline/[id]/output` → `listPipelineRuns` / `listActivityRuns`.

## Bicep sync

- `platform/fiab/bicep/modules/landing-zone/adf.bicep` — new `storageAccountId`
  param + role assignment granting the ADF factory system-assigned MI
  **Storage Blob Data Contributor** (`ba92f5b4-2d11-453d-a403-e96b0029c9fe`) on
  the DLZ storage account (MSI-auth linked service needs it).
- `platform/fiab/bicep/modules/landing-zone/main.bicep` — passes
  `storageAccountId: storage.outputs.storageAccountId` to the `adf` module; adds
  `output adfFactoryPrincipalId`.
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — adds
  `LOOM_SAMPLE_ADLS` (= `loomStorageAccount`) to the Console app env, emitted
  only when an ADLS account is configured so the gate fires otherwise.

## Per-cloud

`dfsSuffix()` derives the linked-service URL host from `AZURE_CLOUD`:
`dfs.core.windows.net` (Commercial / GCC) vs `dfs.core.usgovcloudapi.net`
(GCC-High / IL5). RBAC GUIDs are tenant-global; ADF + ADLS Gen2 are GA in
USGov Virginia/Texas.
