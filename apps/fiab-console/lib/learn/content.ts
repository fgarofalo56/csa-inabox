/**
 * Learn-popup content registry. Keys are FabricItemType ids (matches the
 * `type` URL param in /items/[type]/[id]). Only entries with real, hand-
 * authored content live here — per the no-vaporware rule we never fall
 * back to auto-generated placeholder text. Items without a learn entry
 * surface an honest "not yet authored" MessageBar in the Learn drawer.
 *
 * Contributions: add a new entry below. The Learn drawer auto-shows on
 * first visit to an item of that type; users can dismiss permanently
 * per-type via the "Don't show again" checkbox (persisted to user-prefs).
 */

export interface LearnEntry {
  title: string;
  summary?: string;
  steps?: string[];
  tip?: string;
  docsUrl?: string;
}

const REGISTRY: Record<string, LearnEntry> = {
  'synapse-serverless-sql-pool': {
    title: 'Synapse Serverless SQL Pool',
    summary: 'A pay-per-query T-SQL endpoint that reads Parquet, Delta, and CSV directly from ADLS Gen2 without provisioning compute.',
    steps: [
      'Browse to Run query and paste a SELECT. The first ~1 TB scanned each month is free in many regions; charges apply after that.',
      'Reference files using OPENROWSET(BULK \'https://<storage>.dfs.core.windows.net/container/folder/*.parquet\', FORMAT=\'PARQUET\').',
      'For Delta tables, use OPENROWSET with FORMAT=\'DELTA\' — Synapse Serverless reads the Delta log directly.',
      'Save reusable views in lakehouse-shared-views to share definitions with teammates.',
    ],
    tip: 'Serverless cost is metered by bytes processed — minimise scans by filtering on partitioned columns (year/month/day) and selecting only the columns you need.',
    docsUrl: 'https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview',
  },
  'synapse-dedicated-sql-pool': {
    title: 'Synapse Dedicated SQL Pool',
    summary: 'A provisioned MPP T-SQL data warehouse (formerly SQL DW). Auto-pauses on a schedule and resumes on demand to control cost.',
    steps: [
      'Resume the pool from the editor; the first query blocks until the pool reaches Online (≈ 60–90s).',
      'The pool has a built-in auto-pause Logic App that suspends it after the idle window configured in admin.',
      'Use Run query to issue T-SQL; Recent runs shows execution history and DMV stats.',
      'For high concurrency loads, increase the SLO temporarily — billing scales with the SLO/DWU level.',
    ],
    tip: 'Pause the pool when not actively running ELT — paused pools incur storage cost only.',
    docsUrl: 'https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-overview-what-is',
  },
  'kql-database': {
    title: 'KQL database (Azure Data Explorer / Eventhouse)',
    summary: 'A real-time analytics store optimised for time-series, telemetry, and logs. Query via Kusto Query Language (KQL).',
    steps: [
      'Ingest from Eventstream, Event Hubs, or direct REST POST.',
      'Open a KQL queryset to run interactive queries; pin charts to a KQL dashboard.',
      'Wire an Activator rule on a KQL query to fire on threshold breach (e.g. failure rate > 5%).',
    ],
    docsUrl: 'https://learn.microsoft.com/azure/data-explorer/data-explorer-overview',
  },
  'eventstream': {
    title: 'Eventstream',
    summary: 'Code-free streaming pipeline. Source connectors (Event Hubs, IoT Hub, Kafka, Azure SQL CDC) → optional transforms → destinations (KQL DB, Lakehouse, Activator).',
    steps: [
      'Add a source (Event Hub or IoT Hub for telemetry; Kafka for cross-cloud).',
      'Add a destination — typically a KQL database for real-time queries plus a Lakehouse for long-term retention.',
      'Optional: drop in transforms (filter, derived columns, manage fields) before the destination.',
    ],
    docsUrl: 'https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview',
  },
  'activator': {
    title: 'Activator (Reflex)',
    summary: 'No-code event-driven automation. Watches a stream or KQL query and fires Teams/Email/Power Automate actions on conditions.',
    steps: [
      'Pick a source: a KQL queryset, semantic model measure, or Eventstream.',
      'Define the trigger: when a value crosses a threshold or a pattern occurs.',
      'Pick the action: Teams notification, email, or Power Automate flow.',
    ],
    docsUrl: 'https://learn.microsoft.com/fabric/data-activator/activator-introduction',
  },
  'lakehouse': {
    title: 'Lakehouse',
    summary: 'OneLake-backed lakehouse with bronze/silver/gold containers. Read/write via Spark, Synapse Serverless, or Fabric SQL endpoint.',
    steps: [
      'Use the Files tree to browse raw uploads; use the Tables tree for Delta-managed tables.',
      'Load files into Tables via the "Load to Tables" action — auto-infers schema and writes Delta.',
      'Query tables via the SQL analytics endpoint or via Spark notebooks.',
    ],
    tip: 'Medallion convention: land raw into bronze, conform/clean into silver, aggregate/serve from gold.',
    docsUrl: 'https://learn.microsoft.com/fabric/data-engineering/lakehouse-overview',
  },
  'semantic-model': {
    title: 'Semantic model',
    summary: 'Tabular dataset (formerly "Power BI dataset") with measures, hierarchies, and row-level security. Powers reports, dashboards, and scorecards.',
    steps: [
      'Connect to a Lakehouse, SQL endpoint, or import data directly.',
      'Author DAX measures for KPIs (e.g. Revenue, Cost, Margin %).',
      'Configure RLS roles so each consumer sees only their slice.',
    ],
    docsUrl: 'https://learn.microsoft.com/power-bi/transform-model/datasets/dataset-modes-understand',
  },
  'mirrored-database': {
    title: 'Mirrored database',
    summary: 'Near-real-time replica of an external source (Azure SQL, Snowflake, Cosmos, Databricks) into OneLake. Queries hit the mirror, never the source.',
    steps: [
      'Pick a source connector (Azure SQL, Snowflake, Cosmos, Databricks).',
      'Provide a connection + select tables; mirroring starts and Fabric maintains the replica.',
      'Query the mirror via the SQL analytics endpoint — joins across mirrors and lakehouses are first-class.',
    ],
    docsUrl: 'https://learn.microsoft.com/fabric/database/mirrored-database/overview',
  },
  'ai-foundry-hub': {
    title: 'AI Foundry hub',
    summary: 'Workspace for end-to-end AI app development. Houses prompt flows, evaluations, deployments, fine-tuned models, and shared compute.',
    steps: [
      'Connect models (Azure OpenAI, Foundry catalog, or your own endpoint).',
      'Build a prompt flow that chains retrieval + LLM + post-processing.',
      'Run evaluations on a curated test set before promoting a deployment.',
    ],
    docsUrl: 'https://learn.microsoft.com/azure/ai-studio/concepts/architecture',
  },
  'ai-search-index': {
    title: 'AI Search index',
    summary: 'Vector + keyword hybrid search index for RAG. Source documents are chunked, embedded, and stored with metadata for filtering.',
    steps: [
      'Define the index schema (content, vector, metadata fields).',
      'Run an indexer against your data source (Blob, ADLS, Cosmos, SQL).',
      'Query with hybrid search (vector + BM25 + semantic ranker) from the prompt flow.',
    ],
    docsUrl: 'https://learn.microsoft.com/azure/search/search-what-is-azure-search',
  },
  'copilot-studio-agent': {
    title: 'Copilot Studio agent',
    summary: 'Low-code conversational agent with topics, knowledge sources, actions, and channel deployment (Teams, web, Slack).',
    steps: [
      'Add knowledge sources (SharePoint, websites, files) so the agent can answer factual questions.',
      'Author topics for high-intent flows that need deterministic logic.',
      'Wire actions (Power Automate flows, custom connectors) for write operations.',
      'Publish to Teams, embed in a web page, or expose via the Direct Line API.',
    ],
    docsUrl: 'https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio',
  },
};

export function getLearn(itemType: string): LearnEntry | null {
  return REGISTRY[itemType] ?? null;
}
