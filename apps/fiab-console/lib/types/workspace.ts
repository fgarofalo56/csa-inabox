export interface Workspace {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  /** Selected Fabric/Power BI capacity id (or SKU label for legacy free-text). */
  capacity?: string;
  /** Selected Loom-managed business domain id. */
  domain?: string;
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
