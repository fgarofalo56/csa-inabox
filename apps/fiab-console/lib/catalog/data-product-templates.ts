/**
 * Push-button data-product templates — CSA-curated patterns that
 * materialize a set of underlying items (lakehouse, pipeline, eventhouse,
 * vector store, ...) in a workspace with one click.
 *
 * Each template lists:
 *   - slug, displayName, description, category
 *   - components[]: which item types to spawn + default state per component
 *   - estimatedMonthlyCostUsd (rough order of magnitude, F8 sizing)
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
  },
];
