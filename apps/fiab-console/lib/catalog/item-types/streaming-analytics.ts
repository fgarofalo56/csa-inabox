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
];
