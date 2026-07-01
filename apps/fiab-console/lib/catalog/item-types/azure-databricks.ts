import type { FabricItemType } from './types';

/**
 * Azure Databricks — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const azureDatabricksItems: FabricItemType[] = [
  // Azure Databricks
  { slug: 'databricks-notebook',         displayName: 'Databricks notebook',         restType: 'DatabricksNotebook',        category: 'Azure Databricks', searchOnly: true,
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
];
