# Supercharge medallion journey — 117 Azure-native Spark notebooks

The seven `app-supercharge-*` apps are a **1:1 conversion of the 117 notebooks from
[Supercharge Microsoft Fabric](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric)**
into Loom-native content bundles that run on **Synapse Spark / Databricks + ADLS Gen2 +
ADX**, with zero hard Microsoft Fabric dependency.

This tutorial does **not** walk 117 notebooks. It explains the shape of the packs,
walks **one representative bronze → silver → gold chain end to end** (the chain that is
proven green cell-by-cell on real Spark), and then indexes the rest so you can find
what you need. **~40 minutes for the walked chain.**

## The seven packs

| App | Notebooks | Layer |
| --- | --: | --- |
| `app-supercharge-bronze` | 28 | Raw ingestion → ADLS Gen2 Bronze Delta |
| `app-supercharge-silver` | 28 | Cleanse / conform |
| `app-supercharge-gold` | 34 | Business aggregates / dimensions |
| `app-supercharge-ml` | 8 | ML / MLOps (Azure ML / Databricks + ADLS + ADX) |
| `app-supercharge-streaming` | 9 | Streaming + CDC + real-time |
| `app-supercharge-utils` | 3 | Shared pipeline utilities (`%run`) |
| `app-supercharge-guide` | 7 | Hitchhiker's Guide platform recipes |
| **Total** | **117** | |

Every item in every pack is a **notebook**. Install a pack and you get that many
notebook items in the workspace, each with its converted cells stamped in.

!!! info "What 'converted' means"
    Each Fabric idiom was replaced with its Azure-native equivalent, and a generator
    guard fails the build if `api.fabric.microsoft.com`, `api.powerbi.com`, or
    `onelake.dfs.fabric` survives in an emitted bundle.

    | Upstream Fabric idiom | Azure-native replacement |
    | --- | --- |
    | OneLake ABFSS `…@onelake.dfs.fabric.microsoft.com/…` | ADLS Gen2 `…@{ADLS_ACCOUNT}.dfs.core.windows.net/…` |
    | `notebookutils.*` | `mssparkutils.*` (Synapse Spark native) |
    | Fabric Variable Library `spark.fabric.variable.X` | Synapse Spark conf `spark.loom.variable.X` |
    | OneLake shortcut (S3 / GCS) via Fabric REST | Spark direct read (`s3a://`, `gs://`) → ADLS Bronze Delta |
    | OneLake data-access roles (RLS/CLS) | Synapse Serverless SQL RLS/CLS + ADLS RBAC/ACL |
    | Fabric admin REST `/v1/workspaces` | ARM `Microsoft.Synapse/workspaces` |
    | Power BI dataset refresh | Azure Analysis Services REST (or the Loom Direct-Lake shim) |
    | Fabric Eventhouse / RTI dashboard (`.kql`) | Azure Data Explorer / Loom Real-Time Dashboard |

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_SYNAPSE_WORKSPACE` (or `LOOM_DATABRICKS_HOSTNAME`) | Install the notebooks as real artifacts | Notebook rows gate on the missing workspace |
| `LOOM_SYNAPSE_SPARK_POOL` (or `LOOM_AML_SPARK`) | Execute cells | Nothing to run on |
| `LOOM_ADLS_ACCOUNT` | Resolves the `{{ADLS_ACCOUNT}}` placeholder the generator emits, on both the install and run paths | Cells would point at an unresolved host |

!!! note "Which Spark backend runs your cells"
    `/api/items/notebook/<id>/execute-spark` resolves the backend: **AML Serverless
    Spark** (`LOOM_AML_SPARK`, Commercial / GCC) or **Synapse Spark via Livy**
    (`LOOM_SYNAPSE_SPARK_POOL`). **GCC-High / IL5 force Synapse Livy** because AML
    Spark is not offered there. The converted cells deliberately avoid AML-only APIs,
    so the same bundle runs on a Synapse Spark pool in every cloud.

## 1. Install the packs you need

For the walked chain you need three: **Bronze**, **Silver**, **Gold**. (Add **Utils**
if you want the `%run` helpers.)

1. Left nav → **Apps** → **Supercharge — Bronze Ingestion**
   (`/apps/app-supercharge-bronze`).
2. **Install into workspace** → pick the workspace, and **create a folder**
   (e.g. `Supercharge/Bronze`) — 28 notebooks in a flat root is unpleasant.
3. **Deploy artifacts to live Azure services** → **On**. **Compute** → **Shared**.
4. **Install.** Repeat for Silver and Gold.

## 2. What gets provisioned — and the seed

Each notebook installs via `notebookProvisioner`: a Synapse nbformat artifact
(`LOOM_SYNAPSE_WORKSPACE`) or a Databricks SOURCE notebook under
`/Shared/loom-installs/…`. Fabric is opt-in only (`LOOM_NOTEBOOK_BACKEND=fabric`) and
everything works with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**.

For the four **medallion** packs (`bronze`, `silver`, `gold`, `ml`) the install worker
additionally runs a **real sample-data seed** as a `seeding` phase (best-effort, after
provisioning). You can also fire it yourself:

```http
POST /api/apps/supercharge/seed
{ "workspaceId": "loom-ws-…", "pool": "loompool" }
→ 202 { "ok": true, "status": "seeding", "pool": "…" }
```

The seed runs **one real pyspark statement over Livy** on the Spark pool the notebooks
use, and it:

1. Creates the `lh_bronze`, `lh_silver`, and `lh_gold` Spark databases (idempotent), and
2. Writes deterministic **synthetic** source parquet — 600 rows each — to
   `Files/output/`:
   `bronze_slot_telemetry`, `bronze_player_profile`, `bronze_financial_txn`,
   `bronze_compliance_filings`, `bronze_table_games`, `bronze_security_events`.

It returns `202` immediately because a cold Spark session plus the statement can run
for minutes past the edge gateway's window. Expect **~1–3 minutes after cold start**.

!!! warning "Only the casino core is seeded"
    The six sources above are the ones the seed lands. The federal, industry,
    streaming, and ML sources beyond that core are **not** pre-seeded — their Bronze
    notebooks surface an honest empty-source read until you connect their upstream
    feed. That is deliberate: no fabricated rows.

## 3. First meaningful task — walk one chain end to end

The chain below is the one verified green cell-by-cell on Synapse Spark
(`loompool`): **seed 1/1, Bronze 11/11, Silver 17/17, Gold 14/14 — 43/43 code cells
Succeeded**, with 600 seeded rows flowing all the way to real gold KPIs.

### 3a. Seed first

Confirm the seed completed (or fire `POST /api/apps/supercharge/seed`). Nothing
downstream works without `Files/output/*.parquet` and the `lh_*` databases.

### 3b. Bronze — `01 — Bronze Slot Telemetry`

1. Open the notebook from `Supercharge/Bronze`.
2. Attach a compute in the ribbon's compute picker. A cold Synapse Spark pool takes
   ~2 minutes for the first session; the warm-session indicator tells you whether the
   next run gets a pre-warmed session or a cold start.
3. **Run all.**
4. It reads the seeded `Files/output/bronze_slot_telemetry.parquet` and writes
   `lh_bronze.bronze_slot_telemetry` — **600 rows**.

### 3c. Silver — `01 — Silver Slot Cleansed`

1. Open it from `Supercharge/Silver` and **Run all**.
2. It reads `lh_bronze.bronze_slot_telemetry`, deduplicates, and writes
   `lh_silver.silver_slot_cleansed` — **600 rows post-dedup** (the seed's timestamps
   are deterministic and strictly in the past, so Silver's future-event filter keeps
   every row).

!!! note "One genuine upstream bug was fixed here"
    Upstream, `silver/01_silver_slot_cleansed.py` deduplicated using a window ordered
    by `_silver_timestamp` — a column not added until a later cell, which throws an
    `AnalysisException` under Loom's cell-by-cell execution. The converted notebook
    orders by the real Bronze column `_bronze_ingested_at`, preserving the
    "latest ingestion wins" intent.

### 3d. Gold — `01 — Gold Slot Performance`

1. Open it from `Supercharge/Gold` and **Run all**.
2. It reads `lh_silver.silver_slot_cleansed` and writes
   `lh_gold.gold_slot_performance` with real KPIs: net win, hold percentage, and
   zone / performance breakdowns.

### 3e. Prove it

In any notebook cell:

```python
for t in ("lh_bronze.bronze_slot_telemetry",
          "lh_silver.silver_slot_cleansed",
          "lh_gold.gold_slot_performance"):
    print(t, spark.table(t).count())
```

Three non-zero counts, with bronze and silver at 600, is the receipt that the whole
chain ran on real Spark against real ADLS Delta.

## 4. Index of the rest

Follow the same three steps for any other chain — the numbering lines up across the
packs (`NN — Bronze X` → `NN — Silver X` → `NN — Gold X`).

### Bronze (28)

**Casino core (seeded):** 01 Slot Telemetry · 02 Player Profile · 03 Financial Txn ·
04 Compliance · 05 Table Games · 06 Security Events.
**Federal / public sector:** 07 Tribal Health · 08 DOT/FAA · 09 Video Analytics ·
10 People Movement · 11 Geolocation · 12 USDA · 13 SBA · 14 NOAA · 15 EPA · 16 DOI ·
18 DOJ.
**Platform patterns:** 17 Shortcut Transformations · 19 Variable Library Demo.
**Industry (50–58):** Healthcare Admissions · Financial Transactions ·
Insurance Claims · Retail POS · Manufacturing Sensors · Energy Meters · Telecom CDR ·
Pharma Trials · Media Events.

### Silver (28)

01 Slot Cleansed · 02 Player Master · 03 Table Enriched · 04 Financial Reconciled ·
05 Security Enriched · 06 Compliance Validated · 07–16, 18 the federal set ·
**40 Late-Arriving Backfill** · **41 GDPR Cascading Delete** · 50–58 the industry set
(Healthcare Cleansed, Financial Enriched, Insurance Validated, Retail Cleansed,
Manufacturing Aggregated, Energy Validated, Telecom Enriched, Pharma Validated,
Media Sessions).

### Gold (34)

00 Dim Tables · 01 Slot Performance · 02 Player 360 · 03 Compliance Reporting ·
04 Table Analytics · 05 Financial Summary · 06 Security Dashboard ·
07 Player Slot Daily · 07 Tribal Health 360 · 08 DOT/FAA Analytics ·
08 Player Table Daily · 09 Video Security KPIs · 10 Movement Analytics ·
11 Geolocation Insights · 12–16, 19 the federal analytics set ·
17 AI Functions Compliance · 18 Digital Twin Demo ·
**40 MDM Golden Customer** · **41 SCD Type-2 Dimension** ·
**42 Reference Data Versioned** · 50–58 the industry KPI set (Healthcare KPIs,
Financial Fraud Scoring, Insurance Predictions, Retail Demand Forecast,
Manufacturing OEE, Energy Grid KPIs, Telecom Churn, Pharma Outcomes,
Media Recommendations).

### ML & MLOps (8)

01 Player Churn Prediction · 02 Fraud Detection · 03 AutoML Weather Forecasting ·
04 MLOps Model Registry · 05 Drift Detection · 06 Feature Store Demo ·
07 RAG Eventhouse Vector · 08 Responsible-AI Audit.

### Streaming & CDC (9)

01 SQL Server CDC · 02 Azure SQL Change Feed · 03 Cosmos DB Change Feed ·
04 IBM DB2 CDC · 05 Oracle CDC · 06 Kafka Connector · 07 IoT Hub Ingestion ·
08 Slot Machine IoT Simulator · 01 Real-time Slot Streaming.

### Pipeline utilities (3)

Bronze Utils · Lineage Utils · Pipeline Execution Log Setup. Attach any of these to a
medallion notebook with `%run`.

### Hitchhiker's Guide (7)

00 Guide Index (which runtime am I on?) · 01 Connectivity · 02 Lakehouse/Warehouse Ops ·
03 Security & Identity · 04 Admin & Governance · 05 Automation Utilities ·
06 Troubleshooting. These are the Fabric control-plane recipes rewritten to their
Azure-native equivalents.

!!! note "One upstream artifact is not a notebook"
    `real-time/02_kql_casino_floor.kql` was converted and vendored (Fabric Eventhouse
    → Azure Data Explorer) but is **not** a notebook item — ADX querysets surface
    through the `kql-database` / `kql-dashboard` editors instead.

## 5. Verify it worked

- **Install dialog**: each notebook row `created`, naming the Synapse or Databricks
  artifact path.
- **Seed**: `POST /api/apps/supercharge/seed` returns `202`; a minute or two later
  `SHOW DATABASES` includes `lh_bronze` / `lh_silver` / `lh_gold`, and
  `Files/output/` holds the six parquet sources.
- **Chain**: the three-count cell in step 3e returns non-zero for all three tables.
- **Notebook editor**: every code cell in the walked chain shows **Succeeded**.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `The specified filesystem does not exist` on a relative `Files/…` write | The Synapse default filesystem container was never created | Loom sets `spark.hadoop.fs.azure.createRemoteFileSystemDuringInitialization=true` on **every** Livy session, so this is fixed in-product. If you hit it, you are on an old revision or running outside Loom — create the container |
| `HiveException: null path` on `SHOW DATABASES` / `saveAsTable` | Same root cause as above (the warehouse dir resolved to a missing container) | Same fix |
| `Catalog not found: lh_bronze` | A three-part read (`lh_bronze.dbo.x`) against `spark_catalog` | The generator normalizes `lh_<layer>.dbo.<table>` → `lh_<layer>.<table>`; if you hand-edited a cell, drop the `dbo.` |
| Bronze notebook reads zero rows | The seed has not completed, or this source is outside the seeded casino core | Re-fire `POST /api/apps/supercharge/seed` and wait; otherwise connect the real upstream feed |
| Silver `AnalysisException` on `_silver_timestamp` | You reverted to the upstream ordering | Order the dedup window by `_bronze_ingested_at` |
| Cells point at an unresolved `{{ADLS_ACCOUNT}}` | `LOOM_ADLS_ACCOUNT` unset | Set it — the placeholder is resolved on both the install and run paths |
| First run takes ~2 minutes before anything happens | Cold Synapse Spark pool | Expected. The warm-session indicator tells you when a pre-warmed session is available |

## Cleanup

Delete the notebook items, or the workspace. **The seeded `lh_*` databases, the
`Files/output/` parquet, and the Synapse/Databricks notebook artifacts persist** —
drop the databases and delete the artifacts if you want the storage back.

## What's next

- [Lakehouse Inspector](lakehouse-inspector.md) — the same medallion idea with a
  hand-built star schema and a profiling notebook.
- [Pipeline Designer](pipeline-designer.md) — orchestrate these notebooks on a
  schedule.
- [Editor guide — Notebook](../editor-notebook.md) — every control in the notebook
  editor.
