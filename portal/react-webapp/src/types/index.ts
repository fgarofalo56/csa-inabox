/**
 * Type definitions for the CSA-in-a-Box Data Onboarding Portal.
 * These mirror the Pydantic models in portal/shared/api/models/.
 */

// ─── Source Registration Types ─────────────────────────────────────────────

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

export type TargetFormat = 'delta' | 'parquet' | 'csv' | 'json';

export type SourceStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'provisioning'
  | 'active'
  | 'paused'
  | 'decommissioned'
  | 'error';

export interface ConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
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
  is_pii: boolean;
  classification?: string;
}

export interface SchemaDefinition {
  columns: ColumnDefinition[];
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
}

export interface QualityRule {
  rule_name: string;
  rule_type: 'not_null' | 'unique' | 'range' | 'regex' | 'custom_sql' | 'freshness' | 'completeness';
  column?: string;
  parameters: Record<string, unknown>;
  severity: 'warning' | 'error' | 'critical';
}

export interface DataProductConfig {
  name: string;
  description: string;
  domain: string;
  sla_freshness_hours: number;
  sla_completeness: number;
  sla_availability: number;
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

export interface SourceRegistration {
  name: string;
  description: string;
  source_type: SourceType;
  domain: string;
  classification: ClassificationLevel;
  connection: ConnectionConfig;
  schema?: SchemaDefinition;
  ingestion: IngestionConfig;
  quality_rules: QualityRule[];
  data_product?: DataProductConfig;
  target: TargetConfig;
  owner: OwnerInfo;
  tags: Record<string, string>;
}

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

export type PipelineStatus =
  | 'created'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting';

export type PipelineType =
  | 'batch_copy'
  | 'incremental'
  | 'cdc'
  | 'streaming'
  | 'api_ingestion'
  | 'quality_check';

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
  schema?: SchemaDefinition;
  sample_queries?: string[];
  documentation_url?: string;
}

export interface QualityMetric {
  date: string;
  quality_score: number;
  completeness: number;
  freshness_hours: number;
  row_count: number;
}

// ─── Access Request Types ──────────────────────────────────────────────────

export type AccessRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired';

export interface AccessRequest {
  id: string;
  requester_email: string;
  data_product_id: string;
  justification: string;
  access_level: 'read' | 'read_write' | 'admin';
  duration_days: number;
  status: AccessRequestStatus;
  requested_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
  review_notes?: string;
  expires_at?: string;
}

// ─── Dashboard Types ───────────────────────────────────────────────────────

export interface PlatformStats {
  registered_sources: number;
  active_pipelines: number;
  data_products: number;
  pending_access_requests: number;
  total_data_volume_gb: number;
  last_24h_pipeline_runs: number;
  avg_quality_score: number;
}

export interface DomainOverview {
  name: string;
  source_count: number;
  pipeline_count: number;
  data_product_count: number;
  avg_quality_score: number;
  status: 'healthy' | 'warning' | 'critical';
}
