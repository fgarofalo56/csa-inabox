/**
 * Canonical TypeScript type definitions for the CSA-in-a-Box Data Onboarding Portal.
 *
 * This is the SINGLE SOURCE OF TRUTH for the React portal.
 * All types are derived from the Python backend Pydantic models
 * (portal/shared/api/models/).
 *
 * portal/react-webapp/src/types/index.ts re-exports from this file.
 */

// ─── Enums / Union Types ──────────────────────────────────────────────────

/**
 * Supported data source types.
 * Must match Python `SourceType` enum in models/source.py.
 */
export type SourceType =
  | 'azure_sql'
  | 'synapse'
  | 'cosmos_db'
  | 'adls_gen2'
  | 'blob_storage'
  | 'databricks'
  | 'postgresql'
  | 'mysql'
  | 'oracle'
  | 'rest_api'
  | 'odata'
  | 'sftp'
  | 'sharepoint'
  | 'event_hub'
  | 'iot_hub'
  | 'kafka';

export type IngestionMode = 'full' | 'incremental' | 'cdc' | 'streaming';

export type ClassificationLevel =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'
  | 'cui'
  | 'fouo';

/**
 * Target storage format.
 * Must match Python `TargetFormat` enum in models/source.py.
 */
export type TargetFormat = 'delta' | 'parquet' | 'csv' | 'json';

/**
 * Source lifecycle status.
 * Must match Python `SourceStatus` enum in models/source.py.
 */
export type SourceStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'provisioning'
  | 'active'
  | 'paused'
  | 'decommissioned'
  | 'error';

// ─── Source Registration Types ─────────────────────────────────────────────

/**
 * Connection configuration — fields vary by source type.
 * Matches Python `ConnectionConfig` in models/source.py.
 */
export interface ConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  schema_name?: string;
  container?: string;
  path?: string;
  api_url?: string;
  authentication_method?: string;
  key_vault_secret_name?: string;
}

export interface ColumnDefinition {
  name: string;
  data_type: string;
  nullable: boolean;
  description?: string;
  is_pii?: boolean;
  classification?: string;
}

/**
 * Schema definition for a data source.
 * Matches Python `SchemaDefinition` in models/source.py.
 *
 * `auto_detect` and `table_name` are portal-only fields used during
 * registration; the backend resolves them before persisting.
 * `primary_key_csv` is a convenience field for the form; it is split
 * into `primary_key` before submission.
 */
export interface SchemaDefinition {
  auto_detect?: boolean;
  table_name?: string;
  columns?: ColumnDefinition[];
  primary_key?: string[];
  primary_key_csv?: string;
  partition_columns?: string[];
  watermark_column?: string;
}

export interface IngestionConfig {
  mode: IngestionMode;
  schedule_cron?: string;
  batch_size?: number;
  parallelism?: number;
  max_retry_count?: number;
  timeout_minutes?: number;
}

/**
 * Data quality rule definition.
 * Matches Python `QualityRule` in models/source.py.
 * Note: Python uses `str` (not a union) for rule_type and severity,
 * but the conventional values are listed here for documentation.
 */
export interface DataQualityRule {
  rule_name: string;
  rule_type: string;
  column?: string;
  parameters: Record<string, unknown>;
  severity: string;
}

export interface DataProductConfig {
  name: string;
  description: string;
  domain: string;
  sla_freshness_hours?: number;
  sla_completeness?: number;
  sla_availability?: number;
}

export interface TargetConfig {
  landing_zone: string;
  container: string;
  path_pattern: string;
  format: TargetFormat;
  partition_by?: string[];
}

export interface OwnerInfo {
  name: string;
  email: string;
  team: string;
  cost_center?: string;
}

/**
 * Source registration payload — the create request body.
 * Matches Python `SourceRegistration` in models/source.py.
 *
 * Python field `name` (not `source_name`).
 * Python field `tags` is `dict[str, str]` (not `string[]`).
 * Python field `schema_def` has alias `schema`.
 */
export interface SourceRegistration {
  name: string;
  source_type: SourceType;
  description?: string;
  domain: string;
  classification: ClassificationLevel;
  connection: ConnectionConfig;
  schema_definition?: SchemaDefinition;
  ingestion: IngestionConfig;
  quality_rules?: DataQualityRule[];
  data_product?: DataProductConfig;
  target: TargetConfig;
  owner: OwnerInfo;
  tags: Record<string, string>;
}

/**
 * Persisted source record returned by the API.
 * Matches Python `SourceRecord` in models/source.py.
 *
 * Python field `id` (not `source_id`).
 */
export interface SourceRecord extends SourceRegistration {
  id: string;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  provisioned_at?: string;
  pipeline_id?: string;
  purview_scan_id?: string;
}

// ─── Pipeline Types ────────────────────────────────────────────────────────

/**
 * Pipeline execution status.
 * Must match Python `PipelineStatus` enum in models/pipeline.py.
 */
export type PipelineStatus =
  | 'created'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting';

/**
 * Pipeline template type.
 * Must match Python `PipelineType` enum in models/pipeline.py.
 */
export type PipelineType =
  | 'batch_copy'
  | 'incremental'
  | 'cdc'
  | 'streaming'
  | 'api_ingestion'
  | 'quality_check';

/**
 * Pipeline record stored in the registry.
 * Matches Python `PipelineRecord` in models/pipeline.py.
 */
export interface PipelineRecord {
  id: string;
  name: string;
  source_id: string;
  pipeline_type: PipelineType;
  status: PipelineStatus;
  created_at: string;
  last_run_at?: string;
  schedule_cron?: string;
  adf_pipeline_id?: string;
}

/**
 * A single pipeline run / execution record.
 * Matches Python `PipelineRun` in models/pipeline.py.
 */
export interface PipelineRun {
  id: string;
  pipeline_id: string;
  status: PipelineStatus;
  started_at: string;
  ended_at?: string;
  rows_read?: number;
  rows_written?: number;
  error_message?: string;
  duration_seconds?: number;
}

// ─── Marketplace Types ─────────────────────────────────────────────────────

/**
 * A published data product in the marketplace.
 * Matches Python `DataProduct` in models/marketplace.py.
 */
export interface DataProduct {
  id: string;
  name: string;
  description: string;
  domain: string;
  owner: OwnerInfo;
  classification: ClassificationLevel;
  quality_score: number;
  freshness_hours: number;
  completeness: number;
  availability: number;
  tags: Record<string, string>;
  created_at: string;
  updated_at: string;
  schema_definition?: SchemaDefinition;
  sample_queries?: string[];
  documentation_url?: string;
}

/**
 * Point-in-time quality measurement for a data product.
 * Matches Python `QualityMetric` in models/marketplace.py.
 * All fields are required (Python model has no Optional fields).
 */
export interface QualityMetric {
  date: string;
  quality_score: number;
  completeness: number;
  freshness_hours: number;
  row_count: number;
}

// ─── Access Request Types ──────────────────────────────────────────────────

/**
 * Access level for data product requests.
 * Must match Python `AccessLevel` enum in models/marketplace.py.
 */
export type AccessLevel = 'read' | 'read_write' | 'admin';

/**
 * Lifecycle status of an access request.
 * Must match Python `AccessRequestStatus` enum in models/marketplace.py.
 */
export type AccessRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired';

/**
 * Payload to create a new access request.
 * Matches Python `AccessRequestCreate` in models/marketplace.py.
 */
export interface AccessRequestCreate {
  data_product_id: string;
  justification: string;
  access_level?: AccessLevel;
  duration_days?: number;
}

/**
 * Full access request record.
 * Matches Python `AccessRequest` in models/marketplace.py.
 */
export interface AccessRequest {
  id: string;
  requester_email: string;
  data_product_id: string;
  justification: string;
  access_level: AccessLevel;
  duration_days: number;
  status: AccessRequestStatus;
  requested_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
  review_notes?: string;
  expires_at?: string;
}

// ─── Dashboard Types ───────────────────────────────────────────────────────

/**
 * Platform-wide statistics shown on the dashboard.
 * Matches Python `PlatformStats` in models/marketplace.py.
 */
export interface PlatformStats {
  registered_sources: number;
  active_pipelines: number;
  data_products: number;
  pending_access_requests: number;
  total_data_volume_gb: number;
  last_24h_pipeline_runs: number;
  avg_quality_score: number;
}

/**
 * Health status of a data domain.
 * Must match Python `DomainStatus` enum in models/marketplace.py.
 */
export type DomainStatus = 'healthy' | 'warning' | 'critical';

/**
 * Per-domain summary for the domain overview dashboard.
 * Matches Python `DomainOverview` in models/marketplace.py.
 */
export interface DomainOverview {
  name: string;
  source_count: number;
  pipeline_count: number;
  data_product_count: number;
  avg_quality_score: number;
  status: DomainStatus;
}

/**
 * Recent activity feed item (frontend-only type, not directly from a Python model).
 */
export interface RecentActivity {
  id: string;
  type:
    | 'source_registered'
    | 'pipeline_run'
    | 'access_request'
    | 'product_published';
  title: string;
  description: string;
  timestamp: string;
}

// ─── API Response Wrappers ─────────────────────────────────────────────────

export interface ApiError {
  detail: string;
  status_code: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}
