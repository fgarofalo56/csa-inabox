/**
 * Authoritative Fabric item-type catalog, sourced from
 * docs/fiab/fabric-feature-inventory.md (which was assembled via
 * Microsoft Learn MCP — item-definition-overview,
 * item-management-overview, and per-workload product overviews).
 *
 * Used by:
 *  - the `+ New item` dialog (categorized grid)
 *  - the per-item-type editor routes at /items/[type]/[id]
 *  - the workspace inventory rollup
 *
 * Keep in sync with the inventory doc; any drift means the doc is
 * stale (re-fetch via microsoft_docs_search) or this file is.
 */

export type WorkloadCategory =
  | 'Data Engineering'
  | 'Data Factory'
  | 'Data Warehouse'
  | 'Databases'
  | 'Real-Time Intelligence'
  | 'Data Science'
  | 'Fabric IQ'
  | 'Power BI'
  | 'APIs and functions'
  | 'Synapse Analytics'
  | 'Azure Databricks'
  | 'Azure Data Factory'
  | 'Streaming analytics'
  | 'Azure Data Lake Analytics'
  | 'Azure AI Foundry'
  | 'Azure SQL Database'
  | 'Azure Geoanalytics'
  | 'Azure Graph + Vector'
  | 'CSA Data Products'
  | 'Copilot Studio'
  | 'Power Platform'
  | 'AI & Agents';

export interface LearnStep {
  title: string;
  body: string;
  /** Optional screenshot path under /public */
  screenshot?: string;
}

export interface LearnContent {
  /** 1-3 sentence overview shown on the Learn dialog's first pane. */
  overview: string;
  /** Numbered getting-started walkthrough — 3-5 steps. */
  steps: LearnStep[];
  /** Optional embed URL for an explainer video. */
  videoUrl?: string;
  /** Authoritative docs link (Microsoft Learn for Fabric/Azure concepts, Loom docs for Loom-only). */
  docsUrl?: string;
  /** Optional sample-data dataset suggestions. */
  sampleData?: string[];
}

export interface FabricItemType {
  /** Route slug — used at /items/[slug]/[id] */
  slug: string;
  /** Display name shown in dialog + editor */
  displayName: string;
  /** REST API type name (matches Fabric REST `type` field) */
  restType: string;
  /** Short one-line summary for the New item dialog card */
  description: string;
  /** Workload category for grouping */
  category: WorkloadCategory;
  /** True when this is a preview-only item type */
  preview?: boolean;
  /** True when no Fabric REST API exists (Scorecard, Dataflow Gen1) */
  noRestApi?: boolean;
  /** Learn / Getting started popup content. Required for every type. */
  learnContent?: LearnContent;
}

export const FABRIC_ITEM_TYPES: readonly FabricItemType[] = [
  // Data Engineering
  { slug: 'lakehouse', displayName: 'Lakehouse', restType: 'Lakehouse', category: 'Data Engineering',
    description: 'A unified store for files, folders, and Delta tables in OneLake.',
    learnContent: {
      "overview": "A Lakehouse is the unified store for files and Delta tables in OneLake. In Loom it rides on ADLS Gen2 for storage with the Fabric/Synapse SQL analytics endpoint and Spark for query. Use it as the bronze/silver/gold landing zone for any analytics workload.",
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
  { slug: 'notebook', displayName: 'Notebook', restType: 'Notebook', category: 'Data Engineering',
    description: 'Interactive Spark / Python authoring with cells and outputs.',
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
  { slug: 'environment', displayName: 'Environment', restType: 'Environment', category: 'Data Engineering',
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

  // Data Factory
  { slug: 'data-pipeline', displayName: 'Data pipeline', restType: 'DataPipeline', category: 'Data Factory',
    description: 'Orchestrate Copy, Lookup, ForEach, Notebook, Stored procedure, Web, and more.',
    learnContent: {
      "overview": "A Data pipeline is visual ETL/ELT orchestration — Copy, Lookup, ForEach, Notebook, Stored procedure, Web and more. In Loom it shares run history with notebooks and dataflows and is backed by the Fabric Data Factory runtime.",
      "steps": [
        {
          "title": "Add a Copy activity",
          "body": "Use Copy Data for source-to-sink ingestion across the supported connector set."
        },
        {
          "title": "Call a Notebook",
          "body": "Add a Notebook activity to run PySpark transformations inline in the orchestration."
        },
        {
          "title": "Wire dependencies",
          "body": "Connect activities with success/failure conditions on the designer canvas to control flow."
        },
        {
          "title": "Schedule a trigger",
          "body": "Configure a schedule, tumbling window, or event-based trigger to automate runs and review run history."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-factory/data-factory-overview"
    } },
  { slug: 'dataflow', displayName: 'Dataflow Gen2', restType: 'Dataflow', category: 'Data Factory',
    description: 'Low-code Power Query data prep with visual + M code authoring.',
    learnContent: {
      "overview": "Dataflow Gen2 is low-code Power Query data prep with visual and M-code authoring. In Loom you read from the supported connector set, transform in the Power Query editor, and write to a lakehouse, warehouse, or SQL DB.",
      "steps": [
        {
          "title": "Connect a source",
          "body": "Pick a connector and authenticate; the Power Query editor previews the data."
        },
        {
          "title": "Shape with Power Query",
          "body": "Apply transform steps visually or drop into the M expression bar for fine control."
        },
        {
          "title": "Set a destination",
          "body": "Map the output to a Lakehouse, Warehouse, or SQL database table."
        },
        {
          "title": "Refresh and schedule",
          "body": "Run a refresh to materialize the output and schedule recurring refreshes."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview"
    } },
  { slug: 'copy-job', displayName: 'Copy job', restType: 'CopyJob', category: 'Data Factory',
    description: 'Wizard-driven bulk ingestion from any supported connector.',
    learnContent: {
      "overview": "A Copy job is wizard-driven bulk ingestion from any supported connector — source to sink, no transforms. In Loom a run materializes a Synapse pipeline and triggers it, with run history sourced from queryPipelineRuns.",
      "steps": [
        {
          "title": "Pick source and sink",
          "body": "Choose a source connector and a destination; the wizard handles the mapping for bulk movement."
        },
        {
          "title": "Choose full or incremental",
          "body": "Configure full copy or incremental load with a watermark column where supported."
        },
        {
          "title": "Run the job",
          "body": "Run materializes a Synapse pipeline behind the scenes and triggers it."
        },
        {
          "title": "Review run history",
          "body": "The runs list reads real pipeline run records so you can confirm rows moved and retry on failure."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-factory/what-is-copy-job"
    } },
  { slug: 'mirrored-database', displayName: 'Mirrored database', restType: 'MirroredDatabase', category: 'Data Factory',
    description: 'Near-real-time replica of Snowflake / SQL DB / Postgres / Cosmos / MSSQL into OneLake.',
    learnContent: {
      "overview": "A Mirrored database is a near-real-time replica of an external source (Azure SQL, Snowflake, Cosmos, Databricks, Postgres) into OneLake. Queries hit the mirror, never the source. Use it to join external data with lakehouses without re-ingesting.",
      "steps": [
        {
          "title": "Pick a source connector",
          "body": "Choose Azure SQL, Snowflake, Cosmos, or Databricks as the replication source."
        },
        {
          "title": "Connect and select tables",
          "body": "Provide a connection and pick tables; Fabric starts and maintains the replica automatically."
        },
        {
          "title": "Query the mirror",
          "body": "Read via the SQL analytics endpoint — joins across mirrors and lakehouses are first-class."
        },
        {
          "title": "Monitor replication",
          "body": "Watch mirror status to confirm the replica is keeping pace with the source."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/database/mirrored-database/overview"
    } },
  { slug: 'mirrored-databricks', displayName: 'Mirrored Databricks catalog', restType: 'MirroredAzureDatabricksCatalog', category: 'Data Factory',
    description: 'Mount a Databricks Unity Catalog as a read-only mirror in OneLake.',
    learnContent: {
      "overview": "A Mirrored Databricks catalog mounts a Databricks Unity Catalog as a read-only mirror in OneLake. In Loom you query the Delta tables from Fabric without re-ingesting. Use it to bring governed Databricks data into Fabric analytics.",
      "steps": [
        {
          "title": "Provide the workspace",
          "body": "Point at the Azure Databricks workspace and Unity Catalog you want to mirror."
        },
        {
          "title": "Select the catalog/schema",
          "body": "Choose which catalog and schemas to expose as a read-only OneLake mirror."
        },
        {
          "title": "Query from Fabric",
          "body": "Read the mirrored Delta tables via the SQL analytics endpoint or Spark — no copy required."
        },
        {
          "title": "Respect source governance",
          "body": "Mirroring is read-only; writes and permissions stay governed by Unity Catalog on the Databricks side."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/database/mirrored-database/azure-databricks-tutorial"
    } },
  { slug: 'mounted-adf', displayName: 'Mounted Data Factory', restType: 'MountedDataFactory', category: 'Data Factory',
    description: 'Reference an existing Azure Data Factory and run its pipelines from Fabric.',
    learnContent: {
      "overview": "A Mounted Data Factory is a read-only attachment of an existing Azure Data Factory. In Loom the run history and monitoring surface natively so you can run ADF pipelines without migrating them. Use it to fold existing ADF investments into Loom.",
      "steps": [
        {
          "title": "Reference the factory",
          "body": "Point at the existing Azure Data Factory resource by subscription and resource group."
        },
        {
          "title": "Browse its pipelines",
          "body": "Loom lists the factory's pipelines so you can trigger them from inside the console."
        },
        {
          "title": "Run and monitor",
          "body": "Trigger a pipeline run and watch run history surfaced from the ADF monitoring API."
        },
        {
          "title": "Keep authoring in ADF",
          "body": "Pipeline editing stays in ADF Studio; the mount is a run-and-monitor surface, not a full authoring replacement."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-factory/use-existing-adf-in-fabric"
    } },
  { slug: 'dbt-job', displayName: 'dbt job', restType: 'DataBuildToolJob', category: 'Data Factory',
    description: 'Run dbt Core projects against your warehouse with schedule + run history.',
    learnContent: {
      "overview": "A dbt job runs a dbt Core project (models, tests, docs) against your warehouse or lakehouse. In Loom a run materializes a Databricks Job with a dbt_task and triggers run-now; the runs list comes from the Databricks jobs/runs API.",
      "steps": [
        {
          "title": "Point at the dbt project",
          "body": "Reference the dbt project location and the target warehouse/lakehouse connection."
        },
        {
          "title": "Configure the run",
          "body": "Set the dbt command (run, test, build) and any selectors for the materialization."
        },
        {
          "title": "Trigger a run",
          "body": "Run materializes a Databricks Job with a dbt_task and calls run-now."
        },
        {
          "title": "Inspect results",
          "body": "The runs list reads real Databricks run records so you can see compiled SQL, materialized models, and test failures."
        }
      ],
      "docsUrl": "https://docs.getdbt.com/docs/introduction"
    } },
  { slug: 'airflow-job', displayName: 'Apache Airflow job', restType: 'ApacheAirflowJob', category: 'Data Factory', preview: true,
    description: 'Managed Airflow DAGs synced from a Git repo (preview).',
    learnContent: {
      "overview": "An Apache Airflow job runs DAGs synced from a Git repo on managed Airflow (preview). Use it when you need Airflow operators (Spark, dbt, Snowflake) beyond what ADF/Synapse pipelines cover. This is a preview surface.",
      "steps": [
        {
          "title": "Connect a Git repo",
          "body": "Point the managed Airflow environment at the Git repo that holds your DAG definitions."
        },
        {
          "title": "Sync DAGs",
          "body": "DAGs sync from the repo and appear in the Airflow environment for scheduling."
        },
        {
          "title": "Use Airflow operators",
          "body": "Author tasks with native operators (Spark, dbt, Snowflake, HTTP) that ADF/Synapse pipelines don't expose."
        },
        {
          "title": "Mind the preview gate",
          "body": "This is a preview item; if the managed Airflow runtime isn't provisioned the editor surfaces the env/bicep requirement."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/airflow-overview"
    } },

  // Data Warehouse
  { slug: 'warehouse', displayName: 'Warehouse', restType: 'Warehouse', category: 'Data Warehouse',
    description: 'Lakehouse-native T-SQL warehouse with separated compute and storage.',
    learnContent: {
      "overview": "A Warehouse is a lakehouse-native T-SQL warehouse with separated compute and storage. In Loom storage lives on OneLake as Parquet and compute auto-scales. Use it for full T-SQL DDL/DML and DirectLake-mode Power BI.",
      "steps": [
        {
          "title": "Create tables in T-SQL",
          "body": "Run CREATE TABLE and INSERT like any T-SQL warehouse — no infrastructure to manage."
        },
        {
          "title": "Cross-database query",
          "body": "Query any lakehouse SQL endpoint or mirrored database in the same workspace from one connection."
        },
        {
          "title": "Serve Power BI",
          "body": "Connect a semantic model in DirectLake mode for sub-second refresh over warehouse tables."
        },
        {
          "title": "Load via pipelines",
          "body": "Land data with a Copy activity or dataflow, then transform with stored procedures."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-warehouse/data-warehousing"
    } },

  // Databases
  { slug: 'sql-database', displayName: 'SQL database', restType: 'SQLDatabase', category: 'Databases',
    description: 'Azure SQL Database surface inside Fabric with auto-mirroring to OneLake.',
    learnContent: {
      "overview": "A SQL database is an Azure SQL Database surface inside Fabric with auto-mirroring to OneLake. In Loom it defaults to Azure SQL Database and can target Managed Instance or SQL Server 2025 features depending on the workload.",
      "steps": [
        {
          "title": "Run T-SQL",
          "body": "Use the query editor to issue T-SQL against the database over TDS with AAD auth."
        },
        {
          "title": "Use OneLake mirroring",
          "body": "Data auto-mirrors to OneLake so analytics queries don't load the transactional database."
        },
        {
          "title": "Manage schema",
          "body": "Create tables, indexes, and stored procedures directly from the editor."
        },
        {
          "title": "Pick the right tier",
          "body": "For low cost choose the serverless General Purpose tier with auto-pause, billed in vCore-seconds."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/database/sql/overview"
    } },

  // Real-Time Intelligence
  { slug: 'eventhouse', displayName: 'Eventhouse', restType: 'Eventhouse', category: 'Real-Time Intelligence',
    description: 'Compute + storage container for one or more KQL databases.',
    learnContent: {
      "overview": "An Eventhouse is a compute-plus-storage container for one or more KQL databases that share compute. In Loom it is wired against the shared Loom ADX cluster. Use it as the home for real-time analytics on streaming telemetry.",
      "steps": [
        {
          "title": "Create KQL databases",
          "body": "Add one or more KQL databases under the eventhouse; they share the eventhouse compute."
        },
        {
          "title": "Ingest streaming data",
          "body": "Feed data in from an Eventstream, Event Hubs, or direct REST ingestion."
        },
        {
          "title": "Query with KQL",
          "body": "Open a KQL queryset to run interactive Kusto queries across the databases."
        },
        {
          "title": "Enable OneLake availability",
          "body": "Turn on OneLake availability so the KQL data is also queryable as Delta from Fabric."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/real-time-intelligence/eventhouse"
    } },
  { slug: 'kql-database', displayName: 'KQL database', restType: 'KQLDatabase', category: 'Real-Time Intelligence',
    description: 'Kusto database for high-volume, low-latency analytics with OneLake availability.',
    learnContent: {
      "overview": "A KQL database is a Kusto store for high-volume, low-latency analytics over time-series, telemetry, and logs, with OneLake availability. In Loom it runs on the shared Loom ADX cluster and is queried with KQL.",
      "steps": [
        {
          "title": "Ingest data",
          "body": "Bring data in from an Eventstream, Event Hubs, or a direct REST POST."
        },
        {
          "title": "Query with KQL",
          "body": "Open a KQL queryset to run interactive queries and pin charts to a Real-Time dashboard."
        },
        {
          "title": "Wire an Activator rule",
          "body": "Attach an Activator on a KQL query to fire on a threshold breach such as failure rate over 5 percent."
        },
        {
          "title": "Expose to Fabric",
          "body": "Enable OneLake availability so the same data is queryable as Delta alongside lakehouses."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-explorer/data-explorer-overview"
    } },
  { slug: 'kql-queryset', displayName: 'KQL queryset', restType: 'KQLQueryset', category: 'Real-Time Intelligence',
    description: 'Persisted set of KQL queries with charts and saved views.',
    learnContent: {
      "overview": "A KQL queryset is a persisted set of KQL queries with charts and saved views — like a report for raw streaming data. In Loom it runs against the shared ADX cluster and feeds Real-Time dashboards.",
      "steps": [
        {
          "title": "Pick a KQL database",
          "body": "Bind the queryset to the KQL database you want to explore."
        },
        {
          "title": "Author queries",
          "body": "Write KQL, run it, and visualize results inline with charts."
        },
        {
          "title": "Save views",
          "body": "Persist named queries so teammates reuse the same definitions."
        },
        {
          "title": "Pin to a dashboard",
          "body": "Pin a chart to a Real-Time dashboard tile for monitoring."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/real-time-intelligence/kusto-query-set"
    } },
  { slug: 'kql-dashboard', displayName: 'Real-Time dashboard', restType: 'KQLDashboard', category: 'Real-Time Intelligence',
    description: 'Tile grid powered by KQL queries with parameters and auto-refresh.',
    learnContent: {
      "overview": "A Real-Time dashboard is a tile grid powered by KQL queries with parameters and auto-refresh. In Loom tiles render from the shared ADX cluster. Use it to monitor live telemetry with drilldowns and time-pickers.",
      "steps": [
        {
          "title": "Add tiles",
          "body": "Each tile is backed by a KQL query against a KQL database."
        },
        {
          "title": "Add parameters",
          "body": "Define parameters (time range, dimension filters) that cascade across tiles."
        },
        {
          "title": "Set auto-refresh",
          "body": "Configure the refresh interval so tiles stay current with the stream."
        },
        {
          "title": "Enable drilldowns",
          "body": "Wire drilldowns and time-pickers so viewers can pivot without editing KQL."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create"
    } },
  { slug: 'eventstream', displayName: 'Eventstream', restType: 'Eventstream', category: 'Real-Time Intelligence',
    description: 'Visual canvas to ingest, transform, and route real-time event streams.',
    learnContent: {
      "overview": "An Eventstream is a code-free visual canvas to ingest, transform, and route real-time event streams. In Loom you wire source connectors (Event Hubs, IoT Hub, Kafka, Azure SQL CDC) through optional transforms to destinations; pipeline config persists to Cosmos.",
      "steps": [
        {
          "title": "Add a source",
          "body": "Use Event Hub or IoT Hub for telemetry, or Kafka for cross-cloud streams, on the visual canvas."
        },
        {
          "title": "Add transforms",
          "body": "Optionally drop in filter, derived columns, or manage-fields nodes before the destination."
        },
        {
          "title": "Add a destination",
          "body": "Route to a KQL database for real-time queries plus a Lakehouse for long-term retention."
        },
        {
          "title": "Route to Activator",
          "body": "Send the stream to an Activator to fire actions on conditions."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview"
    } },
  { slug: 'event-schema-set', displayName: 'Event schema set', restType: 'EventSchemaSet', category: 'Real-Time Intelligence',
    description: 'Schema registry for event streams powering DeltaFlow CDC.',
    learnContent: {
      "overview": "An Event schema set is a schema registry (Avro/JSON Schema/Protobuf) shared across Eventstream sources, KQL ingestion, and downstream consumers powering DeltaFlow CDC. In Loom subjects and schemas persist to Cosmos and the eventstream runtime reads them to validate ingress payloads.",
      "steps": [
        {
          "title": "Register a subject",
          "body": "Create a subject under the Subjects tab to name the schema contract."
        },
        {
          "title": "Add a schema version",
          "body": "Add an Avro, JSON Schema, or Protobuf definition; versions are tracked under the Versions tab."
        },
        {
          "title": "Set compatibility",
          "body": "Choose a compatibility mode; if an external registry (Confluent, Apicurio, Event Hubs) is attached, the Compatibility tab links the docs."
        },
        {
          "title": "Wire to streams",
          "body": "Reference the schema from Eventstream sources so ingress payloads are validated against the contract."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview"
    } },
  { slug: 'activator', displayName: 'Activator', restType: 'Reflex', category: 'Real-Time Intelligence',
    description: 'Detect conditions and trigger actions (Teams, email, pipeline, notebook, Power Automate).',
    learnContent: {
      "overview": "An Activator (Reflex) detects conditions on a stream or KQL query and fires actions — Teams, email, pipeline, notebook, or Power Automate. In Loom it watches a real-time source and triggers automation with no code.",
      "steps": [
        {
          "title": "Pick a source",
          "body": "Bind to a KQL queryset, a semantic model measure, or an Eventstream."
        },
        {
          "title": "Define the trigger",
          "body": "Set the condition — a value crossing a threshold or a pattern occurring over a window."
        },
        {
          "title": "Pick the action",
          "body": "Choose a Teams notification, email, pipeline run, notebook, or Power Automate flow."
        },
        {
          "title": "Activate the rule",
          "body": "Save and activate; the rule runs continuously against the live source."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-activator/activator-introduction"
    } },

  // Data Science
  { slug: 'ml-model', displayName: 'ML model', restType: 'MLModel', category: 'Data Science',
    description: 'MLflow-backed registered model with versions and PREDICT endpoint.',
    learnContent: {
      "overview": "An ML model is an MLflow-backed registered model with versions and a PREDICT endpoint. In Loom it is wired live to the AI Foundry hub (Microsoft.MachineLearningServices/workspaces) via the BFF. Use it to register and deploy trained models.",
      "steps": [
        {
          "title": "Register a model",
          "body": "Log a model in MLflow format from an experiment run; it appears with its version history."
        },
        {
          "title": "Browse versions",
          "body": "The editor lists model versions sourced live from the Foundry hub."
        },
        {
          "title": "Deploy an endpoint",
          "body": "Promote a version to a managed online or batch endpoint for scoring."
        },
        {
          "title": "Score with PREDICT",
          "body": "Call the PREDICT endpoint from notebooks or pipelines to apply the model."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-mlflow-models"
    } },
  { slug: 'ml-experiment', displayName: 'ML experiment', restType: 'MLExperiment', category: 'Data Science',
    description: 'Track runs, parameters, metrics, and artifacts for a model family.',
    learnContent: {
      "overview": "An ML experiment tracks runs, parameters, metrics, and artifacts for a model family using MLflow. In Loom it is wired live to the AI Foundry hub via the BFF. Use it to compare hyperparameter sweeps and promote the winning run.",
      "steps": [
        {
          "title": "Create an experiment",
          "body": "Group related training runs under one experiment name."
        },
        {
          "title": "Log runs",
          "body": "From a notebook, log params, metrics, and artifacts with MLflow; runs appear in the editor."
        },
        {
          "title": "Compare runs",
          "body": "Sort and compare runs by metric to find the best configuration."
        },
        {
          "title": "Register the winner",
          "body": "Promote the winning run to a registered ML model for deployment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-mlflow"
    } },

  // Fabric IQ (preview)
  { slug: 'ontology', displayName: 'Ontology', restType: 'Ontology', category: 'Fabric IQ', preview: true,
    description: 'Define business entities, relationships, and condition-action rules.',
    learnContent: {
      "overview": "An Ontology defines business entities, relationships, and condition-action rules (preview). In Loom it types entities and feeds the graph backend semantic layer. Use it to give connected data a shared vocabulary.",
      "steps": [
        {
          "title": "Define entities",
          "body": "Declare the business entity types and their key properties."
        },
        {
          "title": "Define relationships",
          "body": "Connect entities with typed relationships to model the domain graph."
        },
        {
          "title": "Add rules",
          "body": "Author condition-action rules that fire when entity state changes."
        },
        {
          "title": "Mind the preview gate",
          "body": "Fabric IQ ontology is preview; if the graph backend isn't provisioned the editor discloses what's required."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'graph-model', displayName: 'Graph model', restType: 'GraphModel', category: 'Fabric IQ', preview: true,
    description: 'Native graph storage + GQL queries for connected data.',
    learnContent: {
      "overview": "A Graph model is the schema definition for a property graph — node labels, edge types, allowed properties, indexes (preview). In Loom it feeds Cosmos Gremlin, Cypher-over-ADX, or GQL backends. Use it to design the shape before loading data.",
      "steps": [
        {
          "title": "Declare node labels",
          "body": "Define the node types and the properties each carries."
        },
        {
          "title": "Declare edge types",
          "body": "Define edge types and which node labels they connect."
        },
        {
          "title": "Add indexes",
          "body": "Specify indexes on key properties to speed up traversals."
        },
        {
          "title": "Bind a backend",
          "body": "Map the model onto Cosmos Gremlin, ADX graph (Cypher), or a GQL backend."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'plan', displayName: 'Plan', restType: 'Plan', category: 'Fabric IQ', preview: true,
    description: 'Collaborative planning sheets with writeback and approvals.',
    learnContent: {
      "overview": "A Plan is declarative state for a set of items and their dependencies (preview) — like Terraform for Loom items: diffable, reviewable, applyable. Use it to capture and version the intended shape of a workspace.",
      "steps": [
        {
          "title": "Declare desired items",
          "body": "List the items and bindings the plan should produce."
        },
        {
          "title": "Diff against current",
          "body": "Compare the plan to what actually exists in the workspace."
        },
        {
          "title": "Review the change",
          "body": "Inspect the add/change/remove set before applying."
        },
        {
          "title": "Apply the plan",
          "body": "Apply to reconcile the workspace to the declared state."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'map', displayName: 'Map', restType: 'Map', category: 'Fabric IQ', preview: true,
    description: 'Geospatial visualization layered over Lakehouse, KQL, and Ontology data.',
    learnContent: {
      "overview": "A Map is a geospatial visualization layered over Lakehouse, KQL, and Ontology data (preview). In Loom it is a map artifact bound to a geo-dataset, embeddable in reports and dashboards.",
      "steps": [
        {
          "title": "Bind a geo-dataset",
          "body": "Point the map at a geo-dataset with point or polygon geometry."
        },
        {
          "title": "Add layers",
          "body": "Compose heatmap, choropleth, or point-cluster layers over the data."
        },
        {
          "title": "Style and color",
          "body": "Set color ramps and symbology so the geography reads clearly."
        },
        {
          "title": "Embed it",
          "body": "Embed the map in a report or dashboard for consumers."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'data-agent', displayName: 'Data agent', restType: 'DataAgent', category: 'Fabric IQ',
    description: 'Conversational Q&A grounded in your data sources and semantic model.',
    learnContent: {
      "overview": "A Data agent is conversational Q&A grounded in your data sources and semantic model. In Loom it is built on a Foundry prompt-flow plus AI Search hybrid retrieval over your warehouse, lakehouse, and semantic models.",
      "steps": [
        {
          "title": "Pick data sources",
          "body": "Ground the agent on a warehouse, lakehouse, and/or semantic model."
        },
        {
          "title": "Configure retrieval",
          "body": "The agent uses AI Search hybrid retrieval plus a Foundry prompt flow to answer."
        },
        {
          "title": "Test questions",
          "body": "Ask sample business questions and verify the agent cites the right data."
        },
        {
          "title": "Refine grounding",
          "body": "Tune the sources and prompt so answers stay accurate and on-topic."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/fabric-iq"
    } },
  { slug: 'operations-agent', displayName: 'Operations agent', restType: 'OperationsAgent', category: 'Fabric IQ', preview: true,
    description: 'Monitor real-time data and recommend actions via Activator + Power Automate.',
    learnContent: {
      "overview": "An Operations agent monitors real-time data and recommends actions via Activator and Power Automate (preview). In Loom it watches items and workspaces, flags drift, opens incidents in the audit log, and proposes remediations via the Cross-item Copilot.",
      "steps": [
        {
          "title": "Set what to watch",
          "body": "Choose the items, workspaces, or streams the agent should monitor."
        },
        {
          "title": "Define signals",
          "body": "Configure the drift or threshold signals that should raise an incident."
        },
        {
          "title": "Wire actions",
          "body": "Connect Activator and Power Automate so the agent can act on findings."
        },
        {
          "title": "Mind the preview gate",
          "body": "This is preview; if the supporting runtime isn't provisioned the editor discloses what's required."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-activator/activator-introduction"
    } },

  // Power BI
  { slug: 'semantic-model', displayName: 'Semantic model', restType: 'SemanticModel', category: 'Power BI',
    description: 'Tables, relationships, measures, and roles backing Power BI reports.',
    learnContent: {
      "overview": "A Semantic model holds the tables, relationships, measures, and roles backing Power BI reports. In Loom it is wired against live Power BI REST via the Console UAMI. Use it as the shared business layer for reports, dashboards, and scorecards.",
      "steps": [
        {
          "title": "Connect data",
          "body": "Connect to a Lakehouse, warehouse SQL endpoint, or import data directly."
        },
        {
          "title": "Author DAX measures",
          "body": "Write measures for KPIs such as Revenue, Cost, and Margin percent."
        },
        {
          "title": "Configure RLS",
          "body": "Define row-level security roles so each consumer sees only their slice."
        },
        {
          "title": "Refresh the model",
          "body": "Trigger or schedule a refresh; the editor calls live Power BI REST and surfaces 401/403 with a hint if the UAMI isn't yet a workspace member."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/transform-model/datasets/dataset-modes-understand"
    } },
  { slug: 'report', displayName: 'Report', restType: 'Report', category: 'Power BI',
    description: 'Interactive Power BI report with pages, visuals, and filters.',
    learnContent: {
      "overview": "A Report is an interactive Power BI report with pages, visuals, and filters bound to a semantic model. In Loom it is reframed around embed, refresh, and export against live Power BI REST via the Console UAMI.",
      "steps": [
        {
          "title": "Bind a semantic model",
          "body": "The report's visuals read from a semantic model in the same workspace."
        },
        {
          "title": "Embed and view",
          "body": "Loom embeds the report so you can slice and drill in-console."
        },
        {
          "title": "Refresh underlying data",
          "body": "Refresh the bound semantic model to update the visuals."
        },
        {
          "title": "Export",
          "body": "Export to PDF/PPTX via the Power BI REST export-to-file flow; 401/403 surfaces a remediation hint."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/create-reports/"
    } },
  { slug: 'dashboard', displayName: 'Dashboard', restType: 'Dashboard', category: 'Power BI',
    description: 'Pinned-visual dashboard surfacing tiles from multiple reports.',
    learnContent: {
      "overview": "A Dashboard is a pinned-visual canvas surfacing tiles from multiple reports. In Loom it is wired against live Power BI REST via the Console UAMI. Use it to monitor KPIs at a glance across reports.",
      "steps": [
        {
          "title": "Pin tiles",
          "body": "Pin visuals from one or more reports onto the dashboard canvas."
        },
        {
          "title": "Arrange the layout",
          "body": "Size and position tiles so the most important KPIs read first."
        },
        {
          "title": "Embed and view",
          "body": "Loom embeds the dashboard for in-console monitoring."
        },
        {
          "title": "Mind tenant gating",
          "body": "If the Console UAMI isn't yet registered in the Power BI tenant or workspace, the editor surfaces the 401/403 with a remediation hint."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/create-reports/service-dashboards"
    } },
  { slug: 'paginated-report', displayName: 'Paginated report', restType: 'PaginatedReport', category: 'Power BI',
    description: 'Pixel-perfect RDL report for printable, parameterized output.',
    learnContent: {
      "overview": "A Paginated report is a pixel-perfect RDL report for printable, parameterized output (formerly SSRS) — invoices, financial statements, regulatory filings. In Loom it is wired against live Power BI REST via the Console UAMI.",
      "steps": [
        {
          "title": "Bind a data source",
          "body": "The RDL report queries a semantic model or direct SQL source."
        },
        {
          "title": "Set parameters",
          "body": "Define report parameters so consumers run it for a specific scope (date range, entity)."
        },
        {
          "title": "Render and view",
          "body": "Loom embeds the rendered report for review."
        },
        {
          "title": "Export to PDF",
          "body": "Export pixel-perfect output via Power BI REST; tenant 401/403 surfaces a remediation hint."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/paginated-reports/paginated-reports-report-builder-power-bi"
    } },
  { slug: 'scorecard', displayName: 'Scorecard', restType: 'Scorecard', category: 'Power BI', noRestApi: true,
    description: 'KPI tree with targets and status (no REST API today; metadata only).',
    learnContent: {
      "overview": "A Scorecard is a KPI tree with targets and status (OKR-style). There is no Fabric REST API for scorecards today, so in Loom this is metadata-only — the editor persists the KPI hierarchy and discloses the API limitation honestly.",
      "steps": [
        {
          "title": "Define goals",
          "body": "Create the top-level goals and their owners."
        },
        {
          "title": "Add KPIs",
          "body": "Nest KPIs under goals with targets and current values."
        },
        {
          "title": "Set status and cadence",
          "body": "Track progress against targets with a check-in cadence."
        },
        {
          "title": "Know the API limit",
          "body": "No scorecard REST API exists today, so this surface stores metadata only and says so in a MessageBar rather than faking live values."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/consumer/metrics/metrics-get-started"
    } },

  // APIs and functions
  { slug: 'graphql-api', displayName: 'API for GraphQL', restType: 'GraphQLApi', category: 'APIs and functions',
    description: 'Single GraphQL endpoint over Warehouse / Lakehouse / SQL DB / mirrored DBs.',
    learnContent: {
      "overview": "An API for GraphQL exposes a single GraphQL endpoint over Warehouse, Lakehouse, SQL DB, or mirrored databases. In Loom it auto-generates CRUD plus custom resolvers. Use it to give app developers one typed endpoint over your data.",
      "steps": [
        {
          "title": "Pick a data source",
          "body": "Point the API at a Warehouse, Lakehouse SQL endpoint, SQL DB, or mirrored database."
        },
        {
          "title": "Expose types",
          "body": "Select tables/views to expose; CRUD operations are auto-generated as a schema."
        },
        {
          "title": "Test in the explorer",
          "body": "Run queries and mutations against the endpoint to validate the schema."
        },
        {
          "title": "Secure access",
          "body": "Front the endpoint through APIM for auth, rate limiting, and observability."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/api-graphql-overview"
    } },
  { slug: 'user-data-function', displayName: 'User data function', restType: 'UserDataFunction', category: 'APIs and functions',
    description: 'Python functions with bindings to Fabric items and external connections.',
    learnContent: {
      "overview": "A User data function is Python (or C#) server-side compute with bindings to Fabric items and external connections, callable from notebooks, pipelines, and Power BI. In Loom it runs serverless with per-call billing.",
      "steps": [
        {
          "title": "Write the function",
          "body": "Author a Python function with input/output bindings to Fabric items."
        },
        {
          "title": "Add connections",
          "body": "Bind external connections the function needs (databases, APIs)."
        },
        {
          "title": "Test invoke",
          "body": "Run the function with sample inputs to validate behavior."
        },
        {
          "title": "Call from items",
          "body": "Invoke it from notebooks, pipelines, or Power BI; billing is serverless per call."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/data-engineering/user-data-functions/user-data-functions-overview"
    } },
  { slug: 'variable-library', displayName: 'Variable library', restType: 'VariableLibrary', category: 'APIs and functions',
    description: 'Centralized variables with value sets per environment (dev / test / prod).',
    learnContent: {
      "overview": "A Variable library is a centralized name-to-value store with value sets per environment (dev/test/prod). In Loom it is workspace- or domain-scoped and used for pipeline, notebook, and SQL parameter substitution.",
      "steps": [
        {
          "title": "Define variables",
          "body": "Add named variables with a default value."
        },
        {
          "title": "Add value sets",
          "body": "Create per-environment value sets (dev/test/prod) that override defaults."
        },
        {
          "title": "Reference from items",
          "body": "Use variables in pipelines, notebooks, and SQL via parameter substitution."
        },
        {
          "title": "Promote across stages",
          "body": "Switch the active value set when deploying between environments."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/cicd/variable-library/variable-library-overview"
    } },

  // --- Azure-native services, surfaced 1:1 in Loom (no studio jumps) ---
  // Synapse Analytics
  { slug: 'synapse-dedicated-sql-pool',  displayName: 'Synapse dedicated SQL pool',  restType: 'SynapseDedicatedSqlPool',  category: 'Synapse Analytics',
    description: 'Provisioned, MPP T-SQL warehouse. Query editor, monitoring, scaling — native in Loom.',
    learnContent: {
      "overview": "A Synapse dedicated SQL pool is a provisioned MPP T-SQL warehouse (formerly SQL DW). In Loom it is wired via ARM REST for pause/resume and TDS query on workspace.sql.azuresynapse.net through the Console MI. It auto-pauses to control cost.",
      "steps": [
        {
          "title": "Resume the pool",
          "body": "Resume from the editor; the first query blocks until the pool reaches Online (about 60-90 seconds)."
        },
        {
          "title": "Run T-SQL",
          "body": "Use Run query to issue T-SQL; Recent runs shows execution history and DMV stats."
        },
        {
          "title": "Scale for load",
          "body": "Raise the SLO/DWU level temporarily for high-concurrency loads — billing scales with the SLO."
        },
        {
          "title": "Pause when idle",
          "body": "Pause the pool when not running ELT; paused pools incur storage cost only, and a built-in auto-pause Logic App suspends it after the idle window."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-overview-what-is"
    } },
  { slug: 'synapse-serverless-sql-pool', displayName: 'Synapse serverless SQL pool', restType: 'SynapseServerlessSqlPool', category: 'Synapse Analytics',
    description: 'Pay-per-query T-SQL over ADLS. OPENROWSET, external tables, ad-hoc analytics.',
    learnContent: {
      "overview": "A Synapse serverless SQL pool is a pay-per-query T-SQL endpoint over ADLS — OPENROWSET, external tables, ad-hoc analytics, no compute to provision. In Loom it queries workspace-ondemand.sql.azuresynapse.net via the Console MI over a private endpoint.",
      "steps": [
        {
          "title": "Run a SELECT",
          "body": "Browse to Run query and paste a SELECT; cost is metered by bytes scanned."
        },
        {
          "title": "Query files with OPENROWSET",
          "body": "Read Parquet with OPENROWSET(BULK '...', FORMAT='PARQUET'); for Delta use FORMAT='DELTA'."
        },
        {
          "title": "Save shared views",
          "body": "Persist reusable views to share definitions with teammates."
        },
        {
          "title": "Minimize scans",
          "body": "Filter on partitioned columns (year/month/day) and select only needed columns to cut cost."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview"
    } },
  { slug: 'synapse-spark-pool',          displayName: 'Synapse Spark pool',          restType: 'SynapseSparkPool',          category: 'Synapse Analytics',
    description: 'Apache Spark notebooks + job definitions on Synapse-managed clusters.',
    learnContent: {
      "overview": "A Synapse Spark pool is Apache Spark compute for notebooks and Spark job definitions on Synapse-managed clusters. In Loom it auto-scales and auto-pauses, sized by node family. Use it as the compute behind data engineering notebooks.",
      "steps": [
        {
          "title": "Size the pool",
          "body": "Pick a node family and worker range; enable autoscale for variable load."
        },
        {
          "title": "Set auto-pause",
          "body": "Configure an idle timeout so the pool pauses and stops billing compute."
        },
        {
          "title": "Attach notebooks",
          "body": "Attach notebooks and Spark job definitions to the pool to run code."
        },
        {
          "title": "Monitor sessions",
          "body": "Watch active Spark sessions and applications from the editor."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-pool-configurations"
    } },
  { slug: 'synapse-pipeline',            displayName: 'Synapse pipeline',            restType: 'SynapsePipeline',           category: 'Synapse Analytics',
    description: 'Synapse Integrate canvas — pipelines, dataflows, triggers native to Synapse.',
    learnContent: {
      "overview": "A Synapse pipeline is the Synapse Integrate canvas — ADF-shaped pipelines, dataflows, and triggers that run inside a Synapse workspace. In Loom it reuses Synapse-attached linked services and integration runtimes.",
      "steps": [
        {
          "title": "Add activities",
          "body": "Drag Copy, Notebook, and control-flow activities onto the canvas."
        },
        {
          "title": "Reuse linked services",
          "body": "Bind activities to the Synapse workspace's linked services and integration runtimes."
        },
        {
          "title": "Wire dependencies",
          "body": "Connect activities with success/failure conditions to control flow."
        },
        {
          "title": "Trigger and monitor",
          "body": "Attach a trigger and review run history from the Synapse monitoring API."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/data-integration/concepts-data-factory-differences"
    } },
  // Azure Databricks
  { slug: 'databricks-notebook',         displayName: 'Databricks notebook',         restType: 'DatabricksNotebook',        category: 'Azure Databricks',
    description: 'Databricks notebook cells (PySpark / SQL / R / Scala) with cluster attach.',
    learnContent: {
      "overview": "A Databricks notebook runs PySpark/SQL/R/Scala cells with cluster attach, Unity Catalog governance, and Photon execution. In Loom it is wired against the Loom-deployed Databricks workspace via Container App MI and AAD bearer tokens.",
      "steps": [
        {
          "title": "Attach a cluster",
          "body": "Attach the notebook to an all-purpose or job cluster before running cells."
        },
        {
          "title": "Use Unity Catalog",
          "body": "Read and write tables governed by Unity Catalog three-part names (catalog.schema.table)."
        },
        {
          "title": "Run cells",
          "body": "Execute PySpark, SQL, R, or Scala cells; Photon accelerates SQL."
        },
        {
          "title": "Promote to a job",
          "body": "Schedule the notebook as a task in a Databricks job for unattended runs."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/databricks/notebooks/"
    } },
  { slug: 'databricks-job',              displayName: 'Databricks job',              restType: 'DatabricksJob',             category: 'Azure Databricks',
    description: 'Multi-task Databricks job — notebooks, JARs, Python wheels, dbt, SQL.',
    learnContent: {
      "overview": "A Databricks job is a multi-task workflow — notebooks, JARs, Python wheels, dbt, SQL — with dependencies and retry policies. In Loom it runs against the Loom-deployed Databricks workspace via the jobs API.",
      "steps": [
        {
          "title": "Add tasks",
          "body": "Compose tasks from notebooks, JARs, Python wheels, dbt, or SQL."
        },
        {
          "title": "Wire dependencies",
          "body": "Set task dependencies and per-task retry policies."
        },
        {
          "title": "Trigger run-now",
          "body": "Run the job on demand or schedule it; runs surface from jobs/runs/list."
        },
        {
          "title": "Inspect runs",
          "body": "Review real run records to see task status, output, and failures."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/databricks/jobs/"
    } },
  { slug: 'databricks-cluster',          displayName: 'Databricks cluster',          restType: 'DatabricksCluster',         category: 'Azure Databricks',
    description: 'All-purpose or job cluster — node types, autoscale, init scripts, libraries.',
    learnContent: {
      "overview": "A Databricks cluster is all-purpose or job Spark compute — node types, autoscale, init scripts, libraries. In Loom it is managed against the Loom-deployed Databricks workspace. Auto-terminate controls cost.",
      "steps": [
        {
          "title": "Pick node type and size",
          "body": "Choose driver/worker node types and a fixed or autoscaling worker count."
        },
        {
          "title": "Add libraries and init scripts",
          "body": "Attach libraries and init scripts the workloads need at startup."
        },
        {
          "title": "Set auto-terminate",
          "body": "Configure an idle auto-terminate window so the cluster stops billing when unused."
        },
        {
          "title": "Start and attach",
          "body": "Start the cluster and attach notebooks or jobs to it."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/databricks/compute/"
    } },
  { slug: 'databricks-sql-warehouse',    displayName: 'Databricks SQL warehouse',    restType: 'DatabricksSqlWarehouse',    category: 'Azure Databricks',
    description: 'Serverless / classic SQL warehouse with Unity Catalog and Photon.',
    learnContent: {
      "overview": "A Databricks SQL warehouse is a serverless or classic SQL endpoint over Delta Lake with Unity Catalog and Photon. In Loom it lists real warehouses and runs statements via /api/2.0/sql against the Loom-deployed workspace.",
      "steps": [
        {
          "title": "Start a warehouse",
          "body": "Lists real warehouses; start/stop via the /start and /stop endpoints."
        },
        {
          "title": "Browse Unity Catalog",
          "body": "Run SHOW CATALOGS/SCHEMAS/TABLES to navigate governed data."
        },
        {
          "title": "Run SQL",
          "body": "Execute statements via /api/2.0/sql/statements with result polling."
        },
        {
          "title": "Connect BI tools",
          "body": "Point Power BI, Tableau, or Excel at the warehouse via JDBC/ODBC."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/databricks/sql/admin/sql-endpoints"
    } },
  // Azure Data Factory (separate from Fabric Data Factory)
  { slug: 'adf-pipeline',                displayName: 'ADF pipeline',                restType: 'AdfPipeline',               category: 'Azure Data Factory',
    description: 'Classic ADF pipeline — 90+ activities, IR-aware, on-prem via Self-hosted IR.',
    learnContent: {
      "overview": "An ADF pipeline is a classic Azure Data Factory pipeline — 90+ activities, integration-runtime-aware, on-prem via Self-hosted IR. In Loom it sits alongside Synapse and Fabric pipelines and reuses ADF linked services and IRs.",
      "steps": [
        {
          "title": "Add activities",
          "body": "Compose from the 90+ ADF activities (Copy, Lookup, ForEach, Notebook, Web, etc.)."
        },
        {
          "title": "Use integration runtimes",
          "body": "Run via Azure IR, or reach on-prem sources through a Self-hosted IR."
        },
        {
          "title": "Wire control flow",
          "body": "Connect activities with dependency conditions on the canvas."
        },
        {
          "title": "Trigger and monitor",
          "body": "Attach a trigger and review run history from the ADF monitoring API."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities"
    } },
  { slug: 'adf-dataset',                 displayName: 'ADF dataset',                 restType: 'AdfDataset',                category: 'Azure Data Factory',
    description: 'Typed dataset over linked services — JSON, Parquet, Delimited, SQL, REST, etc.',
    learnContent: {
      "overview": "An ADF dataset is a typed pointer over linked services — JSON, Parquet, Delimited, SQL, REST, and more. In Loom it defines the source/sink shape used by Copy Data and Mapping Data Flow activities.",
      "steps": [
        {
          "title": "Pick a linked service",
          "body": "Bind the dataset to a linked service that holds the connection."
        },
        {
          "title": "Choose the format",
          "body": "Select JSON, Parquet, Delimited, SQL table, REST, or another supported type."
        },
        {
          "title": "Define the schema",
          "body": "Set the structure so activities know the source/sink shape."
        },
        {
          "title": "Use in activities",
          "body": "Reference the dataset from Copy Data or Mapping Data Flow source/sink."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-datasets-linked-services"
    } },
  { slug: 'adf-trigger',                 displayName: 'ADF trigger',                 restType: 'AdfTrigger',                category: 'Azure Data Factory',
    description: 'Schedule, tumbling window, storage event, or custom event trigger.',
    learnContent: {
      "overview": "An ADF trigger is a schedule, tumbling window, storage event, or custom event trigger that invokes a pipeline. In Loom you wire one or more pipelines per trigger to automate ADF runs.",
      "steps": [
        {
          "title": "Pick a trigger type",
          "body": "Choose schedule, tumbling window, storage event, or custom event."
        },
        {
          "title": "Configure timing",
          "body": "Set recurrence, window size, or the event source that fires the trigger."
        },
        {
          "title": "Bind pipelines",
          "body": "Attach one or more pipelines that the trigger should invoke."
        },
        {
          "title": "Activate",
          "body": "Start the trigger so runs begin on schedule or on event."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers"
    } },
  // Azure Stream Analytics — real-time streaming SQL over Event Hubs / IoT Hub / Blob
  { slug: 'stream-analytics-job',        displayName: 'Stream Analytics job',        restType: 'StreamAnalyticsJob',        category: 'Streaming analytics',
    description: 'Continuous SQL-style queries over real-time streams (Event Hubs / IoT Hub / Blob) writing to Blob / SQL / Power BI / Event Hub / ADX / Cosmos.',
    learnContent: {
      "overview": "A Stream Analytics job runs continuous SQL-style queries over real-time streams (Event Hubs, IoT Hub, Blob) writing to Blob, SQL, Power BI, Event Hub, ADX, or Cosmos. In Loom it is listed and managed via ARM through the Console UAMI; the query persists to ARM via the transformations endpoint.",
      "steps": [
        {
          "title": "Review job state",
          "body": "The editor lists ASA jobs via ARM and shows state (Starting/Started/Stopping/Stopped) plus last output time."
        },
        {
          "title": "Edit the query",
          "body": "Write the Stream Analytics Query Language (SQL-like) query; Save PUTs it to /streamingjobs/{name}/transformations."
        },
        {
          "title": "Reference inputs and outputs",
          "body": "Inputs (Event Hubs/IoT Hub/Blob) and outputs are shown as references; full create flow is deferred to a later version."
        },
        {
          "title": "Start and stop",
          "body": "Start or Stop the job from the editor; if no job exists, a MessageBar names the bicep module and LOOM_ASA_RG/LOOM_ASA_SUB env vars needed."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/stream-analytics/stream-analytics-introduction"
    } },

  // --- API-first surfacing: APIM is the runtime glue for every Loom-managed function, ML endpoint, and data product ---
  { slug: 'apim-api',                    displayName: 'APIM API',                    restType: 'ApimApi',                   category: 'APIs and functions',
    description: 'A versioned API on Azure API Management. Auto-imports OpenAPI / GraphQL / WSDL; ties to Loom items as backends.',
    learnContent: {
      "overview": "An APIM API is a versioned API on Azure API Management that auto-imports OpenAPI/GraphQL/WSDL and ties Loom items as backends. In Loom it is wired live to the deployed APIM instance; Save issues a real PUT.",
      "steps": [
        {
          "title": "Load or import",
          "body": "Load existing operations and spec, or import an OpenAPI spec to bootstrap operations."
        },
        {
          "title": "Edit API settings",
          "body": "Set display name, path, protocols, and whether a subscription is required; Save PUTs to APIM."
        },
        {
          "title": "Attach to products",
          "body": "Add the API to one or more products to control subscription and visibility."
        },
        {
          "title": "Add policies",
          "body": "Apply auth, throttling, or transformation policies at API or operation scope."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/api-management/api-management-key-concepts"
    } },
  { slug: 'apim-product',                displayName: 'APIM product',                restType: 'ApimProduct',               category: 'APIs and functions',
    description: 'Bundles APIs into a subscribable offering: rate limits, quotas, terms, publisher portal landing.',
    learnContent: {
      "overview": "An APIM product bundles APIs into a subscribable offering with rate limits, quotas, terms, and a publisher-portal landing. In Loom it is wired live to the deployed APIM; Save issues a real PUT.",
      "steps": [
        {
          "title": "Load the product",
          "body": "Open the product to edit its display name, description, and state."
        },
        {
          "title": "Set subscription rules",
          "body": "Configure whether subscription and approval are required and any quotas."
        },
        {
          "title": "Add APIs",
          "body": "Bundle one or more APIs into the product as a unit consumers subscribe to."
        },
        {
          "title": "Save",
          "body": "Save PUTs the product to APIM so it appears in the publisher portal."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/api-management/api-management-howto-add-products"
    } },
  { slug: 'apim-policy',                 displayName: 'APIM policy',                 restType: 'ApimPolicy',                category: 'APIs and functions',
    description: 'Inbound / backend / outbound / on-error XML policy: JWT validation, rate-limit, cache, transform, mock.',
    learnContent: {
      "overview": "An APIM policy is inbound/backend/outbound/on-error XML applied at a scope — JWT validation, rate-limit, cache, transform, mock. In Loom you load the policy XML for a scope, it validates well-formed XML client-side, and Save issues a real PUT.",
      "steps": [
        {
          "title": "Pick a scope",
          "body": "Choose the global, product, API, or operation scope whose policy you want to edit."
        },
        {
          "title": "Edit the XML",
          "body": "Author inbound/backend/outbound/on-error sections; the editor checks the XML is well-formed."
        },
        {
          "title": "Add common policies",
          "body": "Insert JWT validation, rate-limit, cache, transform, or mock policies."
        },
        {
          "title": "Save",
          "body": "Save PUTs the policy to the chosen APIM scope."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/api-management/api-management-howto-policies"
    } },
  { slug: 'data-product',                displayName: 'Data product',                restType: 'DataProduct',               category: 'APIs and functions',
    description: 'Data-mesh-aligned package: dataset + semantic contract + APIM API + access policy + owner. Listed in the marketplace.',
    learnContent: {
      "overview": "A Data product is a data-mesh-aligned package — dataset plus semantic contract, an APIM API, an access policy, and an owner — listed in the marketplace. In Loom the Publish-to-APIM button POSTs a real product as an idempotent upsert.",
      "steps": [
        {
          "title": "Define the contract",
          "body": "Describe the dataset, its semantic contract, owner, and SLA."
        },
        {
          "title": "Set the access policy",
          "body": "Define who can subscribe and under what terms."
        },
        {
          "title": "Publish to APIM",
          "body": "Publish-to-APIM POSTs a real APIM product (idempotent upsert) fronting the data product."
        },
        {
          "title": "List in the marketplace",
          "body": "The product surfaces in the OneLake catalog and API marketplace for discovery."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/purview/concept-data-products"
    } },

  // --- Azure AI Foundry hub (Microsoft.MachineLearningServices/workspaces kind=Hub) ---
  { slug: 'ai-foundry-hub',              displayName: 'AI Foundry hub',              restType: 'AiFoundryHub',              category: 'Azure AI Foundry',
    description: 'Azure AI Foundry hub workspace — connections, models, online endpoints, computes, datastores, and jobs. Native in Loom.',
    learnContent: {
      "overview": "An AI Foundry hub is an Azure AI Foundry hub workspace (Microsoft.MachineLearningServices/workspaces kind=Hub) — connections, models, online endpoints, computes, datastores, and jobs. In Loom it is the shared parent for projects, prompt flows, and evaluations.",
      "steps": [
        {
          "title": "Connect models",
          "body": "Add connections to Azure OpenAI, the Foundry catalog, or your own endpoints."
        },
        {
          "title": "Create a project",
          "body": "Spin up an AI Foundry project under the hub that inherits its connections and datastores."
        },
        {
          "title": "Build a prompt flow",
          "body": "Chain retrieval, LLM, and post-processing nodes in a prompt flow."
        },
        {
          "title": "Evaluate before deploy",
          "body": "Run evaluations on a curated test set before promoting a deployment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/concepts/architecture"
    } },

  // v2.5 — Azure AI Foundry sub-editors (project + project-scoped surfaces)
  { slug: 'ai-foundry-project',          displayName: 'AI Foundry project',          restType: 'AiFoundryProject',          category: 'Azure AI Foundry',
    description: 'Child workspace under the Foundry hub. Inherits connections/models/datastores; scopes prompt flows, evaluations, and data assets.',
    learnContent: {
      "overview": "An AI Foundry project is a child workspace under the Foundry hub. It inherits connections, models, and datastores and scopes prompt flows, evaluations, and data assets. In Loom it is wired to its BFF route and discloses 503/notDeployed honestly.",
      "steps": [
        {
          "title": "Create under the hub",
          "body": "The project inherits the hub's connections, models, and datastores."
        },
        {
          "title": "Scope assets",
          "body": "Author project-scoped prompt flows, evaluations, and data assets."
        },
        {
          "title": "Run experiments",
          "body": "Iterate on flows and evaluations within the project boundary."
        },
        {
          "title": "Mind provisioning",
          "body": "If the Foundry runtime isn't provisioned the BFF returns 503/notDeployed and the editor surfaces the hint."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/concepts/architecture"
    } },
  { slug: 'prompt-flow',                 displayName: 'Prompt flow',                 restType: 'PromptFlow',                category: 'Azure AI Foundry',
    description: 'LangChain-style flow graph of LLM + tool nodes. Author the YAML/JSON definition, run with inputs, view run history.',
    learnContent: {
      "overview": "A Prompt flow is a LangChain-style graph of LLM and tool nodes. In Loom you author the YAML/JSON definition, run it with inputs, and view run history via the Foundry BFF route.",
      "steps": [
        {
          "title": "Author the flow",
          "body": "Define the node graph (retrieval, LLM, post-processing) in YAML/JSON."
        },
        {
          "title": "Run with inputs",
          "body": "Provide sample inputs and run to see node outputs end-to-end."
        },
        {
          "title": "View run history",
          "body": "Inspect prior runs for reproducibility and debugging."
        },
        {
          "title": "Evaluate",
          "body": "Pair with a Foundry evaluation to score the flow before promoting it."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/how-to/prompt-flow"
    } },
  { slug: 'evaluation',                  displayName: 'Foundry evaluation',          restType: 'FoundryEvaluation',         category: 'Azure AI Foundry',
    description: 'Run quality / safety / accuracy evaluators against a dataset + model deployment. Surfaces metric tables and pass/fail signals.',
    learnContent: {
      "overview": "A Foundry evaluation runs quality/safety/accuracy evaluators against a dataset plus a model deployment, surfacing metric tables and pass/fail signals. In Loom it is wired to the Foundry BFF route.",
      "steps": [
        {
          "title": "Pick a dataset",
          "body": "Select the test dataset to evaluate against."
        },
        {
          "title": "Choose evaluators",
          "body": "Add built-in evaluators (groundedness, relevance, fluency) plus any custom ones."
        },
        {
          "title": "Run the evaluation",
          "body": "Run against the model deployment to produce metric tables."
        },
        {
          "title": "Read pass/fail",
          "body": "Review pass/fail signals to decide whether to promote the deployment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/how-to/evaluate-generative-ai-app"
    } },
  { slug: 'content-safety',              displayName: 'Content Safety',              restType: 'ContentSafety',             category: 'Azure AI Foundry',
    description: 'Azure AI Content Safety: text + image moderation across hate/violence/sexual/self-harm with severity thresholds.',
    learnContent: {
      "overview": "Content Safety is Azure AI Content Safety — text and image moderation across hate/violence/sexual/self-harm with severity thresholds. In Loom you configure thresholds and wire it in front of any LLM call.",
      "steps": [
        {
          "title": "Set categories",
          "body": "Enable the harm categories you want screened (hate, violence, sexual, self-harm)."
        },
        {
          "title": "Tune severity thresholds",
          "body": "Set the severity threshold per category that should block content."
        },
        {
          "title": "Test content",
          "body": "Run sample text or images through to see the severity scores."
        },
        {
          "title": "Wire in front of the LLM",
          "body": "Place Content Safety ahead of prompt flow or agent calls to filter inputs and outputs."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-services/content-safety/overview"
    } },
  { slug: 'tracing',                     displayName: 'Foundry tracing',             restType: 'FoundryTracing',            category: 'Azure AI Foundry',
    description: 'Operation traces (App Insights) for prompt flow runs, evaluator runs, and endpoint calls. Filter by operation + window.',
    learnContent: {
      "overview": "Foundry tracing surfaces operation traces (Application Insights) for prompt flow runs, evaluator runs, and endpoint calls. In Loom you filter by operation and time window to drill from a failed run into the actual span.",
      "steps": [
        {
          "title": "Pick an operation",
          "body": "Filter traces by operation type (flow run, evaluator, endpoint call)."
        },
        {
          "title": "Set a window",
          "body": "Choose the time window to scope the trace list."
        },
        {
          "title": "Open a span",
          "body": "Drill into a span to see latency, tokens, and errors for the call."
        },
        {
          "title": "Diagnose failures",
          "body": "Use traces to find the failing node or call behind a bad run."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/concepts/trace"
    } },
  { slug: 'ai-search-index',             displayName: 'AI Search index',             restType: 'AiSearchIndex',             category: 'Azure AI Foundry',
    description: 'Azure AI Search index — fields, scoring profiles, vector + hybrid query. Backs RAG grounding for Foundry agents.',
    learnContent: {
      "overview": "An AI Search index is an Azure AI Search index — fields, scoring profiles, vector and hybrid query — that backs RAG grounding for Foundry agents. In Loom it is wired to the Foundry BFF route.",
      "steps": [
        {
          "title": "Define the schema",
          "body": "Set content, vector, and metadata fields for the index."
        },
        {
          "title": "Run an indexer",
          "body": "Index data from Blob, ADLS, Cosmos, or SQL into the search index."
        },
        {
          "title": "Query hybrid",
          "body": "Run vector + BM25 + semantic-ranker hybrid queries."
        },
        {
          "title": "Ground an agent",
          "body": "Point a prompt flow or data agent at the index for RAG grounding."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/search/search-what-is-azure-search"
    } },
  { slug: 'compute',                     displayName: 'Foundry compute',             restType: 'FoundryCompute',            category: 'Azure AI Foundry',
    description: 'AML compute instances + clusters. Create, start, stop, scale, delete. Used by prompt flows, evaluations, training jobs.',
    learnContent: {
      "overview": "Foundry compute manages AML compute instances and clusters — create, start, stop, scale, delete. In Loom it is used by prompt flows, evaluations, and training jobs; auto-shutdown reduces idle cost.",
      "steps": [
        {
          "title": "Create compute",
          "body": "Provision a compute instance or cluster by VM size and node count."
        },
        {
          "title": "Set auto-shutdown",
          "body": "Configure auto-shutdown so idle compute stops billing."
        },
        {
          "title": "Start and scale",
          "body": "Start, stop, or scale the compute as workloads demand."
        },
        {
          "title": "Attach to workloads",
          "body": "Use the compute for prompt flows, evaluations, and training jobs."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-compute-target"
    } },
  { slug: 'dataset',                     displayName: 'Foundry dataset',             restType: 'FoundryDataset',            category: 'Azure AI Foundry',
    description: 'AML data asset — URI file, URI folder, or MLTable. Versioned, used by prompt flows + evaluations + training runs.',
    learnContent: {
      "overview": "A Foundry dataset is an AML data asset — URI file, URI folder, or MLTable — versioned and used by prompt flows, evaluations, and training runs. In Loom it is wired to the Foundry BFF route.",
      "steps": [
        {
          "title": "Register a data asset",
          "body": "Create a URI file, URI folder, or MLTable pointing at your data."
        },
        {
          "title": "Version it",
          "body": "Each registration is versioned and lineage-tracked."
        },
        {
          "title": "Use in flows",
          "body": "Reference the dataset as input to prompt flows and evaluations."
        },
        {
          "title": "Feed training",
          "body": "Use it as the training input for ML jobs."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-data"
    } },

  // --- v3 — Copilot Studio (Power Platform / Dataverse-backed agents) ---
  { slug: 'copilot-studio-agent',        displayName: 'Copilot Studio agent',        restType: 'CopilotStudioAgent',        category: 'Copilot Studio',
    description: 'Conversational agent stored in Power Platform Dataverse. Instructions, knowledge, topics, actions, channels — native in Loom.',
    learnContent: {
      "overview": "A Copilot Studio agent is a conversational agent stored in Power Platform Dataverse — instructions, knowledge, topics, actions, channels. In Loom it is wired live to Power Platform (BAP) and Dataverse via the BFF; tenant-gate errors surface as a MessageBar.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the Power Platform environment; that drives the Dataverse base URL."
        },
        {
          "title": "Create or open an agent",
          "body": "List, create, or open an agent and set its instructions."
        },
        {
          "title": "Add knowledge and topics",
          "body": "Attach knowledge sources for factual answers and topics for deterministic flows."
        },
        {
          "title": "Publish",
          "body": "Publish the agent so changes go live across its channels."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio"
    } },
  { slug: 'copilot-studio-knowledge',    displayName: 'Copilot knowledge source',    restType: 'CopilotKnowledgeSource',    category: 'Copilot Studio',
    description: 'Grounding source for an agent — URL, file, SharePoint site, or Dataverse table.',
    learnContent: {
      "overview": "A Copilot knowledge source grounds an agent — URL, file, SharePoint site, or Dataverse table. In Loom you pick an agent, then list and add sources via the Dataverse-backed BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent whose grounding you want to manage."
        },
        {
          "title": "Add a source",
          "body": "Add a URL, file, SharePoint site, or Dataverse table as a knowledge source."
        },
        {
          "title": "Verify grounding",
          "body": "Ask the agent factual questions to confirm it uses the source."
        },
        {
          "title": "Manage sources",
          "body": "Add or remove sources as the agent's scope changes."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/nlu-generative-answers"
    } },
  { slug: 'copilot-studio-topic',        displayName: 'Copilot topic',               restType: 'CopilotTopic',              category: 'Copilot Studio',
    description: 'Trigger-phrase-driven dialog flow authored in Copilot Studio YAML.',
    learnContent: {
      "overview": "A Copilot topic is a trigger-phrase-driven dialog flow authored in Copilot Studio YAML. In Loom you pick an agent, list topics, and edit trigger phrases plus the flow YAML via the BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent that owns the topics."
        },
        {
          "title": "Add trigger phrases",
          "body": "Define the phrases that route a user into this topic."
        },
        {
          "title": "Author the flow",
          "body": "Edit the dialog flow YAML for the deterministic conversation path."
        },
        {
          "title": "Test the path",
          "body": "Try the trigger phrases to confirm the topic activates correctly."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/authoring-create-edit-topics"
    } },
  { slug: 'copilot-studio-action',       displayName: 'Copilot action',              restType: 'CopilotAction',             category: 'Copilot Studio',
    description: 'Power Automate flow, custom connector, or prebuilt action bound to a Copilot Studio agent.',
    learnContent: {
      "overview": "A Copilot action is a Power Automate flow, custom connector, or prebuilt action bound to a Copilot Studio agent. In Loom you pick an agent and manage its action list via the BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent to wire actions onto."
        },
        {
          "title": "Add an action",
          "body": "Bind a Power Automate flow, custom connector, or prebuilt action."
        },
        {
          "title": "Map inputs",
          "body": "Map the agent's collected inputs to the action's parameters."
        },
        {
          "title": "Test the write",
          "body": "Trigger the action from the agent to verify the write operation."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/authoring-actions"
    } },
  { slug: 'copilot-studio-channel',      displayName: 'Copilot channel',             restType: 'CopilotChannel',            category: 'Copilot Studio',
    description: 'Publish an agent to Teams, Web chat, Direct Line, Slack, or a custom channel.',
    learnContent: {
      "overview": "A Copilot channel publishes an agent to Teams, web chat, Direct Line, Slack, or a custom channel. In Loom you pick an agent and publish-to-channel via the BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent to publish."
        },
        {
          "title": "Choose a channel",
          "body": "Pick Teams, web chat, Direct Line, Slack, or a custom channel."
        },
        {
          "title": "Publish",
          "body": "Publish-to-channel makes the agent reachable on that surface."
        },
        {
          "title": "Share the link",
          "body": "Distribute the channel link or embed code to users."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/publication-fundamentals-publish-channels"
    } },
  { slug: 'copilot-studio-analytics',    displayName: 'Copilot analytics',           restType: 'CopilotAnalytics',          category: 'Copilot Studio',
    description: 'Sessions, resolution rate, escalation rate, and CSAT for a Copilot Studio agent (last 30 days by default).',
    learnContent: {
      "overview": "Copilot analytics shows sessions, resolution rate, escalation rate, and CSAT for a Copilot Studio agent (last 30 days by default). In Loom you pick an agent and view KPI cards sourced via the BFF.",
      "steps": [
        {
          "title": "Pick an agent",
          "body": "Select the agent whose analytics to view."
        },
        {
          "title": "Set the window",
          "body": "Default is the last 30 days; adjust as needed."
        },
        {
          "title": "Read KPI cards",
          "body": "Review sessions, resolution rate, escalation rate, and CSAT."
        },
        {
          "title": "Act on trends",
          "body": "Use weak topics or high escalation to target authoring improvements."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview"
    } },
  { slug: 'copilot-template-library',    displayName: 'Copilot template library',    restType: 'CopilotTemplateLibrary',    category: 'Copilot Studio',
    description: 'CSA-curated agent templates: data steward, contract analyzer, RFP responder, etc.',
    learnContent: {
      "overview": "The Copilot template library is a CSA-curated gallery of agent templates — data steward, contract analyzer, RFP responder, and more. In Loom templates are Cosmos-backed and Use template creates an agent in the selected environment.",
      "steps": [
        {
          "title": "Browse templates",
          "body": "Scan the CSA-curated gallery for a fitting starting point."
        },
        {
          "title": "Pick an environment",
          "body": "Choose the Power Platform environment the new agent should live in."
        },
        {
          "title": "Use template",
          "body": "Use template creates an agent from the template in that environment."
        },
        {
          "title": "Customize",
          "body": "Open the new agent and adapt its instructions, knowledge, and actions."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/microsoft-copilot-studio/template-fundamentals"
    } },

  // --- v3 — Power Platform (Environments, Dataverse, Power Apps, Power Automate, Power Pages, AI Builder) ---
  { slug: 'powerplatform-environment',   displayName: 'Power Platform environment',  restType: 'PowerPlatformEnvironment',  category: 'Power Platform',
    description: 'Power Platform environment surfaced via the BAP admin API — SKU, region, Dataverse domain, security group, DLP summary.',
    learnContent: {
      "overview": "A Power Platform environment is surfaced via the BAP admin API — SKU, region, Dataverse domain, security group, and DLP summary. In Loom it is read live via /api/powerplatform/environments. Each prod/dev/UAT gets its own environment.",
      "steps": [
        {
          "title": "List environments",
          "body": "The editor reads environments live from the BAP admin API."
        },
        {
          "title": "Inspect details",
          "body": "Review SKU, region, Dataverse domain, and security group."
        },
        {
          "title": "Check DLP",
          "body": "Read the DLP policy summary that governs connectors in the environment."
        },
        {
          "title": "Use as a scope",
          "body": "Pick an environment to scope Dataverse tables, apps, flows, and agents."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-platform/admin/environments-overview"
    } },
  { slug: 'dataverse-table',             displayName: 'Dataverse table',             restType: 'DataverseTable',            category: 'Power Platform',
    description: 'Dataverse EntityDefinition — schema, attributes, primary keys, custom vs system. Sourced from Dataverse Web API v9.2.',
    learnContent: {
      "overview": "A Dataverse table is an EntityDefinition — schema, attributes, primary keys, custom vs system — sourced from the Dataverse Web API v9.2. In Loom you pick an environment first, which drives the Dataverse base URL, then browse tables.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment; that sets the Dataverse base URL on the server."
        },
        {
          "title": "List tables",
          "body": "Browse EntityDefinitions, filtering custom vs system."
        },
        {
          "title": "Inspect attributes",
          "body": "Open a table to see its attributes and primary keys."
        },
        {
          "title": "Use downstream",
          "body": "Reference the table from apps, flows, and agents in the same environment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-intro"
    } },
  { slug: 'power-app',                   displayName: 'Power App',                   restType: 'PowerApp',                  category: 'Power Platform',
    description: 'Canvas or model-driven Power App in an environment — owner, last modified, play link. Sourced from the PowerApps admin API.',
    learnContent: {
      "overview": "A Power App is a canvas or model-driven app in an environment — owner, last modified, play link. In Loom it is sourced from the PowerApps admin API after you pick an environment.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment to list apps from."
        },
        {
          "title": "List apps",
          "body": "Browse canvas and model-driven apps with owner and last-modified."
        },
        {
          "title": "Open or play",
          "body": "Use the play link to launch the app."
        },
        {
          "title": "Track ownership",
          "body": "Use owner metadata to manage app lifecycle across the environment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-apps/powerapps-overview"
    } },
  { slug: 'power-automate-flow',         displayName: 'Power Automate flow',         restType: 'PowerAutomateFlow',         category: 'Power Platform',
    description: 'Cloud flow in Power Automate — state, trigger, run history, manual run. Sourced from the Flow admin API.',
    learnContent: {
      "overview": "A Power Automate flow is a cloud flow — state, trigger, run history, and manual run. In Loom it is sourced from the Flow admin API; you can list flows, inspect runs, and trigger a manual run.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment to list flows from."
        },
        {
          "title": "Inspect a flow",
          "body": "Review its state and trigger."
        },
        {
          "title": "Run manually",
          "body": "Trigger a manual run via /run and watch the result."
        },
        {
          "title": "Review run history",
          "body": "Read real run records from /runs to confirm success or diagnose failures."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-automate/getting-started"
    } },
  { slug: 'power-page',                  displayName: 'Power Pages site',            restType: 'PowerPagesSite',            category: 'Power Platform',
    description: 'Power Pages website (mspp_website / adx_website) — domain, status, type. Sourced from Dataverse Web API.',
    learnContent: {
      "overview": "A Power Pages site (mspp_website / adx_website) is a low-code public-facing website over Dataverse — domain, status, type. In Loom it is sourced from the Dataverse Web API.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment that hosts the site."
        },
        {
          "title": "List sites",
          "body": "Browse Power Pages sites with domain, status, and type."
        },
        {
          "title": "Inspect a site",
          "body": "Open a site to review its configuration."
        },
        {
          "title": "Manage access",
          "body": "Use Dataverse roles and web roles to govern who sees which pages."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-pages/introduction"
    } },
  { slug: 'ai-builder-model',            displayName: 'AI Builder model',            restType: 'AiBuilderModel',            category: 'Power Platform',
    description: 'AI Builder model (msdyn_aimodel) — prediction / extraction / classification / form-processing. State + status from Dataverse.',
    learnContent: {
      "overview": "An AI Builder model (msdyn_aimodel) is prediction, extraction, classification, or form-processing — with state and status from Dataverse. In Loom it is sourced from the Dataverse Web API after you pick an environment.",
      "steps": [
        {
          "title": "Pick an environment",
          "body": "Choose the environment to list models from."
        },
        {
          "title": "List models",
          "body": "Browse AI Builder models with their state and status."
        },
        {
          "title": "Inspect a model",
          "body": "Open a model to see its type (prediction, extraction, classification, form-processing)."
        },
        {
          "title": "Use in Power Platform",
          "body": "Call trained models from Power Apps and Power Automate."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/ai-builder/overview"
    } },

  // --- v3 — Azure SQL family (Microsoft.Sql/servers + databases + MI + SQL Server 2025 features) ---
  { slug: 'azure-sql-server',            displayName: 'Azure SQL server',            restType: 'AzureSqlServer',            category: 'Azure SQL Database',
    description: 'Microsoft.Sql/servers — server-level admin, firewall, AAD admin, list of databases.',
    learnContent: {
      "overview": "An Azure SQL server (Microsoft.Sql/servers) is the logical container for databases — server-level admin, firewall, AAD admin, and the database list. In Loom it is read via ARM REST through the azure-sql-client.",
      "steps": [
        {
          "title": "List servers",
          "body": "The editor lists logical servers via ARM."
        },
        {
          "title": "Manage firewall",
          "body": "Review and manage server firewall rules."
        },
        {
          "title": "Set AAD admin",
          "body": "Configure the Entra (AAD) admin for the server."
        },
        {
          "title": "Drill to databases",
          "body": "Open the database list to manage individual databases."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-sql/database/logical-servers"
    } },
  { slug: 'azure-sql-database',          displayName: 'Azure SQL database',          restType: 'AzureSqlDatabase',          category: 'Azure SQL Database',
    description: 'Per-database T-SQL editor (TDS + AAD), Fabric mirroring config, geo-replication, vector index.',
    learnContent: {
      "overview": "An Azure SQL database is a fully-managed PaaS database. In Loom you get a per-database T-SQL editor (TDS + AAD), Fabric mirroring config, geo-replication, and vector index — wired via ARM and TDS through the azure-sql-client.",
      "steps": [
        {
          "title": "Run T-SQL",
          "body": "Query the database over TDS with AAD auth from the editor."
        },
        {
          "title": "Configure Fabric mirroring",
          "body": "Toggle mirroring to OneLake; runtime is deferred by default and disclosed if not enabled."
        },
        {
          "title": "Set geo-replication",
          "body": "PUT a geo-replication configuration for resilience."
        },
        {
          "title": "Pick a low-cost tier",
          "body": "Choose the serverless General Purpose tier with auto-pause, billed in vCore-seconds."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-sql/database/sql-database-paas-overview"
    } },
  { slug: 'azure-sql-managed-instance',  displayName: 'SQL Managed Instance',        restType: 'AzureSqlManagedInstance',   category: 'Azure SQL Database',
    description: 'Microsoft.Sql/managedInstances — listing + state. Editor execution deferred to v3.x (TDS via PE).',
    learnContent: {
      "overview": "An Azure SQL Managed Instance (Microsoft.Sql/managedInstances) gives near-100% SQL Server compatibility for lift-and-shift. In Loom this surface lists instances and state; editor execution (TDS via private endpoint) is deferred to a later v3.x release.",
      "steps": [
        {
          "title": "List instances",
          "body": "The editor lists managed instances and their state via ARM."
        },
        {
          "title": "Inspect an instance",
          "body": "Review SKU, vCores, and networking."
        },
        {
          "title": "Know the deferral",
          "body": "TDS query execution over a private endpoint is deferred to v3.x; the editor says so rather than faking results."
        },
        {
          "title": "Plan migration",
          "body": "Use MI for lift-and-shift of on-prem SQL with Agent, cross-DB queries, and linked servers."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-sql/managed-instance/sql-managed-instance-paas-overview"
    } },
  { slug: 'sql-server-2025-vector-index',displayName: 'SQL Server 2025 vector index',restType: 'SqlServer2025VectorIndex',  category: 'Azure SQL Database',
    description: 'SQL Server 2025 native vector index — CREATE VECTOR INDEX, JSON_AGG, regex, similarity search.',
    learnContent: {
      "overview": "A SQL Server 2025 vector index is the native VECTOR type and index — CREATE VECTOR INDEX, JSON_AGG, regex, similarity search — for RAG without a separate vector store. In Loom it probes the SQL Server 2025 features against the target database.",
      "steps": [
        {
          "title": "Confirm support",
          "body": "The editor probes the database for SQL Server 2025 vector feature availability."
        },
        {
          "title": "Create a vector index",
          "body": "Run CREATE VECTOR INDEX over a VECTOR column."
        },
        {
          "title": "Store embeddings",
          "body": "Insert embedding vectors alongside your relational data."
        },
        {
          "title": "Similarity search",
          "body": "Query nearest neighbors for RAG grounding without a separate store."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/sql/relational-databases/vectors/vectors-sql-server"
    } },

  // --- v3 — Geoanalytics platform (Azure Maps + lakehouse geometry + spatial T-SQL/KQL + H3/S2) ---
  { slug: 'geo-map',                     displayName: 'Geo map',                     restType: 'GeoMap',                    category: 'Azure Geoanalytics',
    description: 'Azure Maps account + style + tile layer config. OSM fallback when no Maps account is deployed.',
    learnContent: {
      "overview": "A Geo map composes an Azure Maps account, style, and tile layer. In Loom it lists Azure Maps accounts via ARM when available and falls back to OSM tiles with a MessageBar when no Maps account is deployed. Map config is saved to item state.",
      "steps": [
        {
          "title": "Pick a Maps account",
          "body": "Loom lists Azure Maps accounts via ARM; if none exist it falls back to OSM tiles and says so."
        },
        {
          "title": "Choose a style",
          "body": "Select the base map style and tile layer."
        },
        {
          "title": "Save the config",
          "body": "Save persists the map configuration to item state."
        },
        {
          "title": "Layer your data",
          "body": "Compose the map over a geo-dataset for heatmaps and choropleths."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-maps/about-azure-maps"
    } },
  { slug: 'geo-dataset',                 displayName: 'Geo dataset',                 restType: 'GeoDataset',                category: 'Azure Geoanalytics',
    description: 'GeoJSON / Parquet+geometry dataset in ADLS Gen2. Geometry-column inspector + sample preview.',
    learnContent: {
      "overview": "A Geo dataset is a GeoJSON or Parquet+geometry dataset in ADLS Gen2. In Loom the geometry-column inspector runs a sample T-SQL OPENROWSET against Synapse Serverless via the existing query route so you can preview the data.",
      "steps": [
        {
          "title": "Point at an ADLS path",
          "body": "Set the ADLS Gen2 path to your GeoJSON or Parquet+geometry data."
        },
        {
          "title": "Inspect geometry",
          "body": "The inspector runs a sample OPENROWSET to Synapse Serverless to surface the geometry column."
        },
        {
          "title": "Preview rows",
          "body": "Review a sample to confirm the geometry type (point/polygon/H3 cell)."
        },
        {
          "title": "Use downstream",
          "body": "Reference the dataset from geo maps, queries, and pipelines."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/sql/query-parquet-files"
    } },
  { slug: 'geo-query',                   displayName: 'Geo query',                   restType: 'GeoQuery',                  category: 'Azure Geoanalytics',
    description: 'Spatial query against Synapse Serverless / Kusto — H3, S2, ST_DISTANCE, ST_WITHIN.',
    learnContent: {
      "overview": "A Geo query is a spatial query against Synapse Serverless or Kusto — H3, S2, ST_DISTANCE, ST_WITHIN. In Loom a KQL-or-TSQL toggle pre-populates H3 and ST examples and submits to Kusto or Synapse Serverless.",
      "steps": [
        {
          "title": "Toggle KQL or T-SQL",
          "body": "Pick the backend; the editor pre-populates H3 and ST examples for that dialect."
        },
        {
          "title": "Write the spatial query",
          "body": "Use ST_DISTANCE, ST_WITHIN, or H3/S2 functions over your geo-dataset."
        },
        {
          "title": "Submit",
          "body": "Run against Kusto or Synapse Serverless via the existing query route."
        },
        {
          "title": "Pin results",
          "body": "Pin a saved query to a geo-map layer for visualization."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/sql/query-parquet-files"
    } },
  { slug: 'geo-pipeline',                displayName: 'Geo pipeline',                restType: 'GeoPipeline',               category: 'Azure Geoanalytics',
    description: 'ADF/Synapse pipeline specialized for geo enrichment (H3 index, reverse geocode, buffer).',
    learnContent: {
      "overview": "A Geo pipeline is an ADF/Synapse pipeline specialized for geo enrichment — H3 index, reverse geocode, buffer. In Loom it is a Cosmos-backed pointer to an ADF pipeline with a geo-enrichment flag; ADF integration is deferred to v3.x.",
      "steps": [
        {
          "title": "Define the enrichment",
          "body": "Set the geo step: H3 indexing, reverse geocode, or buffer."
        },
        {
          "title": "Point at an ADF pipeline",
          "body": "Reference the ADF pipeline and set the geo-enrichment flag; the spec persists to Cosmos."
        },
        {
          "title": "Save",
          "body": "Save persists the configuration; full ADF execution is deferred to v3.x and disclosed in a MessageBar."
        },
        {
          "title": "Output a geo-dataset",
          "body": "The pipeline is intended to write an enriched, queryable geo-dataset."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities"
    } },

  // --- v3 — Graph + knowledge stores (Cosmos Gremlin, ADX graph, Cypher, GQL, vector stores) ---
  { slug: 'cosmos-gremlin-graph',        displayName: 'Cosmos Gremlin graph',        restType: 'CosmosGremlinGraph',        category: 'Azure Graph + Vector',
    description: 'Cosmos DB for Apache Gremlin — graph traversal queries over property graphs.',
    learnContent: {
      "overview": "A Cosmos Gremlin graph is Cosmos DB for Apache Gremlin — graph traversal over property graphs. In Loom queries run via /api/items/cosmos-gremlin-graph/[id]/query (the gremlin npm client with AAD or account-key auth); a 501 surfaces if the runtime isn't configured.",
      "steps": [
        {
          "title": "Connect the account",
          "body": "The query route uses the gremlin client with AAD or account-key auth against the Cosmos Gremlin account."
        },
        {
          "title": "Write a traversal",
          "body": "Author Gremlin steps (g.V().has(...).out(...)) over your property graph."
        },
        {
          "title": "Run the query",
          "body": "Submit to the real query route; results render in the force-directed graph view."
        },
        {
          "title": "Handle not-configured",
          "body": "If the runtime isn't configured the editor surfaces the 501 deferred message rather than faking data."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/cosmos-db/gremlin/introduction"
    } },
  { slug: 'cypher-graph',                displayName: 'Cypher graph',                restType: 'CypherGraph',               category: 'Azure Graph + Vector',
    description: 'openCypher dialect over Cosmos / Neptune-compatible / ADX graph plugin.',
    learnContent: {
      "overview": "A Cypher graph lets Neo4j-trained engineers use the openCypher dialect; in Loom it is translated to ADX make-graph/graph-match operators and dispatched via the KQL database query route — server-side, no Spark or Gremlin, millisecond-scale up to ~10M edges.",
      "steps": [
        {
          "title": "Load sample data",
          "body": "Run admin Load sample data (kind=graph) once to create SampleSocialGraph in the default Kusto DB."
        },
        {
          "title": "Write Cypher",
          "body": "Author Cypher patterns; (a)-[*1..3]->(b) maps to KQL graph-match (a)-[e*1..3]->(b)."
        },
        {
          "title": "Run via KQL backend",
          "body": "The translator emits make-graph + graph-match and dispatches to the KQL database query route."
        },
        {
          "title": "Use path operators",
          "body": "For shortest path use graph-shortest-paths; results render in the graph view."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-operators"
    } },
  { slug: 'gql-graph',                   displayName: 'GQL graph',                   restType: 'GqlGraph',                  category: 'Azure Graph + Vector',
    description: 'ISO GQL standard graph query language against the graph backend of record.',
    learnContent: {
      "overview": "A GQL graph uses the ISO/IEC 39075:2024 standard graph query language — vendor-neutral pattern matching. In Loom it is dispatched to the graph backend of record (ADX graph operators via the KQL query route).",
      "steps": [
        {
          "title": "Write GQL patterns",
          "body": "Author standard GQL MATCH patterns against your graph."
        },
        {
          "title": "Dispatch to backend",
          "body": "Loom routes the query to the graph backend of record (ADX graph via the KQL route)."
        },
        {
          "title": "Inspect results",
          "body": "Results render in the force-directed graph view."
        },
        {
          "title": "Know the standard",
          "body": "GQL is the ISO standard; use it when you want engine-neutral graph queries."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-operators"
    } },
  { slug: 'vector-store',                displayName: 'Vector store',                restType: 'VectorStore',               category: 'Azure Graph + Vector',
    description: 'Vector index — Cosmos vCore, AI Search, or PostgreSQL pgvector. Similarity search + RAG grounding.',
    learnContent: {
      "overview": "A Vector store is a backend-agnostic vector index — Cosmos vCore, AI Search, or PostgreSQL pgvector — for similarity search and RAG grounding. In Loom you pick a backend and define an index spec, which persists to item state; a live similarity test is deferred to v3.x.",
      "steps": [
        {
          "title": "Pick a backend",
          "body": "Choose Cosmos vCore, AI Search, or pgvector based on existing data gravity."
        },
        {
          "title": "Define the index",
          "body": "Set dimensions, distance metric, and fields in the create-index form."
        },
        {
          "title": "Save the spec",
          "body": "Save persists the index spec to item state; live similarity test is deferred to v3.x and disclosed."
        },
        {
          "title": "Ground RAG",
          "body": "Use the store for similarity search behind a prompt flow or data agent."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/cosmos-db/vector-database"
    } },

  // --- v3 — Push-button data-products library (CSA-curated templates + instances) ---
  { slug: 'data-product-template',       displayName: 'Data product template',       restType: 'DataProductTemplate',       category: 'CSA Data Products',
    description: 'CSA-curated push-button template: medallion lakehouse, IoT analytics, federated mesh, RAG agent, geospatial.',
    learnContent: {
      "overview": "A Data product template is a CSA-curated push-button bundle — medallion lakehouse, IoT analytics, federated mesh, RAG agent, geospatial. In Loom Instantiate POSTs to /api/items/data-product-template/[slug]/instantiate to spawn the underlying items.",
      "steps": [
        {
          "title": "Browse the gallery",
          "body": "Templates render as a grid of CSA-curated patterns."
        },
        {
          "title": "Open a template",
          "body": "Click to see its components and estimated cost."
        },
        {
          "title": "Instantiate",
          "body": "Instantiate POSTs to the instantiate route, spawning the bundled items in your workspace."
        },
        {
          "title": "Manage the instance",
          "body": "Track the resulting data-product instance for status and health."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/purview/concept-data-products"
    } },
  { slug: 'data-product-instance',       displayName: 'Data product instance',       restType: 'DataProductInstance',       category: 'CSA Data Products',
    description: 'Instantiated data product in a workspace — composed of underlying items (pipelines, lakehouses, indexes).',
    learnContent: {
      "overview": "A Data product instance is an instantiated data product in a workspace — composed of underlying items (pipelines, lakehouses, indexes). In Loom it shows the spawned components and a status table; health is best-effort from child items' updatedAt.",
      "steps": [
        {
          "title": "Review components",
          "body": "See the items spawned for this instance and their bindings."
        },
        {
          "title": "Check status",
          "body": "The status table summarizes each component's state."
        },
        {
          "title": "Read health",
          "body": "Health is best-effort, peeking at child items' updatedAt to flag staleness."
        },
        {
          "title": "Open a component",
          "body": "Drill into any underlying item (pipeline, lakehouse, index) to operate it."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/purview/concept-data-products"
    } },

  // --- v3 — Cross-item Copilot orchestrator (AOAI via Foundry hub) ---
  { slug: 'cross-item-copilot',          displayName: 'Cross-item Copilot',          restType: 'CrossItemCopilot',          category: 'AI & Agents',
    description: 'Natural-language orchestrator across every wired Loom service: Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, Foundry. 25+ tools.',
    learnContent: {
      "overview": "The Cross-item Copilot is a natural-language orchestrator across every wired Loom service — Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, Foundry (25+ tools). In Loom it streams from POST /api/copilot/orchestrate via SSE and calls the same BFF actions the UI calls, with a full audit log.",
      "steps": [
        {
          "title": "Start a session",
          "body": "Open a session in the left rail; the right rail lists registered tools grouped by service."
        },
        {
          "title": "Ask in natural language",
          "body": "Describe the task; the orchestrator streams its plan and steps live via SSE."
        },
        {
          "title": "Watch tool calls",
          "body": "Each step calls the same BFF action the UI uses against real services."
        },
        {
          "title": "Audit every move",
          "body": "Review the full audit log of actions the Copilot performed."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/fundamentals/copilot-fabric-overview"
    } },
];

export const WORKLOAD_CATEGORIES: readonly WorkloadCategory[] = [
  'Data Engineering',
  'Data Factory',
  'Data Warehouse',
  'Databases',
  'Real-Time Intelligence',
  'Data Science',
  'Fabric IQ',
  'Power BI',
  'APIs and functions',
  'Synapse Analytics',
  'Azure Databricks',
  'Azure Data Factory',
  'Streaming analytics',
  'Azure Data Lake Analytics',
  'Azure AI Foundry',
  'Azure SQL Database',
  'Azure Geoanalytics',
  'Azure Graph + Vector',
  'CSA Data Products',
  'Copilot Studio',
  'Power Platform',
  'AI & Agents',
];

export function itemsByCategory(category: WorkloadCategory): FabricItemType[] {
  return FABRIC_ITEM_TYPES.filter((i) => i.category === category);
}

export function findItemType(slug: string): FabricItemType | undefined {
  return FABRIC_ITEM_TYPES.find((i) => i.slug === slug);
}
