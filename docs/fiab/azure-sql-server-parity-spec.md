# Loom Azure SQL Server Editor — Azure-portal parity spec

> Captured 2026-05-26. Source: Microsoft Learn `azure-sql/database/logical-servers`, `firewall-configure`, `authentication-aad-overview`, `active-geo-replication-overview`, `network-access-controls-overview`. Item: `azure-sql-server` → `apps/fiab-console/lib/editors/azure-sql-editors.tsx::AzureSqlServerEditor`.

## Overview
A "logical SQL server" (`Microsoft.Sql/servers`) is the administrative parent for Azure SQL Databases and Synapse dedicated SQL pools. It's not a SQL Server instance — it has no T-SQL surface of its own — but it owns the namespace, FQDN (`<name>.database.windows.net`), authentication settings (SQL admin + Microsoft Entra admin), firewall rules, virtual-network rules, private endpoints, outbound-network restrictions, auditing policy, Microsoft Defender for SQL config, and the cross-region geo-replication / failover-group relationships of every database under it.

## Azure portal UI inventory

### Resource menu (left rail)
- **Overview** — server FQDN, location, subscription, resource group, Microsoft Entra admin, public network access state, server version, list of contained databases with status + service tier
- **Activity log**, **Access control (IAM)**, **Tags**, **Diagnose and solve problems**
- **Settings**
  - **Active Directory admin** — set/clear the Microsoft Entra admin login (user, group, or service principal)
  - **SQL databases** — list of databases on this server; create/delete from here
  - **SQL elastic pools** — list + create pools
  - **Deleted databases** — point-in-time restore catalog
  - **Failover groups** — create/delete failover groups; list current primary/secondary mapping
  - **Manage Backups** — long-term retention policy at server scope
  - **Properties**, **Locks**
- **Security**
  - **Microsoft Defender for Cloud** — Defender for SQL enablement, storage account for vulnerability scans, recurring recommendations, alerts
  - **Identity** — system-assigned + user-assigned managed identities (used for Azure AD admin + customer-managed TDE)
  - **Auditing** — server-level audit policy (storage account / Log Analytics / Event Hubs sinks, audit action groups, retention)
  - **Transparent data encryption** — service-managed or customer-managed key (Azure Key Vault), key rotation
  - **Networking** — Public network access (Disabled / Selected networks / All networks), server firewall rules (IPv4 ranges), virtual-network rules, **Allow Azure services and resources to access this server** toggle, **Connection policy** (Default / Proxy / Redirect), **Minimum TLS version**, outbound networking restrictions (FQDN allow-list), private endpoint connections
- **Data management**
  - **Replicas** — per-database geo-replica list (Add replica, Forced failover, Stop replication)
  - **Import/Export history** — BACPAC job history
- **Monitoring**
  - **Metrics**, **Diagnostic settings**, **Alerts**
- **Automation**
  - **Tasks (preview)**, **Export template**

### Top command bar
- **+ Create database**, **+ Import database**, **Reset password** (SQL admin), **Set server firewall**, **Delete**, **Move**, **Refresh**, **Feedback**

## What Loom has
- `AzureSqlServerEditor` (484-line editor in `azure-sql-editors.tsx`) lists `Microsoft.Sql/servers` per subscription, surfaces FQDN, AAD admin, public-network-access state, server state, location, version, and the contained databases (name / status / SKU) via `/api/items/azure-sql-server` + `/api/items/azure-sql-server/[id]/databases`.
- Caption today says: *"Server-level firewall + AAD admin mutation deferred to v3.x — provision via bicep (`Microsoft.Sql/servers/firewallRules`, `Microsoft.Sql/servers/administrators`)."* No mutation surfaces today — read-only.

## Gaps for parity
1. **Firewall rules editor** — list + add/edit/delete `Microsoft.Sql/servers/firewallRules` (name, startIpAddress, endIpAddress) plus the "Allow Azure services" virtual rule (0.0.0.0). Server-scope only (database-scope rules are T-SQL only).
2. **Virtual-network rules editor** — `Microsoft.Sql/servers/virtualNetworkRules` (subnet ARM id + IgnoreMissingVnetServiceEndpoint flag).
3. **Microsoft Entra admin mutation** — `Microsoft.Sql/servers/administrators/ActiveDirectory` PUT (loginName, sid, tenantId). Required so Loom-managed MIs can become admin on bicep-provisioned servers.
4. **Public network access + minimum TLS** — toggle `publicNetworkAccess` Enabled/Disabled/SecuredByPerimeter, change `minimalTlsVersion` (1.0 / 1.1 / 1.2 / 1.3), change `restrictOutboundNetworkAccess` + outbound-rule FQDN allow-list.
5. **Failover groups** — list `Microsoft.Sql/servers/failoverGroups`, create new group (partner server, databases in group, read-write endpoint failover policy + grace period, read-only endpoint failover policy), planned failover, forced failover, remove databases.
6. **Active geo-replication (per database)** — list `Microsoft.Sql/servers/databases/replicationLinks`, create secondary (target server, location, SKU, elastic pool target), forced failover, stop replication.
7. **Defender for SQL config** — enable/disable, choose storage account for VA scans, recurring scan + email config.
8. **Auditing policy** — server-scope `Microsoft.Sql/servers/auditingSettings` (state, storage account ARM id + key/MSI, retention, Log Analytics workspace, Event Hub name + namespace, audit action groups).
9. **TDE key management** — list `Microsoft.Sql/servers/encryptionProtector`, swap to a Key Vault key URI (customer-managed TDE), rotate.
10. **Private endpoint connections** — list, approve, reject `Microsoft.Sql/servers/privateEndpointConnections`.

## Backend mapping
All control-plane surfaces are Azure ARM REST against the `Microsoft.Sql` provider — no TDS for any of the above. Token = MI-as-Loom against `https://management.azure.com/.default`. Suggested new BFF routes (additive to the existing `/api/items/azure-sql-server/[id]/databases`):
- `POST /api/items/azure-sql-server/[id]/firewall-rules` — list / create / delete (`firewallRules`)
- `POST /api/items/azure-sql-server/[id]/vnet-rules` — list / create / delete (`virtualNetworkRules`)
- `POST /api/items/azure-sql-server/[id]/aad-admin` — PUT `administrators/ActiveDirectory`
- `POST /api/items/azure-sql-server/[id]/networking` — PATCH server (`publicNetworkAccess`, `minimalTlsVersion`, `restrictOutboundNetworkAccess`) + `outboundFirewallRules`
- `POST /api/items/azure-sql-server/[id]/failover-groups` — list / create / failover / delete (`failoverGroups`)
- `POST /api/items/azure-sql-server/[id]/replicas` — list / add / forced-failover / delete (`databases/replicationLinks` + `databases` create with `createMode=Secondary`)
- `POST /api/items/azure-sql-server/[id]/auditing` — server-scope `auditingSettings`
- `POST /api/items/azure-sql-server/[id]/defender` — `securityAlertPolicies` + `vulnerabilityAssessments`
- `POST /api/items/azure-sql-server/[id]/tde-protector` — `encryptionProtector`
- `POST /api/items/azure-sql-server/[id]/private-endpoints` — list / approve / reject

## Required Azure resources
Already provisioned by the Loom platform (logical SQL server is a tenant of `Microsoft.Sql`). No new dependencies — additive only.
- Loom MI must hold `SQL Server Contributor` (firewall, vnet rules, networking, replicas, failover groups, audit), `SQL Security Manager` (Defender + auditing storage SAS), and `Directory Readers` (for AAD admin lookup) on the target subscription.
- For TDE swap to CMK: MI must have `Key Vault Crypto Service Encryption User` on the KV holding the key, and the server's own identity (system-assigned) must have `wrapKey/unwrapKey/get` on the key. Wire in `platform/fiab/bicep/modules/sql/sql-server.bicep`.

## Reference ARM shapes (for BFF + bicep)
Common shapes the new BFF routes need to send to `https://management.azure.com`:

```
PUT  /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Sql/servers/{srv}/firewallRules/{rule}?api-version=2023-08-01
     { "properties": { "startIpAddress": "x.x.x.x", "endIpAddress": "y.y.y.y" } }

PUT  /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Sql/servers/{srv}/administrators/ActiveDirectory?api-version=2023-08-01
     { "properties": { "administratorType": "ActiveDirectory",
                       "login": "<group@tenant>", "sid": "<objectId>", "tenantId": "<tenantId>" } }

PATCH /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Sql/servers/{srv}?api-version=2023-08-01
     { "properties": { "publicNetworkAccess": "Disabled",
                       "minimalTlsVersion": "1.2",
                       "restrictOutboundNetworkAccess": "Enabled" } }

PUT  /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Sql/servers/{srv}/failoverGroups/{fg}?api-version=2023-08-01
     { "properties": { "partnerServers": [{ "id": "/.../servers/{partner}" }],
                       "readWriteEndpoint": { "failoverPolicy": "Automatic", "failoverWithDataLossGracePeriodMinutes": 60 },
                       "databases": ["/.../databases/{dbName}"] } }

PUT  /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Sql/servers/{srv}/encryptionProtector/current?api-version=2023-08-01
     { "properties": { "serverKeyType": "AzureKeyVault", "serverKeyName": "<kv>_<key>_<ver>" } }
```

The corresponding bicep modules already exist for the create-time shape (`platform/fiab/bicep/modules/sql/sql-server.bicep`). The new BFF surface mutates these resources after deploy without breaking the bicep idempotency contract — each PUT/PATCH is targeting a child resource that bicep declares but doesn't lock.

## Estimated effort
3 sessions: (1) firewall + vnet + AAD-admin + networking + private-endpoints mutation surface; (2) failover groups + active geo-replication editor with the per-DB replicas tab; (3) Defender + auditing + TDE protector + outbound rules.
