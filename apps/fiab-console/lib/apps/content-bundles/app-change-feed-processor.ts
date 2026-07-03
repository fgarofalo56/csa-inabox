/**
 * Change Feed Processor — app-install content bundle.
 *
 * Content sourced 1:1 from docs/learn/08-solutions/change-feed-processor/README.md.
 *
 * The solution is an event-driven data-synchronization fan-out built on the
 * Azure Cosmos DB change feed:
 *
 *   Application -> Cosmos DB (analytics/orders) -> Change Feed Processor
 *     -> Azure Functions (cosmos_db_trigger, leases container)
 *        -> Event Hubs   (order-events)
 *        -> AI Search    (orders index, mergeOrUpload)
 *        -> Redis Cache  (key-by-id invalidation)
 *        -> Delta Lake   (/delta/orders, merge upsert from spark.readStream
 *                         "cosmos.oltp.changeFeed")
 *
 * This bundle reproduces every object the doc calls out, one BundleItem per
 * object with rich, runnable content:
 *
 *   1. eventstream      — Cosmos DB change feed source -> Event Hubs + AI
 *                         Search + Redis (custom endpoint) + Delta
 *                         destinations (the Functions fan-out across all
 *                         four doc targets, modelled declaratively).
 *   2. notebook (CFP)   — the Change Feed Processor + Azure Functions
 *                         fan-out logic from Steps 1-3 as runnable cells.
 *   3. notebook (Delta) — the Databricks Delta Lake sync from Step 4
 *                         (spark.readStream cosmos.oltp.changeFeed -> MERGE).
 *   4. lakehouse        — the /delta/orders Delta table with leases checkpoint
 *                         layout and seeded sample rows.
 *   5. ai-search-index  — the `orders` index whose schema mirrors the
 *                         search_actions mergeOrUpload payload in Step 3,
 *                         seeded with sample order docs.
 *   6. kql-database     — the change-feed monitoring database (CosmosDBRequests
 *                         + ChangeFeedLag) with the lag-monitor query from the
 *                         Monitoring section, seeded with sample rows.
 *   7. kql-dashboard    — a Change Feed Health dashboard (lag, latency, RU,
 *                         throughput) built on the monitoring KQL.
 *   8. activator        — alert rule firing when change-feed P99 read-feed
 *                         latency breaches the SLO (lag detection).
 *
 * Every Azure detail is grounded in the cited doc + Microsoft Learn:
 *   - Cosmos DB change feed processor / lease container:
 *     https://learn.microsoft.com/azure/cosmos-db/nosql/change-feed-processor
 *   - Azure Functions Cosmos DB trigger (createLeaseContainerIfNotExists):
 *     https://learn.microsoft.com/azure/azure-functions/functions-bindings-cosmosdb-v2-trigger
 *   - Spark Cosmos OLTP change-feed connector (cosmos.oltp.changeFeed):
 *     https://learn.microsoft.com/azure/cosmos-db/nosql/quickstart-spark
 *   - AI Search push API mergeOrUpload:
 *     https://learn.microsoft.com/azure/search/search-how-to-load-search-index
 *   - Delta Lake MERGE (whenMatchedUpdateAll / whenNotMatchedInsertAll):
 *     https://learn.microsoft.com/azure/databricks/delta/merge
 */

import type { AppBundle } from './types';

// ─── Eventstream: Cosmos change feed -> fan-out destinations ─────────────
// Models the Azure-Functions fan-out from Step 3 declaratively. The source
// is the Cosmos DB change feed on analytics/orders; destinations mirror the
// four sinks the Function writes to (Event Hubs, AI Search, Redis Cache via
// a custom endpoint, and Delta Lake). The lease container provides
// checkpointing exactly as the doc's
// `get_change_feed_processor(lease_container=...)` call does.

const EVENTSTREAM_SOURCE_COSMOS = {
  id: 'src-cosmos-changefeed',
  type: 'cosmos-db-cdc',
  config: {
    accountEndpointSecretRef: 'LOOM_COSMOS_ACCOUNT',
    database: 'analytics',
    container: 'orders',
    leaseContainer: 'leases',
    leasePrefix: 'cfp',
    startFrom: 'Now',
    mode: 'Incremental',
    createLeaseContainerIfNotExists: true,
    feedPollDelayMs: 5000,
    maxItemsPerInvocation: 100,
    description:
      'Cosmos DB change feed on analytics/orders. Checkpoints into the ' +
      '`leases` container (lease_prefix "cfp"), matching the doc Step 2 ' +
      'source_container.get_change_feed_processor(lease_container=leases, ' +
      'lease_prefix="cfp", start_from_beginning=False). Incremental mode ' +
      'surfaces the latest version of each changed item (inserts + updates; ' +
      'deletes via the _deleted soft-delete marker the doc routes on).',
  },
};

const EVENTSTREAM_DEST_EVENTHUB = {
  id: 'dst-eventhub-order-events',
  type: 'event-hub',
  config: {
    namespaceSecretRef: 'LOOM_EVENTHUB_NAMESPACE',
    eventHubName: 'order-events',
    connectionSecretRef: 'EventHubConnection',
    partitionKeyField: 'customer_id',
    inputFormat: 'json',
    description:
      'Publishes one envelope per changed order: {id, type:"OrderUpdated", ' +
      'data:<full doc>, timestamp:_ts}. Mirrors the @app.event_hub_output ' +
      'binding (event_hub_name="order-events") in Step 3. Partitioned by ' +
      'customer_id so a customer\'s events stay ordered.',
  },
};

const EVENTSTREAM_DEST_SEARCH = {
  id: 'dst-aisearch-orders',
  type: 'ai-search',
  config: {
    serviceSecretRef: 'SEARCH_ENDPOINT',
    keySecretRef: 'SEARCH_KEY',
    indexName: 'orders',
    action: 'mergeOrUpload',
    keyField: 'id',
    description:
      'Upserts the projected order shape (id, customer_id, order_date, ' +
      'total_amount, status) into the `orders` AI Search index using the ' +
      '@search.action "mergeOrUpload" action from Step 3 search_actions.',
  },
};

const EVENTSTREAM_DEST_DELTA = {
  id: 'dst-delta-orders',
  type: 'lakehouse',
  config: {
    workspace: 'change-feed-processor',
    lakehouse: 'orders_delta',
    deltaPath: 'Tables/orders',
    mergeKey: 'id',
    checkpointLocation: 'Files/checkpoints/cosmos_sync',
    triggerProcessingTime: '1 minute',
    description:
      'Cold-path sink. The bundled Delta-sync notebook runs the Spark ' +
      'cosmos.oltp.changeFeed reader and MERGEs into Tables/orders ' +
      '(whenMatchedUpdateAll / whenNotMatchedInsertAll), checkpointing to ' +
      'Files/checkpoints/cosmos_sync exactly as Step 4 does.',
  },
};

// Redis is a first-class fan-out target in the doc's architecture
// (Functions --> Cache[Redis Cache]; handle_upsert -> update_cache,
// handle_delete -> invalidate_cache). Fabric Eventstream has NO native Redis
// destination — the documented way to route events to a system *outside*
// Fabric is the **Custom endpoint** destination
// (https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-destination-custom-app).
// So Redis is modelled here as a custom-endpoint sink: the same egress the
// Functions fan-out uses to push key-by-id SET / DEL into the cache. This
// keeps the declarative fan-out 1:1 with the doc's four targets (Event Hubs,
// AI Search, Redis, Delta) instead of three.
const EVENTSTREAM_DEST_REDIS = {
  id: 'dst-redis-cache',
  type: 'custom-endpoint',
  config: {
    target: 'redis',
    connectionSecretRef: 'REDIS_CONNECTION',
    keyTemplate: 'order:{id}',
    ttlSeconds: 3600,
    upsertOp: 'SET',
    deleteOp: 'DEL',
    routeOnDeletedField: '_deleted',
    description:
      'Redis Cache fan-out target. Fabric Eventstream exposes no native ' +
      'Redis destination, so this is a Custom endpoint sink — the documented ' +
      'egress for systems outside Fabric — mirroring the Functions handlers ' +
      'update_cache() (SET order:{id} <doc> EX 3600) and invalidate_cache() ' +
      '(DEL order:{id}). Routes on the _deleted marker: upsert -> SET, ' +
      'delete -> DEL. Connection from the REDIS_CONNECTION secret.',
  },
};

const EVENTSTREAM_TX_ENVELOPE = {
  id: 'tx-build-envelope',
  type: 'projection',
  config: {
    description:
      'Builds the OrderUpdated / OrderDeleted event envelope and the ' +
      'search projection from each change-feed document. Routes on the ' +
      '_deleted soft-delete marker the doc handle_changes() switches on.',
    select: [
      { column: 'id',           expression: 'id' },
      {
        column: 'type',
        expression:
          "CASE WHEN _deleted = true THEN 'OrderDeleted' ELSE 'OrderUpdated' END",
      },
      { column: 'customer_id',  expression: 'customer_id' },
      { column: 'order_date',   expression: 'order_date' },
      { column: 'total_amount', expression: 'CAST(total_amount AS double)' },
      { column: 'status',       expression: 'status' },
      { column: 'timestamp',    expression: '_ts' },
    ],
  },
};

// ─── Notebook: Change Feed Processor + Azure Functions fan-out ───────────
// Steps 1-3 of the doc, as a runnable Python notebook. Uses python cells so
// the azure-cosmos / azure-functions / azure-search-documents code runs
// exactly as written in the doc.

const CFP_CELLS = [
  {
    id: 'cfp-md-intro',
    type: 'markdown' as const,
    source:
      '# Change Feed Processor — fan-out from Cosmos DB\n\n' +
      'Reads the **analytics/orders** change feed and fans each change out to ' +
      '**Event Hubs**, **AI Search**, **Redis**, and **Delta Lake**. ' +
      'Routes on the `_deleted` soft-delete marker (upsert vs delete).\n\n' +
      'Source: `docs/learn/08-solutions/change-feed-processor` Steps 1-3.\n\n' +
      '**Required app settings:** `CosmosDBConnection`, `EventHubConnection`, ' +
      '`SEARCH_ENDPOINT`, `SEARCH_KEY`, `REDIS_CONNECTION`.',
  },
  {
    id: 'cfp-code-imports',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      'import os, json, asyncio\n' +
      'from azure.cosmos.aio import CosmosClient\n' +
      'from azure.identity.aio import DefaultAzureCredential\n' +
      'from azure.search.documents import SearchClient\n' +
      'from azure.core.credentials import AzureKeyCredential\n' +
      'import redis.asyncio as redis\n\n' +
      'COSMOS_ENDPOINT = os.environ["COSMOS_ENDPOINT"]\n' +
      'SEARCH_ENDPOINT = os.environ["SEARCH_ENDPOINT"]\n' +
      'SEARCH_KEY      = os.environ["SEARCH_KEY"]\n' +
      'REDIS_CONN      = os.environ["REDIS_CONNECTION"]\n\n' +
      'search_client = SearchClient(\n' +
      '    endpoint=SEARCH_ENDPOINT,\n' +
      '    index_name="orders",\n' +
      '    credential=AzureKeyCredential(SEARCH_KEY),\n' +
      ')\n' +
      'cache = redis.from_url(REDIS_CONN)',
  },
  {
    id: 'cfp-md-step2',
    type: 'markdown' as const,
    source:
      '## Step 2 — fan-out handlers\n\n' +
      'Each handler is idempotent so re-delivery (the change-feed at-least-once ' +
      'guarantee) is safe. AI Search uses `mergeOrUpload`; Redis writes are ' +
      'keyed by document id; Event Hub gets a typed envelope.',
  },
  {
    id: 'cfp-code-handlers',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      'async def update_search_index(doc: dict):\n' +
      '    # mergeOrUpload keeps the index converged on re-delivery.\n' +
      '    search_client.merge_or_upload_documents([{\n' +
      '        "id": doc["id"],\n' +
      '        "customer_id": doc.get("customer_id"),\n' +
      '        "order_date":  doc.get("order_date"),\n' +
      '        "total_amount": doc.get("total_amount"),\n' +
      '        "status":      doc.get("status"),\n' +
      '    }])\n\n' +
      'async def update_cache(doc: dict):\n' +
      '    await cache.set(f"order:{doc[\'id\']}", json.dumps(doc), ex=3600)\n\n' +
      'async def remove_from_search(doc_id: str):\n' +
      '    search_client.delete_documents([{"id": doc_id}])\n\n' +
      'async def invalidate_cache(doc_id: str):\n' +
      '    await cache.delete(f"order:{doc_id}")\n\n' +
      'async def publish_event(event_type: str, doc: dict):\n' +
      '    # In Functions this is the event_hub_output binding; standalone we\n' +
      '    # would use azure.eventhub.aio.EventHubProducerClient.\n' +
      '    envelope = {"id": doc["id"], "type": event_type,\n' +
      '                "data": doc, "timestamp": doc.get("_ts")}\n' +
      '    print("EMIT", json.dumps(envelope))\n\n' +
      'async def handle_upsert(doc: dict):\n' +
      '    await update_search_index(doc)\n' +
      '    await update_cache(doc)\n' +
      '    await publish_event("document.updated", doc)\n\n' +
      'async def handle_delete(doc: dict):\n' +
      '    await remove_from_search(doc["id"])\n' +
      '    await invalidate_cache(doc["id"])\n' +
      '    await publish_event("document.deleted", doc)\n\n' +
      'async def handle_changes(changes):\n' +
      '    for change in changes:\n' +
      '        if change.get("_deleted"):\n' +
      '            await handle_delete(change)\n' +
      '        else:\n' +
      '            await handle_upsert(change)',
  },
  {
    id: 'cfp-md-step2b',
    type: 'markdown' as const,
    source:
      '## Step 2 — start the processor\n\n' +
      'The `leases` container provides checkpointing and partition-balancing ' +
      'across processor instances. `start_from_beginning=False` resumes from ' +
      '"now" so a cold start does not replay history.',
  },
  {
    id: 'cfp-code-start',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      'async def start_change_feed_processor():\n' +
      '    async with DefaultAzureCredential() as cred:\n' +
      '        client = CosmosClient(COSMOS_ENDPOINT, credential=cred)\n' +
      '        database         = client.get_database_client("analytics")\n' +
      '        source_container = database.get_container_client("orders")\n' +
      '        lease_container  = database.get_container_client("leases")\n\n' +
      '        processor = source_container.get_change_feed_processor(\n' +
      '            lease_container=lease_container,\n' +
      '            lease_prefix="cfp",\n' +
      '            feed_handler=handle_changes,\n' +
      '            start_from_beginning=False,\n' +
      '        )\n' +
      '        await processor.start()\n' +
      '        while True:\n' +
      '            await asyncio.sleep(60)\n\n' +
      '# asyncio.run(start_change_feed_processor())',
  },
  {
    id: 'cfp-md-step3',
    type: 'markdown' as const,
    source:
      '## Step 3 — Azure Functions hosting\n\n' +
      'In production the loop above is replaced by the Functions Cosmos DB ' +
      'trigger, which manages the lease container for you ' +
      '(`create_lease_container_if_not_exists=True`) and binds the Event Hub ' +
      'output. Deploy this `function_app.py` to the Function App from the ' +
      'doc ARM template.',
  },
  {
    id: 'cfp-code-functions',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      '# function_app.py\n' +
      'import azure.functions as func\n' +
      'import json, os\n' +
      'from azure.search.documents import SearchClient\n' +
      'from azure.core.credentials import AzureKeyCredential\n\n' +
      'app = func.FunctionApp()\n\n' +
      '@app.cosmos_db_trigger(\n' +
      '    arg_name="documents",\n' +
      '    database_name="analytics",\n' +
      '    container_name="orders",\n' +
      '    connection="CosmosDBConnection",\n' +
      '    lease_container_name="leases",\n' +
      '    create_lease_container_if_not_exists=True,\n' +
      ')\n' +
      '@app.event_hub_output(\n' +
      '    arg_name="eventHubOutput",\n' +
      '    event_hub_name="order-events",\n' +
      '    connection="EventHubConnection",\n' +
      ')\n' +
      'def process_order_changes(documents: func.DocumentList,\n' +
      '                          eventHubOutput: func.Out[list[str]]):\n' +
      '    events, search_actions = [], []\n' +
      '    for doc in documents:\n' +
      '        events.append(json.dumps({\n' +
      '            "id": doc["id"], "type": "OrderUpdated",\n' +
      '            "data": doc.to_dict(), "timestamp": doc.get("_ts"),\n' +
      '        }))\n' +
      '        search_actions.append({\n' +
      '            "@search.action": "mergeOrUpload",\n' +
      '            "id": doc["id"],\n' +
      '            "customer_id": doc.get("customer_id"),\n' +
      '            "order_date": doc.get("order_date"),\n' +
      '            "total_amount": doc.get("total_amount"),\n' +
      '            "status": doc.get("status"),\n' +
      '        })\n' +
      '    eventHubOutput.set(events)\n' +
      '    SearchClient(\n' +
      '        endpoint=os.environ["SEARCH_ENDPOINT"],\n' +
      '        index_name="orders",\n' +
      '        credential=AzureKeyCredential(os.environ["SEARCH_KEY"]),\n' +
      '    ).upload_documents(search_actions)',
  },
];

// ─── Notebook: Delta Lake sync (Step 4) ──────────────────────────────────

const DELTA_CELLS = [
  {
    id: 'delta-md-intro',
    type: 'markdown' as const,
    source:
      '# Delta Lake sync — Cosmos change feed -> Delta MERGE\n\n' +
      'Cold-path mirror of the orders container into Delta Lake using the ' +
      '**Spark Cosmos OLTP change-feed** connector. Each micro-batch is ' +
      'MERGEd into `Tables/orders` (`whenMatchedUpdateAll` / ' +
      '`whenNotMatchedInsertAll`), checkpointing to ' +
      '`Files/checkpoints/cosmos_sync`.\n\n' +
      'Source: `docs/learn/08-solutions/change-feed-processor` Step 4.\n\n' +
      '**Requires** the `azure-cosmos-spark` connector on the cluster ' +
      '(Maven `com.azure.cosmos.spark:azure-cosmos-spark_3-5_2-12`).',
  },
  {
    id: 'delta-code-config',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'from pyspark.sql.functions import *\n' +
      'from delta.tables import DeltaTable\n\n' +
      '# Secrets resolved from the workspace secret scope, never hard-coded.\n' +
      'cosmos_endpoint = dbutils.secrets.get("cfp", "cosmos-endpoint")\n' +
      'cosmos_key      = dbutils.secrets.get("cfp", "cosmos-key")\n\n' +
      'DELTA_PATH       = "Tables/orders"\n' +
      'CHECKPOINT       = "Files/checkpoints/cosmos_sync"',
  },
  {
    id: 'delta-md-read',
    type: 'markdown' as const,
    source:
      '## Read the change feed as a stream\n\n' +
      '`spark.cosmos.changeFeed.startFrom = Beginning` does a one-time ' +
      'backfill on first run, then resumes incrementally from the checkpoint.',
  },
  {
    id: 'delta-code-read',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'changes = (spark.readStream\n' +
      '    .format("cosmos.oltp.changeFeed")\n' +
      '    .option("spark.cosmos.accountEndpoint", cosmos_endpoint)\n' +
      '    .option("spark.cosmos.accountKey", cosmos_key)\n' +
      '    .option("spark.cosmos.database", "analytics")\n' +
      '    .option("spark.cosmos.container", "orders")\n' +
      '    .option("spark.cosmos.changeFeed.startFrom", "Beginning")\n' +
      '    .option("spark.cosmos.changeFeed.mode", "Incremental")\n' +
      '    .load())',
  },
  {
    id: 'delta-md-merge',
    type: 'markdown' as const,
    source:
      '## Bootstrap the target + MERGE each micro-batch\n\n' +
      'On the very first batch we create the Delta table if it does not yet ' +
      'exist (so `DeltaTable.forName` never throws on a cold target), then ' +
      'upsert keyed on `id`.',
  },
  {
    id: 'delta-code-merge',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'def upsert_to_delta(batch_df, batch_id):\n' +
      '    if batch_df.rdd.isEmpty():\n' +
      '        return\n' +
      '    if not DeltaTable.isDeltaTable(spark, DELTA_PATH):\n' +
      '        (batch_df.write.format("delta").mode("overwrite").save(DELTA_PATH))\n' +
      '        return\n' +
      '    target = DeltaTable.forPath(spark, DELTA_PATH)\n' +
      '    (target.alias("t")\n' +
      '        .merge(batch_df.alias("s"), "t.id = s.id")\n' +
      '        .whenMatchedUpdateAll()\n' +
      '        .whenNotMatchedInsertAll()\n' +
      '        .execute())\n\n' +
      'query = (changes.writeStream\n' +
      '    .foreachBatch(upsert_to_delta)\n' +
      '    .option("checkpointLocation", CHECKPOINT)\n' +
      '    .trigger(processingTime="1 minute")\n' +
      '    .start())\n\n' +
      'query.awaitTermination()',
  },
  {
    id: 'delta-md-verify',
    type: 'markdown' as const,
    source: '## Verify the synced table',
  },
  {
    id: 'delta-code-verify',
    type: 'code' as const,
    lang: 'sparksql' as const,
    source:
      'SELECT status, count(*) AS orders, round(sum(total_amount),2) AS revenue\n' +
      'FROM orders\n' +
      'GROUP BY status\n' +
      'ORDER BY revenue DESC',
  },
];

// ─── KQL monitoring: change-feed lag ─────────────────────────────────────
// The Monitoring section's lag query, plus supporting per-operation latency
// breakdowns. CosmosDBRequests mirrors the Cosmos DB diagnostic-log schema
// (Azure Monitor) the doc queries.

const KQL_Q_LAG = `// Monitor change feed read-feed latency (the Monitoring section query).
// ReadFeed = the operation the change-feed processor issues. Rising P99 is
// the leading indicator of change-feed lag.
CosmosDBRequests
| where OperationType == "ReadFeed"
| summarize
    AvgLatencyMs  = avg(DurationMs),
    P99LatencyMs  = percentile(DurationMs, 99),
    RequestCount  = count()
    by bin(TimeGenerated, 5m)
| order by TimeGenerated desc`;

const KQL_Q_RU = `// Request-unit (RU/s) burn by operation over the last hour. A change-feed
// fan-out that is over-provisioned (or starved) shows up here first.
CosmosDBRequests
| where TimeGenerated > ago(1h)
| summarize
    TotalRU   = sum(RequestCharge),
    Requests  = count(),
    Throttled = countif(StatusCode == 429)
    by OperationType, bin(TimeGenerated, 5m)
| order by TimeGenerated desc`;

const KQL_Q_LEASE = `// Change-feed lease estimated lag (the gap, in items, between the latest
// item in a partition and the last checkpointed lease) from the
// ChangeFeedLag table the processor emits.
ChangeFeedLag
| where TimeGenerated > ago(2h)
| summarize EstimatedLag = max(EstimatedLagItems) by LeaseToken, bin(TimeGenerated, 5m)
| order by EstimatedLag desc`;

const KQL_Q_THROTTLE = `// 429 (rate-limited) read-feed requests in the last 6 hours — these force
// the SDK to back off and directly inflate change-feed lag.
CosmosDBRequests
| where TimeGenerated > ago(6h) and StatusCode == 429
| summarize Throttled = count() by OperationType, bin(TimeGenerated, 15m)
| order by TimeGenerated desc`;

// ─── KQL dashboard tiles ─────────────────────────────────────────────────

const TILE_P99 = `CosmosDBRequests
| where OperationType == "ReadFeed" and TimeGenerated > ago(1h)
| summarize value = percentile(DurationMs, 99)
| extend display_name = 'ReadFeed P99 latency (ms, 1h)'`;

const TILE_LAG_LINE = `ChangeFeedLag
| where TimeGenerated > ago(4h)
| summarize max_lag = max(EstimatedLagItems) by bin(TimeGenerated, 5m)
| order by TimeGenerated asc
| render timechart with (title='Estimated change-feed lag (items)')`;

const TILE_LATENCY_LINE = `CosmosDBRequests
| where OperationType == "ReadFeed" and TimeGenerated > ago(4h)
| summarize avg_ms = avg(DurationMs), p99_ms = percentile(DurationMs, 99)
    by bin(TimeGenerated, 5m)
| order by TimeGenerated asc
| render timechart with (title='ReadFeed latency avg vs P99 (ms)')`;

const TILE_RU_BAR = `CosmosDBRequests
| where TimeGenerated > ago(1h)
| summarize TotalRU = sum(RequestCharge) by OperationType
| order by TotalRU desc
| render barchart with (title='RU burn by operation (1h)',
                       xcolumn=OperationType, ycolumns=TotalRU)`;

const TILE_THROTTLE_CARD = `CosmosDBRequests
| where TimeGenerated > ago(1h) and StatusCode == 429
| summarize value = count()
| extend display_name = '429 throttled requests (1h)'`;

const TILE_OP_TABLE = `CosmosDBRequests
| where TimeGenerated > ago(1h)
| summarize
    Requests  = count(),
    AvgMs     = round(avg(DurationMs), 1),
    P99Ms     = round(percentile(DurationMs, 99), 1),
    TotalRU   = round(sum(RequestCharge), 1),
    Throttled = countif(StatusCode == 429)
    by OperationType
| order by Requests desc`;

// ─── Bundle ──────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-change-feed-processor',
  intro:
    '# Change Feed Processor\n\n' +
    'Event-driven data synchronization on the **Azure Cosmos DB change feed**. ' +
    'Application writes land in Cosmos DB (`analytics/orders`); a Change Feed ' +
    'Processor (hosted in Azure Functions, checkpointed via the `leases` ' +
    'container) fans each change out to four destinations:\n\n' +
    '- **Event Hubs** (`order-events`) — typed `OrderUpdated` / `OrderDeleted` envelopes\n' +
    '- **AI Search** (`orders` index) — `mergeOrUpload` for live search\n' +
    '- **Redis Cache** — key-by-id read-through invalidation\n' +
    '- **Delta Lake** (`Tables/orders`) — Spark `cosmos.oltp.changeFeed` MERGE upsert\n\n' +
    'This workspace ships every object from the solution doc: the fan-out ' +
    'eventstream, the Change Feed Processor + Functions notebook, the ' +
    'Delta-sync notebook, the orders Delta lakehouse, the orders AI Search ' +
    'index, and a change-feed-lag monitoring KQL database + dashboard + ' +
    'Activator alert. Real backends throughout; missing infra surfaces as an ' +
    'honest remediation gate naming the exact env var / role to set.',
  sourceDocs: ['docs/learn/08-solutions/change-feed-processor'],
  items: [
    {
      itemType: 'eventstream',
      displayName: 'Order Change Fan-out',
      description:
        'Cosmos DB change feed on analytics/orders -> Event Hubs (order-events) ' +
        '+ AI Search (orders) + Redis Cache (order:{id}) + Delta Lake ' +
        '(Tables/orders). Models the Azure Functions fan-out from Step 3 ' +
        'declaratively across all four doc targets, checkpointed via the ' +
        'leases container.',
      learnDoc: 'change-feed-processor',
      content: {
        kind: 'eventstream',
        sources: [EVENTSTREAM_SOURCE_COSMOS],
        transforms: [EVENTSTREAM_TX_ENVELOPE],
        destinations: [
          EVENTSTREAM_DEST_EVENTHUB,
          EVENTSTREAM_DEST_SEARCH,
          EVENTSTREAM_DEST_REDIS,
          EVENTSTREAM_DEST_DELTA,
        ],
      },
    },
    {
      itemType: 'notebook',
      displayName: 'Change Feed Processor + Functions Fan-out',
      description:
        'Steps 1-3: enable change feed, build the Change Feed Processor with ' +
        'leases checkpointing, and the Azure Functions cosmos_db_trigger / ' +
        'event_hub_output fan-out to Event Hubs, AI Search, and Redis. ' +
        'Runnable Python.',
      learnDoc: 'change-feed-processor',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: CFP_CELLS,
      },
    },
    {
      itemType: 'notebook',
      displayName: 'Delta Lake Sync',
      description:
        'Step 4: Spark structured-streaming read of the Cosmos OLTP change ' +
        'feed (cosmos.oltp.changeFeed) MERGEd into Tables/orders ' +
        '(whenMatchedUpdateAll / whenNotMatchedInsertAll), checkpointing to ' +
        'Files/checkpoints/cosmos_sync. Runnable PySpark + SparkSQL.',
      learnDoc: 'change-feed-processor',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: DELTA_CELLS,
      },
    },
    {
      itemType: 'lakehouse',
      displayName: 'Orders Delta Lakehouse',
      description:
        'Cold-path Delta mirror of the orders container. Tables/orders holds ' +
        'the merged order state; Files/checkpoints/cosmos_sync holds the ' +
        'structured-streaming checkpoint. Seeded with sample orders so the ' +
        'verify query returns rows before the live stream catches up.',
      learnDoc: 'change-feed-processor',
      content: {
        kind: 'lakehouse',
        folders: [
          { path: 'Files/checkpoints/cosmos_sync', description: 'Spark structured-streaming checkpoint for the change-feed reader.' },
          { path: 'Files/raw/orders', description: 'Optional raw landing for change-feed JSON snapshots.' },
        ],
        deltaTables: [
          {
            name: 'orders',
            ddl:
              'CREATE TABLE orders (\n' +
              '  id           STRING,\n' +
              '  customer_id  STRING,\n' +
              '  order_date   DATE,\n' +
              '  total_amount DOUBLE,\n' +
              '  status       STRING,\n' +
              '  _ts          BIGINT\n' +
              ') USING DELTA',
            sampleRows: [
              ['ord-1001', 'cust-001', '2026-05-30', 249.99, 'shipped',    1748620800],
              ['ord-1002', 'cust-002', '2026-05-30', 1799.0, 'processing', 1748622600],
              ['ord-1003', 'cust-001', '2026-05-31',  59.5,  'delivered',  1748707200],
              ['ord-1004', 'cust-003', '2026-05-31', 412.75, 'cancelled',  1748709000],
              ['ord-1005', 'cust-004', '2026-06-01', 89.99,  'pending',    1748793600],
            ],
          },
        ],
      },
    },
    {
      itemType: 'ai-search-index',
      displayName: 'orders',
      description:
        'AI Search index mirroring the Step 3 search_actions mergeOrUpload ' +
        'payload (id, customer_id, order_date, total_amount, status). Kept ' +
        'converged on every change-feed delivery. Seeded with sample order ' +
        'documents.',
      learnDoc: 'change-feed-processor',
      content: {
        kind: 'ai-search-index',
        schema: {
          fields: [
            { name: 'id',           type: 'Edm.String',  key: true,  filterable: true, searchable: false },
            { name: 'customer_id',  type: 'Edm.String',  filterable: true, searchable: true },
            { name: 'order_date',   type: 'Edm.DateTimeOffset', filterable: true, searchable: false },
            { name: 'total_amount', type: 'Edm.Double',  filterable: true, searchable: false },
            { name: 'status',       type: 'Edm.String',  filterable: true, searchable: true },
          ],
        },
        scoringProfiles: [
          { name: 'recent-orders-boost', description: 'Boosts recently-placed orders so newest matches rank first.' },
        ],
        sampleDocs: [
          { id: 'ord-1001', customer_id: 'cust-001', order_date: '2026-05-30T00:00:00Z', total_amount: 249.99, status: 'shipped' },
          { id: 'ord-1002', customer_id: 'cust-002', order_date: '2026-05-30T00:00:00Z', total_amount: 1799.0, status: 'processing' },
          { id: 'ord-1003', customer_id: 'cust-001', order_date: '2026-05-31T00:00:00Z', total_amount: 59.5,   status: 'delivered' },
          { id: 'ord-1004', customer_id: 'cust-003', order_date: '2026-05-31T00:00:00Z', total_amount: 412.75, status: 'cancelled' },
          { id: 'ord-1005', customer_id: 'cust-004', order_date: '2026-06-01T00:00:00Z', total_amount: 89.99,  status: 'pending' },
        ],
      },
    },
    {
      itemType: 'kql-database',
      displayName: 'Change Feed Monitoring',
      description:
        'Change-feed observability database. CosmosDBRequests mirrors the ' +
        'Azure Monitor Cosmos DB diagnostic schema the Monitoring section ' +
        'queries; ChangeFeedLag holds processor-emitted per-lease lag. ' +
        'Includes the read-feed latency query and RU / throttle / lease ' +
        'breakdowns. Seeded with sample rows.',
      learnDoc: 'change-feed-processor',
      content: {
        kind: 'kql-database',
        tables: [
          {
            name: 'CosmosDBRequests',
            columns: [
              { name: 'TimeGenerated',  type: 'datetime' },
              { name: 'OperationType',  type: 'string'   },
              { name: 'DurationMs',     type: 'real'     },
              { name: 'RequestCharge',  type: 'real'     },
              { name: 'StatusCode',     type: 'int'      },
              { name: 'CollectionName', type: 'string'   },
              { name: 'DatabaseName',   type: 'string'   },
            ],
            sample: [
              ['2026-06-01T14:00:00Z', 'ReadFeed', 12.4, 2.1, 200, 'orders', 'analytics'],
              ['2026-06-01T14:00:05Z', 'ReadFeed', 41.8, 2.4, 200, 'orders', 'analytics'],
              ['2026-06-01T14:00:10Z', 'ReadFeed', 318.5, 3.0, 429, 'orders', 'analytics'],
              ['2026-06-01T14:00:15Z', 'Upsert',   6.2, 5.6, 201, 'orders', 'analytics'],
              ['2026-06-01T14:00:20Z', 'ReadFeed', 9.9, 2.0, 200, 'orders', 'analytics'],
            ],
          },
          {
            name: 'ChangeFeedLag',
            columns: [
              { name: 'TimeGenerated',    type: 'datetime' },
              { name: 'LeaseToken',       type: 'string'   },
              { name: 'EstimatedLagItems', type: 'long'    },
              { name: 'InstanceName',     type: 'string'   },
            ],
            sample: [
              ['2026-06-01T14:00:00Z', '0', 12, 'cfp-func-0'],
              ['2026-06-01T14:00:00Z', '1', 4,  'cfp-func-1'],
              ['2026-06-01T14:05:00Z', '0', 1480, 'cfp-func-0'],
              ['2026-06-01T14:05:00Z', '1', 6,  'cfp-func-1'],
            ],
          },
        ],
        ingestionPolicies: [
          {
            table: 'CosmosDBRequests',
            policy:
              '.alter-merge table CosmosDBRequests policy retention softdelete = 30d\n' +
              '.alter-merge table CosmosDBRequests policy caching   hot        =  7d',
          },
          {
            table: 'ChangeFeedLag',
            policy:
              '.alter-merge table ChangeFeedLag policy retention softdelete = 30d\n' +
              '.alter table ChangeFeedLag policy streamingingestion enable',
          },
        ],
        starterQueries: [
          { name: 'Change-feed ReadFeed latency (5m bins)', kql: KQL_Q_LAG },
          { name: 'RU burn by operation (1h)',              kql: KQL_Q_RU },
          { name: 'Estimated lease lag (items)',            kql: KQL_Q_LEASE },
          { name: '429 throttled requests (6h)',            kql: KQL_Q_THROTTLE },
        ],
      },
    },
    {
      itemType: 'kql-dashboard',
      displayName: 'Change Feed Health',
      description:
        'Six-tile change-feed observability dashboard: ReadFeed P99 latency, ' +
        'estimated lag timeline, latency avg-vs-P99, RU burn by operation, ' +
        '429 throttle count, and a per-operation roll-up table. Built on the ' +
        'Change Feed Monitoring database.',
      learnDoc: 'change-feed-processor',
      content: {
        kind: 'kql-dashboard',
        tiles: [
          { title: 'ReadFeed P99 latency (1h)',  viz: 'card',  kql: TILE_P99 },
          { title: '429 throttled (1h)',         viz: 'card',  kql: TILE_THROTTLE_CARD },
          { title: 'Estimated lag (items)',      viz: 'line',  kql: TILE_LAG_LINE },
          { title: 'ReadFeed latency avg/P99',   viz: 'line',  kql: TILE_LATENCY_LINE },
          { title: 'RU burn by operation (1h)',  viz: 'bar',   kql: TILE_RU_BAR },
          { title: 'Per-operation roll-up (1h)', viz: 'table', kql: TILE_OP_TABLE },
        ],
      },
    },
    {
      itemType: 'activator',
      displayName: 'Change Feed Lag Alert',
      description:
        'Fires when change-feed ReadFeed P99 latency breaches the SLO — the ' +
        'leading indicator of processor lag from the Monitoring section. ' +
        'Routes to the on-call channel so the fan-out never silently falls ' +
        'behind.',
      learnDoc: 'change-feed-processor',
      content: {
        kind: 'activator',
        rule: {
          name: 'ChangeFeed ReadFeed P99 latency breach',
          condition: { metric: 'ReadFeed_P99LatencyMs', op: '>', threshold: 250 },
          window: '5m',
          action: {
            kind: 'teams',
            config: {
              channel: 'cosmos-changefeed-oncall',
              title: 'Change feed lag detected',
              messageTemplate:
                'ReadFeed P99 latency is {{value}} ms over the last 5m (SLO 250 ms). ' +
                'The Cosmos change-feed fan-out (Event Hubs / AI Search / Delta) is ' +
                'likely lagging. Check the Change Feed Health dashboard and the ' +
                'ChangeFeedLag lease estimates.',
              sourceQuery: KQL_Q_LAG,
            },
          },
        },
      },
    },
  ],
};

export default bundle;
