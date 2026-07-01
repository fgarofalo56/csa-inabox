import type { FabricItemType } from './types';

/**
 * Synapse Analytics — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const synapseAnalyticsItems: FabricItemType[] = [
  // --- Azure-native services, surfaced 1:1 in Loom (no studio jumps) ---
  // Synapse Analytics
  { slug: 'synapse-dedicated-sql-pool',  displayName: 'Synapse dedicated SQL pool',  restType: 'SynapseDedicatedSqlPool',  category: 'Synapse Analytics', searchOnly: true,
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
  { slug: 'synapse-notebook',            displayName: 'Synapse notebook',            restType: 'SynapseNotebook',          category: 'Synapse Analytics', searchOnly: true,
    description: 'Spark notebook designer — multi-cell PySpark/Scala/SQL on a Synapse Big Data pool.',
    learnContent: {
      "overview": "A Synapse notebook is the Spark authoring surface in Synapse Studio — multi-language cells (PySpark, Spark Scala, Spark SQL, SparkR, .NET Spark C#) run interactively on a Synapse Big Data pool via Livy. In Loom it reads/writes the workspace notebook artifact over the Synapse dev plane and runs cells against a live Livy session through the Console MI.",
      "steps": [
        { "title": "Attach a Spark pool", "body": "Pick a Big Data pool from the attach picker; the first run cold-starts the session (about 2-3 minutes)." },
        { "title": "Attach an environment (optional)", "body": "Pick a Spark configuration to apply library packages and Spark session settings to the pool — surfaced from the workspace's sparkconfigurations." },
        { "title": "Author cells", "body": "Add code or markdown cells between any two cells, set the notebook default language and per-cell language, reorder, duplicate, and collapse cells in the designer." },
        { "title": "Mark a parameters cell", "body": "Designate one code cell as the parameters cell so its variables can be overridden when the notebook runs from a pipeline (papermill/ADF)." },
        { "title": "Navigate with the outline", "body": "The left-panel outline tracks headings from markdown cells; click an entry to scroll to that cell." },
        { "title": "Run and inspect", "body": "Run a cell or Run all; output and error tracebacks render inline from the Livy statement result." },
        { "title": "Publish", "body": "Save publishes the notebook back to the Synapse workspace as an artifact and backs up the .ipynb to ADLS silver/loom/notebooks/." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks"
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
    aliasOf: 'data-pipeline', runtimePreset: 'synapse', searchOnly: true,
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
];
