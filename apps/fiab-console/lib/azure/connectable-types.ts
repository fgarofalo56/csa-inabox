/**
 * connectable-types — the pure mapping layer between Azure ARM resource types
 * and Loom `ConnectionType`s for the /connections "Add existing" import path.
 *
 * The "Add existing" wizard discovers resources the signed-in user can already
 * reach (Azure Resource Graph, queried with the USER's delegated token so their
 * RBAC + ABAC condition assignments apply) across every subscription, then
 * one-click imports any of them as a Key Vault-backed Loom Connection.
 *
 * This module is intentionally free of the Azure SDK / cloud-endpoints
 * credential chain so it can be imported by BOTH the server route AND the
 * client wizard. Host derivation that needs sovereign-cloud suffix helpers
 * lives in the route (which already imports cloud-endpoints).
 */
import type { ConnectionType } from './connections-store';

export interface ConnectableArmType {
  /** Lower-case ARM resource type for an ARG `type in~ (...)` literal. */
  armType: string;
  /** The Loom ConnectionType an imported resource of this ARM type becomes. */
  connType: ConnectionType;
  /** Human label for the ARM type (shown in the picker group / chip). */
  label: string;
}

/**
 * Every connectable Azure resource type, in the order they appear in the
 * single multi-type ARG query. SQL is matched at the database grain (the
 * thing you actually connect to); PostgreSQL covers both the Flexible Server
 * and the (retiring) Single Server. Synapse defaults to the always-on
 * serverless SQL endpoint.
 */
export const CONNECTABLE_ARM_TYPES: ConnectableArmType[] = [
  { armType: 'microsoft.sql/servers/databases',           connType: 'azure-sql',          label: 'Azure SQL Database' },
  { armType: 'microsoft.dbforpostgresql/flexibleservers', connType: 'postgres',           label: 'PostgreSQL Flexible Server' },
  { armType: 'microsoft.dbforpostgresql/servers',         connType: 'postgres',           label: 'PostgreSQL Server' },
  { armType: 'microsoft.storage/storageaccounts',         connType: 'storage-adls',       label: 'Storage / ADLS Gen2' },
  { armType: 'microsoft.documentdb/databaseaccounts',     connType: 'cosmos',             label: 'Cosmos DB' },
  { armType: 'microsoft.synapse/workspaces',              connType: 'synapse-serverless', label: 'Synapse Workspace' },
  { armType: 'microsoft.databricks/workspaces',           connType: 'databricks-sql',     label: 'Databricks Workspace' },
  { armType: 'microsoft.eventhub/namespaces',             connType: 'event-hub',          label: 'Event Hubs Namespace' },
  { armType: 'microsoft.servicebus/namespaces',           connType: 'service-bus',        label: 'Service Bus Namespace' },
  { armType: 'microsoft.keyvault/vaults',                 connType: 'key-vault',          label: 'Key Vault' },
];

/** Resolve an ARM resource type (case-insensitive) to a Loom ConnectionType. */
export function armTypeToConnType(armType: string): ConnectionType | null {
  const t = (armType || '').toLowerCase();
  return CONNECTABLE_ARM_TYPES.find((c) => c.armType === t)?.connType ?? null;
}

/** Human label per ConnectionType (shared by the page, builder, and wizard). */
export const CONN_TYPE_LABEL: Record<ConnectionType, string> = {
  'azure-sql': 'Azure SQL',
  'synapse-dedicated': 'Synapse Dedicated',
  'synapse-serverless': 'Synapse Serverless',
  'databricks-sql': 'Databricks SQL',
  'postgres': 'PostgreSQL',
  'storage-adls': 'ADLS / Storage',
  'cosmos': 'Cosmos DB',
  'generic-sql': 'SQL Server',
  'event-hub': 'Event Hubs',
  'service-bus': 'Service Bus',
  'key-vault': 'Key Vault',
};

/**
 * ConnectionType → item-type-visual slug, so tiles / list rows / pickers reuse
 * the existing visual registry (icon + brand colour) for a connection type.
 */
export const CONN_TILE_SLUG: Record<ConnectionType, string> = {
  'azure-sql': 'azure-sql-database',
  'generic-sql': 'azure-sql-database',
  'synapse-dedicated': 'synapse-dedicated-sql-pool',
  'synapse-serverless': 'synapse-serverless-sql-pool',
  'databricks-sql': 'databricks-sql-warehouse',
  'cosmos': 'cosmos-account',
  'storage-adls': 'storage-adls',
  'postgres': 'postgres',
  'event-hub': 'event-hub',
  'service-bus': 'service-bus',
  'key-vault': 'key-vault',
};

/**
 * Strip scheme / trailing slash / `:443` from an ARG-projected endpoint so the
 * persisted `host` is the bare FQDN every Loom connection consumer expects
 * (e.g. `https://acct.documents.azure.com:443/` → `acct.documents.azure.com`).
 */
export function normalizeHost(raw: string | undefined | null): string {
  return (raw || '')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/:443\/?$/, '')
    .replace(/\/+$/, '')
    .trim();
}

/** Shape returned by GET /api/azure/connectables for one discovered resource. */
export interface ConnectableResource {
  /** Full ARM resource id (non-secret provenance pinned onto the connection). */
  armResourceId: string;
  name: string;
  /** Raw ARM resource type, e.g. 'microsoft.sql/servers/databases'. */
  armType: string;
  /** Mapped Loom ConnectionType. */
  connType: ConnectionType;
  /** Bare host FQDN / account name to connect to (may be '' if not resolvable). */
  host: string;
  /** Database / container name where applicable (SQL databases). */
  database?: string;
  subscriptionId: string;
  subscriptionName?: string;
  resourceGroup: string;
  location?: string;
  /** Default auth method suggested on import (MI-first → no secret needed). */
  suggestedAuth: 'entra-mi';
}
