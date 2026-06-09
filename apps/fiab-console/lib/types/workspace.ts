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
