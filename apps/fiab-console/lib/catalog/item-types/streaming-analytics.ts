import type { FabricItemType } from './types';

/**
 * Streaming analytics — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const streamingAnalyticsItems: FabricItemType[] = [
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
  // N7a — Streaming SQL (RisingWave): STATEFUL streaming materialized views over
  // Event Hubs (Kafka endpoint), sinking to Delta/Iceberg or the Postgres wire.
  // The tier ABOVE Stream Analytics (which stays the light default for simple
  // jobs). Azure-native/OSS — RisingWave runs in-boundary; no Fabric.
  { slug: 'streaming-sql',               displayName: 'Streaming SQL',               restType: 'StreamingSqlJob',          category: 'Streaming analytics',
    description: 'Stateful streaming materialized views authored in SQL over Azure Event Hubs, continuously maintained and sunk to Delta/Iceberg or served on the Postgres wire (RisingWave — the stateful tier above Stream Analytics).',
    learnContent: {
      "overview": "A Streaming SQL job authors continuously-maintained MATERIALIZED VIEWS in SQL over real-time Azure Event Hubs streams, backed by a single-node RisingWave (Apache-2.0) container running in-boundary. It is the STATEFUL tier above Azure Stream Analytics — use it for multi-stream windowed joins, incremental aggregations and temporal joins that ASA cannot express. Results are maintained incrementally and can be sunk to Delta/Iceberg on your own ADLS Gen2 (the lakehouse) or served straight off the Postgres wire. No Microsoft Fabric.",
      "steps": [
        {
          "title": "Add an Event Hubs source",
          "body": "Point the source picker at an Event Hub; the editor builds a CREATE SOURCE over the namespace's Kafka endpoint (<namespace>.servicebus.windows.net:9093). Auth is SASL over a Key-Vault-resolved connection string, or in-VNet trust."
        },
        {
          "title": "Author a materialized view",
          "body": "Write the SELECT (including multi-stream JOINs and windowed aggregations); Materialize runs CREATE MATERIALIZED VIEW, which RisingWave maintains incrementally as new events arrive."
        },
        {
          "title": "Watch it live",
          "body": "The MV status panel reads RisingWave's own catalog — every view's definition, backfill progress and current materialized row count — so you can see throughput as the view fills."
        },
        {
          "title": "Sink to the lake",
          "body": "Add a Delta or Iceberg sink to land the maintained results into your own ADLS Gen2 (the N1 lake), or query the view directly over the Postgres wire."
        }
      ],
      "docsUrl": "https://docs.risingwave.com/docs/current/intro/"
    } },
];
