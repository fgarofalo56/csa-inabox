# onelake-storage-tiers — parity with Azure Blob access tiers / OneLake tier (preview)

Source UI:
- Azure portal — Storage account → Containers → blob → **Change tier** (Hot / Cool / Cold / Archive)
- Microsoft Learn — [Access tiers for blob data](https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview)
- Fabric OneLake — tiering is **preview**; this surface badges the Tier column / dialog title "preview" accordingly.

The Loom lakehouse editor (Files tab) reaches the same ADLS Gen2 blobs over the
multi-protocol `.blob` endpoint, where the access tier is readable/writable
(the `.dfs` DataLake surface does not expose it).

## Azure feature inventory (grounded in Learn)

| # | Capability | Azure portal behavior |
|---|------------|-----------------------|
| 1 | Show current tier | Blob properties list the access tier (Hot/Cool/Cold/Archive). |
| 2 | Change tier — downgrade | Hot→Cool / Hot→Cold / Cool→Cold via **Set Blob Tier** (instant). |
| 3 | Change tier — upgrade | Cool/Cold→Hot. Set Blob Tier would charge the early-deletion penalty if the source is below its minimum; **Copy Blob** to a new Hot blob avoids it. |
| 4 | Early-deletion penalty disclosure | Cool min 30 days, Cold min 90 days; deleting/re-tiering before the minimum is prorated-charged. |
| 5 | Archive handling | Archive requires multi-hour rehydration before re-tiering; not an inline change. |
| 6 | Per-cloud correctness | Tier API is GA in Commercial, GCC, GCC-High, DoD. |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Show current tier | ✅ | `GET /api/onelake/tier` → `getBlobTier` (Get Blob Properties). Tier chip column in Files tab + "Current tier" badge in the dialog. |
| 2 | Downgrade | ✅ | `PUT /api/onelake/tier` → `setBlobTier` → `BlobClient.setAccessTier`. |
| 3 | Upgrade (Copy Blob) | ✅ | `PUT` auto-detects direction → `copyBlobToTier` → `beginCopyFromURL({tier:'Hot'})` to a temp path, delete original, DFS `move` rename. Response reports `method: "copy"`. |
| 4 | Penalty disclosure | ✅ | `TierDialog` shows a `MessageBar intent="warning"` with the 30 d / 90 d minimum when downgrading, and a Copy-Blob notice when upgrading. |
| 5 | Archive handling | ✅ | `getBlobTier` returns `Archive`; dialog disables tier changes + the route returns 409 with an explanation. |
| 6 | Per-cloud correctness | ✅ | `.blob` host from `getBlobSuffix()` (`blob.core.windows.net` / `blob.core.usgovcloudapi.net`). |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Tier chip / "Current tier" badge | `GET /api/onelake/tier` → `adls-client.getBlobTier` → `@azure/storage-blob` `BlobClient.getProperties()` |
| Set to Cool / Cold | `PUT /api/onelake/tier` → `adls-client.setBlobTier` → `BlobClient.setAccessTier()` |
| Set to Hot (from Cool/Cold) | `PUT /api/onelake/tier` → `adls-client.copyBlobToTier` → `beginCopyFromURL({tier})` + `delete()` + DataLake `move()` |

## Infra

No new Azure resource, role, or env var. Tier read/write and Copy Blob are
data-plane operations within the **Storage Blob Data Contributor** role the
Console UAMI already holds on the DLZ containers (wired in
`platform/fiab/bicep/modules/admin-plane/access-policy-rbac.bicep`). No Fabric
dependency — works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
