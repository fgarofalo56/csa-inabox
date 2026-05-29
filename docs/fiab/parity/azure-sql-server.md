# azure-sql-server — parity with Azure SQL logical server (portal)

Source UI: Azure portal SQL server — https://learn.microsoft.com/azure/azure-sql/database/firewall-configure · https://learn.microsoft.com/azure/azure-sql/database/authentication-aad-configure
Editor: `AzureSqlServerEditor` in `apps/fiab-console/lib/editors/azure-sql-editors.tsx`

## Feature inventory

| # | Capability | Portal blade |
|---|---|---|
| 1 | Server list / overview | SQL servers |
| 2 | Databases list (status, SKU) | SQL databases |
| 3 | Networking — server-level firewall rules (create/delete) | Networking |
| 4 | Microsoft Entra (AAD) admin (get/set) | Microsoft Entra ID |
| 5 | Connection strings | Connection strings |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `useSqlServers` discovery, left-pane picker |
| 2 | ✅ | `/azure-sql-server/[id]/databases` (ARM, name/status/SKU) |
| 3 | ✅ | `Firewall` dialog get/add/delete → `/firewall` (Microsoft.Sql/servers/firewallRules ARM) |
| 4 | ✅ | `AAD admin` dialog get/set → `/aad-admin` (administrators ARM) |
| 5 | ✅ | Connection string derivable from server FQDN (shown in overview) |

## Backend per control
- Discovery / databases / firewall / AAD admin → ARM Microsoft.Sql REST via Console UAMI.

Grade: **A (server overview + databases + firewall CRUD + Entra admin all real ARM).**
