/**
 * Workspace licensing model — one-for-one with the Fabric "License mode" the
 * workspace settings General → License panel exposes (Trial / Pro / Premium /
 * Embedded / Premium-Per-User), plus Loom's Azure-native default `Org` which
 * means "organizational Azure-native capacity, no Power BI / Fabric license
 * required". Persisted on the workspace doc; the Azure-native path NEVER
 * enforces a Power BI / Fabric license (see no-fabric-dependency.md) — the
 * value drives the settings UI + capacity-bind affordance only.
 */
export type WorkspaceLicenseMode =
  | 'Org' | 'Trial' | 'Pro' | 'Premium' | 'PremiumPerUser' | 'Embedded' | 'Delegated';

export interface Workspace {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  /** Lifecycle state. Absent on older docs (treated as 'Active' by readers). */
  state?: 'Active' | 'Provisioning' | 'Suspended' | 'Deleted';
  /** Selected Fabric/Power BI capacity id (or SKU label for legacy free-text). */
  capacity?: string;
  /** Selected Loom-managed business domain id. */
  domain?: string;
  /** Licensing model (workspace settings → License tab). Defaults to 'Org'. */
  licenseMode?: WorkspaceLicenseMode;
  /**
   * Workspace contacts — UPNs / group display names assigned in the create
   * wizard's "Contact list" step (workspace admins / members beyond the
   * creator). Mirrors the Fabric "Contact list" workspace setting.
   */
  contacts?: string[];
  /**
   * Linked Microsoft 365 unified-group object id (workspace settings →
   * "Teams and SharePoint" / M365 tab). Set when the workspace is linked to
   * (or creates) an M365 group; the group's SharePoint document library is
   * the workspace's OneLake-adjacent file collaboration surface in Fabric.
   * Optional — the Azure-native workspace works without it.
   */
  m365GroupId?: string;
  /** SharePoint site URL of the linked M365 group (from Graph site root webUrl). */
  m365SiteUrl?: string;
  /** Display name of the linked M365 group (cached for the settings UI). */
  m365GroupName?: string;
  /** Dedicated backing Azure resource group provisioned for this workspace, when requested. */
  backingRgName?: string;
  /** Outcome of the optional post-create backing-RG ARM provision. */
  backingRgProvision?: {
    status: 'provisioned' | 'failed';
    rgName?: string;
    error?: string;
    at?: string;
  };
  /** Bound Power BI / Fabric group id (created lazily on first PBI-backed artifact). */
  fabricGroupId?: string;
  /**
   * ARM resource id of the storage account explicitly bound to this workspace
   * for OneLake lifecycle management (and shortcut resolution). When absent, the
   * global DLZ account (LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG + LOOM_*_URL) is used.
   * Shape: /subscriptions/{sub}/resourceGroups/{rg}/providers/
   *   Microsoft.Storage/storageAccounts/{name}
   */
  storageAccountId?: string;
  /** F16 — ARM resource id of the ADLS Gen2 account bound for dataflow staging. */
  adlsConnectionId?: string;
  /** F16 — Log Analytics workspace GUID (customerId) bound for query-log export. */
  lawConnectionId?: string;
  /** Outcome of the post-create Capacity assignment side-effect — captured so the
   * UI can show whether it succeeded, is pending, or failed with a reason. */
  capacityAssignment?: {
    status: 'pending' | 'assigned' | 'queued' | 'failed';
    capacityId?: string;
    queuedReason?: string;   // e.g. "no bound Fabric group yet — assignment queued for first PBI artifact"
    error?: string;
    at?: string;
  };
  /** Outcome of the post-create Purview registration + marketplace publish. */
  domainRegistration?: {
    status: 'pending' | 'registered' | 'failed';
    purviewAssetGuid?: string;
    marketplaceListingId?: string;
    error?: string;
    at?: string;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the most recent open. Optional — older docs may lack it. */
  lastAccessedAt?: string;
  /** Aggregated item count. Only present on GET /api/workspaces?count=true. */
  itemCount?: number;
  /**
   * Customer-managed keys (F14) binding state for the workspace's backing ADLS
   * Gen2 storage account (and, optionally, its Cosmos account). Set when a
   * customer key is bound via /api/admin/workspaces/{id}/cmk. The live ARM
   * state is always re-read on GET; this is a cached convenience copy.
   */
  cmkBinding?: {
    status: 'bound' | 'unbound' | 'pending' | 'error';
    vaultUri?: string;
    keyName?: string;
    /** '' = auto-rotate to latest; a hex string = pinned version. */
    keyVersion?: string;
    /** ARM resource id of the UAMI used as the storage encryption identity. */
    uamiResourceId?: string;
    /** True when the Cosmos account was also bound to the customer key. */
    cosmosBound?: boolean;
    boundAt?: string;
    error?: string;
  };
}

export interface WorkspaceItem {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  description?: string;
  /** Optional folder this item lives in (null/undefined = workspace root). */
  folderId?: string | null;
  state?: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFolder {
  id: string;
  workspaceId: string;
  name: string;
  /** Optional parent folder id (null/undefined = root folder). */
  parent?: string | null;
  createdBy: string;
  createdAt: string;
}
