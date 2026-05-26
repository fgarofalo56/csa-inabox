# Loom Azure SQL Managed Instance Editor — Azure-portal parity spec

> Captured 2026-05-26. Source: Microsoft Learn `azure-sql/managed-instance/sql-managed-instance-paas-overview`, `instance-create-quickstart`, `connectivity-architecture-overview`, `public-endpoint-overview`, `auditing-configure`, `threat-detection-configure`, `update-policy`, `failover-group-sql-mi`, `managed-instance-link-feature-overview`, `instance-pools-overview`. Item: `azure-sql-managed-instance` → `apps/fiab-console/lib/editors/azure-sql-editors.tsx::SqlManagedInstanceEditor`.

## Overview
Azure SQL Managed Instance (`Microsoft.Sql/managedInstances`) is full SQL Server (Database Engine) PaaS with near-100% SQL Server feature parity (cross-DB queries, CLR, SQL Agent, Service Broker, native backup/restore, Resource Governor, linked servers, Database Mail). It runs in a dedicated subnet of the customer's VNet (or in an Instance Pool) on Standard-series (Gen5) or Premium-series hardware, with a General Purpose / Business Critical / Next-gen GP service tier and an SQL Server 2022 / SQL Server 2025 / Always-up-to-date update policy. Connectivity is via a VNet-local data endpoint on TCP 1433 plus an optional public endpoint on TCP 3342.

## Azure portal UI inventory

### Resource menu
- **Overview** — instance name, FQDN (`<mi>.<dns-zone>.database.windows.net`), state, location, subscription/RG, service tier + hardware + vCores + storage, update policy, AAD admin, VNet/subnet link, connection strings tile, contained databases tile, recent activity
- **Activity log**, **Access control (IAM)**, **Tags**, **Diagnose and solve problems**, **Resource health**
- **Settings**
  - **Compute + storage** — change vCores (4-80), storage in GB, hardware generation, License type (LicenseIncluded vs. BasePrice + Hybrid Benefit), zone redundancy, service tier, **Stop / Start** instance, **Update policy** (SQL 2022 / SQL 2025 / Always-up-to-date), maintenance window
  - **Active Directory admin** — set MI-scope AAD admin login + Windows Authentication for AAD principals
  - **Networking** — VNet/subnet (read-only after create), public endpoint toggle (off by default; opens on port 3342), connection type (Proxy / Redirect; public endpoint always Proxy), minimum TLS version, IPv6 dual-stack
  - **Databases** — list of databases on the MI, create new (from blank / from backup URL / from point-in-time)
  - **Failover groups** — list/create geo-replication failover groups across MIs (planned/forced failover, partner MI selection)
  - **Instance links** — Managed Instance link to SQL Server 2022+ (replication source + DR failback)
  - **Backups** — automated backup retention (7-35 days PITR + LTR weekly/monthly/yearly + W policy), restore PITR, restore from URL backup
  - **Transparent data encryption** — service-managed or customer-managed key (Key Vault)
  - **Storage Account** — for native `BACKUP TO URL` / `RESTORE FROM URL`
  - **Properties**, **Locks**
- **Security**
  - **Microsoft Defender for Cloud** — Advanced Threat Protection toggle (instance-scope), storage account for anomaly audit records, email recipients + recipient roles, notification types
  - **Identity** — system-assigned + user-assigned MI for outbound calls (AAD admin, CMK TDE, BACKUP TO URL via MSI)
  - **Auditing** — instance-scope `BlobAuditingPolicies` (storage / LA / EH sinks, action groups, retention) — also a per-database-scope policy
- **Data management** — Time zone (read-only after create), Geo-replication, Backup retention
- **Monitoring** — Metrics, Diagnostic settings, Alerts, Resource health
- **Automation** — Tasks (preview), Export template

### Top command bar
- **+ New database**, **Restore**, **Stop / Start** (cold pause), **Delete**, **Move**, **Refresh**, **Feedback**, **Open in SSMS** (deep link)

## What Loom has
- `SqlManagedInstanceEditor` — list-only. Calls `/api/items/azure-sql-managed-instance` (ARM list) and renders a table with name / state / location / SKU / FQDN. Caption: *"Managed Instance editor — list-only in v3. Query execution deferred to v3.x (TDS via dedicated PE in the MI subnet)."*

## Gaps for parity
1. **Query editor (T-SQL)** — biggest gap. Needs TDS execution against the MI data endpoint. Because MI is VNet-local, the Loom Console runtime needs a private endpoint into the MI subnet (or the MI public endpoint must be enabled + NSG-allowlisted on port 3342). Render schema browser + multi-tab editor like the Database editor.
2. **Database listing per instance** — list `managedInstances/{id}/databases` with status, collation, sku.
3. **Stop / Start** — `managedInstances/{id}/stop` + `/start` (cost-pause for Next-gen GP).
4. **Compute + storage scale** — PATCH `managedInstances/{id}` (vCores, storage, hardware family, license type, zone-redundant, service tier).
5. **Update policy** — PATCH `managedInstances/{id}` (`administratorLoginPassword`-style PATCH with `updatePolicy=SQLServer2022|SQLServer2025|AlwaysUpToDate`) + maintenance window selection.
6. **AAD admin (instance-scope)** — `managedInstances/{id}/administrators/ActiveDirectory` PUT.
7. **Networking** — public endpoint toggle (`publicDataEndpointEnabled`), `minimalTlsVersion`, NSG rule helper (warn that NSG mutation is in the network admin's RBAC scope, not the SQL admin's; this is intentional separation-of-duties per Microsoft Learn).
8. **Failover groups** — `managedInstances/{id}/failoverGroups` list / create / planned-failover / forced-failover / delete; partner MI selection from another region.
9. **Managed Instance link** — list `managedInstances/{id}/distributedAvailabilityGroups`, create/break link (replication endpoint port 5022 + 11000-11999 health probe).
10. **Backups** — short-term retention policy, LTR policy (W/M/Y), PITR restore form, restore from URL backup.
11. **TDE protector (CMK)** — `managedInstances/{id}/encryptionProtector` swap to Key Vault key URI.
12. **Defender for SQL config** — Advanced Threat Protection enablement + storage account for anomaly logs + email recipients.
13. **Auditing** — instance-scope `managedInstances/{id}/auditingSettings`.
14. **Instance pools view** — list `Microsoft.Sql/instancePools`, show which MIs belong to which pool, surface 2-vCore-in-pool option.

## Backend mapping
Control-plane: Azure ARM REST against `Microsoft.Sql/managedInstances/*` (token = MI-as-Loom against `https://management.azure.com/.default`).
Data-plane (T-SQL): TDS port 1433 to the MI VNet-local FQDN — requires Loom Console runtime to be in the MI VNet (private endpoint, peered VNet, or App Service VNet integration). If the MI exposes the public endpoint, port 3342 + NSG allow-list is the alternative. Both paths use AAD MI tokens.
Suggested new BFF routes:
- `POST /api/items/azure-sql-managed-instance/[id]/databases` — list databases on instance
- `POST /api/items/azure-sql-managed-instance/[id]/query` — TDS exec (server = MI FQDN, database = chosen)
- `POST /api/items/azure-sql-managed-instance/[id]/start` + `/stop` — cost-pause for Next-gen GP
- `POST /api/items/azure-sql-managed-instance/[id]/scale` — PATCH compute/storage/tier/update-policy
- `POST /api/items/azure-sql-managed-instance/[id]/aad-admin` — PUT AAD admin
- `POST /api/items/azure-sql-managed-instance/[id]/networking` — PATCH publicDataEndpointEnabled + minimalTlsVersion
- `POST /api/items/azure-sql-managed-instance/[id]/failover-groups` — CRUD + failover
- `POST /api/items/azure-sql-managed-instance/[id]/link` — distributedAvailabilityGroups CRUD
- `POST /api/items/azure-sql-managed-instance/[id]/backups` — STR/LTR policy + PITR restore
- `POST /api/items/azure-sql-managed-instance/[id]/tde-protector` — encryptionProtector swap
- `POST /api/items/azure-sql-managed-instance/[id]/defender` + `/auditing`

## Required Azure resources
- **Dedicated subnet** delegated to `Microsoft.Sql/managedInstances` (bicep: `platform/fiab/bicep/modules/sql/sql-mi.bicep`).
- **NSG** on the MI subnet with the auto-managed rules + (if public endpoint enabled) an inbound allow on 3342 sourced to the Loom Console egress IPs.
- **Route table** on the MI subnet (auto-managed default routes + 0.0.0.0/0 if forced-tunneling).
- **Private endpoint** from the Loom Console VNet into the MI subnet (or VNet peering) for TDS query path.
- Loom MI must hold `SQL Managed Instance Contributor` (subscription-scope or RG-scope) + `Directory Readers` (AAD admin lookup).
- For CMK TDE: KV with `Get/WrapKey/UnwrapKey` granted to the MI's system-assigned identity.
- For Defender + Auditing: storage account in the same region (already provisioned by Loom platform).
- For SQL Server 2025 vector features: instance update policy must be `SQLServer2025` or `AlwaysUpToDate` (per Microsoft Learn `vectors` doc).

## Estimated effort
4-5 sessions. List-only → full-fidelity is a large lift because the TDS path requires VNet wiring. (1) instance details view + databases list + Stop/Start + scale (control-plane only, no networking work); (2) AAD admin + networking + Defender + auditing; (3) failover groups + MI link + backups; (4) TDS query editor + schema browser (gated on Loom Console VNet integration into MI subnet — also requires a bicep change to add a private endpoint); (5) instance pools view + TDE CMK + maintenance windows.
