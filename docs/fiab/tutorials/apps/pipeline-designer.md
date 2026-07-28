# Pipeline Designer — from install to the same medallion on three orchestrators

Install `app-pipeline-designer` and get **one conceptual pipeline expressed three
ways** — a Synapse pipeline, an ADF pipeline, and a Databricks job — all feeding the
same **gold star-schema warehouse**. The point of the app is the comparison: same
bronze → silver → gold, three orchestrator surfaces, so you can choose deliberately.
**~30 minutes.**

!!! abstract "What you end up with"
    Four items: `Medallion ETL — Synapse Orchestrator` (synapse-pipeline),
    `SAP-to-Lakehouse Extract` (adf-pipeline), `Medallion ETL — Databricks Job`
    (databricks-job), and `Sales Star Schema — Gold Warehouse` (warehouse). Every
    pipeline is really authored in its service and really run.

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_SYNAPSE_WORKSPACE` | Author + run the Synapse pipeline via the Synapse dev REST | *"Synapse workspace is not configured for this deployment."* |
| `LOOM_ADF_SUBSCRIPTION_ID` / `LOOM_ADF_RG` / `LOOM_ADF_FACTORY` (or the `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` fallback) | `PUT` the ADF pipeline via ARM + `createRun` | *"Azure Data Factory is not configured for this deployment."* |
| `LOOM_DATABRICKS_HOSTNAME` | Import the task notebooks + create/reset the job (Jobs 2.1) | *"Databricks workspace is not configured for this deployment."* |
| `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL` | The warehouse runs its DDL + seed rows over TDS | *"Synapse dedicated pool not configured. Set `LOOM_SYNAPSE_WORKSPACE` … and `LOOM_SYNAPSE_DEDICATED_POOL` …"* |

You do **not** need all four. Each item gates independently, so a Synapse-only estate
still gets a working Synapse pipeline plus the warehouse.

## 1. Install the app

1. Left nav → **Apps** → **Pipeline Designer** (`/apps/app-pipeline-designer`).
2. **Install into workspace** → workspace, optional folder (e.g. `ETL`).
3. **Deploy artifacts to live Azure services** → **On**. **Compute** → **Shared**.
4. **Install**.

!!! tip "This install can take minutes"
    Three of the four items do real long-running work — a dedicated-pool resume can
    take 1–3 minutes, and each pipeline is `createRun`-ed and polled. That is exactly
    why the install is asynchronous: close the dialog and let the toast tell you when
    it lands.

## 2. What gets provisioned

| Item | Provisioner | Real backend | Runs it? |
| --- | --- | --- | --- |
| `Medallion ETL — Synapse Orchestrator` | `synapsePipelineProvisioner` | `PUT` the pipeline via the Synapse dev REST | Yes — `createRun` + poll |
| `SAP-to-Lakehouse Extract` | `adfPipelineProvisioner` | `PUT` `Microsoft.DataFactory/factories/pipelines` (ARM, `2018-06-01`) | Yes — `createRun` + poll |
| `Medallion ETL — Databricks Job` | `databricksJobProvisioner` | Imports the task notebooks, creates/resets a multi-task job on a shared cluster | Yes — `run-now` + poll |
| `Sales Star Schema — Gold Warehouse` | `warehouseProvisioner` | Synapse **dedicated SQL pool** over TDS with the Console managed identity (`LOOM_WAREHOUSE_BACKEND=synapse-dedicated` is the Azure-native default) | Executes the DDL, the dbt models as views, and the seed `INSERT`s |

### Read this before you judge the pipeline graphs

Both pipeline bundles are deliberately **self-contained control-flow graphs**, and the
bundle source says so in its own comments:

- The Loom provisioners `PUT` **only the pipeline**. They do not create datasets,
  linked services, mapping data flows, or integration runtimes.
- ADF's ARM REST validates every `DatasetReference` / `LinkedServiceReference` /
  `DataFlowReference` at `PUT` time. A graph that referenced `ds_sap_table` therefore
  failed with `400 invalid reference` on a bare factory.
- So the shipped graphs model the orchestration with control-flow plus real
  MSI-authenticated `Web` activities — which install and run against a bare
  Synapse workspace / the default Loom factory with zero external artifacts.
- The byte-moving Copy / Mapping-Data-Flow steps live in a fully provisioned DLZ
  factory deployed separately (`scripts/deploy/deploy-adf.sh` +
  `domains/shared/pipelines/adf/**`, with `ls_adls_gen2`, `ls_sap_ecc_selfhosted`,
  `ls_fabric_onelake`, and the `ds_*` datasets).

That is an honest architecture statement, not a stub: the orchestration layer is real
and runnable; the connector layer is a separate deployment.

### The three graphs

**Synapse — `Medallion ETL — Synapse Orchestrator`** (5 activities, parameters
`runDate` defaulting to `@formatDateTime(utcnow(),'yyyy-MM-dd')`, `sourceContainer`
`raw-sales-drop`, `targetWorkspace`):
`Prepare_Landing` → `Transform_Bronze` → `Transform_Silver` → `Transform_Gold` →
`Notify_OnCompletion` (a real Web activity). On a Databricks-wired DLZ each transform
stage becomes a `DatabricksNotebook` activity bound to `ls_databricks_csa`.

**ADF — `SAP-to-Lakehouse Extract`** (parameters `runDate`, `sapSystemId` = `ECP`,
`lakehouseId`, `extractTables` = `['VBAK','VBAP','KNA1','MARA']`):
`ForEach_SapTable` (containing `Dispatch_TableExtract`, a Web activity) →
`Wait_ForExtracts` → `Notify_OnCompletion`. This is the pattern for sources that need
ADF's connector library rather than Synapse's notebook surface.

**Databricks — `Medallion ETL — Databricks Job`**: three chained `notebook_task`s —
`bronze` → `silver` → `gold` — sharing **one** job cluster
(`15.4.x-photon-scala2.12`, `Standard_DS3_v2`, 4 workers), with `depends_on` enforcing
serial execution. Task paths are
`/Workspace/Repos/csa-loom/medallion/{bronze,silver,gold}`. Each task is idempotent:
re-running with the same `run_date` overwrites that day's partition.

## 3. Seeded data

The **warehouse** is the seeded item. It carries:

- The **gold star-schema DDL** — `fact_sales` + `dim_customer` + `dim_product` +
  `dim_date`.
- **Six dbt models** materialized as views: `bronze_sales`, `silver_sales`,
  `dim_customer`, `dim_product`, `dim_date`, `fact_sales`, plus the `dbt_project.yml`.
- **Seed rows** inserted after the DDL, so the star schema answers queries before any
  pipeline has run.
- **Four starter queries** (below).

The three pipelines are orchestration; the warehouse is the contract they populate.

## 4. First meaningful task — run one orchestrator, then read the gold layer

1. Open **`Sales Star Schema — Gold Warehouse`** and run the starter query
   **"Pipeline freshness — what is the latest `order_date` in gold?"**:

   ```sql
   SELECT
       MAX(d.date)                                   AS latest_order_date,
       DATEDIFF(HOUR, MAX(d.date), SYSUTCDATETIME()) AS hours_behind_now,
       COUNT_BIG(*)                                  AS total_order_lines
   FROM gold.fact_sales f
   JOIN gold.dim_date d ON d.date_key = f.order_date_key;
   ```

   Note the row count. This is your **before** reading.

2. Open **`Medallion ETL — Synapse Orchestrator`**. Review the five stages and the
   parameter defaults, then trigger a run from the editor. Watch it move through
   `Prepare_Landing` → … → `Notify_OnCompletion`.

3. Do the same for **`SAP-to-Lakehouse Extract`** and compare: the ADF graph fans out
   per table with `ForEach`, which is the shape you want when the source system
   dictates table-at-a-time extraction. The Synapse graph is stage-at-a-time.

4. Open **`Medallion ETL — Databricks Job`**. Three tasks, one cluster, serial by
   `depends_on` — the shape you want when the transforms are Spark code you already
   own and cluster reuse dominates cost.

5. Back in the warehouse, run the other three starter queries:
   - **Top 10 customers by margin — last 90 days**
   - **Revenue by quarter and customer segment**
   - **Top categories by margin pct**

   These join `gold.fact_sales` to `gold.dim_customer` / `gold.dim_product` /
   `gold.dim_date`, so a successful result proves the DDL, the seed, and the
   relationships all landed.

### Which orchestrator should you pick?

| Choose | When |
| --- | --- |
| **Synapse pipeline** | Your transforms are Synapse notebooks / Spark pools and you want one plane for orchestration and compute |
| **ADF pipeline** | The source needs ADF's connector library (SAP ECC ODP, on-prem via a self-hosted IR) more than it needs notebooks |
| **Databricks job** | The transforms are Databricks notebooks in a repo and you want cluster reuse plus `depends_on` DAG semantics |

## 5. Verify it worked

- **Install dialog**: each pipeline row is `created` with the resolved pipeline name,
  and its step log shows the run id and terminal status from the poll.
- **Warehouse row**: `created`, with the DDL/seed batch counts in the step log.
- **Warehouse editor**: all four starter queries return rows.
- **Azure side**: the pipeline exists in Synapse Studio / the ADF portal, and the job
  exists in the Databricks Jobs UI with a completed run.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Warehouse row asks you to wait ~3 minutes and Retry | Loom issued an ARM **resume** on a paused dedicated pool | Wait for Online, click **Retry**. If resume was rejected, grant the Console MI **Synapse Administrator / Contributor**, or resume manually with `az synapse sql pool resume --name $LOOM_SYNAPSE_DEDICATED_POOL --workspace-name $LOOM_SYNAPSE_WORKSPACE --resource-group $LOOM_DLZ_RG` |
| Warehouse DDL rejected | The Console UAMI is not a user in the pool | Synapse workspace → **Manage → Security**: `CREATE USER … FROM EXTERNAL PROVIDER;` then `ALTER ROLE db_owner ADD MEMBER …` |
| Pipeline row: "references an artifact that isn't provisioned on this estate" | The graph was edited to point at a dataset/linked service the bare factory does not have | Deploy the full DLZ factory (`scripts/deploy/deploy-adf.sh`), or keep the graph control-flow-only |
| Pipeline authored but "on-demand run was not authorized" | The identity can author but not run | Grant the Console MI **Data Factory Contributor** (ADF) or the Synapse pipeline-run role, then **Retry** |
| Databricks row: "cannot import the job's task notebooks" | Workspace permissions | Grant the Console MI write access to `/Workspace/Repos/csa-loom/medallion/` |
| `Unknown LOOM_WAREHOUSE_BACKEND` | The variable is set to an unrecognized value | Set `LOOM_WAREHOUSE_BACKEND=synapse-dedicated` (the Azure-native default; no Fabric required) |

## Cleanup

Delete the four items, or the workspace. **The Azure artifacts persist**: the Synapse
and ADF pipelines, the Databricks job, and the warehouse tables all remain in their
services. Remove them there — and remember a dedicated SQL pool bills while Online, so
pause it if you are done.

## What's next

- [Lakehouse Inspector](lakehouse-inspector.md) — the bronze/silver/gold data these
  pipelines produce, with a profiling notebook.
- [Supercharge medallion journey](supercharge-medallion.md) — 117 Spark notebooks
  running the same medallion at scale.
- [FinOps Cost Optimizer](finops-cost.md) — what all this compute costs.
