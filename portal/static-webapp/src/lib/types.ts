/**
 * TypeScript type definitions for the CSA-in-a-Box Data Onboarding Portal.
 * Mirrors the Pydantic models in portal/shared/api/models/.
 */

// ─── Source Registration Types ─────────────────────────────────────────────

export type SourceType =
	| 'sql_server'
	| 'azure_sql'
	| 'cosmos_db'
	| 'rest_api'
	| 'file_drop'
	| 'blob_storage'
	| 'event_hub'
	| 'kafka'
	| 's3'
	| 'oracle'
	| 'mysql'
	| 'postgres'
	| 'sharepoint'
	| 'dynamics365'
	| 'databricks'
	| 'snowflake';

export type IngestionMode = 'full' | 'incremental' | 'cdc' | 'streaming';

export type ClassificationLevel =
	| 'public'
	| 'internal'
	| 'confidential'
	| 'restricted'
	| 'cui'
	| 'fouo';

export type TargetFormat = 'delta' | 'parquet' | 'csv' | 'json' | 'avro';

export type SourceStatus =
	| 'pending'
	| 'provisioning'
	| 'active'
	| 'paused'
	| 'error'
	| 'decommissioned';

export interface ConnectionConfig {
	host?: string;
	port?: number;
	database?: string;
	schema?: string;
	username?: string;
	key_vault_secret_name?: string;
	connection_string_secret?: string;
	url?: string;
	auth_type?: string;
	event_hub_namespace?: string;
	consumer_group?: string;
}

export interface ColumnDefinition {
	name: string;
	data_type: string;
	nullable: boolean;
	description?: string;
	is_primary_key: boolean;
	classification?: ClassificationLevel;
}

export interface SchemaDefinition {
	tables?: Record<string, ColumnDefinition[]>;
	endpoints?: string[];
	auto_detect: boolean;
}

export interface IngestionConfig {
	mode: IngestionMode;
	schedule?: string;
	watermark_column?: string;
	batch_size?: number;
	parallelism: number;
}

export interface QualityRule {
	type: string;
	column: string;
	params?: Record<string, unknown>;
}

export interface DataProductConfig {
	name: string;
	domain: string;
	description?: string;
	sla_freshness_minutes: number;
	valid_row_ratio: number;
	quality_rules: QualityRule[];
}

export interface TargetConfig {
	landing_zone: string;
	container: string;
	path_pattern: string;
	format: TargetFormat;
}

export interface OwnerInfo {
	name: string;
	email: string;
	domain: string;
	team?: string;
}

export interface SourceRegistration {
	source_name: string;
	source_type: SourceType;
	description?: string;
	connection: ConnectionConfig;
	schema_definition: SchemaDefinition;
	ingestion: IngestionConfig;
	classification: ClassificationLevel;
	owner: OwnerInfo;
	data_product?: DataProductConfig;
	target: TargetConfig;
	tags: string[];
	environment: string;
}

export interface SourceRecord extends SourceRegistration {
	source_id: string;
	status: SourceStatus;
	created_at: string;
	updated_at: string;
	pipeline_id?: string;
	provisioning_details?: Record<string, unknown>;
}

// ─── Pipeline Types ────────────────────────────────────────────────────────

export type PipelineStatus =
	| 'draft'
	| 'deploying'
	| 'active'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'paused'
	| 'cancelled';

export type PipelineType =
	| 'batch_copy'
	| 'incremental'
	| 'cdc'
	| 'api_ingestion'
	| 'streaming'
	| 'custom';

export interface PipelineRecord {
	pipeline_id: string;
	source_id: string;
	pipeline_type: PipelineType;
	name: string;
	status: PipelineStatus;
	adf_pipeline_name?: string;
	adf_resource_group?: string;
	adf_factory_name?: string;
	last_run_at?: string;
	last_run_status?: string;
	last_run_duration_seconds?: number;
	rows_processed?: number;
	created_at: string;
	updated_at: string;
}

export interface PipelineRun {
	run_id: string;
	pipeline_id: string;
	status: PipelineStatus;
	started_at: string;
	completed_at?: string;
	duration_seconds?: number;
	rows_read: number;
	rows_written: number;
	errors: string[];
}

// ─── Marketplace Types ─────────────────────────────────────────────────────

export interface DataProduct {
	product_id: string;
	name: string;
	domain: string;
	description: string;
	owner: string;
	owner_email: string;
	classification: string;
	schema_summary?: Record<string, unknown>;
	sla_freshness_minutes: number;
	quality_score: number;
	last_updated?: string;
	row_count?: number;
	tags: string[];
	access_count: number;
	created_at: string;
}

export interface QualityMetric {
	metric_id: string;
	product_id: string;
	timestamp: string;
	valid_row_ratio: number;
	null_rate: number;
	duplicate_rate: number;
	freshness_minutes: number;
	schema_drift_detected: boolean;
	overall_score: number;
}

// ─── Access Request Types ──────────────────────────────────────────────────

export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'revoked';

export interface AccessRequest {
	request_id?: string;
	product_id: string;
	requester_name: string;
	requester_email: string;
	requester_domain: string;
	justification: string;
	access_level: 'read' | 'read_write' | 'admin';
	duration_days: number;
	status: AccessRequestStatus;
	reviewer?: string;
	review_notes?: string;
	created_at: string;
	reviewed_at?: string;
	expires_at?: string;
}

// ─── Dashboard Types ───────────────────────────────────────────────────────

export interface PlatformStats {
	registered_sources: number;
	active_pipelines: number;
	data_products: number;
	pending_access_requests: number;
}

export interface RecentActivity {
	id: string;
	type: 'source_registered' | 'pipeline_run' | 'access_request' | 'product_published';
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
