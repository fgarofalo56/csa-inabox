import type { FabricItemType } from './types';

/**
 * Data Factory — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const dataFactoryItems: FabricItemType[] = [
  // Data Factory
  { slug: 'data-pipeline', displayName: 'Data pipeline', restType: 'DataPipeline', category: 'Data Factory',
    description: 'Orchestrate Copy, Lookup, ForEach, Notebook, Stored procedure, Web, and more.',
    createConfig: {
      runtimes: [
        { value: 'adf', label: 'Azure Data Factory', desc: 'Azure-native default — standalone ADF factory, 90+ activities, Self-hosted IR for on-prem.', default: true },
        { value: 'synapse', label: 'Synapse', desc: 'Run inside a Synapse workspace, reusing its linked services + integration runtimes.' },
        { value: 'fabric', label: 'Microsoft Fabric (opt-in)', desc: 'Opt-in only — requires a bound Fabric workspace; never the default.' },
      ],
      templates: [
        { value: 'blank', label: 'Blank pipeline', desc: 'Start from an empty canvas.', default: true },
        { value: 'geo-enrich', label: 'Geo-enrichment', desc: 'Pre-wired H3 index + reverse-geocode (Azure Maps) + buffer over a points dataset; runs on ADF.' },
      ],
    },
    learnContent: {
      "overview": "A Data pipeline is visual ETL/ELT orchestration — Copy, Lookup, ForEach, Notebook, Stored procedure, Web and more. Azure-native by default: authored on the standalone Azure Data Factory runtime (or a Synapse workspace), with Microsoft Fabric available as an opt-in runtime. Shares run history with notebooks and dataflows.",
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
  { slug: 'mapping-dataflow', displayName: 'Mapping data flow', restType: 'MappingDataFlow', category: 'Data Factory',
    description: 'Visually design a Spark-executed data flow — Source, schema/row transformations, and Sink — that runs on an integration runtime.',
    learnContent: {
      "overview": "A Mapping data flow is a visually-designed, Spark-executed data transformation. You draw a graph of Source → transformation → Sink nodes on a canvas and Azure Data Factory / Synapse compiles it to a Data Flow Script that runs on a scaled-out Spark cluster (an integration runtime with data-flow compute) — no hand-written Spark code. In CSA Loom it is Azure-native: the flow is a real Microsoft.DataFactory/factories/dataflows resource (type: MappingDataFlow) on the deployment-default Data Factory, and pipelines invoke it with an Execute data flow activity. It is DISTINCT from Dataflow Gen2 (Power Query / M) — same goal, different engine and authoring model.",
      "steps": [
        {
          "title": "Add a source",
          "body": "Drop a Source node and bind a dataset (the reusable connector object). Sources can allow schema drift and validate the projected schema."
        },
        {
          "title": "Add transformations",
          "body": "Use the ＋ on a stream to add transformations — Select, Derived column, Filter, Join, Aggregate, Pivot, Window, Conditional split, and more. Each opens a structured settings panel; column logic uses the data-flow expression (Spark column DSL)."
        },
        {
          "title": "Add a sink",
          "body": "Terminate each branch in a Sink node bound to a destination dataset, with insert/update/upsert/delete row policies and key columns."
        },
        {
          "title": "Debug + run",
          "body": "Turn on Data flow debug to preview rows at each transformation — this needs a live Spark data-flow debug cluster (an Azure IR with data-flow compute); without one the preview is an honest gate, never faked. Run the flow in production from a pipeline's Execute data flow activity."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview"
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
    description: 'Near-real-time replica of Snowflake / SQL DB / Postgres / Cosmos / MSSQL into ADLS Bronze (Delta) — Azure-native CDC, no Fabric required.',
    learnContent: {
      "overview": "A Mirrored database is a near-real-time replica of an external source (Azure SQL, Snowflake, Cosmos, Databricks, Postgres) into ADLS Bronze as Delta — Azure-native CDC (ADF / Synapse Link), no Fabric or OneLake required. Queries hit the mirror, never the source. Use it to join external data with lakehouses without re-ingesting.",
      "steps": [
        {
          "title": "Pick a source connector",
          "body": "Choose Azure SQL, Snowflake, Cosmos, or Databricks as the replication source."
        },
        {
          "title": "Connect and select tables",
          "body": "Provide a connection and pick tables; Loom's ADF CDC / Synapse Link replicator starts and maintains the replica into ADLS Bronze Delta automatically."
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
    description: 'Mount a Databricks Unity Catalog as a read-only mirror to ADLS Gen2 Delta — Azure-native, no Fabric required.',
    learnContent: {
      "overview": "A Mirrored Databricks catalog brings a Databricks Unity Catalog into Loom analytics as a read-only mirror — Azure-native, no Fabric or OneLake required. In Loom the UC Delta tables are mirrored into ADLS Bronze (ADF CDC / Synapse Link) and queried via the Synapse serverless SQL analytics endpoint, without re-ingesting or copying governed data. (Fabric mirroring into OneLake is opt-in only, never the default.)",
      "steps": [
        {
          "title": "Provide the workspace",
          "body": "Point at the Azure Databricks workspace and Unity Catalog you want to mirror."
        },
        {
          "title": "Select the catalog/schema",
          "body": "Choose which catalog and schemas to expose as a read-only mirror in ADLS Bronze Delta."
        },
        {
          "title": "Query via Synapse SQL",
          "body": "Read the mirrored Delta tables via the Synapse serverless SQL analytics endpoint or Spark — no copy required."
        },
        {
          "title": "Respect source governance",
          "body": "Mirroring is read-only; writes and permissions stay governed by Unity Catalog on the Databricks side."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/database/mirrored-database/azure-databricks-tutorial"
    } },
  { slug: 'mounted-adf', displayName: 'Mounted Data Factory', restType: 'MountedDataFactory', category: 'Data Factory',
    description: 'Reference an existing Azure Data Factory and run its pipelines from Loom — Azure-native, no Fabric required.',
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
    description: 'Visually build a dbt project (sources, models, tests, materializations), generate real project files, and run them against Databricks or Synapse.',
    learnContent: {
      "overview": "A dbt job is a visual dbt model/project builder. Draw a medallion DAG on a canvas — sources feed bronze/silver/gold models with materializations and tests — and Loom generates a real dbt Core project (dbt_project.yml, profiles.yml, models, schema.yml). Runs execute Azure-native: the Databricks target runs natively as a Databricks Job dbt_task; the Synapse dedicated SQL pool (and opt-in Fabric Warehouse) run in the loom-dbt-runner Container App (dbt-synapse + ODBC). No Microsoft Fabric dependency.",
      "steps": [
        {
          "title": "Draw the model graph",
          "body": "Add Source nodes, then Bronze/Silver/Gold model nodes. Wire ref()/source() lineage by selecting upstream models/sources; pick a materialization (view/table/incremental/ephemeral) and add column + model tests."
        },
        {
          "title": "Pick a target",
          "body": "Choose the run target adapter: Databricks (Azure-native default), Synapse dedicated SQL pool, or opt-in Fabric Warehouse. The same project runs on any of them by swapping only the profiles.yml adapter."
        },
        {
          "title": "Generate project files",
          "body": "Generate the real dbt project files from the graph and preview every file (dbt_project.yml, profiles.yml, per-layer model SQL, sources.yml, schema.yml) before running."
        },
        {
          "title": "Run + inspect",
          "body": "Run dbt. Databricks runs push the project to a workspace folder and trigger a Job dbt_task; Synapse/Fabric runs return the dbt log + per-node results. The runs list reads real Databricks run records."
        }
      ],
      "docsUrl": "https://docs.getdbt.com/docs/build/projects"
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
  { slug: 'linked-service', displayName: 'Linked service', restType: 'LinkedService', category: 'Data Factory',
    description: 'A reusable connection definition — the bind target for pipelines, datasets, and data flows. 31-connector gallery over Azure Data Factory (default) or a Synapse workspace.',
    learnContent: {
      "overview": "A Linked service is a first-class, reusable connection definition (connection string + authentication) that pipelines, datasets, Copy activities, and Mapping data flows bind to — exactly the Azure Data Factory / Synapse Studio Manage-hub 'Linked services' object. In CSA Loom it is Azure-native: every connection is a real Microsoft.DataFactory/factories/linkedservices (or Synapse workspace linkedservices) resource created via ARM / the Synapse dev plane. The editor is the 31-connector gallery in manage mode — browse by category, fill the per-connector structured form (auth selector + fields, secrets as secureString — never freeform JSON), Test connection, then create. No Microsoft Fabric capacity or workspace is required.",
      "steps": [
        { "title": "Pick a backend", "body": "Choose Azure Data Factory (the deployment-default factory) or a Synapse workspace. ADF is the Azure-native default; both share the same {name, properties} contract." },
        { "title": "Browse the connector gallery", "body": "Search or browse 31 connectors grouped by Azure / Database / File / NoSQL / Generic protocol / Services & apps, then pick one." },
        { "title": "Fill the structured form", "body": "Select an authentication method (Managed Identity, key, SAS, service principal) and complete its fields. Secrets are stored as ARM secureString — never round-tripped as plaintext." },
        { "title": "Test + create", "body": "Run Test connection (a real validate round-trip via the BFF), then Create — a real ARM / Synapse upsert. Edit and Delete existing linked services from the same surface." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-linked-services"
    } },
  { slug: 'integration-runtime', displayName: 'Integration runtime', restType: 'IntegrationRuntime', category: 'Data Factory',
    description: 'Azure, Self-Hosted, or Azure-SSIS compute that powers activity dispatch, data movement, and data-flow execution for pipelines.',
    learnContent: {
      "overview": "An Integration runtime (IR) is the compute infrastructure Azure Data Factory / Synapse pipelines use for activity dispatch, data movement, SSIS package execution, and data-flow Spark execution. In CSA Loom it is Azure-native: every IR is a real Microsoft.DataFactory/factories/integrationruntimes resource on the deployment-default factory, created and managed via ARM (no mocks). The editor is the IR manager — list IRs with live status, create Azure / Self-Hosted / Azure-SSIS IRs from structured forms, reveal Self-Hosted install (auth) keys, and start / stop / delete lifecycle-managed IRs. When no factory env (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME) is set the surface still renders and shows an honest infra-gate. No Microsoft Fabric dependency.",
      "steps": [
        { "title": "Choose a type", "body": "Azure IR (managed, region-pinned cloud compute), Self-Hosted IR (a gateway to private / on-prem data), or Azure-SSIS IR (lift-and-shift SSIS packages)." },
        { "title": "Configure + create", "body": "Fill the type's structured form (region, compute size, node count) — never freeform JSON — then create via a real ARM PUT." },
        { "title": "Register Self-Hosted nodes", "body": "Reveal the install (auth) keys and register the Microsoft Integration Runtime on each gateway machine to reach private / on-prem data." },
        { "title": "Manage lifecycle", "body": "Start, stop, and delete Self-Hosted / Azure-SSIS runtimes; the built-in AutoResolveIntegrationRuntime is always available by default." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-integration-runtime"
    } },
  // --- v3 — Azure Logic Apps (Consumption, multitenant) ---
  // Workflow Definition Language (WDL) workflows: Request/Recurrence triggers,
  // HTTP / ApiConnection / Compose / ParseJson / Query / Select / If actions,
  // deployed via PUT Microsoft.Logic/workflows and run via the manual trigger.
  { slug: 'logic-app',                   displayName: 'Logic App',                   restType: 'Microsoft.Logic/workflows',  category: 'Data Factory',
    description: 'Azure Logic Apps (Consumption) workflow: triggers + actions in the WDL designer, run via the manual trigger.',
    learnContent: {
      "overview": "A Logic App is an Azure Logic Apps (Consumption) workflow defined in the Workflow Definition Language (WDL): a trigger (Request, Recurrence) followed by actions (HTTP, ApiConnection, Compose, ParseJson, Query, Select, If/Switch, Response). In Loom it opens fully built-out from the installed definition or the live Microsoft.Logic/workflows resource, and Run trigger fires a real manual run.",
      "steps": [
        {
          "title": "Read the designer",
          "body": "The Designer tab shows the trigger followed by every action in execution order, including branch sub-actions and runAfter dependencies."
        },
        {
          "title": "Inspect parameters",
          "body": "The Parameters tab lists the WDL parameters (type, default, description) and the deploy-time parameter values."
        },
        {
          "title": "Review the WDL",
          "body": "The Code view tab shows the full Workflow Definition Language JSON in a Monaco editor."
        },
        {
          "title": "Run the trigger",
          "body": "Run trigger fires the manual trigger on the bound workflow and polls run history, or surfaces an honest gate naming LOOM_LOGIC_SUB / LOOM_LOGIC_RG / LOOM_LOGIC_LOCATION + the Logic App Contributor role."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/logic-apps/workflow-definition-language-schema"
    } },
];
