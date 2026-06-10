# azure-connections — parity with Azure "Connections & gateways" (workspace bindings)

Source UI: Fabric/Power BI **Manage connections and gateways** + Azure portal
**Storage account → Access Control (IAM)** and **Log Analytics workspace → Agents /
Data export**. F16 binds two Azure resources to a Loom workspace, Azure-native
only (no Microsoft Fabric / Power BI dependency, per `no-fabric-dependency.md`).

## Azure feature inventory (grounded in Learn)

| Capability | Source UI |
|---|---|
| Pick a storage account for data staging | Azure portal Storage account picker (Microsoft.Storage list) |
| Choose / create a staging container | Storage → Containers |
| Verify the identity can write blobs | Storage IAM → Storage Blob Data Contributor |
| Pick a Log Analytics workspace for log export | Azure Monitor / LAW picker (Microsoft.OperationalInsights list) |
| Verify the identity can configure collection/export | LAW IAM → Log Analytics Contributor |
| Confirm log data plane reachable | LAW → Logs (KQL `print`) |
| Connect / disconnect / status | Connections list with state + remove |

## Loom coverage

| Inventory row | Status | Notes |
|---|---|---|
| ADLS Gen2 account picker (HNS first) | built ✅ | `GET …/connections/adls-accounts` → `storage-discovery.listStorageAccounts()` (real ARM) |
| Staging container (default `dataflow-staging`) | built ✅ | created on connect via `DataLakeFileSystemClient.create()` |
| Storage Blob Data Contributor verification | built ✅ | ARM roleAssignments check on the account, filtered to the UAMI principal + role GUID |
| Log Analytics workspace picker | built ✅ | `GET …/connections/log-analytics-workspaces` → ARM OperationalInsights list (real ARM) |
| Log Analytics Contributor verification | built ✅ | ARM roleAssignments check on the LAW |
| Log data-plane reachability probe | built ✅ | `POST …/v1/workspaces/{customerId}/query` (`print`) |
| Connect / disconnect / status | built ✅ | Cosmos `azure-connections` (PK /workspaceId); status badge + Disconnect |
| Missing-role state | honest-gate ⚠️ | saved as `role-missing` + Fluent MessageBar naming the exact role + `azure-connections-rbac.bicep` + Retry |
| Dataflow staging consumes the binding | built ✅ | `dataflow-run.ts` prefers the workspace-bound ADLS account over the DLZ lake |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---|---|
| ADLS account list | ARM `Microsoft.Storage/storageAccounts` list (`storage-discovery.ts`) |
| LAW list | ARM `Microsoft.OperationalInsights/workspaces` list (api 2023-09-01) |
| Connect ADLS | ARM roleAssignments list (role check) + `DataLakeFileSystemClient.exists()/create()` + Cosmos upsert |
| Connect LAW | ARM GET workspace + roleAssignments list + `POST …/query` data-plane probe + Cosmos upsert |
| Disconnect | Cosmos delete (resource + RBAC untouched) |
| Role grant (remediation) | `platform/fiab/bicep/modules/admin-plane/azure-connections-rbac.bicep` |

## Per-cloud

All hosts resolve via `cloud-endpoints.ts` (`armBase` / `dfsUrl` / `getLogAnalyticsHost`):
Commercial+GCC use `management.azure.com` / `dfs.core.windows.net` / `api.loganalytics.azure.com`;
GCC-High/IL5 use `management.usgovcloudapi.net` / `dfs.core.usgovcloudapi.net` / `api.loganalytics.us`.
Both built-in role GUIDs are cloud-invariant.

## Verification

- `npx vitest run lib/clients/__tests__/azure-connections-client.test.ts` (role GUIDs + UAMI principal resolution).
- Live: with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, open `/admin/workspaces` → a workspace's
  **Connections** drawer; connect a real ADLS account (staging container created) and a real LAW
  (KQL probe succeeds); a missing role renders the honest MessageBar with Retry.
