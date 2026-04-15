/**
 * Canonical TypeScript type definitions for the CSA-in-a-Box Data Onboarding Portal.
 *
 * This is the SINGLE SOURCE OF TRUTH shared between React and Svelte portals.
 * Generated from / kept in sync with source-api.schema.json.
 *
 * Both portal/react-webapp/src/types/index.ts and
 * portal/static-webapp/src/lib/types.ts re-export from this file.
 */

// ─── Enums / Union Types ──────────────────────────────────────────────────

/** Union of ALL supported data source types across both portals. */
export type SourceType =
  | 'azure_sql'
  | 'synapse'
  | 'cosmos_db'
  | 'adls_gen2'
  | 'blob_storage'
  | 'databricks'
  | 'postgresql'
  | 'postgres'
  | 'mysql'
  | 'oracle'
  | 'sql_server'
  | 'rest_api'
  | 'odata'
  | 'sftp'
  | 'sharepoint'
  | 'event_hub'
  | 'iot_hub'
  | 'kafka'
  | 'file_drop'
  | 's3'
  | 'snowflake'
  | 'dynamics365';

export type IngestionMode = 'full' | 'incremental' | 'cdc' | 'streaming';

export type ClassificationLevel =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'
  | 'cui'
  | 'fouo';

/** Superset of target formats from both implementations. */
export type TargetFormat = 'delta' | 'parquet' | 'csv' | 'json' | 'avro';

/** Superset of source statuses from both implementations. */
export type SourceStatus =
  | 'draft'
  | 'pending'
  | 'pending_approval'
  | 'approved'
  | 'provisioning'
  | 'active'
  | 'inactive'
  | 'paused'
  | 'decommissioned'
  | 'error'
  | 'archived';

// ─── Source Registration Types ─────────────────────────────────────────────

/** Merged connection config — all fields from React + Svelte implementations. */
export interface ConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  schema_name?: string;
  container?: string;
  path?: string;
  url?: string;
  api_url?: string;
  auth_type?: string;
  authentication_method?: string;
  username?: string;
  password_secret?: string;
  connection_string_secret?: string;
  key_vault_secret_name?: string;
  event_hub_namespace?: string;
  consumer_group?: string;
}

export interface ColumnDefinition {
  name: string;
  data_type: string;
  nullable: boolean;
  description?: string;
  is_pii?: boolean;
  is_primary_key?: boolean;
  classification?: string;
}

/** Supports both column-based and table-based schemas, plus API endpoints. */
export interface SchemaDefinition {
  columns?: ColumnDefinition[];
  tables?: Record<string, ColumnDefinition[]>;
  endpoints?: string[];
  auto_detect?: boolean;
  primary_key?: string[];
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
  watermark_column?: string;
}

export interface DataQualityRule {
  rule_name: string;
  rule_type:
    | 'not_null'
    | 'unique'
    | 'range'
    | 'regex'
    | 'custom_sql'
    | 'freshness'
    | 'completeness';
  column?: string;
  parameters: Record<string, unknown>;
  severity: 'warning' | 'error' | 'critical';
}

export interface DataProductConfig {
  name: string;
  description?: string;
  domain: string;
  sla_freshness_hours?: number;
  sla_freshness_minutes?: number;
  sla_completeness?: number;
  sla_availability?: number;
  valid_row_ratio?: number;
  quality_rules?: DataQualityRule[];
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
  team?: string;
  domain?: string;
  cost_center?: string;
}

/**
 * Source registration payload — uses snake_case consistently.
 * This is what gets POSTed to the API.
 */
export interface SourceRegistration {
  source_name: string;
  source_type: SourceType;
  description?: string;
  domain?: string;
  classification: ClassificationLevel;
  environment?: string;
  connection: ConnectionConfig;
  schema_definition?: SchemaDefinition;
  ingestion: IngestionConfig;
  quality_rules?: DataQualityRule[];
  data_product?: DataProductConfig;
  target: TargetConfig;
  owner: OwnerInfo;
  tags: string[];
}

/** Persisted source record returned by the API. */
export interface SourceRecord extends SourceRegistration {
  source_id: string;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  provisioned_at?: string;
  pipeline_id?: string;
  provisioning_details?: Record<string, unknown>;
}

// ─── Pipeline Types ────────────────────────────────────────────────────────

export type PipelineStatus =
  | 'draft'
  | 'created'
  | 'deploying'
  | 'running'
  | 'active'
  | 'succeeded'
  | 'failed'
  | 'paused'
  | 'cancelled'
  | 'waiting';

export type PipelineType =
  | 'batch_copy'
  | 'incremental'
  | 'cdc'
  | 'streaming'
  | 'api_ingestion'
  | 'quality_check'
  | 'custom';

export interface PipelineRecord {
  pipeline_id: string;
  source_id: string;
  pipeline_type: PipelineType;
  name: string;
  status: PipelineStatus;
  adf_pipeline_name?: string;
  adf_pipeline_id?: string;
  adf_resource_group?: string;
  adf_factory_name?: string;
  last_run_at?: string;
  last_run_status?: string;
  last_run_duration_seconds?: number;
  rows_processed?: number;
  schedule_cron?: string;
  created_at: string;
  updated_at?: string;
}

export interface PipelineRun {
  id: string;
  pipeline_id: string;
  status: PipelineStatus;
  started_at: string;
  ended_at?: string;
  completed_at?: string;
  duration_seconds?: number;
  rows_read?: number;
  rows_written?: number;
  error_message?: string;
  errors?: string[];
}

// ─── Marketplace Types ─────────────────────────────────────────────────────

export interface DataProduct {
  id: string;
  product_id?: string;
  name: string;
  description: string;
  domain: string;
  owner: string | OwnerInfo;
  owner_email?: string;
  classification: string;
  quality_score: number;
  freshness_hours?: number;
  sla_freshness_minutes?: number;
  completeness?: number;
  availability?: number;
  schema_summary?: Record<string, unknown>;
  tags: string[] | Record<string, string>;
  row_count?: number;
  access_count?: number;
  created_at: string;
  updated_at?: string;
  last_updated?: string;
  schema?: SchemaDefinition;
  sample_queries?: string[];
  documentation_url?: string;
}

export interface QualityMetric {
  metric_id?: string;
  product_id?: string;
  date?: string;
  timestamp?: string;
  quality_score?: number;
  overall_score?: number;
  completeness?: number;
  freshness_hours?: number;
  freshness_minutes?: number;
  valid_row_ratio?: number;
  null_rate?: number;
  duplicate_rate?: number;
  schema_drift_detected?: boolean;
  row_count?: number;
}

// ─── Access Request Types ──────────────────────────────────────────────────

export type AccessRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired';

export interface AccessRequest {
  id?: string;
  request_id?: string;
  product_id?: string;
  data_product_id?: string;
  requester_name?: string;
  requester_email: string;
  requester_domain?: string;
  justification: string;
  access_level: 'read' | 'read_write' | 'admin';
  duration_days: number;
  status: AccessRequestStatus;
  reviewer?: string;
  reviewed_by?: string;
  review_notes?: string;
  requested_at?: string;
  reviewed_at?: string;
  expires_at?: string;
  created_at?: string;
}

// ─── Dashboard Types ───────────────────────────────────────────────────────

export interface PlatformStats {
  registered_sources: number;
  active_pipelines: number;
  data_products: number;
  pending_access_requests: number;
  total_data_volume_gb?: number;
  last_24h_pipeline_runs?: number;
  avg_quality_score?: number;
}

export interface DomainOverview {
  name: string;
  source_count: number;
  pipeline_count: number;
  data_product_count: number;
  avg_quality_score: number;
  status: 'healthy' | 'warning' | 'critical';
}

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
