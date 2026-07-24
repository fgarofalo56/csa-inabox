/**
 * Shared types extracted from lakehouse-editor-shell.tsx.
 * Keeps all interface/type declarations in one place so hooks,
 * panes, and dialogs can import them without circular deps.
 */

// ---- Permissions ----
export interface PermAssignment {
  id: string; principalId: string; principalType?: string; roleName?: string; upn?: string;
}
export interface PermRole { name: string; id: string }
export type PermsTab = 'object' | 'table' | 'column' | 'row';
export interface SqlGrant {
  principal: string; principalType: string; schema: string; table: string;
  column: string | null; permissionName: string;
}
export interface SqlTableRef { objectId: number; schema: string; name: string; type: string }
export interface SqlColRef { columnId: number; name: string; dataType: string }
export interface RlsPolicy {
  policyObjectId: number; policySchema: string; policyName: string;
  schema: string; table: string; isEnabled: boolean;
  functionSchema: string; functionName: string;
}
export interface ResolvedPrincipal { id: string; displayName: string; upn: string }

// ---- Settings ----
export interface LakehouseSettings {
  displayName?: string; description?: string; defaultSparkPool?: string;
  sparkConfig?: Record<string, string>;
  timeTravelDays?: number;
  deltaDefaults?: { autoOptimize?: boolean; tableProperties?: Record<string, string> };
  schemasEnabled?: boolean;
  liquidClustering?: { tableName: string; columns: string[] };
  icebergExpose?: { enabled: boolean; tableName: string; schemaName?: string };
  fabricToggles?: { vorder: boolean; autotune: boolean; nativeExecution: boolean };
}
export interface IcebergEndpoint {
  abfss: string; httpsTablePath: string; httpsMetadataFolder: string;
  azureMetadataFolder: string; format: 'iceberg-v2'; via: 'delta-uniform';
}

// ---- N1 Interop (Delta ↔ Iceberg dual metadata) ----
/** One table's interop row as returned by GET/PUT /api/lakehouse/interop. */
export interface InteropTableRow {
  table: string;
  namespace: string;
  delta: true;
  iceberg: boolean;
  via: 'delta-uniform' | 'xtable' | 'none';
  metadataLocation?: string;
  tableRootUri?: string;
  metadataFiles?: number;
  registeredInCatalog?: boolean;
  lastJobId?: string;
  lastJobState?: 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  lastDetail?: string;
  updatedAt: string;
  updatedBy: string;
  /** Bare Iceberg table id (last path segment) — added by the BFF. */
  icebergTableName?: string;
}

/** The gate block the shared HonestGate renderer consumes. */
export interface InteropGateBlock {
  id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[];
  state?: 'blocked' | 'cloud-unavailable'; fallbackNote?: string;
}

/** GET/PUT /api/lakehouse/interop response envelope. */
export interface InteropResponse {
  ok: boolean;
  error?: string;
  container?: string;
  account?: string | null;
  accountGate?: string;
  storeError?: string;
  catalogNote?: string;
  pool?: string;
  defaultPool?: string;
  catalog?: {
    configured: boolean;
    uri: string;
    warehouse: string;
    gate?: InteropGateBlock;
  };
  tables?: InteropTableRow[];
}

// ---- Data Agent ----
export interface DaAgentRow { id: string; displayName: string; state?: { sources?: unknown[] } }

// ---- Live Catalog ----
export interface LiveCatalogTable {
  schema: string; name: string; adlsPath: string; bulkUrl: string;
  format: 'delta' | 'parquet' | 'unknown';
  status: 'ok' | 'empty' | 'broken';
  latestVersion: number | null;
  rowCount: number | null; sizeBytes: number | null;
  lastModified: string | null;
}

// ---- Shortcuts ----
export type ShortcutTargetType = 'adls' | 'internal' | 's3' | 'gcs' | 'dataverse' | 'delta_sharing' | 'sharepoint';
export type ShortcutKind = 'files' | 'tables';
export interface ShortcutRow {
  id: string; lakehouseId: string; name: string; kind: ShortcutKind;
  parentPath: string; fullPath: string; targetType: ShortcutTargetType;
  targetUri: string; abfssUri?: string; engine?: 'synapse' | 'databricks' | 'none';
  engineObject?: string; format?: string; status: 'active' | 'pending' | 'error';
  statusDetail?: string; createdBy: string; createdAt: string;
}

// ---- Schemas ----
export interface SchemaRow {
  id: string; lakehouseId: string; name: string; description?: string;
  isDefault: boolean; status: 'active' | 'pending' | 'error'; statusDetail?: string;
  createdBy?: string; createdAt?: string;
}
