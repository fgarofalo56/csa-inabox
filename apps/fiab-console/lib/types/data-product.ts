/**
 * Data Marketplace types — Azure-native parity with Microsoft Purview Unified
 * Catalog "data products". These are the Cosmos document shapes for the
 * `dataproducts` and `access-requests` containers (see
 * lib/azure/cosmos-client.ts). NO Fabric / Power BI dependency: data products
 * live entirely in Cosmos and are governed by Loom-native governance domains.
 */

export type DataProductStatus = 'Draft' | 'Published' | 'Expired';

export interface DataProductOwner {
  /** AAD object id of the owner. */
  id: string;
  /** User principal name. */
  upn?: string;
  /** Display name (cached at create time; refreshed by people-picker in T4). */
  displayName?: string;
  /** Optional contact label the data-product owner can set per owner
   *  (e.g. "Primary contact", "Escalation"). Editable in T4. */
  label?: string;
}

export interface DataProductCustomAttribute {
  /** Attribute group (custom-attribute group / managed-attribute group name). */
  groupName: string;
  /** Attribute name. */
  name: string;
  /** Attribute value — may be null/empty (the "show empty" toggle reveals these). */
  value?: string | number | boolean | null;
}

export interface DataProductLink {
  label: string;
  url: string;
  /** Optional governed-asset id this link points at. */
  assetId?: string;
}

export interface DataProductAsset {
  guid: string;
  name: string;
  typeName: string;
}

export interface DataProductDoc {
  id: string;
  tenantId: string;
  /** Governance domain (partition key). */
  governanceDomainId: string;
  /** Cached domain display name (refreshed by the domain editor). */
  governanceDomainName?: string;
  name: string;
  description?: string;
  useCase?: string;
  /** Data-product type (e.g. "Dataset", "Master data", "Operational"). */
  type?: string;
  /** Intended audience (free-text tags). */
  audience?: string[];
  status: DataProductStatus;
  /** Endorsement flag — renders the "Endorsed" badge when true. */
  endorsed?: boolean;
  /** Update cadence (e.g. "Daily", "Hourly", "Monthly"). */
  updateFrequency?: string;
  owners?: DataProductOwner[];
  customAttributes?: DataProductCustomAttribute[];
  termsOfUse?: DataProductLink[];
  documentation?: DataProductLink[];
  dataAssets?: DataProductAsset[];
  createdAt: string;
  updatedAt: string;
  _etag?: string;
}

export interface AccessRequestDoc {
  id: string;
  /** Partition key — the data product this request targets. */
  dataProductId: string;
  tenantId: string;
  requesterOid?: string;
  requesterUpn?: string;
  requesterDisplayName?: string;
  purpose?: string;
  status: 'pending' | 'approved' | 'denied' | 'revoked';
  requestedAt: string;
  grantedAt?: string;
  decidedBy?: string;
}

/** Shape returned by GET /api/data-products/[id]. */
export interface DataProductDetailResponse {
  ok: boolean;
  product?: DataProductDoc;
  /** Real computed DQ score 0–100, or null when no rules are configured. */
  dqScore?: number | null;
  /** Honest-gate message shown in place of the gauge when dqScore is null. */
  dqGate?: string | null;
  /** Count of approved subscribers (real access-requests query). */
  subscriberCount?: number;
  error?: string;
}
