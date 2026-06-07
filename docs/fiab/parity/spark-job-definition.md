# spark-job-definition — parity with Fabric Spark Job Definition (Azure-native Synapse Spark)

Source UI: Microsoft Learn — *Create an Apache Spark job definition in Fabric*
(`/fabric/data-engineering/create-spark-job-definition`), *Run a Spark job
definition* (`/fabric/data-engineering/run-spark-job-definition`).

Azure-native backend (NO Fabric dependency, per `no-fabric-dependency.md`):
**Azure Synapse Spark** via the Livy batch API
(`/livyApi/versions/2019-11-01-preview/sparkPools/{pool}/batches`). Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

Editor: `apps/fiab-console/lib/editors/spark-job-definition-editor.tsx`
Routes: `apps/fiab-console/app/api/items/spark-job-definition/[id]/{submit,runs,runs/[runId],runs/[runId]/cancel,files}/route.ts`

## Fabric/Azure feature inventory → Loom coverage

| Fabric SJD capability | Loom coverage | Backend per control |
|---|---|---|
| Language picker (PySpark / Spark(Scala-Java) / SparkR) | ✅ Dropdown; drives upload `accept` + Main-class visibility + `className` sent only for Scala/Java | client-side; persisted on `state.spec.language` |
| Main definition file (upload **or** abfss:// URI) | ✅ Text input + **Upload** (local → ADLS) | `POST .../[id]/files` → `uploadFile()` ADLS Gen2 `landing/sjd/<id>/Main/<file>` → returns abfss URI |
| Main class (FQCN, Scala/Java) | ✅ Conditional Input shown only for `Spark` language | sent to Livy `className` |
| Command-line arguments | ✅ Textarea, one-per-line → `argv[]` | Livy `args[]` |
| Reference files — Python (.py/.zip/.egg) | ✅ Textarea of abfss URIs | Livy `pyFiles[]` |
| Reference files — JARs | ✅ Textarea of abfss URIs | Livy `jars[]` |
| Reference files — other (data/config) | ✅ Textarea of abfss URIs | Livy `files[]` |
| Spark pool selection | ✅ Dropdown from live pool list | `GET /api/items/synapse-spark-pool/list`; Livy submit targets the pool |
| Environment attachment | ✅ Dropdown of Loom `environment` items; merges its Spark conf + JARs at submit | `GET /api/items/environment`; merge in `.../submit` route |
| Spark Compute — driver/executor memory + cores, executor count | ✅ Inputs on the Spark Compute tab | Livy `driverMemory/driverCores/executorMemory/executorCores/numExecutors` |
| Spark conf overrides (key/value grid) | ✅ `KeyValueGrid` (not raw JSON) | Livy `conf{}` |
| Optimization — retry policy (count + interval, idempotency note) | ⚠️ Persisted on `state.spec.retryPolicy` + surfaced; auto-enforcement gated on the run-orchestrator worker (honest in-UI note). Manual re-submit available now. | persisted; documented gate |
| Runs history grid (id, app name, state, result, submitted, app id) | ✅ Table; auto-refreshes every 5s while a run is active | `GET .../runs` → `listSparkBatchJobs()` |
| Run state live transition → Succeeded/Failed | ✅ Polled while active | Livy batch `state`/`result` |
| Cancel active run | ✅ Ribbon "Cancel active run" + per-row Cancel | `POST .../runs/[runId]/cancel` → `cancelSparkBatchJob()` (Livy DELETE) |
| Driver log viewer | ✅ Per-run Accordion → fetches log tail + errorInfo | `GET .../runs/[runId]` → `getSparkBatchJob()` `log[]` |
| Save / Saved indicator + Ctrl+S | ✅ | `PUT /api/items/spark-job-definition/[id]` (Cosmos) |
| Settings → Schedule | ❌ deferred (parity-spec gap 9) — separate task; not in F17 scope |
| Per-run snapshot (View snapshot / Restore) | ❌ deferred (parity-spec gap 10) |
| Lakehouse default-context references | ❌ deferred (parity-spec gap 4) |
| Pipeline "Spark Job Definition activity" | ❌ deferred (parity-spec gap 13) |
| Run-history retention TTL | ❌ deferred (parity-spec gap 12) |

The four ❌ rows are tracked in `docs/fiab/spark-job-definition-parity-spec.md`
(Session 3 scope) and are out of the F17 task boundary. Everything in the F17
goal — main definition file, command-line args, reference files (.py/.jar/files),
pool/env selection, submit, runs-history grid with live status + logs + cancel —
is built ✅ on the Azure-native Synapse path.

## Azure backing (no new bicep)

- **Synapse workspace + Spark Big Data pool** — `platform/fiab/bicep/modules/landing-zone/synapse.bicep`
  (`bigDataPools@2021-06-01`, `deploySparkPool=true` default).
- **Spark submit role** — the Console UAMI is set as the workspace AAD admin
  (`consoleAadAdmin`), which carries the **Synapse Administrator** data-plane
  role → authorizes Livy batch submit/list/cancel. No additional role grant
  required.
- **File upload target** — ADLS Gen2 `landing` container
  (`LOOM_LANDING_URL`, provisioned by the DLZ storage module); the upload route
  shows an honest MessageBar when the env var is unset and still accepts a
  pasted abfss:// URI.

## Per-cloud endpoints

- **Commercial** — `{ws}.dev.azuresynapse.net` + `management.azure.com` (current `synapse-dev-client.ts`).
- **GCC** — same as Commercial (Synapse on Azure Commercial infra).
- **GCC-High / IL5 (AzureUSGovernment)** — `{ws}.dev.azuresynapse.us` +
  `management.usgovcloudapi.net`; ADLS suffix `dfs.core.usgovcloudapi.net`.
  Add a `LOOM_AZURE_CLOUD=AzureUSGovernment` branch to the dev/ARM base + OAuth
  scopes in `synapse-dev-client.ts` (tracked separately; same Livy path, no Fabric).

## Verification

- `npx tsc --noEmit` — touched files clean (only Griffel px-token noise).
- `npx vitest run lib/editors/__tests__/spark-job-definition.test.tsx` — 2 passed.
- Live E2E (operator, post-merge): create an SJD, upload/point a PySpark
  `main.py`, pick a pool, Submit → batch appears in Runs with state
  `starting`→`running`→`success`; expand the run to view the driver log; Cancel
  an in-flight run — all against Synapse with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
