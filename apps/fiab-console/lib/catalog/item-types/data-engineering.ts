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
];
