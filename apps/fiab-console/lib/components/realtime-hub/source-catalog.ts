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
  /** 'text' | 'textarea' — most connection props are short strings. */
  kind?: 'text' | 'textarea';
  help?: string;
}

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
      { key: 'eventHubName', label: 'Event Hub name', required: true, placeholder: 'telemetry' },
      { key: 'consumerGroupName', label: 'Consumer group', placeholder: '$Default' },
      { key: 'dataConnectionId', label: 'Connection id', help: 'Existing Fabric cloud connection GUID for the Event Hubs namespace.' },
    ],
  },
  {
    id: 'azure-iot-hub',
    name: 'Azure IoT Hub',
    category: 'Microsoft sources',
    sourceType: 'AzureIoTHub',
    description: 'Managed service for IoT device data and telemetry.',
    fields: [
      { key: 'consumerGroupName', label: 'Consumer group', placeholder: '$Default' },
      { key: 'dataConnectionId', label: 'Connection id', help: 'Existing Fabric cloud connection GUID for the IoT Hub.' },
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
      { key: 'entityName', label: 'Queue / topic name', required: true },
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id' },
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
      { key: 'dataConnectionId', label: 'Connection id', help: 'Connection to the storage account (System Topic).' },
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
  AmazonKinesis:                   Stream20Regular,
  AmazonMSKKafka:                  Branch20Regular,
  ApacheKafka:                     Branch20Regular,
  ConfluentCloud:                  CloudArrowUp20Regular,
  GooglePubSub:                    Cloud20Regular,
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
