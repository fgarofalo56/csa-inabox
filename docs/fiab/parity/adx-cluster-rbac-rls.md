# adx-cluster-rbac-rls — parity with Azure Data Explorer cluster admin, Permissions, and Row-Level Security

Source UI:
- ADX portal cluster **Overview** + **Configuration** blades (stop/start/scale/autoscale/streaming-ingest/delete)
- ADX portal **Permissions** blade + Kusto.Explorer "Manage authorized principals"
- KQL **Row-Level Security policy** (`.alter table policy row_level_security`)

Learn:
- https://learn.microsoft.com/azure/data-explorer/manage-cluster-horizontal-scaling
- https://learn.microsoft.com/azure/data-explorer/start-stop-cluster
- https://learn.microsoft.com/kusto/management/manage-database-security-roles
- https://learn.microsoft.com/kusto/management/row-level-security-policy

## Azure/Fabric feature inventory

### Cluster lifecycle + scale
| Capability | Source UI |
|---|---|
| Stop cluster (release compute, keep data) | Overview → Stop |
| Start cluster (~10-min warm-up) | Overview → Start |
| Delete cluster (14-day soft-delete) | Overview → Delete |
| Change SKU (compute size) | Scale up |
| Change instance count | Scale out |
| Optimized autoscale (enable + min/max) | Scale out → Optimized autoscale |
| Streaming ingestion toggle | Configuration → Streaming ingestion |

### Database / table RBAC
| Capability | Source UI |
|---|---|
| List database principals + role | Permissions blade |
| Add database principal (admins/users/viewers/unrestrictedviewers/ingestors/monitors) | Permissions → Add |
| Remove database principal | Permissions → row delete |
| List table principals | Kusto.Explorer table → Manage principals |
| Add/remove table principal (admins/ingestors) | same |

### Row-Level Security
| Capability | Source UI |
|---|---|
| Show table RLS policy | `.show table T policy row_level_security` |
| Enable RLS with a KQL predicate | `.alter table T policy row_level_security enable "<q>"` |
| Disable RLS | `.alter table T policy row_level_security disable ""` |
| Force-test RLS without affecting users | `set query_force_row_level_security;` |

## Loom coverage

| Inventory row | Status | Loom surface |
|---|---|---|
| Stop / Start / Delete cluster | ✅ | `AdxClusterEditor` Manage tab → PUT `/api/admin/scaling/adx` |
| Change SKU + instance count | ✅ | `AdxClusterEditor` Overview tab → POST `/api/admin/scaling/adx` |
| Optimized autoscale enable + min/max | ✅ | `AdxClusterEditor` (disabled on Basic SKU with honest note) |
| Streaming ingestion toggle | ✅ | `AdxClusterEditor` |
| List/add/remove database principals | ✅ | `AdxRbacPanel` Database tab → `/api/adx/principals` |
| List/add/remove table principals | ✅ | `AdxRbacPanel` Table tab → `/api/adx/principals?scope=table` |
| Show/enable/disable table RLS | ✅ | per-table shield in `AdxDatabaseTree` + KqlDatabaseEditor RLS dialog → `/api/adx/rls` |
| Force-test RLS | ✅ (documented) | RLS dialog hint: `set query_force_row_level_security;` runnable in the query editor |

Zero ❌, zero stub banners. The previously-honest-gated "Row-level security"
row in the navigator's "Not yet wired" group is removed and replaced with the
working per-table shield.

## Backend per control

| Control | Backend call |
|---|---|
| Stop / Start | `stopKustoCluster` / `startKustoCluster` → `POST .../clusters/{n}/{stop,start}` |
| Delete | `deleteKustoCluster` → `DELETE .../clusters/{n}` (type-the-name confirm) |
| SKU + capacity | `updateKustoClusterSku` → `PATCH .../clusters/{n}` |
| Autoscale | `updateKustoClusterAutoscale` → `PATCH optimizedAutoscale` |
| Streaming ingest | `updateKustoStreamingIngest` → `PATCH enableStreamingIngest` |
| DB/table principals | `add/dropDatabasePrincipal` / `add/dropTablePrincipal` → `.add/.drop database|table <role> ('<fqn>')` |
| RLS show/alter | `showTableRlsPolicy` / `alterTableRlsPolicy` → `.show/.alter table T policy row_level_security` |

## Cloud matrix

| Concern | Commercial | GovCloud (AzureUSGovernment) | Fabric Eventhouse |
|---|---|---|---|
| Cluster ARM stop/start/delete | `armBase()` (`management.azure.com`) | `management.usgovcloudapi.net` — no code change | N/A (Fabric manages compute) |
| DB/table RBAC commands | `/v1/rest/mgmt`, AAD token | identical (Entra) | identical KQL |
| RLS command | `/v1/rest/mgmt` | identical | identical |
| AllDatabasesAdmin grant | `adxConsoleAdmin` principalAssignment | same resource type | Fabric workspace roles drive RBAC; KQL principal adds are additive |

## Verification

`vitest` covers the control-command shapes (`kusto-rbac-rls.test.ts`) and the
RLS predicate validator (`kusto-rls-predicate.test.ts`). Live: open a KQL
database, use Manage › Manage principals / Row-level security / Cluster
lifecycle & scale against a real ADX cluster (`LOOM_DEFAULT_FABRIC_WORKSPACE`
unset) and confirm each control returns a real ARM/Kusto receipt.
