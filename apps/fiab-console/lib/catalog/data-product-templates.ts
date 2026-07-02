/**
 * Push-button data-product templates — CSA-curated patterns that
 * materialize a set of underlying items (lakehouse, pipeline, eventhouse,
 * vector store, ...) in a workspace with one click.
 *
 * Each template lists:
 *   - slug, displayName, description, category
 *   - components[]: which item types to spawn + default state per component
 *   - estimatedMonthlyCostUsd (rough order of magnitude, F8 sizing)
 *   - instructions: what the spawned product is + how to use it
 *   - nextSteps[]: ordered actions after spawn to make it live
 *   - references[]: Learn / architecture-center links for the pattern
 *
 * Add new templates by appending to this array. The Instantiate endpoint
 * walks `components[]` and calls createOwnedItem for each.
 */

export interface TemplateComponent {
  slug: string;
  label: string;
  description: string;
  defaultState?: Record<string, unknown>;
}

export interface DataProductTemplate {
  slug: string;
  displayName: string;
  description: string;
  category:
    | 'Lakehouse'
    | 'Streaming'
    | 'Mesh'
    | 'AI / RAG'
    | 'IoT'
    | 'Geospatial';
  estimatedMonthlyCostUsd: number;
  components: TemplateComponent[];
  /** Plain-language summary of the product the user gets once spawned. */
  instructions: string;
  /** Ordered follow-up actions to take the product from scaffold → live. */
  nextSteps: string[];
  references?: { label: string; href: string }[];
}

export const CURATED_TEMPLATES: readonly DataProductTemplate[] = [
  {
    slug: 'modern-data-warehouse',
    displayName: 'Modern data warehouse (Bronze → Silver → Gold)',
    description: 'Classic ADF + Synapse medallion architecture. Bronze raw ingestion, Silver conformed, Gold semantic layer. Backed by Synapse Dedicated SQL Pool for the warehouse layer.',
    category: 'Lakehouse',
    estimatedMonthlyCostUsd: 2_400,
    components: [
      { slug: 'lakehouse', label: 'Bronze lakehouse', description: 'Raw ingest, schema-on-read.' },
      { slug: 'lakehouse', label: 'Silver lakehouse', description: 'Conformed + deduped tables.' },
      { slug: 'lakehouse', label: 'Gold lakehouse', description: 'Star-schema marts.' },
      { slug: 'adf-pipeline', label: 'Bronze → Silver pipeline', description: 'Copy + cleanse pipeline.' },
      { slug: 'adf-pipeline', label: 'Silver → Gold pipeline', description: 'Aggregate + transform.' },
      { slug: 'synapse-dedicated-sql-pool', label: 'Warehouse pool', description: 'DW100c, paused overnight.' },
    ],
    instructions: 'Spawns the three medallion lakehouses (ADLS Gen2 + Delta), two ADF pipelines to move Bronze→Silver→Gold, and a Synapse dedicated SQL pool serving the Gold marts. Each item opens in its own editor wired to a real Azure backend — no Fabric capacity required.',
    nextSteps: [
      'Open the Bronze→Silver pipeline and bind a Copy activity to your source dataset.',
      'Define Silver conformed tables and Gold star-schema marts in the lakehouses.',
      'Resume the warehouse pool and build a semantic model over the Gold marts.',
    ],
    references: [{ label: 'Modern data warehouse architecture', href: 'https://learn.microsoft.com/azure/architecture/example-scenario/dataplate2e/data-platform-end-to-end' }],
  },
  {
    slug: 'lambda-architecture',
    displayName: 'Lambda architecture (batch + speed layers)',
    description: 'Event Hub for ingestion → Stream Analytics for hot path → ADLS for cold path → Synapse + ADX for serving. Reconciliation pipeline merges hot + cold daily.',
    category: 'Streaming',
    estimatedMonthlyCostUsd: 3_200,
    components: [
      { slug: 'eventstream', label: 'EventHub ingestion', description: 'Throughput unit = 2.' },
      { slug: 'kql-database', label: 'Hot path (ADX)', description: 'Real-time analytics.' },
      { slug: 'lakehouse', label: 'Cold path lakehouse', description: 'Long-term Delta storage.' },
      { slug: 'adf-pipeline', label: 'Reconciliation pipeline', description: 'Hot+cold merge job.' },
    ],
    instructions: 'A dual-path streaming product: Event Hubs ingestion feeds a hot path (ADX/KQL) for sub-second queries and a cold path (Delta lakehouse) for replay/accuracy, reconciled daily by an ADF pipeline. Azure-native end to end.',
    nextSteps: [
      'Point the EventHub stream at your producer and confirm throughput.',
      'Create hot-path tables + update policies in the ADX database.',
      'Schedule the reconciliation pipeline to merge hot + cold nightly.',
    ],
    references: [{ label: 'Lambda architecture', href: 'https://learn.microsoft.com/azure/architecture/data-guide/big-data/' }],
  },
  {
    slug: 'kappa-architecture',
    displayName: 'Kappa architecture (streaming only)',
    description: 'Single stream-processing pipeline (EventHub + Databricks Structured Streaming) writing to Delta. No batch layer — replay from EventHub Capture or Delta time travel.',
    category: 'Streaming',
    estimatedMonthlyCostUsd: 2_800,
    components: [
      { slug: 'eventstream', label: 'EventHub stream', description: 'Capture enabled.' },
      { slug: 'databricks-notebook', label: 'Streaming notebook', description: 'Structured Streaming job.' },
      { slug: 'lakehouse', label: 'Delta lakehouse', description: 'Streaming sink.' },
    ],
    instructions: 'A single-path streaming product: Event Hubs (Capture on) → Databricks Structured Streaming notebook → Delta lakehouse. No batch layer — re-process by replaying Capture or Delta time travel.',
    nextSteps: [
      'Enable Capture on the EventHub stream for replayability.',
      'Attach the streaming notebook to a cluster and start the readStream→writeStream.',
      'Verify Delta sink commits and set a checkpoint location.',
    ],
    references: [{ label: 'Kappa architecture', href: 'https://learn.microsoft.com/azure/architecture/data-guide/big-data/' }],
  },
  {
    slug: 'medallion-on-databricks',
    displayName: 'Medallion on Databricks (Auto Loader + DLT)',
    description: 'Databricks-native medallion: Auto Loader for ingest, Delta Live Tables for declarative transforms, Unity Catalog for governance.',
    category: 'Lakehouse',
    estimatedMonthlyCostUsd: 2_600,
    components: [
      { slug: 'databricks-cluster', label: 'DLT cluster', description: 'Photon, 2-8 workers auto.' },
      { slug: 'databricks-notebook', label: 'Bronze Auto Loader', description: 'cloudFiles source.' },
      { slug: 'databricks-notebook', label: 'Silver DLT', description: 'Declarative cleanse.' },
      { slug: 'databricks-notebook', label: 'Gold DLT', description: 'Aggregations.' },
      { slug: 'databricks-job', label: 'DLT pipeline job', description: 'Triggered + continuous modes.' },
    ],
    instructions: 'A Databricks-native medallion: Auto Loader ingests to Bronze, Delta Live Tables declaratively build Silver + Gold, Unity Catalog governs. The DLT job orchestrates the three notebooks in triggered or continuous mode.',
    nextSteps: [
      'Provision the DLT cluster and point Bronze Auto Loader at your cloudFiles path.',
      'Register the catalog/schema in Unity Catalog for governance.',
      'Run the DLT pipeline job and confirm Bronze→Silver→Gold tables materialize.',
    ],
    references: [{ label: 'Databricks medallion', href: 'https://learn.microsoft.com/azure/databricks/lakehouse/medallion' }],
  },
  {
    slug: 'iot-analytics',
    displayName: 'IoT analytics (IoT Hub + ADX)',
    description: 'Per-device telemetry → IoT Hub → ADX with time-series rollups. Activator on anomalies. Power BI on top.',
    category: 'IoT',
    estimatedMonthlyCostUsd: 1_900,
    components: [
      { slug: 'eventstream', label: 'IoT Hub bridge', description: 'EventHub-compatible endpoint.' },
      { slug: 'kql-database', label: 'Telemetry DB', description: 'Hot + warm cache tiers.' },
      { slug: 'kql-dashboard', label: 'Fleet dashboard', description: 'Real-time tiles.' },
      { slug: 'activator', label: 'Anomaly activator', description: 'KQL rules + email/Teams.' },
    ],
    instructions: 'End-to-end IoT telemetry: device data via the IoT Hub EventHub-compatible endpoint → ADX time-series DB → real-time fleet dashboard, with an Activator firing email/Teams alerts on KQL anomaly rules (Azure Monitor-backed, no Fabric).',
    nextSteps: [
      'Bind the IoT Hub bridge to your hub’s built-in endpoint.',
      'Create telemetry tables + rollup policies in the ADX DB.',
      'Author dashboard tiles and define anomaly rules on the Activator.',
    ],
    references: [{ label: 'Azure Data Explorer for IoT', href: 'https://learn.microsoft.com/azure/data-explorer/ingest-data-iot-hub' }],
  },
  {
    slug: 'federated-mesh',
    displayName: 'Federated data mesh (APIM + domain products)',
    description: 'Data Mesh pattern. Each domain owns a Data Product surfaced via APIM. Central catalog + access policy.',
    category: 'Mesh',
    estimatedMonthlyCostUsd: 3_500,
    components: [
      { slug: 'apim-product', label: 'Domain APIM product', description: 'Subscription + quota.' },
      { slug: 'apim-api', label: 'Domain API', description: 'OpenAPI bound to backend.' },
      { slug: 'apim-policy', label: 'JWT + rate-limit policy', description: 'Validate + throttle.' },
      { slug: 'data-product', label: 'Catalog data product', description: 'Marketplace entry.' },
    ],
    instructions: 'A data-mesh domain product: an APIM product + API surfaced behind a JWT-validate + rate-limit policy, registered as a marketplace data product so consumers can discover and subscribe. Central catalog + access policy.',
    nextSteps: [
      'Bind the domain API to your backend OpenAPI and import operations.',
      'Tune the JWT + rate-limit policy and assign the product quota.',
      'Publish the data product to the marketplace for consumer subscriptions.',
    ],
    references: [{ label: 'Data mesh on Azure', href: 'https://learn.microsoft.com/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-mesh' }],
  },
  {
    slug: 'rag-agent-platform',
    displayName: 'RAG agent platform (Foundry + AI Search + vector store)',
    description: 'Retrieval-augmented generation agent. Documents → AI Search hybrid index → Foundry agent with grounding + content safety + tracing.',
    category: 'AI / RAG',
    estimatedMonthlyCostUsd: 2_200,
    components: [
      { slug: 'lakehouse', label: 'Document corpus', description: 'Versioned source-of-truth lakehouse.' },
      { slug: 'ai-search-index', label: 'Hybrid index', description: 'BM25 + vector vectors.' },
      { slug: 'vector-store', label: 'Vector store spec', description: 'Backend = ai-search.' },
      { slug: 'ai-foundry-project', label: 'Foundry project', description: 'Scopes agent + connections.' },
      { slug: 'prompt-flow', label: 'RAG flow', description: 'LangChain-style flow.' },
      { slug: 'content-safety', label: 'Safety guardrails', description: 'Hate/violence thresholds.' },
      { slug: 'tracing', label: 'Operation tracing', description: 'App Insights spans.' },
    ],
    instructions: 'A full RAG agent stack: a versioned document corpus → AI Search hybrid (BM25 + vector) index → AI Foundry project hosting a grounded prompt-flow, fenced by Content Safety guardrails and traced into App Insights.',
    nextSteps: [
      'Load documents into the corpus lakehouse and run the indexer.',
      'Wire the prompt-flow to the hybrid index + your chat deployment.',
      'Set content-safety thresholds and confirm traces land in App Insights.',
    ],
    references: [{ label: 'RAG with AI Search', href: 'https://learn.microsoft.com/azure/search/retrieval-augmented-generation-overview' }],
  },
  {
    slug: 'geospatial-pipeline',
    displayName: 'Geospatial pipeline (geo-dataset → H3 enrich → Serverless)',
    description: 'Spatial dataset → ADF pipeline with geo enrichment (H3 cell + reverse-geocode) → Synapse Serverless OPENROWSET surface for ad-hoc geo queries.',
    category: 'Geospatial',
    estimatedMonthlyCostUsd: 1_400,
    components: [
      { slug: 'geo-dataset', label: 'Source geo dataset', description: 'GeoJSON or Parquet+WKB.' },
      { slug: 'geo-pipeline', label: 'Enrichment pipeline', description: 'H3 res-7 + buffer.' },
      { slug: 'synapse-serverless-sql-pool', label: 'Geo query surface', description: 'OPENROWSET on enriched lake.' },
      { slug: 'geo-map', label: 'Visualization map', description: 'Azure Maps or OSM fallback.' },
    ],
    instructions: 'A spatial enrichment product: a geo dataset (GeoJSON/Parquet+WKB) → enrichment pipeline (H3 res-7 cell + buffer) → Synapse Serverless OPENROWSET query surface, visualized on an Azure Maps (OSM fallback) map.',
    nextSteps: [
      'Upload your source geo dataset and confirm the WKB/GeoJSON schema.',
      'Run the enrichment pipeline to add H3 cells + buffers.',
      'Query the enriched lake via OPENROWSET and bind it to the map.',
    ],
    references: [{ label: 'Synapse serverless SQL', href: 'https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview' }],
  },
];
