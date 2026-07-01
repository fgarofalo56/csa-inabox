import type { FabricItemType } from './types';

/**
 * Real-Time Intelligence — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const realTimeIntelligenceItems: FabricItemType[] = [
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
          "title": "Make data available as Delta",
          "body": "Configure ADX continuous export (or an external table) to land the KQL data as Delta in ADLS Gen2, so it's queryable alongside lakehouses — no Fabric or OneLake needed."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/fabric/real-time-intelligence/eventhouse"
    } },
  { slug: 'workspace-monitor', displayName: 'Workspace monitoring', restType: 'Eventhouse', category: 'Real-Time Intelligence', hiddenFromGallery: true,
    description: 'Read-only ADX database of platform usage/performance telemetry, fed by Azure Monitor diagnostic settings.',
    learnContent: {
      "overview": "Workspace monitoring is the Azure-native parity for Fabric's monitoring Eventhouse: a read-only Azure Data Explorer database on the shared Loom ADX cluster that holds the platform's own usage and performance telemetry. Diagnostic settings on every Loom resource route logs + metrics to Log Analytics; a data-export rule streams them to ADX so operators can query and dashboard them with KQL — no Microsoft Fabric required.",
      "steps": [
        {
          "title": "Provision the monitoring DB",
          "body": "Installing the Workspace Monitoring app creates the read-only ADX database (ResourceDiagnostics, ActivityEvents, PlatformMetrics, AppTelemetry) and enables diag-loom-stdz on any resource missing it."
        },
        {
          "title": "Wire the live feed",
          "body": "Set LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID to stream AzureDiagnostics / AzureActivity / AzureMetrics / AppRequests through Event Hubs into ADX continuously. Until then the seeded tables stay fully queryable."
        },
        {
          "title": "Query with KQL",
          "body": "Use the WorkspaceMonitor functions (RequestRate, DiagnosticCoverage) or open a KQL queryset to explore the telemetry."
        },
        {
          "title": "Open the dashboard",
          "body": "The bundled Workspace Monitoring Dashboard renders diagnostic coverage, request rate, failure %, and resource errors over the live ADX data."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-monitor/logs/logs-data-export"
    } },
  { slug: 'kql-database', displayName: 'KQL database', restType: 'KQLDatabase', category: 'Real-Time Intelligence',
    description: 'Kusto database (Azure Data Explorer) for high-volume, low-latency analytics with ADLS Delta export — Azure-native, no Fabric required.',
    learnContent: {
      "overview": "A KQL database is a Kusto store for high-volume, low-latency analytics over time-series, telemetry, and logs. In Loom it is Azure-native: it runs on the shared Loom Azure Data Explorer (ADX) cluster and is queried with KQL — no Microsoft Fabric or OneLake required.",
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
          "title": "Make data available as Delta",
          "body": "Configure ADX continuous export (or an external table) to land the same data as Delta in ADLS Gen2, so it's queryable alongside lakehouses — no OneLake needed."
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
  // --- wave2-a — genuinely-missing Azure-native messaging + lakehouse items ---
  // All Azure-native by default (no Fabric / OneLake / Power BI dependency per
  // no-fabric-dependency.md); each reuses an existing Azure client and a real
  // ARM/data-plane backend with an honest infra gate (no-vaporware.md).
  { slug: 'event-hubs-namespace',        displayName: 'Event Hubs namespace',        restType: 'Microsoft.EventHub/namespaces', category: 'Real-Time Intelligence',
    description: 'Azure Event Hubs namespace + event hubs — the Kafka-compatible messaging backbone behind Eventstreams. Real ARM.',
    learnContent: {
      "overview": "An Event Hubs namespace is the standalone Azure Event Hubs resource (Microsoft.EventHub/namespaces) that the Eventstream consumes — the big-data streaming + Kafka-compatible ingestion backbone. In Loom it is a navigator over the deployment-pinned namespace: it shows namespace properties (SKU, TLS, capture) and lets you create, list, and delete event hubs (entities) and consumer groups against the real ARM REST. Azure-native — no Microsoft Fabric required.",
      "steps": [
        { "title": "Bind the namespace", "body": "The editor targets the deployment namespace (LOOM_EVENTHUB_NAMESPACE). If unset it shows an honest gate naming the env var + the Contributor role the Console UAMI needs." },
        { "title": "Create an event hub", "body": "Name a hub and pick a partition count + retention; Loom PUTs Microsoft.EventHub/namespaces/{ns}/eventhubs over real ARM." },
        { "title": "Add consumer groups", "body": "Create consumer groups on a hub so independent readers each track their own offset." },
        { "title": "Wire it downstream", "body": "Point an Eventstream, Stream Analytics job, or KQL ingestion at the hub — the namespace is the source." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/event-hubs/event-hubs-about"
    } },
  { slug: 'service-bus-namespace',       displayName: 'Service Bus namespace',       restType: 'Microsoft.ServiceBus/namespaces', category: 'Real-Time Intelligence',
    description: 'Azure Service Bus namespace + queues/topics — enterprise message broker with FIFO, sessions, and pub/sub. Real ARM.',
    learnContent: {
      "overview": "A Service Bus namespace is the standalone Azure Service Bus resource (Microsoft.ServiceBus/namespaces) — an enterprise message broker for reliable queues (point-to-point) and topics/subscriptions (publish-subscribe) with ordering, sessions, dead-lettering, and duplicate detection. In Loom it is a navigator over the deployment-pinned namespace: it shows namespace properties and creates, lists, and deletes queues and topics against the real ARM REST. Azure-native — no Microsoft Fabric required.",
      "steps": [
        { "title": "Bind the namespace", "body": "The editor targets the deployment namespace (LOOM_SERVICEBUS_NAMESPACE). If unset it shows an honest gate naming the env var + the Contributor role the Console UAMI needs." },
        { "title": "Create a queue", "body": "Name a queue and set max size + lock duration; Loom PUTs Microsoft.ServiceBus/namespaces/{ns}/queues over real ARM for point-to-point messaging." },
        { "title": "Create a topic", "body": "Create a topic for publish-subscribe fan-out; subscribers each get their own copy of every message." },
        { "title": "Connect producers + consumers", "body": "Apps authenticate with Entra ID (local auth disabled by default) and send/receive against the queue or topic." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/service-bus-messaging/service-bus-messaging-overview"
    } },
  { slug: 'event-grid-topic',            displayName: 'Event Grid topic',            restType: 'Microsoft.EventGrid/topics', category: 'Real-Time Intelligence',
    description: 'Azure Event Grid custom topic + event subscriptions — reactive event routing with CloudEvents schema. Real ARM.',
    learnContent: {
      "overview": "An Event Grid topic is an Azure Event Grid custom topic (Microsoft.EventGrid/topics) — a reactive, push-based event router. Publishers POST events to the topic endpoint and event subscriptions fan them out to handlers (Functions, webhooks, Event Hubs, Service Bus) with filtering and retry. In Loom it shows the topic endpoint + access keys, lists event subscriptions, and creates/deletes custom topics against the real ARM REST using the CloudEvents v1.0 schema by default. Azure-native — no Microsoft Fabric required.",
      "steps": [
        { "title": "Bind the resource group", "body": "The editor targets the deployment Event Grid scope (LOOM_EVENTGRID_SUB / RG). If unset it shows an honest gate naming the env vars + the EventGrid Contributor role." },
        { "title": "Create a custom topic", "body": "Name a topic; Loom PUTs Microsoft.EventGrid/topics with the CloudEvents v1.0 input schema (idempotent) over real ARM." },
        { "title": "Inspect endpoint + keys", "body": "The editor surfaces the topic endpoint and access keys publishers use to POST events." },
        { "title": "Review subscriptions", "body": "List the event subscriptions that route this topic's events to handlers, with their filters and delivery destinations." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/event-grid/custom-topics"
    } },
];
