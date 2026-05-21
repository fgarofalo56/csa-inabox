[Home](../../README.md) > [Docs](../index.md) > [Runbooks](index.md) > **Purview Scan Failure**

# Runbook — Purview Scan Failure Diagnostics

> **Scope:** Diagnostic and recovery procedures for Microsoft Purview
> scan failures across the CSA-in-a-Box data estate — ADLS Gen2, Azure
> SQL, Synapse Analytics, Databricks, and any source registered in the
> Purview Data Map. Covers connectivity issues, permission gaps, scan
> timeouts, classification errors, and lineage gaps.

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#8-contact-information) table.
- [ ] Confirm the Purview account name(s) per environment.
- [ ] Confirm which scan rule sets are assigned to each registered source.
- [ ] Verify SHIR VM names and auto-start configuration if applicable.
- [ ] Confirm the managed identity object ID for the Purview account.

## 📑 Table of Contents

- [📋 1. Symptoms](#1-symptoms)
- [🔍 2. Triage](#2-triage)
- [🧪 3. Common Failure Causes](#3-common-failure-causes)
- [🌐 4. Connectivity Diagnostics](#4-connectivity-diagnostics)
- [🔑 5. Permission Verification](#5-permission-verification)
- [⚡ 6. Scan Optimization](#6-scan-optimization)
- [📊 7. Monitoring](#7-monitoring)
- [📎 8. Contact Information](#8-contact-information)
- [🗓️ 9. Drill Log](#9-drill-log)
- [🔗 10. Related Documentation](#10-related-documentation)

---

## 📋 1. Symptoms

| Symptom                                                          | Typical Source                                                    | Severity |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| Scan status shows `Failed` in Data Map → Sources                 | Auth failure, network timeout, or permission gap                  | P2       |
| Scan completes but reports partial results                       | Scope too narrow, permission missing on subset of containers      | P3       |
| Classification results missing or incorrect                      | Custom classification regex mismatch, scan rule set misconfigured | P3       |
| Lineage gaps (pipeline assets missing upstream/downstream links) | ADF/Synapse lineage connector not enabled                         | P3       |
| Scan timeout after extended run                                  | Too many objects in scope, SHIR resource exhaustion               | P2       |
| SHIR shows `Offline` or `Degraded` in portal                     | VM stopped, service crashed, or network connectivity lost         | P2       |
| Scan queued but never starts                                     | Concurrent scan limit reached (default 10 per account)            | P3       |

---

## 🔍 2. Triage

### Step 1: Check scan run history

- [ ] Open Purview portal → Data Map → Sources → select the source.
- [ ] Open the most recent scan run; review status, timing, and error details.
- [ ] Note the scan run ID for correlation in diagnostic logs.

### Step 2: Review scan error logs

```kql
PurviewScanStatusLogs
| where TimeGenerated > ago(24h)
| where ScanResultStatus == "Failed"
| project TimeGenerated, DataSourceName, ScanName, ScanRunId,
          ErrorMessage = tostring(ErrorDetails),
          AssetsDiscovered, AssetsClassified
| order by TimeGenerated desc
```

### Step 3: Verify connectivity

- [ ] Determine the scan's integration runtime type (Managed VNet or SHIR).
- [ ] If using private endpoints, verify DNS resolution from the IR to the source.
- [ ] If using SHIR, check node status in Purview portal → Management → Integration runtimes.

### Step 4: Check managed identity permissions

```bash
az role assignment list \
  --assignee <purview-mi-object-id> \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/<provider>/<resource>" \
  -o table
```

!!! danger
If the scan is failing in production and blocking governance
reporting deadlines, escalate immediately while continuing
diagnostics in parallel.

---

## 🧪 3. Common Failure Causes

| Error                                              | Root Cause                                          | Fix                                                        |
| -------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `Authentication failed` / `403 Forbidden`          | Purview MI not assigned required role               | Grant role (see §5); re-run scan                           |
| `Network timeout` / `Connection refused`           | Private endpoint misconfigured or firewall blocking | Verify DNS and NSG rules (see §4.2)                        |
| `SHIR offline` / `Integration runtime unavailable` | VM stopped, SHIR service crashed, or re-imaged      | Restart VM/service, re-register if needed (see §4.3)       |
| `Scan timeout` / `ScanExceededTimeLimit`           | Too many objects in scope                           | Split into smaller scopes, increase timeout (see §6.1)     |
| `Classification error` / unexpected results        | Custom classification regex incorrect               | Test regex against sample data, update rule set (see §6.4) |
| `Partial scan` — low asset count                   | Permission missing on subset of containers/schemas  | Audit per-container permissions, expand role scope         |
| `Lineage not populated`                            | ADF/Synapse lineage connector not enabled           | Enable lineage extraction in Data Map settings             |
| `Scan queued indefinitely`                         | Concurrent scan limit reached                       | Wait or cancel low-priority scans                          |

---

## 🌐 4. Connectivity Diagnostics

### 4.1 Managed VNet vs. SHIR decision tree

```
Is the data source accessible over a public endpoint?
├── Yes → Use Managed VNet IR (default). Check:
│         ├── Purview managed private endpoint approved?
│         ├── Source firewall allows Purview managed VNet?
│         └── DNS resolves to private IP from managed VNet?
└── No (on-prem or isolated VNet) → Use SHIR. Check:
          ├── SHIR VM running and service healthy?
          ├── SHIR outbound to Purview control plane (443)?
          ├── SHIR can resolve and reach data source?
          └── SHIR registered to correct Purview account?
```

### 4.2 Private endpoint DNS verification

- [ ] From the SHIR VM (or a VM in the same VNet), verify resolution:
    ```bash
    nslookup <storage-account>.blob.core.windows.net
    # Expected: resolves to 10.x.x.x (private IP)
    # Problem:  resolves to public IP or NXDOMAIN
    ```
- [ ] Check the Private DNS Zone:
    ```bash
    az network private-dns record-set list \
      --zone-name "privatelink.blob.core.windows.net" --resource-group <rg> -o table
    ```
- [ ] Verify the zone is linked to the VNet:
    ```bash
    az network private-dns link vnet list \
      --zone-name "privatelink.blob.core.windows.net" --resource-group <rg> -o table
    ```

!!! tip
Each Azure service has its own private DNS zone name. SQL uses
`privatelink.database.windows.net`, Synapse uses
`privatelink.sql.azuresynapse.net`. See the
[Azure private endpoint DNS docs](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns).

### 4.3 SHIR health check

- [ ] Verify the SHIR VM is running:
    ```bash
    az vm get-instance-view --name <shir-vm> --resource-group <rg> \
      --query '{powerState:instanceView.statuses[1].displayStatus}' -o table
    ```
- [ ] On the SHIR VM, check and restart the service:
    ```powershell
    Get-Service -Name "DIAHostService" | Select-Object Name, Status, StartType
    Restart-Service -Name "DIAHostService"
    & "C:\Program Files\Microsoft Integration Runtime\5.0\Shared\dmgcmd.exe" -Status
    ```
- [ ] Test outbound connectivity to Purview:
    ```powershell
    Test-NetConnection -ComputerName "<purview-account>.purview.azure.com" -Port 443
    ```
- [ ] If SHIR registration was lost, re-register:
    ```powershell
    & "C:\Program Files\Microsoft Integration Runtime\5.0\Shared\dmgcmd.exe" `
      -RegisterNewNode "<authentication-key>" "<node-name>"
    ```

### 4.4 Network trace for connectivity issues

- [ ] TCP connectivity test from SHIR VM:
    ```powershell
    Test-NetConnection -ComputerName "<data-source-fqdn>" -Port <port> -InformationLevel Detailed
    ```
- [ ] Check NSG flow logs for dropped traffic:
    ```kql
    AzureNetworkAnalytics_CL
    | where TimeGenerated > ago(1h)
    | where FlowStatus_s == "D"
    | where DestIP_s has "<data-source-private-ip>"
    | project TimeGenerated, SrcIP_s, DestIP_s, DestPort_d, NSGRule_s
    ```

---

## 🔑 5. Permission Verification

The Purview managed identity requires specific roles per source type.

| Source Type          | Required Role                            | Notes                                          |
| -------------------- | ---------------------------------------- | ---------------------------------------------- |
| ADLS Gen2            | `Storage Blob Data Reader`               | Must be RBAC, not ACL-only                     |
| Azure SQL Database   | `db_datareader` (database role)          | Grant via T-SQL (see below)                    |
| Synapse Analytics    | `Synapse Administrator`                  | Required for metadata + lineage                |
| Cosmos DB            | `Cosmos DB Account Reader Role`          | SQL API; other APIs may need more              |
| Databricks           | N/A (use SHIR with PAT or Unity Catalog) | MI not directly supported                      |
| SQL Managed Instance | `db_datareader`                          | Requires SHIR                                  |
| Power BI             | Tenant Admin consent                     | Purview ↔ Power BI integration must be enabled |

### Verifying ADLS permissions

```bash
az role assignment list \
  --assignee <purview-mi-object-id> \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<sa>" \
  --query "[?roleDefinitionName=='Storage Blob Data Reader']" -o table
```

### Granting and verifying SQL permissions

```sql
-- Run against the target database
CREATE USER [purview-managed-identity-name] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [purview-managed-identity-name];

-- Verify
SELECT dp.name, r.name AS role_name
FROM sys.database_principals dp
JOIN sys.database_role_members drm ON dp.principal_id = drm.member_principal_id
JOIN sys.database_principals r ON drm.role_principal_id = r.principal_id
WHERE dp.name = '<purview-managed-identity-name>';
```

---

## ⚡ 6. Scan Optimization

### 6.1 Scan scoping

Broad scans against entire storage accounts are the most common cause
of timeouts. Scope scans to specific paths or schemas.

- [ ] For ADLS, scope to specific containers or folder paths
      (e.g., `container1/bronze/`), not the full account.
- [ ] For SQL, scope to specific schemas rather than the full database.
- [ ] For very large sources, split into multiple non-overlapping scan definitions.

!!! warning
Overlapping scan scopes will cause duplicate assets in the Data Map.

### 6.2 Scan frequency recommendations

| Source Tier              | Frequency           | Rationale                                    |
| ------------------------ | ------------------- | -------------------------------------------- |
| Gold-layer (curated)     | Weekly              | Schema changes infrequent; freshness matters |
| Silver-layer (conformed) | Weekly              | Track dbt model schema evolution             |
| Bronze-layer (raw)       | Bi-weekly / monthly | High volume, low schema change rate          |
| External / third-party   | Monthly             | Scan on-demand after known schema changes    |
| Development environments | On-demand only      | Do not schedule; scan manually when testing  |

### 6.3 Resource set rules for large data lakes

Partitioned data (`year=2026/month=04/day=30/`) generates millions of
assets without resource set rules. Purview collapses these into a single
resource set asset.

- [ ] Verify resource set rules are enabled in Purview → Management.
- [ ] For custom partitioning, add a custom rule:
    ```
    Pattern: {container}/{table_name}/year={year}/month={month}/day={day}/*.parquet
    Resource set name: {container}/{table_name}
    ```
- [ ] After updating rules, trigger a full re-scan to re-classify assets.

### 6.4 Custom classification best practices

- [ ] Test regex against sample data before deploying:
    ```
    # Example: classify columns with FedRAMP control IDs
    Pattern:  (AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|RA|SA|SC|SI)-\d{1,3}(\.\d+)*
    Column pattern: (?i)(control|control_id|fedramp)
    ```
- [ ] Avoid overly broad regex — false positives erode catalog trust.
- [ ] Assign custom classifications to a dedicated scan rule set.

---

## 📊 7. Monitoring

### 7.1 Diagnostic logs

```bash
az monitor diagnostic-settings create \
  --name purview-diagnostics \
  --resource "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Purview/accounts/<account>" \
  --workspace "<log-analytics-workspace-id>" \
  --logs '[{"category":"ScanStatusLogEvent","enabled":true},{"category":"DataSensitivityLogEvent","enabled":true}]'
```

### 7.2 Scan metrics dashboard

| Metric                     | Alert Threshold                         |
| -------------------------- | --------------------------------------- |
| Scan success rate (7d)     | < 95% → P3 alert                        |
| Average scan duration      | > 2x baseline → P3 alert                |
| Assets discovered per scan | Drop > 20% from prior run → investigate |
| Failed scans (24h)         | Any → P2 alert                          |

```kql
PurviewScanStatusLogs
| where TimeGenerated > ago(7d)
| summarize total = count(),
            succeeded = countif(ScanResultStatus == "Succeeded"),
            failed = countif(ScanResultStatus == "Failed")
| extend successRate = round(100.0 * succeeded / total, 2)
```

### 7.3 Lineage completeness checks

- [ ] Spot-check that ADF/Synapse pipeline assets show lineage links in Data Map.
- [ ] Verify ADF → Purview connector status is `Connected` in ADF Studio → Manage → Purview.

---

## 📎 8. Contact Information

!!! warning
**Action Required:** Populate these before first production use.

| Role                  | Contact                                                                                        | Phone                        | Escalation                    |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------- |
| Data Governance Lead  | _(set via your org's governance team)_                                                         | _(see PagerDuty / OpsGenie)_ | Scan / classification issues  |
| Platform On-Call      | _(set via your org's on-call roster)_                                                          | _(see PagerDuty / OpsGenie)_ | SHIR / network failures       |
| Data Eng Lead         | _(set via your org's data eng DL)_                                                             | _(see PagerDuty / OpsGenie)_ | Source permission grants      |
| Security / Compliance | _(set via your org's security team)_                                                           | _(see PagerDuty / OpsGenie)_ | Classification policy changes |
| Azure Support         | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A                          | Purview platform issues       |

---

## 🗓️ 9. Drill Log

Run this runbook in tabletop form quarterly. Add one row per drill.

| Quarter  | Date  | Type (tabletop / live) | Scenario exercised | Lead  | Gaps identified | Fixes tracked |
| -------- | ----- | ---------------------- | ------------------ | ----- | --------------- | ------------- |
| Q1 — Jan | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q2 — Apr | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q3 — Jul | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q4 — Oct | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |

---

## 🔗 10. Related Documentation

- [Data Pipeline Failure](./data-pipeline-failure.md) — ADF / Synapse pipeline triage
- [Key Rotation](./key-rotation.md) — Credential rotation procedures
- [Security Incident](./security-incident.md) — Compromise response
- [Dead Letter](./dead-letter.md) — Dead-letter queue recovery
- [DR Drill](./dr-drill.md) — Region failover and data recovery
