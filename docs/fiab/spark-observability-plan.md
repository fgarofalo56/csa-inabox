# CSA Loom — Spark configs, Databricks clusters & Spark observability

**Created 2026-06-24. Branch `feat/loom-marketplace`.** Operator ask: best-practice
Spark config presets users pick per work type + a config builder in notebooks; the same
for Databricks clusters; collect ALL Synapse + Databricks logs into the Loom Log
Analytics workspace; and a Monitor / performance-tuning / troubleshooting section with
Spark-application analytics + links to the native Spark diag tools.

Grounded in MS Learn: Synapse [create-spark-configuration], Synapse Spark→LA
[data-collector→log-ingestion API], Databricks [spark/conf], [compute/configure],
[apps/observability + monitor + best-practices], [notebooks/best-practices].

## ✅ SHIPPED (this commit)
- **Spark config PRESET CATALOG** — `apps/fiab-console/lib/spark/config-presets.ts`.
  7 best-practice profiles for different work types (Balanced, Large joins/shuffle,
  Many small files / high parallelism, Streaming, ML / heavy compute, Delta-optimized,
  Cost-optimized) — each with curated `spark.*` confs + Synapse sizing + a Databricks
  cluster shape (`DatabricksShape`). Synapse-only confs (dynamicAllocation) vs Databricks-only
  (delta optimizeWrite) are separated. `COMMON_SPARK_CONF_KEYS` powers builder autocomplete.
- **Notebook config BUILDER** — `session-config-dialog.tsx`: a preset picker (applies sizing +
  confs in one click) + a structured key/value `spark.*` editor (one row per prop, common-key
  datalist, add/remove) — NO JSON textarea. `SessionConfig` now carries `sparkConf` + `presetId`;
  `toConfigureOptions` → Livy `conf`; `createLivySessionAsync` sets `request.conf`.
- **Synapse → Loom Log Analytics (default)** — `synapseLogAnalyticsConf()` returns the
  `spark.synapse.logAnalytics.{enabled,workspaceId,secret|keyVault.*}` confs; the run route
  merges them into EVERY session's conf so all Loom Spark sessions emit
  SparkLoggingEvent/SparkMetrics/SparkListenerEvent to Loom LA. Honest gate: emits nothing
  until `LOOM_SPARK_LA_WORKSPACE_ID` + `LOOM_SPARK_LA_KEY` (or `LOOM_SPARK_LA_KEYVAULT_NAME`
  + `_SECRET`) are set.

## ✅ SHIPPED (later commits)
- **Databricks cluster preset BUILDER** (commit 5bb6db3b) — `compute-picker`
  NewClusterDialog: preset picker (5 Databricks-targeted profiles) applying
  autoscale min/max + Photon + Spot + auto-terminate + curated `spark_conf` in one
  click; Photon/Spot toggles; min/max autoscale; structured key/value spark_conf
  builder (no JSON; dynamicAllocation hidden). compute-targets POST expands
  presetId → DatabricksShape + databricksConfFor(); ClusterSpec gained
  runtime_engine / azure_attributes / cluster_log_conf; databricksClusterLogConf()
  honest-gated on LOOM_DATABRICKS_CLUSTER_LOG_PATH.
- **Monitor → Spark surface** (commit 6d744114) — a new "Spark" tab under Monitor:
  `lib/azure/spark-monitor.ts` (listSparkApplications over SparkListenerEvent_CL +
  DatabricksJobs, isfuzzy + column_ifexists; getSparkAppMetrics; PURE recommendTuning()
  heuristic engine — 12 unit tests; sparkNativeDiagLinks), `/api/monitor/spark` BFF
  (honest gate), `lib/panes/spark-observability.tsx` (sortable app table → drill-down
  metric cards + tuning-rec cards w/ conf chips → native Spark-UI/History-Server links).
- **Synapse→LA emission wired LIVE** (rev rolling as bjpbgi276): set
  `LOOM_SPARK_LA_WORKSPACE_ID=01273839-…` + `LOOM_SPARK_LA_KEY=secretref:spark-la-key`
  (console secret = LA primary shared key) on the live console, so every Loom Spark
  session now emits SparkListenerEvent/SparkMetrics to law-csa-loom-centralus and the
  Monitor → Spark tab shows real data. STILL NEEDS the durable bicep (wave 1 below).

## ⏳ NEXT WAVES (designed, ready to build)

### 1. Wire the Synapse→LA env + pool default (infra)
> Live env is SET (see SHIPPED above); the remaining work here is the DURABLE bicep
> (apps[].env + KV secret) + the Synapse pool default + the DCR migration.
- Set `LOOM_SPARK_LA_WORKSPACE_ID` (the Loom LA workspace GUID — live = `01273839-800f-4fef-86bf-85e94cdf3a65`)
  + `LOOM_SPARK_LA_KEYVAULT_NAME`/`_SECRET` (a KV secret holding the LA shared key) on the
  console app via `main.bicep` apps[].env + the post-deploy bootstrap. Prefer KV over the
  inline `LOOM_SPARK_LA_KEY`.
- ~~ALSO set the same `spark.synapse.logAnalytics.*` as the Synapse **pool default**~~
  **DECLINED (secret-safety):** the pool `sparkConfigProperties.content` is plaintext in
  the ARM template, so embedding `spark.synapse.logAnalytics.secret` (the LA shared key)
  there leaks a secret. The shipped **session-level** emission (key from the console
  `spark-la-key` secret, applied per Livy session) is the secure equivalent and covers
  every Loom-launched job. The only safe pool-default is the KV-backed variant
  (`spark.synapse.logAnalytics.keyVault.{name,key}` + a Synapse linked service + pool-MSI
  KV access) — a larger, optional lift, not required for parity.
- Migrate to the **Log Ingestion API (DCR-based)** per the Learn doc when the Data Collector
  API path is retired: create a DCR + DCE targeting the Loom LA custom tables; swap the
  `spark.synapse.diagnostic.*` confs. (Confs are env-driven, so this is an env/bicep change.)

### 2. Databricks cluster presets + builder
- `compute-targets` POST already creates Databricks clusters. Extend it to accept a `presetId`
  → expand to the catalog's `DatabricksShape` (nodeType, autoscale min/max, photon → `runtime_engine:PHOTON`,
  autotermination, spot → `azure_attributes.availability:SPOT_WITH_FALLBACK_AZURE`, `spark_conf` =
  `databricksConfFor(preset)`, `runtimeChannel`→ resolve `spark_version` from the workspace's
  spark-versions list, prefer LTS / ML).
- Builder UI in `<ComputePicker>` (notebook + anywhere compute is created): preset dropdown +
  the same key/value `spark_conf` editor + node/autoscale/photon/spot/autotermination fields.
  NEVER expose `spark.dynamicAllocation.*` for Databricks (conflicts with autoscaling).
- **Cluster log delivery**: set `cluster_log_conf` (Volumes path — UC `/Volumes/<cat>/<schema>/<vol>/cluster-logs`,
  or DBFS legacy) on created clusters so driver/worker/event logs persist + can be ingested.

### 3. Databricks → Loom Log Analytics (infra)
- Workspace **diagnostic settings** → Loom LA: bicep `Microsoft.Insights/diagnosticSettings` on the
  `Microsoft.Databricks/workspaces` resource, all categories (clusters, jobs, notebook, accounts,
  dbfs, sqlPermissions, instancePools, …) → the Loom LA workspace. Surfaces in LA as
  `DatabricksClusters`, `DatabricksJobs`, `DatabricksNotebook`, etc.
- Optionally the **Spark monitoring library** (cluster-level metrics → LA) for fine-grained
  executor/task metrics; or rely on Databricks **system tables** (`system.compute.*`, billing)
  queried via the SQL warehouse.

### 4. Monitor → Spark (analytics + perf-tuning + troubleshooting)
New surface — best fit: a **"Spark" tab/section under Monitor** (`/monitor/spark`) + per-item
"Diagnostics" tabs on the notebook / spark-job / spark-pool editors. All data REAL from Loom LA
(no mocks); honest gate when LA isn't wired.
- **Applications list**: recent Spark apps/runs (id, name, pool/cluster, user, start, duration,
  status) — LA KQL over `SparkListenerEvent_CL` (Synapse) + `DatabricksJobs`/system tables (Dbx).
- **App drill-down + analytics**: stages/tasks, executor count + utilization over time, shuffle
  read/write, disk spill, GC time, input/output bytes, task skew (max vs median task time),
  failed tasks — from `SparkMetrics_CL` / `SparkListenerEvent_CL`. Render with the existing
  `loom-chart.tsx` (bar/line/area).
- **Performance-tuning recommendations** (heuristic engine over the metrics): e.g. high disk
  spill → raise executor memory or `spark.sql.shuffle.partitions`; detected skew → enable
  `spark.sql.adaptive.skewJoin.enabled`; many tiny tasks → coalesce / raise
  `maxPartitionBytes`; long GC → tune memory fraction; under-utilized executors → lower count /
  enable autoscale. Each rec links to the exact preset/conf in the builder ("Apply").
- **Troubleshooting**: failed apps + error/traceback excerpt + "Fix with Copilot" (reuse the
  notebook Copilot /fix). Common-failure playbook (OOM, ELOGIN, skew, shuffle fetch fail).
- **Native diag tools** (deep links, no reinvention):
  - Synapse Spark application UI / Spark History Server — `https://<ws>.dev.azuresynapse.net` Monitor → Apache Spark applications (per-app Spark UI + driver/executor logs).
  - Databricks Spark UI + driver logs + metrics — the cluster's `…/sparkui/<app>` + the run's `run_page_url`.
  - LA: a one-click "Open in Log Analytics" with the prefilled KQL.

### 5. (Found via the UI sweep) panes/components UI pass
The page-UI workflow showed most `app/**/page.tsx` are thin wrappers delegating to
`lib/panes/*` + `lib/components/*`; the real overflow/dead-space/token issues for those
surfaces live in the panes/components. A follow-up workflow should sweep `lib/panes/**` +
`lib/components/**` (admin/*, monitor/*, deploy-planner, network, health, etc.) with the same
conservative issue-class fixes. (admin/health-pane.tsx already flagged: fixScript `<pre>`
horizontal scroll + many hardcoded px + un-wrapped remediation text.)
