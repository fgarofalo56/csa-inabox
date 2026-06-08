/**
 * Microsoft Purview Unified Catalog — data-product enumerations.
 *
 * These are the REAL API enum values (no mock list) used by the Create Data
 * Product operation, grounded in the Unified Catalog data-plane REST API
 * (api-version 2026-03-20-preview):
 *
 *   - CatalogModelDataProductTypeEnum  (the "Type" dropdown)
 *   - AudienceEnum                     (the "Audience" multi-select)
 *
 * Source of truth (Microsoft Learn):
 *   https://learn.microsoft.com/rest/api/purview/purview-unified-catalog/data-products/create
 *   https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage
 *
 * `value` is the exact string the data-plane POST body expects; `label` is the
 * friendly portal-style display string for the Loom dropdowns. Both the BFF
 * route (validation + Purview register) and the wizard import from here so the
 * front end and back end can never drift.
 *
 * NOTE on counts: the live 2026-03-20-preview enum exposes 14 data-product
 * types (the operator brief estimated 12; the real API has 14, so per
 * .claude/rules/no-vaporware.md we ship the real enum). The Audience enum has
 * exactly 8 values.
 */

export interface EnumOption {
  /** Exact data-plane API value. */
  value: string;
  /** Friendly display label (portal parity). */
  label: string;
}

/**
 * CatalogModelDataProductTypeEnum — 14 values. The portal's conceptual list
 * uses friendlier names ("Analytics model", "ML training data", …); each maps
 * to one of these API enum values.
 */
export const DATA_PRODUCT_TYPES: readonly EnumOption[] = [
  { value: 'Master', label: 'Master data' },
  { value: 'Reference', label: 'Reference data' },
  { value: 'Analytical', label: 'Analytical' },
  { value: 'AI', label: 'AI' },
  { value: 'MasterDataAndReferenceData', label: 'Master and reference data' },
  { value: 'BusinessSystemOrApplication', label: 'Business system / Application' },
  { value: 'ModelTypes', label: 'Model types' },
  { value: 'DashboardsOrReports', label: 'Dashboards / Reports' },
  { value: 'Operational', label: 'Operational' },
  { value: 'MLAITrainingDataSet', label: 'ML / AI training dataset' },
  { value: 'MLAITestingDataSet', label: 'ML / AI testing dataset' },
  { value: 'TransactionalDataset', label: 'Transactional data' },
  { value: 'AnalyticsModel', label: 'Analytics model' },
  { value: 'SemanticModel', label: 'Semantic model' },
] as const;

/** AudienceEnum — exactly 8 values. */
export const DATA_PRODUCT_AUDIENCES: readonly EnumOption[] = [
  { value: 'DataEngineer', label: 'Data engineer' },
  { value: 'BIEngineer', label: 'BI engineer' },
  { value: 'DataAnalyst', label: 'Data analyst' },
  { value: 'DataScientist', label: 'Data scientist' },
  { value: 'BusinessAnalyst', label: 'Business analyst' },
  { value: 'SoftwareEngineer', label: 'Software engineer' },
  { value: 'BusinessUser', label: 'Business user' },
  { value: 'Executive', label: 'Executive' },
] as const;

/** The hard limit Purview enforces on the description field. */
export const DATA_PRODUCT_DESCRIPTION_MAX = 10_000;

export const DATA_PRODUCT_TYPE_VALUES: readonly string[] = DATA_PRODUCT_TYPES.map((t) => t.value);
export const DATA_PRODUCT_AUDIENCE_VALUES: readonly string[] = DATA_PRODUCT_AUDIENCES.map((a) => a.value);

const TYPE_LABELS = new Map(DATA_PRODUCT_TYPES.map((t) => [t.value, t.label]));
const AUDIENCE_LABELS = new Map(DATA_PRODUCT_AUDIENCES.map((a) => [a.value, a.label]));

export function dataProductTypeLabel(value: string | undefined | null): string {
  if (!value) return '—';
  return TYPE_LABELS.get(value) || value;
}

export function audienceLabel(value: string): string {
  return AUDIENCE_LABELS.get(value) || value;
}

export function isValidDataProductType(value: unknown): value is string {
  return typeof value === 'string' && DATA_PRODUCT_TYPE_VALUES.includes(value);
}

export function isValidAudience(value: unknown): value is string {
  return typeof value === 'string' && DATA_PRODUCT_AUDIENCE_VALUES.includes(value);
}
