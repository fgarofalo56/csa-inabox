/**
 * Real-Time Hub source catalog — mirrors the Fabric "Data sources" /
 * "Get events" experience one-for-one. Each entry maps a user-facing
 * connector to the documented Fabric Eventstream source `type` enum and
 * the connection fields that source needs.
 *
 * Source enum + categories grounded in Microsoft Learn:
 *   https://learn.microsoft.com/fabric/real-time-hub/supported-sources
 *   https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/eventstream-rest-api
 *
 * The `fields` drive the Connect-source dialog's dynamic form; their keys
 * become the eventstream source `properties` object posted to
 * /api/realtime-hub/connect-source.
 */

import type { RthSourceType } from '@/lib/azure/fabric-client';

export type SourceCategory =
  | 'Microsoft sources'
  | 'Database CDC'
  | 'External streams'
  | 'Fabric events'
  | 'Azure events'
  | 'Sample';

export interface SourceField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  /**
   * Field renderer:
   *  - 'text'     short string (default)
   *  - 'textarea' multi-line string
   *  - 'password' secret — value is written to Key Vault, only the secretRef is kept
   *  - 'select'   single-choice dropdown (uses `options`)
   *  - 'toggle'   boolean switch that reveals the fields whose `showWhen` names it
   *  - 'cert'     Key Vault certificate picker (CA or client cert for mTLS)
   *  - 'resource-select' cascading dropdown populated from a REAL subscription
   *    query (GET /api/realtime-hub/options); optionally create-if-missing via
   *    POST /api/realtime-hub/provision. See {@link ResourceSelectSource}.
   */
  kind?: 'text' | 'textarea' | 'password' | 'select' | 'toggle' | 'cert' | 'resource-select';
  help?: string;
  /** Options for `kind: 'select'`. */
  options?: Array<{ value: string; label: string }>;
  /** Default value applied when the connector form opens (e.g. '$Default'). */
  defaultValue?: string;
  /** Present when `kind === 'resource-select'` — drives the dropdown + create. */
  source?: ResourceSelectSource;
  /**
   * Conditional visibility: this field renders only when the named toggle field
   * (a `kind: 'toggle'` key) is on. Used by the MQTT mTLS panel so the CA/client
   * cert pickers only show when "Use TLS/mTLS" is enabled.
   */
  showWhen?: string;
  /** Group fields under a collapsible/visual section header in the dialog. */
  section?: string;
}

/**
 * Binds a `resource-select` field to the /api/realtime-hub/options endpoint and
 * (optionally) the /api/realtime-hub/provision create-if-missing endpoint. The
 * dialog forwards the canonical scope props it holds (subscriptionId,
 * resourceGroup, namespace, eventHubName→eventHub, iotHubName→hubName) as query
 * params, so a field only declares which it depends on.
 */
export interface ResourceSelectSource {
  /** Which list the options endpoint should return. */
  optionsKind: 'namespaces' | 'eventhubs' | 'consumerGroups' | 'authRules' | 'iotConsumerGroups' | 'connections';
  /** For optionsKind:'namespaces' — Event Hubs namespaces vs IoT hubs. */
  service?: 'eventhub' | 'iothub';
  /**
   * For optionsKind:'connections' — restrict the Loom connection picker to a
   * single connection `type` (e.g. 'service-bus', 'azure-sql', 'cosmos'). Unset
   * shows every connection the caller owns.
   */
  connectionType?: string;
  /** Prop keys that must be set before the list can load (cascading parents). */
  dependsOn?: string[];
  /** Show an inline "+ Create new…" affordance that really provisions + selects. */
  creatable?: boolean;
  /** Provision kind posted to /api/realtime-hub/provision for the create path. */
  createKind?: 'eventhub' | 'consumerGroup' | 'iotConsumerGroup' | 'namespace';
  /**
   * When true, selecting an option also captures its subscriptionId +
   * resourceGroup into props (used by the namespace / IoT-hub picker so the
   * dependent dropdowns know which scope to query).
   */
  captureScope?: boolean;
}

/**
 * Canonical scope prop keys the connect dialog tracks for source binding even
 * though some are NOT user-visible fields (captured from a namespace / IoT-hub
 * selection or pre-filled from the RTI hub Subscribe action). The dialog
 * preserves these across `pick()` and forwards them as the source `properties`.
 */
export const SCOPE_KEYS = ['subscriptionId', 'resourceGroup', 'namespace'] as const;

export interface SourceConnector {
  /** Stable id used in the dialog. */
  id: string;
  /** User-facing connector name (matches Fabric). */
  name: string;
  category: SourceCategory;
  /** Fabric Eventstream source `type` enum value. */
  sourceType: RthSourceType;
  description: string;
  preview?: boolean;
  /** Connection fields → eventstream source `properties`. Empty = no extra config (e.g. SampleData, Fabric/Azure events). */
  fields: SourceField[];
}

export const SOURCE_CONNECTORS: SourceConnector[] = [
  // ---- Microsoft sources ------------------------------------------------
  {
    id: 'azure-event-hubs',
    name: 'Azure Event Hubs',
    category: 'Microsoft sources',
    sourceType: 'AzureEventHub',
    description: 'Fully managed real-time data ingestion service.',
    fields: [
      {
        key: 'namespace', label: 'Event Hubs namespace', required: true, kind: 'resource-select',
        help: 'Namespaces discovered across your subscription(s) via Azure Resource Graph. None yet? Create one inline.',
        source: { optionsKind: 'namespaces', service: 'eventhub', captureScope: true, creatable: true, createKind: 'namespace' },
      },
      {
        key: 'eventHubName', label: 'Event hub', required: true, kind: 'resource-select',
        placeholder: 'telemetry',
        help: 'Event hubs in the selected namespace. No hubs yet? Create one inline.',
        source: { optionsKind: 'eventhubs', dependsOn: ['namespace'], creatable: true, createKind: 'eventhub' },
      },
      {
        key: 'consumerGroupName', label: 'Consumer group', kind: 'resource-select', defaultValue: '$Default',
        help: 'Consumer groups on the selected event hub. Create a dedicated one inline.',
        source: { optionsKind: 'consumerGroups', dependsOn: ['namespace', 'eventHubName'], creatable: true, createKind: 'consumerGroup' },
      },
      {
        key: 'keyName', label: 'Shared access policy (optional)', kind: 'resource-select',
        help: 'SAS policy whose key authorizes the connection. Leave blank to use Entra (UAMI Data Receiver) — the secure default.',
        source: { optionsKind: 'authRules', dependsOn: ['namespace', 'eventHubName'] },
      },
    ],
  },
  {
    id: 'azure-iot-hub',
    name: 'Azure IoT Hub',
    category: 'Microsoft sources',
    sourceType: 'AzureIoTHub',
    description: 'Managed service for IoT device data and telemetry.',
    fields: [
      {
        key: 'iotHubName', label: 'IoT Hub', required: true, kind: 'resource-select',
        help: 'IoT Hubs discovered across your subscription(s) via Azure Resource Graph.',
        source: { optionsKind: 'namespaces', service: 'iothub', captureScope: true },
      },
      {
        key: 'consumerGroupName', label: 'Consumer group', kind: 'resource-select', defaultValue: '$Default',
        help: 'Consumer groups on the hub\'s built-in Event Hubs endpoint. Create a dedicated one inline.',
        source: { optionsKind: 'iotConsumerGroups', dependsOn: ['iotHubName'], creatable: true, createKind: 'iotConsumerGroup' },
      },
    ],
  },
  {
    id: 'azure-service-bus',
    name: 'Azure Service Bus',
    category: 'Microsoft sources',
    sourceType: 'AzureServiceBus',
    description: 'Reliable enterprise messaging — queues and topics.',
    preview: true,
    fields: [
      { key: 'entityName', label: 'Queue / topic name', required: true, placeholder: 'orders-queue' },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection to the Service Bus namespace. None? Add one under Connections.',
        source: { optionsKind: 'connections', connectionType: 'service-bus' },
      },
    ],
  },
  // ---- Database CDC -----------------------------------------------------
  {
    id: 'azure-sql-cdc',
    name: 'Azure SQL Database CDC',
    category: 'Database CDC',
    sourceType: 'AzureSQLDBCDC',
    description: 'Capture and stream database changes in real time.',
    fields: [
      { key: 'tableName', label: 'Table', required: true, placeholder: 'dbo.Orders' },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection to the source database. None? Add one under Connections.',
        source: { optionsKind: 'connections', connectionType: 'azure-sql' },
      },
    ],
  },
  {
    id: 'azure-sql-mi-cdc',
    name: 'Azure SQL Managed Instance CDC',
    category: 'Database CDC',
    sourceType: 'AzureSQLMIDBCDC',
    description: 'Stream changes from SQL Managed Instances.',
    fields: [
      { key: 'tableName', label: 'Table', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection to the managed instance. None? Add one under Connections.',
        source: { optionsKind: 'connections', connectionType: 'azure-sql' },
      },
    ],
  },
  {
    id: 'cosmos-cdc',
    name: 'Azure Cosmos DB CDC',
    category: 'Database CDC',
    sourceType: 'AzureCosmosDBCDC',
    description: 'Stream the change feed from a Cosmos DB container.',
    fields: [
      { key: 'containerName', label: 'Container', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection to the Cosmos account. None? Add one under Connections.',
        source: { optionsKind: 'connections', connectionType: 'cosmos' },
      },
    ],
  },
  {
    id: 'postgres-cdc',
    name: 'Azure Database for PostgreSQL CDC',
    category: 'Database CDC',
    sourceType: 'PostgreSQLCDC',
    description: 'Stream changes from PostgreSQL databases.',
    fields: [
      { key: 'tableName', label: 'Table', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection to the PostgreSQL server. None? Add one under Connections.',
        source: { optionsKind: 'connections', connectionType: 'postgres' },
      },
    ],
  },
  {
    id: 'mysql-cdc',
    name: 'Azure Database for MySQL CDC',
    category: 'Database CDC',
    sourceType: 'MySQLCDC',
    description: 'Stream changes from MySQL databases.',
    fields: [
      { key: 'tableName', label: 'Table', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection to the MySQL server. None? Add one under Connections.',
        source: { optionsKind: 'connections' },
      },
    ],
  },
  // ---- External streams -------------------------------------------------
  {
    id: 'apache-kafka',
    name: 'Apache Kafka',
    category: 'External streams',
    sourceType: 'ApacheKafka',
    description: 'Ingest from an open-source Apache Kafka cluster.',
    preview: true,
    fields: [
      { key: 'bootstrapServers', label: 'Bootstrap servers', required: true, placeholder: 'broker:9092' },
      { key: 'topic', label: 'Topic', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection holding the broker/stream credentials. None? Add one under Connections.',
        source: { optionsKind: 'connections' },
      },
    ],
  },
  {
    id: 'confluent-kafka',
    name: 'Confluent Cloud for Apache Kafka',
    category: 'External streams',
    sourceType: 'ConfluentCloud',
    description: 'Ingest from Confluent Cloud Kafka.',
    fields: [
      { key: 'topic', label: 'Topic', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection holding the broker/stream credentials. None? Add one under Connections.',
        source: { optionsKind: 'connections' },
      },
    ],
  },
  {
    id: 'amazon-msk',
    name: 'Amazon MSK Kafka',
    category: 'External streams',
    sourceType: 'AmazonMSKKafka',
    description: 'Amazon Managed Streaming for Apache Kafka.',
    fields: [
      { key: 'bootstrapServers', label: 'Bootstrap servers', required: true },
      { key: 'topic', label: 'Topic', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection holding the broker/stream credentials. None? Add one under Connections.',
        source: { optionsKind: 'connections' },
      },
    ],
  },
  {
    id: 'amazon-kinesis',
    name: 'Amazon Kinesis Data Streams',
    category: 'External streams',
    sourceType: 'AmazonKinesis',
    description: 'Ingest from an Amazon Kinesis data stream.',
    fields: [
      { key: 'streamName', label: 'Stream name', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection holding the broker/stream credentials. None? Add one under Connections.',
        source: { optionsKind: 'connections' },
      },
    ],
  },
  {
    id: 'gcp-pubsub',
    name: 'Google Cloud Pub/Sub',
    category: 'External streams',
    sourceType: 'GooglePubSub',
    description: 'Ingest from a Google Cloud Pub/Sub subscription.',
    fields: [
      { key: 'subscriptionId', label: 'Subscription id', required: true },
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection holding the broker/stream credentials. None? Add one under Connections.',
        source: { optionsKind: 'connections' },
      },
    ],
  },
  {
    id: 'mqtt',
    name: 'MQTT',
    category: 'External streams',
    sourceType: 'Mqtt',
    description: 'Ingest from any MQTT broker (IoT). Supports TLS/SSL + mutual-TLS with Key Vault certs.',
    preview: true,
    fields: [
      {
        key: 'brokerUrl', label: 'MQTT broker URL', required: true,
        placeholder: 'ssl://broker.contoso.com:8883',
        help: 'Supported protocols: ssl://, wss://, tcp://.',
      },
      { key: 'topic', label: 'Topic name', required: true, placeholder: 'devices/+/telemetry', help: 'A single MQTT topic to subscribe to.' },
      {
        key: 'protocolVersion', label: 'Version', kind: 'select',
        options: [{ value: 'V5', label: 'V5' }, { value: 'V3', label: 'V3' }],
        help: "Select your broker's MQTT protocol version.",
      },
      { key: 'username', label: 'Username', placeholder: 'mqtt-user', help: 'Broker username (optional for anonymous brokers).' },
      { key: 'password', label: 'Password', kind: 'password', help: 'Broker password. Stored in Key Vault — never in Cosmos or the browser.' },
      // ---- TLS / mTLS panel ----
      {
        key: 'useMtls', label: 'Use TLS/mTLS settings', kind: 'toggle', section: 'TLS / mTLS settings',
        help: 'Enable for brokers with a custom CA or that require client-certificate (mutual TLS) authentication.',
      },
      {
        key: 'caCertName', label: 'Trust CA certificate', kind: 'cert', showWhen: 'useMtls', section: 'TLS / mTLS settings',
        help: 'Server CA certificate (Key Vault certificate object, PEM). The broker is verified against this CA.',
      },
      {
        key: 'clientCertName', label: 'Client certificate and key', kind: 'cert', showWhen: 'useMtls', section: 'TLS / mTLS settings',
        help: 'Client certificate + private key (Key Vault certificate object, PEM bundle) for mutual-TLS auth.',
      },
    ],
  },
  // ---- Fabric events ----------------------------------------------------
  {
    id: 'fabric-workspace-item-events',
    name: 'Fabric Workspace Item events',
    category: 'Fabric events',
    sourceType: 'FabricWorkspaceItemEvents',
    description: 'Subscribe to create/update/delete events on Fabric workspace items.',
    fields: [],
  },
  {
    id: 'fabric-job-events',
    name: 'Fabric Job events',
    category: 'Fabric events',
    sourceType: 'FabricJobEvents',
    description: 'React to job created / status-changed / succeeded / failed events.',
    fields: [],
  },
  {
    id: 'fabric-onelake-events',
    name: 'Fabric OneLake events',
    category: 'Fabric events',
    sourceType: 'FabricOneLakeEvents',
    description: 'Subscribe to file/folder created/deleted/renamed events in OneLake.',
    fields: [],
  },
  // ---- Azure events -----------------------------------------------------
  {
    id: 'azure-blob-events',
    name: 'Azure Blob Storage events',
    category: 'Azure events',
    sourceType: 'AzureBlobStorageEvents',
    description: 'React to blob created / replaced / deleted events.',
    fields: [
      {
        key: 'dataConnectionId', label: 'Connection', kind: 'resource-select',
        help: 'A Loom connection to the storage account (System Topic). None? Add one under Connections.',
        source: { optionsKind: 'connections', connectionType: 'storage-adls' },
      },
    ],
  },
  {
    id: 'azure-eventgrid-topic',
    name: 'Azure Event Grid custom topic',
    category: 'Azure events',
    sourceType: 'AzureEventGridCustomTopic',
    description: 'Subscribe to a governed business-event Event Grid custom topic.',
    fields: [
      {
        key: 'topic', label: 'Event Grid topic', required: true, placeholder: 'orders-events',
        help: 'The custom-topic name a publisher emits governed business signals to.',
      },
      {
        key: 'inputSchema', label: 'Input schema', kind: 'select', defaultValue: 'CloudEventSchemaV1_0',
        help: 'The event envelope schema the topic publishes in.',
        options: [
          { value: 'CloudEventSchemaV1_0', label: 'CloudEvents v1.0' },
          { value: 'EventGridSchema', label: 'Event Grid schema' },
          { value: 'CustomInputSchema', label: 'Custom input schema' },
        ],
      },
    ],
  },
  // ---- Fabric events (cont.) -------------------------------------------
  {
    id: 'fabric-capacity-events',
    name: 'Fabric Capacity Utilization events',
    category: 'Fabric events',
    sourceType: 'FabricCapacityUtilizationEvents',
    description: 'Stream capacity throttling / utilization events for a Fabric capacity.',
    fields: [],
  },
  // ---- External streams (cont.) ----------------------------------------
  {
    id: 'custom-endpoint',
    name: 'Custom endpoint',
    category: 'External streams',
    sourceType: 'CustomEndpoint',
    description: 'Push events to a custom app endpoint (Event Hub / Kafka / AMQP compatible).',
    fields: [],
  },
  // ---- Sample -----------------------------------------------------------
  {
    id: 'sample-data',
    name: 'Sample data',
    category: 'Sample',
    sourceType: 'SampleData',
    description: 'Built-in sample stream (Bicycles / Yellow Taxi / Stock market) — no connection required.',
    fields: [
      { key: 'sampleType', label: 'Sample', placeholder: 'YellowTaxi | Bicycles | StockMarket' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Per-connector visual — a stable {icon, color} for each Real-Time Hub source
// so the source gallery + data-stream rows render color-coded, recognisable
// chips (one-for-one with how Fabric colour-codes its connector tiles).
// Source types are not Loom "item types", so this is a dedicated local
// registry (kept beside the catalog it serves).
// ---------------------------------------------------------------------------

import type { FluentIcon } from '@fluentui/react-icons';
import {
  Pulse20Regular, Iot20Regular, Mail20Regular, Database20Regular,
  DatabasePlugConnected20Regular, CloudArrowUp20Regular, Cloud20Regular,
  Storage20Regular, Box20Regular, Branch20Regular, Stream20Regular,
  Briefcase20Regular, DocumentTable20Regular, Gauge20Regular,
  BeakerSettings20Regular, PlugConnected20Regular,
} from '@fluentui/react-icons';

export interface SourceVisual { icon: FluentIcon; color: string; }

/** Category → brand colour family (mirrors Fabric connector grouping). */
export const SOURCE_CATEGORY_COLOR: Record<SourceCategory, string> = {
  'Microsoft sources': '#0078d4', // Azure blue
  'Database CDC':      '#1a7f4e', // green
  'External streams':  '#c2410c', // orange
  'Fabric events':     '#4b1d8f', // Fabric purple
  'Azure events':      '#0050b3', // deep blue
  'Sample':            '#6b7280', // neutral grey
};

const SOURCE_ICONS: Partial<Record<RthSourceType, FluentIcon>> = {
  AzureEventHub:                   Pulse20Regular,
  AzureIoTHub:                     Iot20Regular,
  AzureServiceBus:                 Mail20Regular,
  AzureSQLDBCDC:                   Database20Regular,
  AzureSQLMIDBCDC:                 DatabasePlugConnected20Regular,
  AzureCosmosDBCDC:                Box20Regular,
  PostgreSQLCDC:                   Database20Regular,
  MySQLCDC:                        Database20Regular,
  AzureBlobStorageEvents:          Storage20Regular,
  AzureEventGridCustomTopic:       CloudArrowUp20Regular,
  AmazonKinesis:                   Stream20Regular,
  AmazonMSKKafka:                  Branch20Regular,
  ApacheKafka:                     Branch20Regular,
  ConfluentCloud:                  CloudArrowUp20Regular,
  GooglePubSub:                    Cloud20Regular,
  Mqtt:                            Iot20Regular,
  SampleData:                      BeakerSettings20Regular,
  CustomEndpoint:                  PlugConnected20Regular,
  FabricWorkspaceItemEvents:       Briefcase20Regular,
  FabricJobEvents:                 DocumentTable20Regular,
  FabricOneLakeEvents:             Storage20Regular,
  FabricCapacityUtilizationEvents: Gauge20Regular,
};

/** Resolve a colour-coded visual for a connector (icon + brand colour). */
export function sourceVisual(c: Pick<SourceConnector, 'sourceType' | 'category'>): SourceVisual {
  return {
    icon: SOURCE_ICONS[c.sourceType] ?? PlugConnected20Regular,
    color: SOURCE_CATEGORY_COLOR[c.category] ?? '#6b7280',
  };
}

export const SOURCE_CATEGORIES: SourceCategory[] = [
  'Microsoft sources',
  'Database CDC',
  'External streams',
  'Fabric events',
  'Azure events',
  'Sample',
];
