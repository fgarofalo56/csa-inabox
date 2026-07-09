# PRP — Fabric feature-gap closure (Azure-first)

> **Title:** Fabric feature-gap closure (Azure-first)
> **Date:** 2026-07-08
> **Status:** proposed
> **Owner:** Fabric→Loom Parity Architect
> **Sources consulted:** 4 code-grounded research streams (Data Engineering + Data Factory;
> Real-Time Intelligence + Data Science; Power BI + Fabric Databases; Platform/Governance/Admin),
> each verified via Grep/Read against `apps/fiab-console` on 2026-07-08 and grounded in Microsoft
> Learn + the 2026 Fabric blog wave (FabCon Atlanta March 2026, Feb/April/June 2026 monthly
> summaries). Prior baselines: `docs/fiab/prp/{data-engineering,data-factory,real-time-intelligence,data-science,power-bi,databases,platform,governance-security}.md`
> (2026-06-26) and `PRPs/active/fabric-parity/`.
> **Governing rules (die-hard, non-negotiable):** `.claude/rules/no-fabric-dependency.md`
> (Azure-native is the DEFAULT; Fabric/Power BI are opt-in only, never a gate),
> `.claude/rules/no-vaporware.md` (real backend + receipt per merge),
> `.claude/rules/ui-parity.md` (one-for-one usable feature parity),
> `loom_no_freeform_config` (wizards/dropdowns/canvas — never a raw JSON textarea),
> `loom_design_standards` (Fluent v9 + Loom tokens + `canvas-node-kit` for designers).
> Dual-cloud (Commercial + Government/GCC/GCC-High) is mandatory for every item.

---

## Executive summary

CSA Loom is Fabric-class analytics delivered on **pure Azure + OSS** — every Fabric item, editor,
and object runs 100% functional with **no real Microsoft Fabric capacity, no OneLake, and no Power BI
workspace**. Fabric is an opt-in alternative backend, never a dependency and never a gate. Over the
last two waves Loom closed the bulk of the mid-2026 Fabric surface: materialized lake views, copy-job,
airflow-job, user-data-functions, mirrored-database (open mirroring + Snowflake/Iceberg/BigQuery/Oracle),
spark-environment, OneLake security/shortcuts, a 21-connector Real-Time hub, ADX-native Activator on
Azure Monitor, AML-native notebooks + MLflow experiments + AutoML, calc groups / field parameters /
RLS+OLS / deployment pipelines / Git integration / report + paginated-report designers / scorecards /
Loom Apps / Cosmos+Gremlin, and a real governance/admin plane. All grep-confirmed on real Azure
backends with **zero default-path Fabric/Power BI host calls**.

This PRP captures the **genuine remaining gap** — the capabilities Fabric shipped or newly documented
through 2026-07-08 that Loom has not yet built, plus a set of PARTIALs that need deepening. Every item
below has a concrete Azure-native/OSS build recipe that honors the no-fabric-dependency rule: T-SQL and
single-node Python notebooks (Synapse Serverless / ACA-hosted kernels), Spark consumption billing +
surge/overage admission control (Synapse serverless + Databricks serverless + Azure Cost Management),
MLV incremental refresh (Delta `MERGE`), an Airflow provider of Loom-item operators, a Digital Twin
Builder (ADX-graph default, ADT opt-in), Activator stateful trigger depth (Monitor metric alerts with
dimension splitting + ADX anomaly queries), Data Wrangler + SemPy + batch-PREDICT for data science,
Azure SQL PITR, variable-library-aware promotion, a real chargeback report, and cross-tenant external
sharing (Entra B2B + scoped ADLS grant). Nothing here reintroduces a Fabric requirement.

**Documentation-hygiene note (do this first, not tracked as a build item):** the 2026-06-26 PRPs
`power-bi.md`, `databases.md`, `platform.md`, `governance-security.md`, `data-engineering.md`, and
`data-science.md` are now **stale** — a large share of rows they mark 🟡/❌/🔶 are verified BUILT in
code (e.g. calc groups, field parameters, RLS/OLS/test-as-role, automatic aggregations, deployment
pipelines + Git integration, report/paginated-report designers, scorecards, Loom Apps, Cosmos/Gremlin,
mirrored-database multi-source, `govern-admin.tsx`/`govern-owner.tsx`). **Re-verify those PRPs
row-by-row against current code before scheduling any further Wave work off their task numbers**, so
effort isn't spent re-implementing shipped features.

---

## Work items

| # | Item | Domain | State | Priority | Effort |
|---|------|--------|-------|----------|--------|
| FGC-01 | T-SQL Notebook (Spark-free, SQL-endpoint) | Data Eng | MISSING | P2 | M |
| FGC-02 | Python-only single-node Notebook (DuckDB/Polars) | Data Eng | MISSING | P2 | L |
| FGC-03 | Materialized Lake Views — incremental + multi-schedule + cross-workspace lineage | Data Eng | PARTIAL | P2 | M |
| FGC-04 | Semantic Model Refresh pipeline activity | Data Factory | MISSING | P2 | S |
| FGC-05 | Airflow native Loom-item operators | Data Factory | PARTIAL | P2 | L |
| FGC-06 | Dataflow Gen2 Fast Copy path | Data Factory | MISSING | P3 | M |
| FGC-07 | OneLake cross-workspace security-role management | OneLake | PARTIAL | P3 | M |
| FGC-08 | Spark consumption/autoscale billing + max-spend cap | Data Eng | PARTIAL | P2 | L |
| FGC-09 | Native Execution Engine honest-gate + Photon opt-in | Data Eng | MISSING | P3 | S |
| FGC-10 | High-concurrency Spark session pooling | Data Eng | PARTIAL | P3 | L |
| FGC-11 | Developer tooling — `loom-cli` + VS Code extension | Dev Platform | MISSING | P2 | XL |
| FGC-12 | Digital Twin Builder item (ADX-native default, ADT opt-in) | RTI | MISSING | P1 | XL |
| FGC-13 | Activator trigger-model depth (Event/Split/Property rules) | RTI | PARTIAL | P1 | L |
| FGC-14 | Real-Time hub new source connectors + curated samples | RTI | PARTIAL | P2 | M |
| FGC-15 | Eventstream DeltaFlow analytics-ready CDC transform | RTI | MISSING | P2 | M |
| FGC-16 | Data Wrangler in-notebook (AI-assisted prep) | Data Science | PARTIAL | P1 | L |
| FGC-17 | Semantic link / SemPy (`LoomDataFrame`) | Data Science | MISSING | P2 | L |
| FGC-18 | Batch model scoring (PREDICT-equivalent) | Data Science | MISSING | P2 | M |
| FGC-19 | AI Functions breadth + model-tier selector | Data Science | PARTIAL | P3 | S |
| FGC-20 | Azure SQL Database PITR / restore points | Databases | MISSING | P1 | M |
| FGC-21 | Standalone DAX query view | Power BI | PARTIAL | P2 | S |
| FGC-22 | Copilot autonomous model-health scan + apply-fix | Power BI | PARTIAL | P2 | M |
| FGC-23 | Mirrored-database native CDC copy-job | Databases | PARTIAL | P3 | M |
| FGC-24 | Variable-library-aware deployment-pipeline promotion | Platform/ALM | DONE (Wave 8) | P1 | M |
| FGC-25 | Capacity surge protection (admission control) | Admin | MISSING | P1 | M |
| FGC-26 | Capacity overage toggle | Admin | MISSING | P2 | S |
| FGC-27 | Capacity health + timepoint summary/detail | Admin | MISSING | P2 | M |
| FGC-28 | Chargeback report page | Admin | PARTIAL | P1 | M |
| FGC-29 | Copilot capacity (AOAI) designation + isolated spend | Admin | MISSING | P3 | S |
| FGC-30 | External (cross-tenant) data sharing | Governance | MISSING | P1 | L |
| FGC-31 | Workspace create wizard (multi-step) + settings flyout | Admin | PARTIAL | P2 | M |

**Suggested sequencing.** P1 first (FGC-12/13/16/20/24/25/28/30), grouped by build agent per domain;
P2 second; P3 as fill. Merge-note dedupes already applied: the Digital-Twin finding appears in two
streams (RTI + Databases) and is unified in **FGC-12**; the loom-cli / fabric-cli / VS Code findings are
unified in **FGC-11**; the Synapse-cost-cap and Databricks-serverless-billing findings are unified in
**FGC-08**.

---

## FGC-01 — T-SQL Notebook

**Capability.** A dedicated T-SQL-only notebook item whose cells run directly against a SQL endpoint
(Warehouse / Lakehouse SQL analytics endpoint) with **no Spark/Livy session** at all.

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-engineering/author-tsql-notebook
- https://blog.fabric.microsoft.com/en-us/blog/announcing-public-preview-of-t-sql-notebook-in-fabric/

**Current Loom state — MISSING.** No `tsql-notebook` item type exists; grep across `apps/fiab-console`
returns zero files. `synapse-notebook-editor.tsx` supports only PySpark/SQL-magic/Scala/SparkR cells,
always bound to a Spark/Livy session — there is no Spark-free T-SQL notebook.

**Azure-first build.**
- **Backend:** Synapse Serverless SQL pool (or Azure SQL DB) — no Livy, no Spark. Reuse
  `synapse-sql-client` / `azure-sql-client`.
- **BFF route:** `app/api/items/tsql-notebook/[id]/execute/route.ts` posts a cell's T-SQL to the SQL
  client and streams the result grid.
- **UI:** new `lib/editors/tsql-notebook-editor.tsx` reusing the existing `tsql-monaco.tsx` editor +
  a result grid; cell add/run/reorder like the Spark notebook but SQL-only.
- **Catalog wiring:** register in `lib/catalog/fabric-item-types.ts` + `lib/editors/registry.ts`.
- **Scheduling:** invoke via the existing pipeline Script/StoredProcedure activity or a new trigger
  binding — no new scheduler.
- **Bicep:** none new (Synapse Serverless GA in all clouds). **Gov:** Serverless SQL is GA
  Commercial + Gov.

**Acceptance (no-vaporware receipt).** Create a `tsql-notebook`, run `SELECT TOP 10 * FROM <delta table>`
against the Serverless endpoint **with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET**; receipt shows real rows
returned by the SQL client (first 300 chars) + a browser screenshot of the grid.

**Priority P2 · Effort M.**

---

## FGC-02 — Python-only single-node Notebook

**Capability.** A lightweight single-node notebook (DuckDB/Polars/scikit-learn kernel, ~2 vCore/16 GB
default) with no Spark cluster, so small-data / low-cost workloads don't pay full Spark-pool cost.
`%run` module reuse preserved.

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-engineering/using-python-experience-on-notebook
- https://blog.fabric.microsoft.com/en/blog/python-notebook-public-preview

**Current Loom state — MISSING.** Only the Spark notebook item exists
(`synapse-notebook-editor.tsx` + `provisioners/notebook.ts`), always targeting a Synapse Spark pool via
Livy; no single-node Python kernel option — small jobs overpay.

**Azure-first build.**
- **Backend:** a **compute-mode toggle** on the existing notebook item — `Spark` (current Livy path)
  vs `Python (single-node)`. The Python path runs on a scale-to-zero **ACA Job / ACI** with a Jupyter
  kernel pre-loaded with `duckdb`/`polars`/`scikit-learn`, billed only for container runtime.
- **Client + route:** `lib/azure/python-kernel-client.ts` +
  `app/api/notebook/[id]/python-execute/route.ts`.
- **UI:** compute-mode dropdown in the notebook toolbar; same notebook artifact schema; `%run` maps to a
  script include from the workspace ADLS path.
- **Bicep:** ACA Job (Python-kernel image) + ACR image; scale-to-zero. **Gov:** ACA GA Commercial + Gov.

**Acceptance.** Toggle a notebook to Python mode, run a DuckDB/Polars cell over a Delta/Parquet file;
receipt shows the ACA-Job execution result + a Cost Management line proving no Spark-pool charge.

**Priority P2 · Effort L.**

---

## FGC-03 — Materialized Lake Views: incremental + multi-schedule + cross-workspace lineage

**Capability.** MLV feature-completeness to match Fabric's March-2026 GA: **incremental refresh**,
**multiple named schedules per view** (beyond one ADF trigger), and **extended cross-workspace lineage**
(recursively trace across lakehouses in other workspaces).

**Source grounding.**
- https://community.fabric.microsoft.com/t5/Fabric-Updates-Blog/Materialized-Lake-Views-in-Microsoft-Fabric-Generally-Available/ba-p/5172223
- https://learn.microsoft.com/en-us/fabric/data-engineering/materialized-lake-views/view-lineage

**Current Loom state — PARTIAL.** `materialized-lake-view-engine.ts` implements full-refresh only
(comment: "full refresh (the only mode PySpark MLVs…)"); `materialized-lake-view-model.ts` types
`MlvRefreshMode = 'full' | 'incremental'` but incremental is unimplemented; `materialized-lake-view-editor.tsx`
has a single Refresh tab wired to one ADF pipeline; `mlv-lineage.ts` is within-workspace Cosmos-derived only.

**Azure-first build.**
- **Incremental:** MLV driver detects a watermark/partition column and emits Delta `MERGE INTO` instead
  of full overwrite via the existing Livy/Spark batch path; reuse the **Copy-Job watermark-in-Azure-SQL**
  pattern (already built) for MLV state tracking.
- **Multi-schedule:** extend the ADF-pipeline generator (`adf-pipeline/route.ts`) to create N schedule
  triggers per MLV instead of one; UI adds a named-schedules list to the Refresh tab.
- **Cross-workspace lineage:** extend `mlv-lineage.ts` to cross-query Cosmos `items` across every
  workspace the caller has RBAC on, unioned into the existing React-Flow lineage drawer (reuse the
  OneLake T10 lineage component).
- **Bicep:** none new. **Gov:** ADLS+Delta+Synapse Spark all GA both clouds.

**Acceptance.** Configure an MLV with a watermark column + two schedules; receipt shows a `MERGE`-based
incremental run (only changed partitions rewritten), both triggers created in ADF, and a lineage graph
that includes an upstream table in a second workspace.

**Priority P2 · Effort M.**

---

## FGC-04 — Semantic Model Refresh pipeline activity

**Capability.** A dedicated pipeline activity type that refreshes a semantic model, table/partition-scoped,
with wait-on-completion.

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-factory/semantic-model-refresh-activity
- https://endjin.com/blog/refresh-semantic-model-fabric-pipelines

**Current Loom state — MISSING.** Full read of `lib/components/pipeline/activity-catalog.ts` (~30
activity keys: Copy, DataflowGen2, ExecuteDataFlow, Lookup, GetMetadata, Delete, Notebook, SparkJob,
ExecutePipeline, Script, StoredProcedure, HDInsight×5, SynapseNotebook, Databricks×2, AzureFunction,
AzureML×2, USQL, Web, Webhook, ApprovalWebhook, Fail, Validation, Office365Outlook, Set/AppendVariable,
Filter, ForEach, IfCondition, Switch, Until, Wait) has **no** semantic-model / Analysis-Services refresh
entry.

**Azure-first build.**
- Add activity key `SemanticModelRefresh` (category orchestration), `type: 'WebActivity'` wrapping a call
  to **Loom's own semantic-model item refresh route** (over Azure Analysis Services if bound, else the
  AAS-less tabular refresh already built for the report designer) — **never** a Power BI / Fabric call.
- **UI:** table/partition-scope picker + "wait for completion" toggle in `activity-forms.tsx`.
- **Bicep:** none. **Gov:** targets Loom's semantic layer; no cloud-specific dependency.

**Acceptance.** Add the activity to a pipeline, point it at a Loom semantic-model item, run it; receipt
shows the tabular refresh completing (partition-scoped) with the pipeline waiting on it — no
`api.powerbi.com` call in the network trace.

**Priority P2 · Effort S.**

---

## FGC-05 — Airflow native Loom-item operators

**Capability.** First-class Airflow operators to run Loom items as DAG tasks (Notebook, Spark Job
Definition, Pipeline, Semantic Model, User Data Function, Copy Job, dbt) instead of hand-written
Python/Bash HTTP boilerplate.

**Source grounding.**
- https://blog.fabric.microsoft.com/en-US/blog/announcing-the-latest-innovations-in-fabric-data-factory-apache-airflow-jobs-and-pipelines/
- https://learn.microsoft.com/en-us/fabric/data-factory/apache-airflow-jobs-run-fabric-item-job

**Current Loom state — PARTIAL.** The `airflow-job` item exists end-to-end (editor + `route.ts` +
`dags/route.ts` + `connection/route.ts`) but DAGs are authored generically — grep for
`Loom*Operator`/`Fabric*Operator` in `airflow-job-editor.tsx` returns zero matches (matches the memory
note "wrangler/airflow honest-gate"). No first-class "run this Loom item" operator picker.

**Azure-first build.**
- Ship a small Loom-authored Airflow provider package (pip-installable into the managed Airflow-on-ACA
  runtime already used by the item) exposing `LoomNotebookOperator`, `LoomSparkJobDefinitionOperator`,
  `LoomPipelineOperator` (wraps ADF `createRun`), `LoomUserDataFunctionOperator` (invokes the UDF REST
  endpoint), `LoomCopyJobOperator`, and a generic `LoomDbtOperator` (`dbt run` against the lakehouse
  Synapse Serverless endpoint via a container step).
- **UI:** a DAG-task template picker in `airflow-job-editor.tsx` so authors pick an item + operator
  instead of writing HTTP calls (honors `loom_no_freeform_config`).
- **Bicep:** package baked into the Airflow-on-ACA image. **Gov:** ACA + OSS Airflow both clouds.

**Acceptance.** Author a DAG via the picker with a `LoomNotebookOperator` task; receipt shows the DAG
run triggering a real notebook execution and the task succeeding on the ACA Airflow runtime.

**Priority P2 · Effort L.**

---

## FGC-06 — Dataflow Gen2 Fast Copy path

**Capability.** A high-throughput bulk-copy path within Dataflow Gen2 that bypasses the mashup engine
for simple source→destination moves.

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-factory/dataflows-gen2-overview
- https://community.fabric.microsoft.com/t5/Fabric-Updates-Blog/Benchmarking-Dataflow-Gen2-Faster-data-transformation-at-lower/ba-p/5189072

**Current Loom state — MISSING.** Grep for `fast.?copy`/`fastCopy` returns zero files;
`dataflow-gen2-editor.tsx` (built on ADF Mapping Data Flow) has no dedicated bulk/fast path distinct from
the standard mashup-engine execution.

**Azure-first build.**
- Add a detection heuristic to the M-to-pipeline compiler in `power-query-host.tsx`'s run route: when the
  authored query is a simple 1:1 move with no transform (or only column-select/rename), route execution
  to ADF's plain **Copy activity** (high-DIU, parallel-partition — already built) instead of compiling a
  Mapping Data Flow. Mirrors Fast Copy's skip-the-heavy-engine behavior.
- **UI:** surface a "Fast copy eligible" badge when detected. **Bicep:** none. **Gov:** ADF both clouds.

**Acceptance.** Author a select-only Dataflow Gen2 to a lakehouse table; receipt shows the run using the
Copy activity path (not Mapping Data Flow) with a measurably higher throughput/lower DIU.

**Priority P3 · Effort M.**

---

## FGC-07 — OneLake cross-workspace security-role management

**Capability.** Assign one OneLake security role across items in **multiple workspaces** from a single
Secure-tab flow (Fabric preview, ~April 2026).

**Source grounding.**
- https://community.fabric.microsoft.com/t5/Fabric-Updates-Blog/Cross-workspace-role-management-in-the-OneLake-catalog-Preview/ba-p/5192072
- https://www.jamesserra.com/archive/2026/07/understanding-microsoft-fabric-onelake-security/

**Current Loom state — PARTIAL.** `onelake-security-rules.ts` + `onelake-security-tab.tsx` implement
per-item roles (Type/Permission/Scope/Members), but grep for `crossWorkspace` returns zero matches —
assignment is single-item/single-workspace only.

**Azure-first build.**
- Extend the Secure-tab role-assignment dialog to accept a multi-item, multi-workspace target set (query
  Cosmos `items` across every workspace the caller has Contributor+ on) and batch-apply the same
  scope/permission/member set to each target's role store in **one Cosmos transactional batch write**.
- **Bicep:** none. **Gov:** Cosmos + ADLS ACL both clouds.

**Acceptance.** Select 3 items across 2 workspaces, assign one role in a single submit; receipt shows the
batch write and each item's role store carrying the new assignment.

**Priority P3 · Effort M.**

---

## FGC-08 — Spark consumption/autoscale billing + max-spend cap

**Capability.** Consumption-based Spark billing decoupled from base capacity — pay-as-you-go per
vCore/DBU-second, a **max-spend cap** that kills runaway jobs, and a **billing-mode selector**
(Reserved pool vs Autoscale PAYG). (Merges the two research findings: Synapse cost-cap + Databricks
serverless billing mode.)

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-engineering/autoscale-billing-for-spark-overview
- https://blog.fabric.microsoft.com/en-us/blog/now-generally-available-autoscale-billing-for-spark-in-microsoft-fabric/
- https://learn.microsoft.com/en-us/fabric/data-engineering/billing-capacity-management-for-spark

**Current Loom state — PARTIAL.** `spark-environment-editor.tsx` has cluster-size autoscale
(`nodeSizeFamily`/`autoscaleEnabled`/min/max nodes) but no consumption-billing model or spend cap; grep
for `autoscale.*billing`/`autoScaleBilling` returns zero. `spark-compute.tsx` wires Databricks pools but
has no PAYG-vs-reserved billing-mode toggle.

**Azure-first build.**
- **Billing-mode selector** on the spark-environment / spark-compute Pool tab: `Reserved pool` vs
  `Autoscale PAYG`. Autoscale PAYG provisions **Databricks serverless** (per-DBU-second) or **Synapse
  on-demand** (per-vCore-second) via ARM instead of a fixed pool.
- **Max-spend cap:** persist a `maxSpendCap` on the environment doc; a new `consumption-client.ts` pulls
  live vCore/DBU-hour spend from the **Azure Cost Management** API scoped to the Synapse/Databricks
  resource; when a run exceeds the cap mid-flight, an Azure Monitor action group fires and
  `synapse-livy-client.killSession` (or the Databricks jobs API) terminates it.
- **Honest-gate** when Cost Management Reader is absent (per no-vaporware).
- **Bicep:** Cost Management Reader role for the Console UAMI. **Gov:** Cost Management + Databricks +
  Synapse GA both clouds.

**Acceptance.** Set a low cap, launch a job that exceeds it; receipt shows live spend from Cost
Management, the Monitor alert firing, and the Livy/Databricks session auto-killed — plus the honest-gate
MessageBar when the role is missing.

**Priority P2 · Effort L.**

---

## FGC-09 — Native Execution Engine honest-gate + Photon opt-in

**Capability.** Fabric's vectorized native (non-JVM) execution engine. This is genuinely Fabric-proprietary
with no OSS/Azure equivalent — handle honestly, do not fake.

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-engineering/billing-capacity-management-for-spark
- https://radacad.com/fabric-spark-custom-live-pools-resource-profiles-performance-fixes-a-conversation-with-santhosh-kumar-ravindran-fabric-insider-ep-4/

**Current Loom state — MISSING.** Grep for `nativeExecutionEngine`/`Photon` returns zero;
`spark-environment-editor.tsx`'s Runtime tab has no acceleration-engine toggle (unlike the already-shipped
V-Order/Autotune honest gate, `data-engineering.md` F22/T13).

**Azure-first build.**
- Follow the exact V-Order/Autotune T13 pattern: add a **disabled** "Native execution engine" toggle in
  the Runtime tab with a Fluent `MessageBar intent="warning"`: "Fabric-only acceleration; the Azure path
  uses standard Spark/JVM execution. For comparable vectorized gains, opt into Databricks
  (`LOOM_NOTEBOOK_BACKEND=databricks`) to get Photon." Keeps parity honest without vaporware.
- **Bicep:** none. **Gov:** copy identical both clouds.

**Acceptance.** Runtime tab renders the disabled toggle + the exact MessageBar; enabling Databricks
backend surfaces Photon as the real acceleration path.

**Priority P3 · Effort S.**

---

## FGC-10 — High-concurrency Spark session pooling

**Capability.** Real session-sharing across multiple notebooks / pipeline notebook-activities on one
Spark cluster (reduces startup + cost) — not just advisory text.

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-engineering/spark-best-practices-capacity-planning
- https://learn.microsoft.com/en-us/fabric/data-engineering/billing-capacity-management-for-spark

**Current Loom state — PARTIAL.** `lib/components/notebook/session-config-dialog.tsx` (~L117-118) shows
only a static advisory MessageBar; there is no actual shared/pooled Livy session.

**Azure-first build.**
- Implement real session pooling in `synapse-livy-client.ts`: keep a keyed pool of live Livy sessions per
  `(pool, environment)`; a second notebook/activity attaches to an existing idle session (Livy allows
  multiple statements per session) instead of creating a new one.
- **UI:** a "High concurrency" toggle on the spark-environment item opting sessions into the shared pool
  with a max-concurrent-notebooks cap; the session status pill shows the shared session id + attached
  notebook count.
- **Bicep:** none. **Gov:** Synapse Livy both clouds.

**Acceptance.** Open two notebooks against the same environment with high-concurrency on; receipt shows
both attaching to one Livy session id (no second session created) and the status pill reflecting the
attached count.

**Priority P3 · Effort L.**

---

## FGC-11 — Developer tooling: `loom-cli` + VS Code extension

**Capability.** Local-dev parity — a CLI (fabric-cli/`fab deploy`-equivalent) and a minimal VS Code
extension to edit/run/deploy notebooks, pipelines, SJDs, UDFs, Airflow DAGs, and deployment pipelines from
a terminal/IDE, not just the web console. (Merges the two CLI/IDE findings across streams.)

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-factory/apache-airflow-jobs-manage-vs-code
- https://pypi.org/project/fabric-user-data-functions/

**Current Loom state — MISSING.** No CLI package, VS Code manifest, or local artifact export/import beyond
the data-factory pipeline `.zip` round-trip (Task 7); no IDE integration anywhere.

**Azure-first build.**
- **`loom-cli`** (Node/TS, npx-installable) authenticates via the same session/MSAL flow as the console and
  wraps existing BFF routes: `loom-cli notebook pull/push <id>`, `loom-cli pipeline pull/push`,
  `loom-cli sjd run`, `loom-cli udf invoke`, `loom-cli airflow dag push`, and the **P2 core**
  `loom-cli deploy --pipeline <id> --stage prod` (wraps `POST /api/deployment-pipelines/loom/[id]/deploy`
  with a minted UAMI/SP token) — the fabric-cicd `fab deploy` analog.
- **VS Code extension (P3 stretch):** minimal extension shelling out to `loom-cli` (no bespoke LSP).
- **Optional:** a `loom-cicd` GitHub Action / ADO task calling the same deploy endpoint for
  pipeline-as-code parity.
- **Bicep:** none (client over shipped routes). **Gov:** MSAL/token flow both clouds.

**Acceptance.** `loom-cli deploy --pipeline <id> --stage prod` promotes a pipeline stage end-to-end;
receipt shows the CLI-driven deploy landing the item in the destination workspace. `notebook pull/push`
round-trips a notebook.

**Priority P2 · Effort XL.**

---

## FGC-12 — Digital Twin Builder item (ADX-native default, ADT opt-in)

**Capability.** A low-code ontology item — model assets/processes and relationships, map batch + real-time
data sources onto them, query via KQL, and act via Activator. Fabric's newest RTI item (Public Preview,
GA-track 2026). **Unified from two research findings (RTI + Databases streams).**

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/real-time-intelligence/digital-twin-builder/overview
- https://learn.microsoft.com/en-us/fabric/real-time-intelligence/digital-twin-builder/tutorial-0-introduction
- https://learn.microsoft.com/en-us/fabric/real-time-intelligence/digital-twin-builder/tutorial-rti-2-get-streaming-data

**Current Loom state — MISSING.** No item type/editor/provisioner; the only repo hits are marketing copy
(`app-supercharge-gold.ts`, `catalog-meta.ts`) and a notebook demo
(`examples/supercharge-fabric/notebooks/gold/18_gold_digital_twin_demo.py`). Building blocks already
exist to reuse: Fabric-IQ ontology (`lib/catalog/item-types/fabric-iq.ts`), ADX-native graph
(`gql-graph`, per memory `csa_loom_graph_adx`), Cosmos Gremlin (`gremlin-client.ts`,
`gremlin-graph-canvas.tsx`).

**Azure-first build (no new mandatory Azure service — honors no-fabric-dependency).**
- **Default backend = ADX-native graph.** New item type `digital-twin` (register in
  `fabric-item-types.ts` + `editors/registry.ts`). Low-code wizard: pick source items
  (lakehouse/warehouse/KQL DB tables) → map to ontology entities/relationships (reuse the Fabric-IQ
  ontology editor's entity/relationship model) → materialize as an **ADX graph** via `kusto-client` +
  `gql-graph make-graph` for queryable twin exploration; twin state history is queryable via KQL on the
  existing Eventhouse, and property-change conditions flow to the existing Activator.
- **Opt-in alternate = Azure Digital Twins (ADT).** Behind a flag for teams wanting the DTDL/twin-instance
  model: new `adt-client.ts` (DTDL model CRUD, twin CRUD, event-route to Event Grid/Event Hub); ADT
  event route feeds the same Eventhouse + Activator. **Never the default** so no new mandatory service.
- **UI:** `lib/editors/digital-twin-builder-editor.tsx` with a `@xyflow/react` / `canvas-node-kit` canvas
  for model authoring + a source-mapping wizard.
- **BFF:** `app/api/items/digital-twin/[id]/{models,twins,relationships,event-route}`.
- **Bicep (opt-in path only):** `adt-instance.bicep` + Azure Digital Twins Data Owner for the Console UAMI
  + Event Grid system topic. **Gov:** ADX-native path GA both clouds; ADT is FedRAMP High authorized —
  verify IL5/IL6 region list via ARM at build time.
- **Coordinate** with the RTI PRP owner to avoid duplicate item-type registration.

**Acceptance.** Model a 2-entity ontology, map an eventstream + a lakehouse table onto it, materialize the
ADX graph **with Fabric unset**; receipt shows a `graph-match`/openCypher query returning twin
relationships and an Activator rule firing on a twin property change — all on ADX, no Fabric call. The ADT
opt-in path proven separately with the flag set.

**Priority P1 · Effort XL.**

---

## FGC-13 — Activator trigger-model depth

**Capability.** Event Rules / Split-Event Rules / Property Rules with per-object grouping (group by
`device_id`/`asset_id`) and stateful change-detection (BECOMES, INCREASES, DECREASES, EXIT RANGE,
heartbeat/absence-of-data) — vs today's flat per-message comparison.

**Source grounding.**
- https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-trigger-model
- https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-introduction

**Current Loom state — PARTIAL.** `lib/editors/phase3-editors.tsx:9297` exposes only flat operators
(`GreaterThan…Equals…BecomesTrue…ChangesTo`) mapped 1:1 to an Azure Monitor scheduled-query alert
(L9179); no object-key grouping, no property-over-time trend rule, no heartbeat/no-data rule kind.

**Azure-first build (no new Azure resource — query-authoring depth on existing Monitor + ADX).**
- Add a **rule-kind selector** (Event Rule | Split-Event Rule | Property Rule) to the `activator` editor +
  `monitor-client.ts`/`activator-monitor.ts` backend. Property Rule adds an **object-key** field (groups
  incoming Eventstream/ADX rows by a chosen column) and a condition-type dropdown
  (Becomes / Increases-by / Decreases-by / Exits-range / No-data-for) that compiles to either:
  - an **Azure Monitor metric alert with dimension splitting** (object key = alert dimension) for
    stateless per-object thresholds, or
  - an **ADX materialized-view + scheduled-query** using `prev()` / `series_decompose_anomalies` for
    trend/heartbeat detection needing sub-minute per-object state.
- **UI:** dropdowns/pickers only (honors `loom_no_freeform_config`). **Bicep:** none. **Gov:** Monitor +
  ADX both clouds.

**Acceptance.** Author a Property Rule grouped by `device_id` with a "Decreases by 10% / No data for 5m"
condition; receipt shows the compiled Monitor dimension-split alert (or ADX anomaly query) and the alert
firing per object.

**Priority P1 · Effort L.**

---

## FGC-14 — Real-Time hub new source connectors + curated samples

**Capability.** Add the 2025-2026 Real-Time-hub sources missing from the catalog — MongoDB CDC, Oracle
Database CDC, HTTP, Solace PubSub+, Real-time weather — and replace the free-text sample-data field with a
curated named catalog (Bicycles/Yellow Taxi/Stock Market/Buses/S&P 500/Semantic Model Logs).

**Source grounding.**
- https://learn.microsoft.com/fabric/real-time-hub/supported-sources
- https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-manage-eventstream-sources
- https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-mongodb-change-data-capture
- https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-oracle-database-change-data-capture

**Current Loom state — PARTIAL.** `lib/components/realtime-hub/source-catalog.ts` `SOURCE_CONNECTORS` (21
entries) covers Event Hubs/IoT Hub/Service Bus, SQL/MI/Cosmos/Postgres/MySQL CDC, Kafka family, Kinesis,
GCP Pub/Sub, MQTT, Fabric events, Blob/Event Grid events, custom-endpoint, and one generic free-text
`sample-data` entry — but no MongoDB CDC, Oracle CDC, HTTP, Solace, or weather, and samples are free text.

**Azure-first build.**
- **MongoDB CDC / Oracle CDC:** Loom `connections` feeding an ADF/Synapse CDC pipeline into Event Hubs
  (Azure has no native Mongo/Oracle CDC service — OSS **Debezium-on-ACA** / GoldenGate fallback).
- **HTTP source:** Loom-native polling/webhook ingester
  (`app/api/realtime-hub/http-source/route.ts`) feeding an Event Hub.
- **Solace PubSub+:** reuse the MQTT connector's AMQP/MQTT TLS/mTLS fields.
- **Real-time weather:** a scheduled Azure Function pulling a public weather API into an Event Hub
  (document as OSS/public-API backed — no paid Azure weather service).
- **Samples:** replace the free-text field with a `kind:'select'` of curated Loom-generated sample streams
  (reuse seed-data generators or 3-4 Blob-served CSV/JSON fixtures) — honors `loom_no_freeform_config`.
- **Bicep:** Debezium-on-ACA (Mongo/Oracle), weather Function. **Gov:** Event Hubs/Functions/ACA both
  clouds; document any public-API egress for Gov.

**Acceptance.** Add each new connector and land events in an Event Hub; receipt per connector shows real
events flowing (e.g. a Mongo change captured via Debezium→Event Hub) + the curated sample dropdown
producing a live stream.

**Priority P2 · Effort M.**

---

## FGC-15 — Eventstream DeltaFlow analytics-ready CDC transform

**Capability.** A CDC schema-handling mode that auto-transforms raw CDC events into analytics-ready
streams (insert/update/delete enrichment, auto-managed destination tables, automatic schema evolution) vs
the "Raw CDC events" mode.

**Source grounding.**
- https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-postgresql-database-change-data-capture
- https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-azure-sql-managed-instance-change-data-capture

**Current Loom state — MISSING.** No "DeltaFlow"/schema-handling-mode toggle in the CDC connector paths;
CDC entries capture only table/container name + a connection picker.

**Azure-first build.**
- Add a schema-handling step to each CDC SourceConnector (SQL/MI/Postgres/MySQL/Cosmos): **Raw CDC
  events** (today) vs **Analytics-ready (DeltaFlow-equivalent)**, which additionally runs a **Stream
  Analytics job** (or ADF mapping data flow) normalizing the CDC envelope into change-type + timestamp
  columns and auto-creating/evolving the destination Delta table schema in ADLS via `delta-rs` schema
  merge — mirrors DeltaFlow without OneLake.
- **Bicep:** Stream Analytics job. **Gov:** Stream Analytics + ADLS both clouds.

**Acceptance.** Configure a SQL CDC source in Analytics-ready mode, apply a schema change at source;
receipt shows the destination Delta table auto-evolving and normalized change-type columns.

**Priority P2 · Effort M.**

---

## FGC-16 — Data Wrangler in-notebook

**Capability.** An interactive AI-assisted data-prep grid inside the notebook: rule-based suggested
operations (PROSE-style), Copilot NL-to-code with preview/apply/discard, and an exportable operation
history.

**Source grounding.**
- https://community.fabric.microsoft.com/t5/Data-Science-Community-Blog/Data-Wrangler-in-Microsoft-Fabric-A-No-Code-Approach-to-Faster/ba-p/5126293
- https://learn.microsoft.com/en-us/fabric/data-science/data-wrangler-ai
- https://blog.fabric.microsoft.com/en-US/blog/enhance-data-prep-with-ai-powered-capabilities-in-data-wrangler-preview/

**Current Loom state — PARTIAL.** `lib/editors/components/delta-preview-grid.tsx` (L4-6) claims Data
Wrangler parity but is a **read-only** Fluent DataGrid with column-summary stats only — no operation
history, no suggested-operations panel, no NL code-gen; and it lives in the Lakehouse editor, not the
notebook.

**Azure-first build (no new Azure resource — reuses AOAI + the existing Jupyter execute pipeline).**
- Build `lib/components/notebook/data-wrangler-panel.tsx`, opened from a DataFrame cell output:
  - **Left:** operation history list (each = one applied pandas/PySpark op, undo-able).
  - **Center:** the `delta-preview-grid` table with per-column summary stats.
  - **Right, two tabs:** "Suggested operations" (rule-based heuristics — drop-nulls, dedupe, type-coerce,
    outlier-flag — computed client-side or via `/api/notebook/[id]/wrangler-suggest`) and "Describe a
    change" (NL prompt → Azure OpenAI generates a pandas/PySpark snippet via `resolveAoaiTarget`, shown as
    a diff preview; **Apply** inserts it as a real notebook cell via the existing Jupyter execute route).
- **Bicep:** none. **Gov:** AOAI + Jupyter both clouds.

**Acceptance.** Open Wrangler on a DataFrame, apply a suggested drop-nulls op + an NL-generated transform;
receipt shows the generated code applied as a real cell, the grid updating, and the operation history
exportable as code.

**Priority P1 · Effort L.**

---

## FGC-17 — Semantic link / SemPy (`LoomDataFrame`)

**Capability.** A notebook-facing Python library — a pandas subclass carrying semantic-model lineage,
`add_measure()` to pull DAX measures into Python, and relationship discovery/validation.

**Source grounding.**
- https://learn.microsoft.com/fabric/data-science/semantic-link-overview
- https://learn.microsoft.com/fabric/data-science/semantic-link-validate-relationship
- https://learn.microsoft.com/fabric/data-science/semantic-link-service-principal-support

**Current Loom state — MISSING.** Grep for `sempy`/`semantic.link` hits only `copilot-orchestrator.ts`,
`tabular-eval-client.ts`, `tabular-model.ts`, `tabular-read-tool.ts` — these back the semantic-model
editor's own DAX/Copilot, not a notebook-importable library. No `FabricDataFrame` equivalent,
`add_measure()`, or relationship-validation helper.

**Azure-first build (no new Azure resource — reuses AAS/Loom semantic layer + notebook identity).**
- Ship a Loom-authored pip package `loom-semantic-link` (installed into the AML Compute Instance conda env
  via the curated AML Environment) exposing:
  - `LoomDataFrame(pd.DataFrame)` with `.add_measure(model_id, measure_name)` — calls the existing
    AAS/semantic-model DAX evaluation backend (`tabular-eval-client.ts` exposed as a small internal REST
    the notebook calls).
  - `.list_relationships()` / `.validate_relationships()` against the Loom semantic-model's stored
    relationship metadata.
- Auth via the notebook's existing managed-identity/session token — no separate SP flow.
- **Bicep:** package in the AML Environment. **Gov:** AAS-native or Loom-native tabular both clouds.

**Acceptance.** From a notebook cell, `LoomDataFrame(...).add_measure(<model>, 'Total Sales')` returns the
DAX-evaluated column; `.validate_relationships()` flags a broken relationship — receipt shows real values
from the semantic layer, no Power BI call.

**Priority P2 · Effort L.**

---

## FGC-18 — Batch model scoring (PREDICT-equivalent)

**Capability.** Score a registered ML model over a table without opening a notebook — the SynapseML
PREDICT outcome via a guided wizard.

**Source grounding.**
- https://learn.microsoft.com/fabric/data-science/model-scoring-predict
- https://learn.microsoft.com/fabric/data-science/low-code-automl

**Current Loom state — MISSING.** Grep for `SynapseML PREDICT`/`predict_udf`/warehouse-PREDICT returns
zero; the `ml-model-editor` and `warehouse-editor` have no batch-scoring action wiring a registered AML
model into a callable scoring step.

**Azure-first build.**
- Add a "Score with model" action to the ml-model editor and the Synapse/warehouse table context menu.
  BFF `app/api/aml/models/[id]/score-batch/route.ts`: (a) read the model's MLflow signature; (b) submit a
  **Synapse Spark batch job** (or AML batch endpoint) invoking `mlflow.pyfunc.spark_udf()` against the
  source table in the Synapse dedicated pool / lakehouse Delta table; (c) write results to a
  wizard-named target table.
- **Honest disclosure:** document that Synapse dedicated pools don't support arbitrary Python UDFs as
  in-query T-SQL scalar functions, so scoring runs as a guided batch job rather than a literal SQL
  `PREDICT()` — no vaporware claim of in-query scoring.
- **Bicep:** none new (Synapse Spark / AML already provisioned). **Gov:** Synapse + AML both clouds.

**Acceptance.** Register a model, run "Score with model" against a table; receipt shows the batch job
producing a scored output table with predictions.

**Priority P2 · Effort M.**

---

## FGC-19 — AI Functions breadth + model-tier selector

**Capability.** `ai_classify`/`ai_summarize`/`ai_translate`/`ai_similarity` etc. available consistently
across pandas, PySpark, Warehouse SQL, and Dataflow Gen2, with a default-model + reasoning-effort tuning
control.

**Source grounding.**
- https://learn.microsoft.com/en-us/fabric/data-science/ai-functions/overview
- https://community.fabric.microsoft.com/t5/Fabric-Updates-Blog/Fabric-June-2026-Feature-Summary/ba-p/5190690

**Current Loom state — PARTIAL.** `lib/editors/components/ai-functions-helper.tsx` +
`app/api/items/[type]/[id]/ai-function/route.ts` confirm an AI-functions surface wired to AOAI, but no
model/reasoning-effort selector and no confirmed coverage across all four surfaces (only one editor).

**Azure-first build (surface-coverage + model-tiering, not a new backend).**
- Extend `ai-functions-helper.tsx` model resolution to a two-tier selector (**Fast/default** = a
  cost-efficient AOAI deployment; **Advanced** = a higher-reasoning deployment with a configurable
  reasoning-effort-equivalent param passed through `aoai-chat-client.ts`).
- Confirm/add the helper is reachable from notebook cells (pandas/PySpark magic or import), the warehouse
  SQL editor (as a callable scalar wrapper hitting the AI-function BFF route), and the Dataflow Gen2
  transform palette — all through the one existing `/api/items/[type]/[id]/ai-function` route.
- **Bicep:** none. **Gov:** AOAI both clouds.

**Acceptance.** Call `ai_summarize` from a notebook cell, a warehouse SQL query, and a Dataflow Gen2 step,
each with Fast vs Advanced selected; receipt shows real AOAI responses from all three surfaces at both
tiers.

**Priority P3 · Effort S.**

---

## FGC-20 — Azure SQL Database PITR / restore points

**Capability.** Point-in-time restore from the Query-editor/Settings surface — earliest-restore-time
display, constrained time picker, target-DB name, LRO progress.

**Source grounding.**
- https://learn.microsoft.com/azure/azure-sql/database/recovery-using-backups (Azure SQL control plane)
- Fabric SQL database / Databases workload PITR parity.

**Current Loom state — MISSING.** No match for `restorableDroppedDatabases`/`PointInTimeRestore` or a
restore route/panel; grep of `azure-sql-client.ts` + `unified-sql-database-editor.tsx` for `restore`
returns zero. `databases.md` T12/S17 flagged this MISSING on 2026-06-26 — still MISSING.

**Azure-first build (pure Azure SQL control plane — zero Fabric dependency).**
- Add `restorePoints`/`restore` methods to `lib/azure/azure-sql-client.ts` calling ARM
  `restorableDroppedDatabases` (list) and database `PUT ...?api-version=2022-05-01-preview` with
  `createMode: PointInTimeRestore`, `restorePointInTime`, `sourceDatabaseId`; poll the LRO via existing
  `arm-deployments-client` patterns.
- BFF `app/api/items/azure-sql-database/[id]/restore/route.ts` (GET restorable window, POST restore).
- UI `lib/editors/components/sql-restore-panel.tsx` in the `unified-sql-database-editor.tsx` **Settings**
  tab: earliest-restore-time, time picker constrained to the real window, target-DB field, Restore button
  with LRO progress.
- **Bicep:** UAMI SQL DB Contributor on the server RG (shared with the existing scale-panel role,
  `platform/fiab/bicep/modules/.../sql-rbac.bicep`). Host resolution via the existing cloud-endpoints ARM
  helper — **Gov-ready by construction**.

**Acceptance.** Open the Settings restore panel, pick a time inside the window, restore to a new DB name;
receipt shows the real restorable window from ARM and the LRO completing with a new database created.

**Priority P1 · Effort M.**

---

## FGC-21 — Standalone DAX query view

**Capability.** An ad-hoc DAX query pane auto-populated per table/column ("Show as a query"), independent
of the measure editor, with save-as-measure.

**Source grounding.**
- https://learn.microsoft.com/power-bi/transform-model/dax-query-view

**Current Loom state — PARTIAL.** DAX `EVALUATE` execution exists and is wired to real AAS XMLA
(`semantic-model-editor.tsx` ~L1391/2053/2802) but each is scoped to its own feature (measure test, RLS
test-as-role, aggregation probe); there is no single dedicated DAX query view tab with right-click-generate
+ pin-as-measure.

**Azure-first build (UI composition of already-built AAS execution + measure-save routes — no new backend).**
- Add a "DAX query view" tab to `lib/editors/phase3/semantic-model-editor.tsx` reusing the proven AAS XMLA
  `EVALUATE` path: a first-class Monaco DAX pane, right-click-table/column → "New quick query" template
  insertion, results grid, and a "Save as measure" button posting to the existing measure createOrReplace
  TMSL route.
- **Bicep:** none. **Gov:** AAS XMLA / Loom-native tabular both clouds.

**Acceptance.** Right-click a table → generate a starter query, run it against AAS, save a result as a
measure; receipt shows real EVALUATE rows and the new measure persisted via TMSL.

**Priority P2 · Effort S.**

---

## FGC-22 — Copilot autonomous model-health scan + apply-fix

**Capability.** Copilot detects semantic-model issues (ambiguous/missing relationships, no marked date
table, unused columns, DAX anti-patterns) and can directly modify the model via a review/apply flow —
the June-2026 Power BI Copilot model-modification feature.

**Source grounding.**
- https://learn.microsoft.com/power-bi/create-reports/copilot-modify-semantic-model
- Power BI 2026 release wave — "Copilot can now modify semantic models".

**Current Loom state — PARTIAL.** Semantic-model Copilot exists (`copilot-personas-dax.ts`,
`agent-config-tools.ts`, semantic-model-editor Copilot pane) and can explain/suggest DAX, but grep for
`applyChange`/`writeModel`/`proposeFix` in `copilot-personas-dax.ts` returns zero — the TMSL write path is
only invoked from direct user edits, never from a Copilot-proposed diff. No scan→list→preview-diff→apply
loop.

**Azure-first build (Azure OpenAI + AAS XMLA — no Power BI Premium capacity, no PBI service call).**
- Add a model-health-scan tool to `lib/copilot/agent-config-tools.ts` that reads the live TMSL (via
  `aas-client.getDatabase`) and runs a Best-Practice-Analyzer-style rule set (ambiguous/missing
  relationships, tables without a marked date table, unused/hidden-candidate columns, non-additive-measure
  patterns) against Azure OpenAI + the TMSL JSON.
- Surface results as a **diff-preview dialog** (reuse the deployment-pipeline compare UI from
  `app/api/deployment-pipelines/loom/[id]/compare`) with an **Apply** button POSTing the same TMSL
  createOrReplace route the manual editors already use.
- **Bicep:** none. **Gov:** AOAI + AAS both clouds.

**Acceptance.** Run a scan on a model with a known issue (e.g. unmarked date table); receipt shows the
issue list, a TMSL diff preview, and Apply persisting the fix via createOrReplace — no `api.powerbi.com`
call in the trace.

**Priority P2 · Effort M.**

---

## FGC-23 — Mirrored-database native CDC copy-job

**Capability.** Fabric's 2026 "CDC in Copy job" — capture inserts/updates/deletes natively for SQL-family
sources (Azure SQL DB/MI/SQL Server) instead of snapshot + incremental-poll.

**Source grounding.**
- https://learn.microsoft.com/fabric/data-factory/cdc-copy-job

**Current Loom state — PARTIAL.** `mirror-engine.ts` + `mirror-source-wizard.tsx` already drive ADF
Copy-activity mirroring for Azure SQL/MI/Postgres/Cosmos/Snowflake(+Iceberg)/BigQuery/Oracle
(`mirror-adf-copy.test.ts`, `mirror-source-wizard-iceberg.test.tsx`) — well beyond the 06-26 "SQL only"
status. Unclear whether the SQL-family path uses ADF **native CDC** vs a watermark/incremental-column poll
(the specific 2026 capability).

**Azure-first build.**
- Verify/extend `lib/azure/mirror-engine.ts`'s Azure-SQL-family path to use ADF's native Change Data
  Capture Copy-activity setting (`enableCdc` / native-CDC linked-service option, on an ADF api-version that
  supports it) instead of a manual watermark column — for Azure SQL DB, SQL MI, and SQL Server sources.
- Own jointly with the data-factory PRP (the mirror engine already calls `adf-client.ts`).
- **Bicep:** none new. **Gov:** ADF both clouds.

**Acceptance.** Mirror an Azure SQL source in native-CDC mode; receipt shows deletes propagating to the
Bronze Delta target (which watermark-poll cannot capture), proving native CDC.

**Priority P3 · Effort M.**

---

## FGC-24 — Variable-library-aware deployment-pipeline promotion

**Capability.** Workspace-scoped config resolved per-environment (dev/test/prod) so item promotion swaps
values automatically — Fabric's FabCon-2026 flagship CI/CD feature.

**Source grounding.**
- https://learn.microsoft.com/fabric/cicd/variable-library/variable-library-overview
- FabCon 2026 CI/CD announcements.

**Current Loom state — PARTIAL.** `app/api/items/variable-library/[id]/route.ts` +
`lib/editors/phase4-editors.tsx` (`VariableLibraryEditor`) + tests exist as a standalone item, but it is
**not wired** into deployment-pipeline stage promotion (`app/api/deployment-pipelines/loom/[id]/deploy/route.ts`)
— the item exists in isolation.

**Azure-first build (pure Cosmos + string substitution — zero new infra).**
- Keep variable-library as a Cosmos-backed WorkspaceItem (key/value + per-stage override map:
  dev/test/prod). Extend `.../loom/[id]/deploy/route.ts` so on stage promotion it resolves every
  referencing item's placeholder tokens (`{{var:connectionString}}`) against the target stage's
  variable-library values before writing the item JSON to the destination workspace.
- **UI:** a "Variable overrides" tab on `deployment-pipelines-pane.tsx` showing which variables differ per
  stage (mirrors Fabric's variable-library view in the pipeline compare).
- **Bicep:** none. **Gov:** Cosmos both clouds.

**Acceptance.** Define a variable with different dev/prod values, reference it in an item, promote
dev→prod; receipt shows the destination item carrying the prod value (token resolved), and the overrides
tab diffing the two stages.

**Priority P1 · Effort M.**

---

## FGC-25 — Capacity surge protection (admission control)

**Capability.** Two-level surge protection — capacity-level early background rejection before hard
throttle, and workspace-level per-workspace CU consumption cap.

**Source grounding.**
- https://learn.microsoft.com/fabric/enterprise/surge-protection
- Fabric Admin Capacity settings, 2026.

**Current Loom state — MISSING.** Grep for `surgeProtection`/`surge_protection` returns no real hits;
`app/admin/capacity/page.tsx` has cost + utilization + scale/pause but no consumption-cap or
rejection-threshold controls.

**Azure-first build (Loom-enforced admission control — ADX/Synapse/Databricks have no native "surge" primitive).**
- New Cosmos `capacity-guardrails` container: per-capacity-resource `rejectionThresholdPct` (e.g. reject
  new jobs at 90% before Azure's own throttle) + per-workspace `cuCapPerHour`.
- Enforce in the BFF middleware that dispatches long-running jobs (pipeline runs, Spark jobs, KQL
  ingestion): check current utilization via `monitor-client` (Azure Monitor Metrics) before dispatch;
  reject with a Fluent MessageBar naming the guardrail when over threshold.
- **UI:** a "Surge protection" tab on the `/admin/capacity` detail drawer (`ScaleManagePanel`) — two
  toggles + numeric SpinButtons, mirroring Fabric's two-level model.
- **Bicep:** Cosmos container init. **Gov:** Monitor + Cosmos both clouds.

**Acceptance.** Set a low rejection threshold, drive utilization above it, submit a job; receipt shows the
job rejected with the guardrail MessageBar and the utilization read from Monitor Metrics.

**Priority P1 · Effort M.**

---

## FGC-26 — Capacity overage toggle

**Capability.** Allow paying the PAYG rate for excess consumption instead of being throttled.

**Source grounding.**
- https://learn.microsoft.com/fabric/enterprise/capacity-overage
- Fabric Admin Capacity settings, 2026.

**Current Loom state — MISSING.** Grep for `capacityOverage` returns zero real hits.

**Azure-first build (policy toggle over already-wired cost + admission-control — no new Azure resource).**
- ADX/Synapse/Databricks already bill PAYG for actual consumption under autoscale/serverless, so "overage"
  isn't a distinct Azure primitive. Add an "Allow overage (bill PAYG instead of rejecting)" toggle to the
  same `capacity-guardrails` doc from FGC-25: when **off**, the FGC-25 surge rejection enforces a hard cap;
  when **on**, jobs proceed and Cost Management (`cost-client.ts`, already real) shows the resulting
  overage spend on the same capacity row.
- **Bicep:** none. **Gov:** Cost Management both clouds.

**Acceptance.** With overage on, exceed the cap; receipt shows the job proceeding and the overage spend
appearing on the capacity row from Cost Management. With it off, the FGC-25 rejection fires.

**Priority P2 · Effort S.**

---

## FGC-27 — Capacity health + timepoint summary/detail

**Capability.** A per-region at-a-glance capacity health view with time-bucketed (timepoint) utilization
and a drill-down to the jobs/queries active in a window.

**Source grounding.**
- https://learn.microsoft.com/fabric/enterprise/metrics-app
- Fabric Capacity Metrics, GA 2026.

**Current Loom state — MISSING.** Grep for `timepoint`/`capacityHealth` returns no real hits;
`app/admin/capacity/page.tsx` is a flat grid, not a health-summary/timepoint drill-down.

**Azure-first build (reuses Monitor Metrics + Log Analytics already wired).**
- New "Capacity health" tab on `/admin/capacity` aggregating Azure Monitor Metrics (`monitor-client.ts`)
  into a time-bucketed (~30s timepoint) utilization heatmap per resource — reuse the existing `MetricChart`
  component. "Timepoint detail" = clicking a bucket opens a drawer listing jobs/queries active in that
  window, sourced from Log Analytics (the pipeline/dataflow/Spark run tables already queried by
  refresh-summary and usage-client). Region grouping comes from ARM metadata already in the
  `azure-resources` route.
- **Bicep:** none. **Gov:** Monitor + Log Analytics both clouds.

**Acceptance.** Open the health tab, click a high-utilization timepoint; receipt shows the heatmap from
Monitor and a drawer listing the real jobs active in that window from Log Analytics.

**Priority P2 · Effort M.**

---

## FGC-28 — Chargeback report page

**Capability.** Attribute capacity/resource spend to department/domain — a real report, not just a
tagging toggle.

**Source grounding.**
- https://learn.microsoft.com/fabric/enterprise/chargeback-app
- Fabric Chargeback app, GA 2026.

**Current Loom state — PARTIAL.** `lib/types/tenant-settings.ts` has a `billing.chargebackTagging` toggle
("Tag Azure resources with /domain when items are created") but **no report/dashboard consumes those
tags** — grep found no chargeback report route or page.

**Azure-first build (real Cost Management query — no fake numbers).**
- When `billing.chargebackTagging` is on, items already get an Azure tag `domain=<domainId>`. Build
  `/admin/chargeback` page + `app/api/admin/chargeback/route.ts`: query Azure Cost Management
  (`Microsoft.CostManagement/query`, the same API `cost-client.ts` calls) grouped by the `domain` tag
  dimension, joined against Cosmos `governance-domains` for display names. Render as a Fluent table +
  stacked bar chart (reuse dataviz patterns).
- **Honest-gate** when tagging is off or Gov Cost Management is unavailable (per no-vaporware).
- **Bicep:** none new (Cost Management Reader already needed for FGC-08/26). **Gov:** Cost Management both
  clouds.

**Acceptance.** With tagging on and spend accrued, open `/admin/chargeback`; receipt shows real per-domain
spend from Cost Management (first 300 chars of the query response) + the chart, and the honest-gate
MessageBar when tagging is off.

**Priority P1 · Effort M.**

---

## FGC-29 — Copilot capacity (AOAI) designation + isolated spend

**Capability.** Designate a specific AOAI deployment as the dedicated Copilot backend and track its
consumption separately — the Feb-2026 "this capacity is dedicated to Copilot" UX.

**Source grounding.**
- https://learn.microsoft.com/fabric/admin/service-admin-portal-copilot
- Fabric Copilot & Agent tenant settings, 2026.

**Current Loom state — MISSING.** `tenant-settings.ts` "AI & Copilot" has per-feature toggles
(`copilotPane`, `dataAgent`, `inlineCodeComplete`, `fabricCopilotOptIn`) but no capacity-designation
concept; `/admin/capacity` has no "Copilot capacity" flag.

**Azure-first build (AOAI deployment designation — Loom runs inference on AOAI, not a Fabric pool).**
- New Cosmos `ai-capacity-designation` doc mapping which AOAI deployment id serves
  `ai.copilotPane`/`ai.crossItemCopilot`/`ai.inlineCodeComplete`, surfaced as a dropdown in the AI & Copilot
  tenant-settings category. Add a cost/utilization card (reuse `cost-client.ts` + `monitor-client.ts`
  scoped to that AOAI resource) on `/admin/capacity` so Copilot spend is visibly isolated.
- **Bicep:** none. **Gov:** AOAI both clouds.

**Acceptance.** Designate an AOAI deployment for Copilot; receipt shows Copilot traffic routed to it and
the `/admin/capacity` card showing that deployment's isolated spend from Cost Management.

**Priority P3 · Effort S.**

---

## FGC-30 — External (cross-tenant) data sharing

**Capability.** Share data in-place to another **Entra tenant** (cross-org), read-only, scoped to a
folder/table subset, with expiry — Fabric's External Data Sharing + shortcut transformations.

**Source grounding.**
- https://learn.microsoft.com/fabric/governance/external-data-sharing-overview
- Fabric Governance — External Data Sharing + Shortcut Transformations, GA 2026.

**Current Loom state — MISSING.** Grep for `external.?data.?shar`/`cross.?tenant.?shar` returns zero real
hits (the only "external" match in `shortcut-wizard.tsx` is intra-tenant ADLS/S3/GCS shortcuts). Not
covered by `governance-security.md` Task 6, which is same-tenant only.

**Azure-first build (Entra B2B + scoped ADLS grant — the Azure-native cross-tenant mechanism).**
- New Cosmos `external-shares` container (source item, target tenant domain, target folder/table subset,
  read-only flag, expiry).
- Grant via ADLS ACL to an **Entra B2B**-invited guest UAMI/group from the target tenant; or — where B2B
  can't complete — a folder-scoped Storage **SAS** with a governed rotation policy.
- **UI:** extend the existing Share dialog (`share-item-dialog`, governance-security Task 6) with an
  "External tenant" tab (accepts a foreign tenant UPN/domain) — reuse the `item-permissions-client.ts`
  share pattern.
- **Shortcut transformations:** map schema-on-read reshaping through a shortcut to a **Loom-native Synapse
  serverless view** over the ADLS shortcut path (a view-definition wizard, `loom_no_freeform_config`) — no
  new Azure primitive.
- **Bicep:** external-shares Cosmos container; document the B2B admin action in the tenant-bootstrap guide.
  **Gov:** B2B + ADLS both clouds (validate cross-cloud tenant B2B constraints for Gov).

**Acceptance.** Share a table subset to a second tenant's guest identity read-only with expiry; receipt
shows the guest reading the data via the scoped ADLS grant and being denied outside the subset/after
expiry.

**Priority P1 · Effort L.**

---

## FGC-31 — Workspace create wizard (multi-step) + settings flyout

**Capability.** A multi-step workspace create wizard (name/desc → contacts → license mode → capacity bind
→ advanced) and a Workspace Settings flyout (General / License / M365-SharePoint / OneLake-storage).

**Source grounding.**
- https://learn.microsoft.com/fabric/fundamentals/create-workspaces
- https://learn.microsoft.com/fabric/fundamentals/workspaces-manage

**Current Loom state — PARTIAL.** `lib/panes/workspaces.tsx` create dialog is a single-step name+description
form (L1-60); `lib/panes/workspace-settings.tsx` exists. `platform.md` Task 6 (F7/F8) called for a
full multi-step wizard (contact-list Graph picker, license mode, capacity bind, OneLake-storage usage) —
needs a follow-up read of `workspace-settings.tsx` to confirm panel completeness before final scoping.

**Azure-first build.**
- Extend the create Dialog into a Fluent multi-step **Wizard** (pattern already used for domain create):
  Name/Description → Contacts (reuse `graph-identity-client` picker) → License mode (Cosmos flag) →
  Capacity bind (reuse `workspaces-client` capacity list) → Advanced (region / backing RG).
- Settings flyout: confirm/extend `workspace-settings.tsx` tabs to the General / License / M365-SharePoint /
  OneLake-storage set — the OneLake-storage tab shows real ADLS container usage via `adls-client`.
- **Bicep:** none. **Gov:** Graph + ADLS + Cosmos both clouds.

**Acceptance.** Create a workspace through all wizard steps (contacts picked from Graph, capacity bound);
receipt shows the workspace created with the chosen contacts/capacity, and the settings flyout's
OneLake-storage tab showing real ADLS usage.

**Priority P2 · Effort M.**

---

## Cross-cutting acceptance & governance

- **No-vaporware receipt per item (per merge):** endpoint hit + real Azure response (first 300 chars) +
  a browser screenshot / Playwright trace + a bicep diff if infra changed. Reviewers reject PRs without it.
- **No-fabric verification per item:** the item installs + its editor works **with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET**, showing a real Azure backend response. Any default-path call to
  `api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric.microsoft.com` is a blocking
  violation (Fabric backends are opt-in via `LOOM_<ITEM>_BACKEND=fabric` + a bound workspace only).
- **Config UX:** every new config surface uses wizards/dropdowns/canvas (`canvas-node-kit` for the Digital
  Twin + Activator designers) — never a raw JSON textarea (`loom_no_freeform_config`).
- **Bicep sync:** each new Azure resource (ACA Python-kernel job, ADT instance + Event Grid topic, Debezium
  ACA, weather Function, Stream Analytics job) and each new role (Cost Management Reader, ADT Data Owner,
  SQL DB Contributor) lands in `platform/fiab/bicep/**` and wires into the orchestrator; each new env var
  into the `apps[]` list; each new Cosmos container into a Cosmos init step.
- **Dual-cloud:** every item ships Commercial + Government; verify Gov region/service availability
  (especially ADT IL5/IL6, cross-cloud B2B, public-API egress for the weather connector) at build time.
