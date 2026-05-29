# azure-sql-managed-instance — parity with Azure SQL Managed Instance (portal)

Source UI: Azure portal SQL MI — https://learn.microsoft.com/azure/azure-sql/managed-instance/
Editor: `SqlManagedInstanceEditor` in `apps/fiab-console/lib/editors/azure-sql-editors.tsx`

## Feature inventory

| # | Capability | Portal blade |
|---|---|---|
| 1 | Instance list (state, location, SKU, FQDN) | SQL managed instances |
| 2 | Provision new instance | Create (45+ min) |
| 3 | In-instance T-SQL query | (requires connectivity into MI subnet) |
| 4 | Networking / VNet | Networking |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/api/items/azure-sql-managed-instance` ARM list (real) |
| 2 | ⚠️ honest-gate | MessageBar: provision via bicep `Microsoft.Sql/managedInstances` or portal (out-of-band, 45+ min). Read-only registry view. |
| 3 | ⚠️ honest-gate | MessageBar names the exact requirement: a private endpoint joined to the MI delegated subnet + Console UAMI `db_datareader`; then queries route through the shared TDS path. No "deferred" wording. |
| 4 | ⚠️ honest-gate | VNet/networking is provisioned out-of-band (same MI subnet requirement). |

## Backend per control
- Instance list → ARM Microsoft.Sql/managedInstances REST.
- Query → blocked by topology (MI has no public TDS gateway); honest infra-gate names the private-endpoint + role provisioning needed.

Grade: **B − (real ARM-backed list; in-instance query and provisioning are honest infra-gates that name the exact private-endpoint + role requirement — full surface renders, no stubs).**
