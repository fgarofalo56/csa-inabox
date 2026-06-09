# pipeline-copilot — parity with the Fabric/ADF Data pipeline Copilot

Source UI: Microsoft Fabric Data pipeline **Copilot** pane + Azure Data Factory
Studio Copilot (NL→pipeline, run-from-chat, error diagnostics). Grounded in
Microsoft Learn "Copilot for Data Factory" and the ADF Studio pipeline canvas.

CSA Loom is its own product on Azure-native backends (Azure Data Factory ARM /
Synapse Integrate dev endpoint). **No Microsoft Fabric or Power BI dependency** —
the Copilot works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (per
`.claude/rules/no-fabric-dependency.md`).

## Fabric/ADF Copilot feature inventory

| Capability (source UI) | What it does |
|------------------------|--------------|
| NL → pipeline | "Copy from X to Y" generates a complete pipeline (Copy activity + datasets + linked-service refs) on the canvas |
| `/` source / dest completion | Pick a real connection (linked service) inline to ground source/sink |
| Run from chat | Trigger the pipeline and return the run id |
| Run status | Report Queued/InProgress/Succeeded/Failed for a run |
| Summarize pipeline | Explain what the current pipeline does (activities + dependencies) |
| Error assistant | Read a failed run's activity errors and explain them in plain English |
| Apply to canvas | Generated activities land as real nodes on the design canvas |

## Loom coverage

| Inventory row | Status | Loom surface |
|---------------|--------|--------------|
| NL → pipeline | ✅ built | `pipeline_generate` (AOAI, grounded in real connections) → `pipeline_apply_canvas` |
| `/` source/dest completion | ✅ built | `PipelineCopilotPane` `/` picker ← `GET …/connections` (real linked services, source/sink classified) |
| Run from chat | ✅ built | `pipeline_run` → real `adf.runPipeline` / `synapseDev.runPipeline` → real runId |
| Run status | ✅ built | `pipeline_get_run_status` → `adf.listPipelineRuns` / `synapseDev.getPipelineRun` |
| Summarize pipeline | ✅ built | `pipeline_summarize` → `adf.getPipeline` / `synapseDev.getPipeline` |
| Error assistant | ✅ built | `pipeline_explain_error` → `adf.listActivityRuns` / `synapseDev.listActivityRuns` (Failed only, real errorCode+message) |
| Apply to canvas | ✅ built | `canvas_apply` SSE event → `PipelineEditorCore.applyGeneratedSpec` → React-Flow re-render + fitToScreen |
| AOAI not wired | ⚠️ honest-gate | 503 `code:'no_aoai'` + MessageBar naming `LOOM_AOAI_ENDPOINT`/`LOOM_AOAI_DEPLOYMENT` + Cognitive Services OpenAI User role |
| Item not bound | ⚠️ honest-gate | Pane shows "Bind a pipeline first" MessageBar; copilot route 412s until bound |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend call (real) |
|---------|---------------------|
| `pipeline_list_connections` | `adf.listLinkedServices()` / `synapseDev.listLinkedServices()` (ARM / dev endpoint) |
| `pipeline_list_datasets` | `adf.listDatasets()` / `synapseDev.listDatasets()` |
| `pipeline_generate` | Azure OpenAI chat-completions (`cogScope()` token, sovereign-aware) → validated PipelineSpec |
| `pipeline_apply_canvas` | `adf.upsertPipeline()` / `synapseDev.upsertPipeline()` (Synapse polls the LRO to Succeeded) |
| `pipeline_run` | `adf.runPipeline()` (ARM createRun) / `synapseDev.runPipeline()` (dev createRun) |
| `pipeline_get_run_status` | `adf.listPipelineRuns()` / `synapseDev.getPipelineRun()` |
| `pipeline_summarize` | `adf.getPipeline()` / `synapseDev.getPipeline()` |
| `pipeline_explain_error` | `adf.listActivityRuns()` / `synapseDev.listActivityRuns()` + run-level message |

## Orchestration

The persona reuses the cross-item `orchestrate()` loop via the new
`registryOverride` + `systemPromptOverride` options — same SSE step stream,
session persistence (`copilot-sessions` Cosmos container), AOAI resolution
(tenant admin pick → `LOOM_AOAI_ENDPOINT` env → Foundry-hub discovery), and the
o1/o3-class temperature fallback. Only the tool set (8 pipeline tools) and the
system prompt differ. `pipeline_apply_canvas` returns an `_action` marker the
BFF route turns into the dedicated `canvas_apply` SSE event.

## Per-cloud notes

- **Commercial / GCC**: ADF ARM `management.azure.com`, Synapse dev
  `{ws}.dev.azuresynapse.net`, AOAI `*.openai.azure.com` (`cogScope()` →
  `cognitiveservices.azure.com/.default`).
- **GCC-High / IL5 (`AzureUSGovernment`)**: AOAI `*.openai.azure.us`
  (`cogScope()` → `cognitiveservices.azure.us/.default`); Synapse dev suffix via
  `AZURE_SYNAPSE_DEV_HOST_SUFFIX` / `LOOM_SYNAPSE_DEV_SUFFIX`; ARM
  `management.usgovcloudapi.net`. The generate sub-call always uses `cogScope()`
  — never a hard-coded Commercial host.
- **DoD (`AzureDOD`)**: `armBase()` → `management.azure.microsoft.scloud`; AOAI
  via the DoD-boundary `LOOM_AOAI_ENDPOINT`. `pipeline_generate` falls back to
  markdown-fence stripping when a non-JSON-mode model is deployed.

## No new infra

No new Azure resource, env var, Cosmos container, or RBAC grant. The Copilot
reuses the **existing** ADF "Data Factory Contributor" and Synapse
"Synapse Administrator" UAMI roles (read linked services, upsert pipelines, run,
query activity runs) plus the existing AOAI deployment + "Cognitive Services
OpenAI User" grant the rest of the Copilot already requires. Nothing to add to
bicep or the post-deploy bootstrap for this feature.

## Verification

- `npx tsc --noEmit` — clean (0 errors).
- `vitest lib/copilot/__tests__/pipeline-tools.test.ts` — 9/9 green
  (connection source/sink classification, summarize dependsOn normalization,
  error-assistant Failed-only filtering for ADF + Synapse, run + status routing).
- Live walk (operator): bind a pipeline → "copy from ADLS folder raw/orders to
  SQL table dbo.Orders" → real Copy activity node on the canvas (persisted via
  upsert) → "run it" → real runId → force a failure → "explain the error" →
  real errorCode + message.
