/**
 * Type definitions for the CSA-in-a-Box Data Onboarding Portal.
 *
 * Re-exports canonical types from portal/shared/contracts/types.ts.
 * That file is the single source of truth for all API type definitions
 * shared between the React and Svelte portals.
 *
 * NOTE: We copy the canonical types here rather than using a cross-project
 * import because Next.js does not resolve paths outside its root without
 * monorepo tooling. Keep this file in sync with portal/shared/contracts/types.ts.
 */

// Re-export everything from the canonical shared contract
export type {
  SourceType,
  IngestionMode,
  ClassificationLevel,
  TargetFormat,
  SourceStatus,
  ConnectionConfig,
  ColumnDefinition,
  SchemaDefinition,
  IngestionConfig,
  DataQualityRule,
  DataProductConfig,
  TargetConfig,
  OwnerInfo,
  SourceRegistration,
  SourceRecord,
  PipelineStatus,
  PipelineType,
  PipelineRecord,
  PipelineRun,
  DataProduct,
  QualityMetric,
  AccessLevel,
  AccessRequestStatus,
  AccessRequest,
  AccessRequestCreate,
  SLADefinition,
  LineageInfo,
  SchemaInfo,
  DomainStatus,
  PlatformStats,
  DomainOverview,
  RecentActivity,
  ApiError,
  PaginatedResponse,
} from '../../../shared/contracts/types';
