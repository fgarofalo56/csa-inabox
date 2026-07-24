import type { FabricItemType } from './types';

/**
 * Data Engineering — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const dataEngineeringItems: FabricItemType[] = [
  // Data Engineering
  { slug: 'lakehouse', displayName: 'Lakehouse', restType: 'Lakehouse', category: 'Data Engineering',
    description: 'A unified store for files, folders, and Delta tables in ADLS Gen2 (Delta) — Azure-native, no Fabric required.',
    learnContent: {
      "overview": "A Lakehouse is the unified store for files and Delta tables. In Loom it is Azure-native: storage rides on ADLS Gen2 (Delta) with a Synapse serverless SQL analytics endpoint and Spark for query — no Microsoft Fabric or OneLake required. Use it as the bronze/silver/gold landing zone for any analytics workload. (An OneLake-backed lakehouse is opt-in only, never the default.)",
      "steps": [
        {
          "title": "Browse Files vs Tables",
          "body": "The Files tree shows raw uploads on ADLS Gen2; the Tables tree shows Delta-managed tables. Drop raw data into Files, then promote it into Tables."
        },
        {
          "title": "Load files to tables",
          "body": "Use the Load to Tables action to auto-infer schema and write a managed Delta table — no DDL required."
        },
        {
          "title": "Query via SQL or Spark",
          "body": "Hit the SQL analytics endpoint for T-SQL, or read Delta directly from a Notebook with spark.read.format('delta')."
        },
        {
          "title": "Follow the medallion convention",
          "body": "Land raw into bronze, conform and clean into silver, aggregate and serve from gold so downstream items have a stable contract."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/lakehouse-overview"
    } },
  { slug: 'materialized-lake-view', displayName: 'Materialized lake view', restType: 'MaterializedLakeView', category: 'Data Engineering',
    preview: true,
    description: 'A persisted, auto-refreshed Delta view defined in Spark SQL or PySpark over your lakehouse.',
    learnContent: {
      "overview": "A materialized lake view (MLV) is a persisted, automatically refreshed view defined in Spark SQL or PySpark. It expresses multi-stage medallion (bronze → silver → gold) transformations declaratively rather than as custom Spark jobs, persisting the result as a managed Delta table that downstream consumers query directly. In Loom the MLV rides on Azure-native ADLS Gen2 + Delta (no Microsoft Fabric required): the definition is materialized by a Synapse Spark batch, refreshes run via an ADF 'Refresh materialized lake view' pipeline activity, and Loom tracks cross-workspace dependency lineage in its own Cosmos store.",
      "steps": [
        {
          "title": "Author the definition (SQL or PySpark)",
          "body": "Write a CREATE MATERIALIZED LAKE VIEW … AS SELECT … in the SQL tab, or a @fmlv-style PySpark function returning a DataFrame in the PySpark tab. Pick the target medallion container + schema + view name."
        },
        {
          "title": "Add data-quality constraints",
          "body": "Declare CHECK constraints with an on-violation action (FAIL stops the refresh; DROP silently removes bad rows) so quality is enforced uniformly on every refresh."
        },
        {
          "title": "Materialize + refresh",
          "body": "Refresh runs a Synapse Spark batch that executes the definition and writes the result as a managed Delta table; an ADF 'Refresh materialized lake view' pipeline orchestrates scheduled refreshes."
        },
        {
          "title": "Track lineage",
          "body": "Loom auto-derives source-table → MLV and MLV → MLV dependencies from the definition and persists them as cross-workspace lineage edges, so refreshes can be ordered and impact analysis is one click away."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/materialized-lake-views/overview-materialized-lake-view"
    } },
  { slug: 'notebook', displayName: 'Notebook', restType: 'Notebook', category: 'Data Engineering',
    description: 'Interactive Spark / Python authoring with cells and outputs.',
    createConfig: {
      runtimes: [
        { value: 'spark', label: 'Spark notebook (Synapse/Fabric)', desc: 'Azure-native default — interactive PySpark/Python on a Synapse Spark pool (or opt-in Databricks/Fabric); reads/writes Lakehouse Delta.', default: true, slug: 'notebook' },
        { value: 'synapse', label: 'Synapse notebook', desc: 'Multi-language Spark cells (PySpark/Scala/SQL/.NET) on a Synapse Big Data pool via Livy, authored over the Synapse dev plane.', slug: 'synapse-notebook' },
        { value: 'databricks', label: 'Databricks notebook', desc: 'Explicit choice — PySpark/SQL/R/Scala cells on a Databricks cluster with Unity Catalog + Photon; never auto-selected.', slug: 'databricks-notebook' },
      ],
    },
    learnContent: {
      "overview": "A Notebook is interactive Spark/Python authoring with cells and outputs. In Loom it attaches to a Synapse Spark pool or a Databricks cluster and reads/writes Lakehouse Delta tables. Use it for data engineering and data science work that needs code.",
      "steps": [
        {
          "title": "Attach compute",
          "body": "Attach the notebook to a Synapse Spark pool or a Databricks cluster before running a cell — Loom shows the attach state in the chrome."
        },
        {
          "title": "Read from a Lakehouse",
          "body": "Read Delta with spark.read.format('delta').load('Files/...') or query the mounted SQL endpoint."
        },
        {
          "title": "Write results back",
          "body": "Persist with df.write.mode('overwrite').format('delta').save('Tables/...') so the output lands as a managed table."
        },
        {
          "title": "Schedule recurring runs",
          "body": "Wire the notebook into a Data pipeline or Synapse pipeline trigger for scheduled execution."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/lakehouse-notebook-explore"
    } },
  { slug: 'spark-job-definition', displayName: 'Spark job definition', restType: 'SparkJobDefinition', category: 'Data Engineering',
    description: 'Run a compiled Spark application (JAR / .py) against your lakehouse.',
    learnContent: {
      "overview": "A Spark job definition runs a compiled Spark application (JAR or .py) headlessly against your lakehouse — like a notebook but for production batch. In Loom it submits a Livy batch to the configured Synapse Spark pool.",
      "steps": [
        {
          "title": "Point at your artifact",
          "body": "Reference the main JAR or .py file plus any command-line args and reference files in the job spec."
        },
        {
          "title": "Pick the Spark pool",
          "body": "The job submits a Livy batch against the Synapse Spark pool configured for this workspace."
        },
        {
          "title": "Submit and watch",
          "body": "Use Submit to fire the batch; the run state surfaces in the editor from the Livy session."
        },
        {
          "title": "Promote from a notebook",
          "body": "Prototype logic in a Notebook, then move it to a Spark job definition for unattended scheduled runs."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/spark-job-definition"
    } },
  { slug: 'environment', displayName: 'Environment', restType: 'Environment', category: 'Data Engineering', hiddenFromGallery: true,
    description: 'Reusable Spark settings and library bundle for notebooks and jobs.',
    learnContent: {
      "overview": "An Environment is a reusable bundle of Spark settings and libraries that you attach to notebooks and Spark job definitions. In Loom the spec persists to Cosmos and Apply to pool PUTs it onto the Synapse Spark pool.",
      "steps": [
        {
          "title": "Define libraries",
          "body": "List the Python/R packages and Spark properties you want standardized across notebooks."
        },
        {
          "title": "Set the runtime version",
          "body": "Pin the Spark runtime version so jobs are reproducible across the team."
        },
        {
          "title": "Apply to a pool",
          "body": "Use Apply to pool to push the environment spec onto the Synapse Spark pool via its PUT endpoint."
        },
        {
          "title": "Attach to items",
          "body": "Reference the environment from notebooks and Spark job definitions so they all share the same runtime."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/environment-manage-customization"
    } },
  { slug: 'spark-environment', displayName: 'Spark environment', restType: 'SparkEnvironment', category: 'Data Engineering',
    description: 'Full lifecycle Spark environment: runtime version, compute config, public libraries (pip/conda), custom libraries (whl/jar), and Spark properties. Publish bakes the spec into a Synapse Spark pool; attach to notebooks and Spark job definitions.',
    learnContent: {
      "overview": "A Spark environment is a versioned, publishable bundle of runtime, compute, and library configuration. In Loom the spec persists to Cosmos; Publish bakes it into a Synapse Spark Big Data pool (sessionLevelPackagesEnabled + libraryRequirements + customLibraries + sparkConfigProperties) via ARM, and Attach wires it onto notebooks and Spark job definitions so they share the same runtime. No Microsoft Fabric capacity is required — the backend is Azure Synapse + ADLS Gen2.",
      "steps": [
        {
          "title": "Pick the runtime",
          "body": "Choose the Spark runtime version (3.5 GA recommended) and node family on the Runtime tab."
        },
        {
          "title": "Size the compute",
          "body": "Set node size, autoscale or a fixed node count, and auto-pause on the Compute tab — these are baked into the pool on publish."
        },
        {
          "title": "Add libraries",
          "body": "List pip/conda packages on Public libraries and upload .whl/.jar files (staged to ADLS) on Custom libraries."
        },
        {
          "title": "Publish + validate",
          "body": "Publish bakes the spec into the target Spark pool, then Validate import runs a live Spark session that installs the packages and imports them — the receipt proves importability."
        },
        {
          "title": "Attach to items",
          "body": "Attach the environment to notebooks and Spark job definitions so they default to the published pool and share the same libraries."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-azure-portal-add-libraries"
    } },
  { slug: 'lakehouse-shortcut',          displayName: 'Lakehouse shortcut',          restType: 'LakehouseShortcut', category: 'Data Engineering',
    description: 'An ADLS external-location pointer (abfss shortcut) — read external Delta/Parquet in place without copying. Azure-native OneLake-shortcut equivalent.',
    learnContent: {
      "overview": "A Lakehouse shortcut is the Azure-native equivalent of a OneLake shortcut: a named pointer to external Delta/Parquet that a lakehouse reads IN PLACE without copying. In Loom it targets an ADLS Gen2 path (container + path, resolved to an abfss:// location) on the deployment data lake; Loom verifies the target resolves by listing it via the ADLS client (no data movement) and persists the pointer as a workspace item. SQL/Spark over the lakehouse then reads the shortcut's Delta directly. No Microsoft Fabric / OneLake dependency — pure ADLS Gen2.",
      "steps": [
        { "title": "Name the shortcut", "body": "Give the shortcut a name; it appears under the lakehouse's shortcuts as a virtual folder." },
        { "title": "Point at external data", "body": "Choose a target ADLS container + path (or paste an abfss:// location). Loom resolves it to the lake's abfss root." },
        { "title": "Verify resolution", "body": "Loom lists the target path via the ADLS client to confirm the pointer resolves — proving access WITHOUT copying a single byte." },
        { "title": "Query in place", "body": "Spark / serverless SQL over the lakehouse reads the shortcut's Delta/Parquet directly at query time; the data is never duplicated." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction"
    } },
  { slug: 'batch-pool',                  displayName: 'Batch pool',                  restType: 'Microsoft.Batch/batchAccounts', category: 'Data Engineering',
    description: 'Azure Batch pools + jobs + tasks — bulk parallel / HPC compute for AI fan-out across a managed VM fleet. Real ARM + Batch REST.',
    learnContent: {
      "overview": "A Batch pool is a managed fleet of VMs on the deployment-pinned Azure Batch account (Microsoft.Batch/batchAccounts) for large-scale parallel and HPC work — the canonical use in Loom is fanning bulk AI scoring / document-enrichment tasks across many nodes. In Loom it is an ADF-Studio-style navigator: pools (VM size, fixed or formula-driven autoscale, dedicated + low-priority/Spot nodes) are managed over the real ARM management plane, and jobs + tasks are created and listed over the Batch data plane. The BatchExecute pipeline activity fans one Custom task per pipeline run onto a pool. Azure-native — no Microsoft Fabric required.",
      "steps": [
        { "title": "Bind the account", "body": "The editor targets the deployment Batch account (LOOM_BATCH_ACCOUNT). If unset it shows an honest gate naming the env var + the Contributor role the Console UAMI needs; deploy it with the deploy-planner batch.bicep module." },
        { "title": "Create a pool", "body": "Pick a VM size and either a fixed dedicated/Spot node count or a named autoscale formula preset; Loom PUTs Microsoft.Batch/batchAccounts/{acct}/pools over real ARM." },
        { "title": "Add a job", "body": "Create a job bound to a pool — the container for a set of parallel tasks — over the Batch data plane." },
        { "title": "Fan out tasks", "body": "Add tasks (each a command line) to a job; the pool's nodes execute them in parallel. Track state + exit codes in the tasks grid." },
        { "title": "Drive from a pipeline", "body": "Drop a BatchExecute (Custom) activity onto a data pipeline to submit a task per run — bulk-score a file set against Document Intelligence / a model without hand-scripting Batch." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/batch/batch-technical-overview"
    } },
  // W12 — Synthetic data generator (Loom-native; no Fabric REST equivalent).
  { slug: 'synthetic-data', displayName: 'Synthetic data', restType: 'SyntheticData', category: 'Data Engineering', noRestApi: true,
    description: 'Generate realistic synthetic rows from a per-column strategy (faker-style names / dates / categoricals / numeric distributions) and write them to a real Delta table. Seed columns from a data contract; PII columns are synthesized (never real). Azure-native (Databricks SQL) — no Fabric dependency.',
    learnContent: {
      "overview": "A Synthetic data generator produces realistic, non-sensitive rows for testing, demos, and ML — never a copy of real data. You seed the columns from a data contract's schema (or define them by hand), pick a per-column generation strategy (sequence, UUID, integer/decimal/normal distributions, dates, categoricals, and faker-style names / emails / phones / addresses / companies), set a row count and a reproducible seed, preview real generated rows, then GENERATE the full table — written to a real Delta table via Databricks SQL (CSV → staged Unity Catalog volume → CREATE TABLE with schema inference). It is 100% Azure-native — no Microsoft Fabric capacity is required. Every value is synthesized from scratch, so no real PII is ever emitted; a source column classified PII/PHI/PCI is mapped to a synthetic strategy (a fake name / email / phone) or a redacted mask.",
      "steps": [
        { "title": "Pick a source schema", "body": "Seed the columns from a data contract in your workspace (its typed columns + PII classification drive the inferred strategies), or add columns by hand." },
        { "title": "Choose per-column strategies", "body": "For each column pick a generation strategy — sequence / UUID / integer / decimal / normal distribution / date / timestamp / categorical / constant, or a synthetic name / email / phone / company / city / address — and its options (ranges, values, distribution, null rate)." },
        { "title": "Preview real rows", "body": "Set a row count and a seed, then Preview generates the first rows exactly as the full run will (deterministic for the seed) — no backend needed." },
        { "title": "Generate to Delta", "body": "Pick a Databricks SQL warehouse, catalog, schema, staging volume, and a new table name, then Generate. The rows are written to a real managed Delta table; each run is recorded in the history." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/databricks/sql/language-manual/functions/read_files"
    } },
  // W11 — Data-quality check (Loom-native; wraps the shared DQ rule engine).
  { slug: 'data-quality', displayName: 'Data-quality check', restType: 'DataQualityRuleSet', category: 'Data Engineering', noRestApi: true,
    description: 'A workspace-scoped data-quality run: pin a backend (Azure Data Explorer / Databricks / Synapse) and a target, run your data-quality rules (not-null / unique / range / regex / freshness) against the live table, and see a composite scorecard + per-rule breakdown + history. Azure-native — no Fabric dependency.',
    learnContent: {
      "overview": "A Data-quality check is a first-class, workspace-scoped run configuration over Loom's shared Data Quality Rule Engine. You pin a backend (Azure Data Explorer by default, or Databricks SQL / Synapse SQL) and a target, then run your organization's enabled data-quality rules — not-null, unique, in-range, matches-a-pattern, and freshness — against the live table using real queries on that backend. The pass rate of every rule feeds a composite data-quality score, shown as a scorecard with the per-rule breakdown, and every run is kept in the item's history. The rules themselves are authored and managed centrally in Governance → Data quality. It is 100% Azure-native — no Microsoft Fabric capacity is required; when the chosen backend isn't configured the item shows an honest gate naming the exact env var to set.",
      "steps": [
        { "title": "Author rules once", "body": "Define your data-quality rules (not-null / unique / range / regex / freshness, each scoped to a table or column with a pass threshold) in Governance → Data quality." },
        { "title": "Pin a backend + target", "body": "Choose Azure Data Explorer, Databricks SQL, or Synapse SQL, and the database / warehouse / catalog / schema to run against. Optionally filter to specific tables." },
        { "title": "Run the checks", "body": "Run executes every matching enabled rule against the live backend and computes the composite score — real queries, no fabricated numbers." },
        { "title": "Read the scorecard + history", "body": "See the score, the passing/failing rule counts, and the per-rule measured pass %. Each run is recorded in the history so you can track quality over time." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-explorer/"
    } },
  // N2b — SQL Lab (DuckDB): the interactive tier BELOW Spark.
  { slug: 'sql-lab', displayName: 'SQL Lab (DuckDB)', restType: 'SqlLab', category: 'Data Engineering', noRestApi: true,
    description: 'Interactive read-only SQL over Delta, Iceberg and Parquet read in place on your own ADLS Gen2 by an embedded DuckDB — sub-second, no Spark session. Falls back to Synapse Serverless when the tier is not deployed. Slice the result again in your browser for free, and connect ADBC / Flight SQL / JDBC clients to the same engine.',
    learnContent: {
      "overview": "SQL Lab is Loom's fast path below Spark. An embedded DuckDB running as an internal-ingress Container App reads Delta (delta_scan), Iceberg (iceberg_scan) and Parquet (read_parquet) IN PLACE on your own ADLS Gen2, authenticating with a managed identity that holds Storage Blob Data READER — so it can query everything and change nothing. A Spark session costs 1-5 minutes to start; this tier answers in under a second, which is why interactive analysis belongs here and large joins, writes and ML belong on Spark. When LOOM_DUCKDB_URL is unset the identical statement runs on Synapse Serverless, so the surface is never blocked — only faster once the tier is deployed. Every execution is written to the audit trail with the principal, the statement and the engine that answered. 100% Azure-native and OSS: no Microsoft Fabric, no OneLake, no Power BI, and nothing SaaS in the query path — the whole capability runs disconnected in an air-gapped enclave.",
      "steps": [
        { "title": "Query the lake in place", "body": "Write read-only SQL against delta_scan('abfss://...'), read_parquet('abfss://.../*.parquet') or iceberg_scan('abfss://...'). Nothing is copied or imported, and write/DDL statements are refused by the engine's read-only guard." },
        { "title": "Read the status bar", "body": "Every run prints the row count, the engine's own execution time, the round-trip time, and WHICH engine answered (DuckDB or the Synapse Serverless fallback). No claim is made that was not measured." },
        { "title": "Slice it again for free", "body": "The Local analysis tab fetches the result's Arrow stream once, then runs further SQL on duckdb-wasm inside your browser: zero server cost, zero network requests, and a timing bar that proves it." },
        { "title": "Connect your own tools", "body": "The Connect tab mints a short-lived, scoped access ticket and hands you ADBC / Arrow Flight SQL / JDBC snippets. Those clients stream the same Arrow RecordBatches the engine produced instead of serializing rows one at a time over ODBC." }
      ],
      "docsUrl": "https://duckdb.org/docs/stable/core_extensions/delta"
    } },
  // N8 lab 1 — DuckLake catalog option (Preview; Postgres-backed lakehouse metadata).
  { slug: 'ducklake-catalog', displayName: 'DuckLake catalog', restType: 'DuckLakeCatalog', category: 'Data Engineering', noRestApi: true, preview: true,
    description: 'Preview — a Postgres-backed lakehouse-metadata catalog (DuckLake, Apache-2.0) offered ALONGSIDE the Iceberg REST Catalog. The DuckDB engine ATTACHes it and reads Delta/Parquet in place on your own ADLS Gen2. Honest-gated on the Postgres connection. Azure-native — no Fabric.',
    learnContent: {
      "overview": "DuckLake is a Preview lab: a catalog format that keeps lakehouse table metadata in a SQL database (Postgres) instead of a metadata-file tree. It is a forward bet on the DuckDB ecosystem, offered ALONGSIDE the Iceberg REST Catalog — not a replacement; pick whichever matches your engine mix. The N2 DuckDB serving tier is the query engine: it ATTACHes the DuckLake catalog and reads the Delta/Parquet data in place on your own ADLS Gen2. It is 100% Azure-native and OSS: the metadata store is an in-VNet Azure Database for PostgreSQL and the engine is the in-boundary DuckDB container — no Microsoft Fabric, no OneLake, nothing SaaS. When LOOM_DUCKLAKE_CATALOG_URL (or the DuckDB tier) is unset the editor renders a guided empty state and honest-gates with a Fix-it — never fabricated catalog contents.",
      "steps": [
        { "title": "Point at a Postgres store", "body": "Set LOOM_DUCKLAKE_CATALOG_URL to the connection string of the Postgres database that backs the DuckLake metadata (an in-VNet Azure Database for PostgreSQL flexible server). The editor's Fix-it wizard writes it for you." },
        { "title": "Deploy the DuckDB tier", "body": "DuckLake needs the N2 DuckDB serving tier to run the ATTACH — set LOOM_DUCKDB_URL (duckdb-aca.bicep) too. The editor names the exact missing var when either is absent." },
        { "title": "Browse the catalog", "body": "Once wired, the editor lists the real tables the DuckLake catalog exposes — read live from Postgres via the DuckDB tier, with the count shown. Every read is audited." },
        { "title": "Query in place", "body": "Point SQL Lab at a DuckLake table; the DuckDB engine reads the Delta/Parquet data in place on your ADLS Gen2 — nothing is copied." }
      ],
      "docsUrl": "https://ducklake.select/docs/stable/"
    } },
  // N8 lab 3 — S3-compatible ADLS gateway (Preview; permissive s3proxy path).
  { slug: 's3-gateway', displayName: 'S3-compatible ADLS gateway', restType: 'S3Gateway', category: 'Data Engineering', noRestApi: true, preview: true,
    description: 'Preview — expose an S3-compatible endpoint over your ADLS Gen2 so s3://-native OSS clients connect. Uses an operator-deployed Apache-2.0 s3proxy (never AGPL MinIO). Most engines need no gateway: the Iceberg REST Catalog + native abfss:// path already cover it. Honest-gated. Azure-native — no Fabric.',
    learnContent: {
      "overview": "This Preview lab lets s3://-native OSS clients (Trino, Spark, DuckDB's s3 extension) address the deployment's ADLS Gen2 through an S3 API. The MinIO gateway path is deliberately dropped — MinIO's gateway is deprecated AND AGPL-licensed (banned by Loom's permissive-license rule); the permissive path is an operator-deployed Apache-2.0 s3proxy placed in front of ADLS. Loom bundles nothing (no AGPL, no s3proxy in the console image). Crucially, most deployments need NO gateway at all: the N1 Iceberg REST Catalog plus the native abfss:// path already give external engines governed, audited access to the same data — deploy the gateway only for clients that speak S3 exclusively. The surface is honest either way: when LOOM_S3_GATEWAY_URL is unset it documents the IRC/ADLS path and gates the connect panel with a Fix-it; when set it shows the real endpoint + copy-paste connect snippets. Azure-native, in-boundary, IL5-safe — no Microsoft Fabric.",
      "steps": [
        { "title": "Consider the native path first", "body": "Point engines at the Iceberg REST Catalog (LOOM_ICEBERG_CATALOG_URL) and read over abfss:// — governed and audited. This covers Trino, Spark, DuckDB and Snowflake without any gateway." },
        { "title": "Deploy an Apache-2.0 s3proxy (only if needed)", "body": "For s3://-exclusive clients, run an Apache-2.0 s3proxy in front of ADLS on your own Container Apps environment (internal ingress, its own UAMI). Never the AGPL MinIO gateway." },
        { "title": "Wire the endpoint", "body": "Set LOOM_S3_GATEWAY_URL to the gateway endpoint via the editor's Fix-it wizard. The surface then renders the real endpoint and per-engine connect snippets." },
        { "title": "Connect s3://-native clients", "body": "Copy the DuckDB / Trino connect snippet from the editor; the client addresses your lake with the S3 API while the data stays in your ADLS Gen2." }
      ],
      "docsUrl": "https://github.com/gaul/s3proxy"
    } },
];
