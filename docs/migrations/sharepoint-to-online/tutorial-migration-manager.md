# Tutorial: Migration Manager at Scale

**Status:** Authored 2026-04-30
**Audience:** M365 administrators and migration leads managing large-scale SharePoint on-premises to SharePoint Online migrations using Migration Manager in the Microsoft 365 admin center.
**Scope:** Agent installation, centralized scanning, bulk migration scheduling, monitoring dashboard, and at-scale operations.

---

## Prerequisites

Before starting this tutorial, ensure:

- [ ] Microsoft 365 tenant with SharePoint Online provisioned
- [ ] Global Administrator or SharePoint Administrator role
- [ ] One or more Windows servers/workstations for Migration Manager agents
- [ ] Network connectivity from agent machines to source SharePoint farms and SPO
- [ ] Entra Connect configured and syncing users
- [ ] Agent machines: Windows Server 2016+ or Windows 10/11, 8 GB RAM, 50 GB free disk

---

## Step 1: Access Migration Manager

### 1.1 Navigate to Migration Manager

1. Open the **Microsoft 365 admin center**: [https://admin.microsoft.com](https://admin.microsoft.com)
2. In the left navigation, expand **Settings** and click **Migration**
3. Or navigate directly to the **SharePoint admin center** > **Migration**
4. Select **SharePoint Server** as the migration source

### 1.2 Migration Manager vs SPMT

| Feature     | SPMT                    | Migration Manager             |
| ----------- | ----------------------- | ----------------------------- |
| Interface   | Desktop application     | M365 admin center (web)       |
| Agent model | Single workstation      | Multi-agent distributed       |
| Monitoring  | Local logs              | Centralized dashboard         |
| Scheduling  | Manual/scripted         | Built-in calendar             |
| Scanning    | Basic pre-scan          | Centralized scan with reports |
| Scale       | Small-to-medium         | Enterprise-scale              |
| PowerShell  | Full PowerShell support | Limited PowerShell            |
| Cost        | Free                    | Free                          |

---

## Step 2: Install Migration Manager agents

### 2.1 Download and install agents

1. In Migration Manager, click **Set up agents**
2. Click **Download agent setup file** to get the installer
3. Run the installer on each agent machine

```powershell
# Download the agent installer
# The download link is provided in the Migration Manager UI

# Install silently (optional)
.\MigrationAgentSetup.exe /quiet /norestart

# The agent registers with your M365 tenant during installation
# You will be prompted to sign in with admin credentials
```

### 2.2 Agent placement strategy

| Environment size      | Recommended agents | Placement                              |
| --------------------- | ------------------ | -------------------------------------- |
| < 10 TB total content | 1-2 agents         | Single server near source farm         |
| 10-50 TB              | 3-5 agents         | Distributed across network segments    |
| 50-200 TB             | 5-10 agents        | Co-located with source WFE/App servers |
| > 200 TB              | 10-20 agents       | Dedicated migration VMs                |

### 2.3 Agent requirements per machine

- Windows Server 2016/2019/2022 or Windows 10/11
- 8 GB RAM minimum (16 GB recommended for heavy loads)
- 50 GB free disk space for temporary staging
- .NET Framework 4.6.2+
- Network: outbound HTTPS to _.sharepoint.com, _.microsoftonline.com, \*.blob.core.windows.net
- Network: access to source SharePoint farm (HTTP/HTTPS)

### 2.4 Verify agent status

After installation, agents appear in the Migration Manager dashboard:

1. Navigate to **Migration Manager** > **Agents**
2. Verify each agent shows **Available** status
3. Check agent version is current
4. Monitor agent health (CPU, memory, network utilization)

```powershell
# Check agent service status on the agent machine
Get-Service -Name "SharePoint Migration Agent" | Select-Object Status, StartType
```

---

## Step 3: Scan source environment

### 3.1 Add source sites for scanning

1. In Migration Manager, click **Add source**
2. Enter the root URL of your SharePoint farm: `https://sp2016.contoso.com`
3. Provide credentials (farm administrator or site collection administrator)
4. Migration Manager discovers all site collections under the root

### 3.2 Bulk add sources via CSV

For large environments with multiple farms or web applications:

```csv
SourcePath,TargetPath,TargetList,TargetListRelativePath
https://sp2016.contoso.com/sites/finance,https://contoso.sharepoint.com/sites/finance,,
https://sp2016.contoso.com/sites/hr,https://contoso.sharepoint.com/sites/hr,,
https://sp2016.contoso.com/sites/legal,https://contoso.sharepoint.com/sites/legal,,
https://sp2016.contoso.com/sites/marketing,https://contoso.sharepoint.com/sites/marketing,,
https://sp2016.contoso.com/sites/engineering,https://contoso.sharepoint.com/sites/engineering,,
https://sp2013.contoso.com/sites/archive,https://contoso.sharepoint.com/sites/archive,,
https://sp2013.contoso.com/sites/projects,https://contoso.sharepoint.com/sites/projects,,
```

1. Click **Bulk upload** in Migration Manager
2. Upload the CSV file
3. Migration Manager validates each source/target pair
4. Invalid entries are flagged for correction

### 3.3 Run assessment scan

1. Select all source sites in the list
2. Click **Scan** to start assessment
3. Migration Manager agents scan each site and report:
    - Total size (with and without versions)
    - File count
    - List count
    - Blocked items (unsupported file types, path too long)
    - Warnings (checked-out files, InfoPath forms, workflows)

### 3.4 Review scan results

The scan dashboard shows:

| Metric                 | Description                                        |
| ---------------------- | -------------------------------------------------- |
| **Total content size** | Sum of all sites being migrated                    |
| **Ready to migrate**   | Sites with no blockers                             |
| **Needs attention**    | Sites with warnings (can migrate with limitations) |
| **Blocked**            | Sites with critical issues that must be resolved   |
| **Items scanned**      | Total files and list items assessed                |
| **Issues found**       | Count of warnings and blockers                     |

Export scan results for detailed analysis:

1. Click **Download report** to get CSV export
2. Review blocked items and determine remediation plan
3. Sort by size to plan wave order

---

## Step 4: Configure migration settings

### 4.1 Global settings

In Migration Manager, configure settings that apply to all migration tasks:

1. Navigate to **Settings** in Migration Manager
2. Configure:

| Setting                             | Recommended value | Notes                                                |
| ----------------------------------- | ----------------- | ---------------------------------------------------- |
| **Preserve file share permissions** | On                | Preserves NTFS permissions for file share migrations |
| **Preserve SharePoint permissions** | On                | Preserves site/list/item permissions                 |
| **Migrate file version history**    | On                | Enable version migration                             |
| **Number of versions**              | 10                | Balance between history and migration speed          |
| **Azure Active Directory lookup**   | On                | Map on-prem users to Entra ID                        |
| **User mapping file**               | Upload CSV        | For accounts that cannot be auto-mapped              |
| **Migrate hidden files**            | On                | Include hidden files and folders                     |
| **Skip files older than**           | Optional          | Filter by date if desired                            |
| **Migrate OneNote notebooks**       | On                | Include OneNote content                              |

### 4.2 Performance tuning

```powershell
# Migration Manager automatically balances load across agents
# To optimize throughput:

# 1. Run migrations during off-hours to avoid SPO throttling
# 2. Deploy agents close to the source (same network segment)
# 3. Ensure sufficient bandwidth (100 Mbps+ per agent recommended)
# 4. Reduce version count if speed is critical
# 5. Exclude large media files that can be migrated separately
```

---

## Step 5: Schedule and execute migration

### 5.1 Create migration batches

Group sites into migration batches based on:

- **Wave 1:** Pilot sites (3-5 small, low-risk sites)
- **Wave 2:** Standard team sites (simple content, no customizations)
- **Wave 3:** Sites with managed metadata and content types
- **Wave 4:** Publishing sites and intranet
- **Wave 5:** Complex sites (workflows, InfoPath, custom solutions)

### 5.2 Schedule migrations

1. Select sites for a batch in Migration Manager
2. Click **Schedule migration**
3. Choose start time (recommend off-hours: weeknights or weekends)
4. Set migration window (e.g., Friday 6 PM to Monday 6 AM)
5. Enable incremental migration for subsequent runs

### 5.3 Execute migration

1. Click **Start migration** for the selected batch
2. Migration Manager distributes tasks across available agents
3. Each agent processes assigned sites concurrently
4. Progress is updated in real-time on the dashboard

### 5.4 Monitor during migration

The Migration Manager dashboard provides real-time monitoring:

| Dashboard element        | Description                                |
| ------------------------ | ------------------------------------------ |
| **Active migrations**    | Currently running migration tasks          |
| **Items migrated**       | Count of files and list items transferred  |
| **Items failed**         | Count of items that failed to migrate      |
| **Throughput**           | Current migration speed (GB/hour)          |
| **Agent utilization**    | CPU/memory/network usage per agent         |
| **Estimated completion** | Time remaining based on current throughput |
| **Error summary**        | Top errors with counts                     |

---

## Step 6: Review results and remediate

### 6.1 Post-migration reports

After each batch completes:

1. Click **View report** for the completed batch
2. Review summary: items migrated, failed, skipped
3. Download detailed report CSV for analysis

### 6.2 Error triage

| Error category                                | Action                                    | Priority |
| --------------------------------------------- | ----------------------------------------- | -------- |
| **Blocker** (file too large, path too long)   | Remediate source, re-run                  | High     |
| **Permission error** (user not found)         | Update user mapping, re-run               | High     |
| **Content type error** (missing content type) | Create content type in target, re-run     | Medium   |
| **Warning** (workflow not migrated)           | Expected; plan Power Automate replacement | Low      |
| **Throttled** (429 Too Many Requests)         | Wait and re-run; reduce concurrent tasks  | Medium   |

### 6.3 Incremental re-run

```
1. In Migration Manager, select the completed batch
2. Click "Run incremental migration"
3. Only changed and previously failed items are processed
4. Review updated results
5. Repeat until all items are migrated successfully
```

---

## Step 7: At-scale operations

### 7.1 Managing 1,000+ sites

For enterprise-scale migrations with thousands of sites:

1. **Automated source discovery:**

    ```powershell
    # Generate source list from on-premises farm
    Add-PSSnapin Microsoft.SharePoint.PowerShell

    Get-SPSite -Limit All | ForEach-Object {
        [PSCustomObject]@{
            SourcePath = $_.Url
            TargetPath = $_.Url -replace "https://sp2016.contoso.com",
                                         "https://contoso.sharepoint.com"
        }
    } | Export-Csv -Path "C:\Migration\bulk-sources.csv" -NoTypeInformation
    ```

2. **Wave planning by size:**

    ```powershell
    # Sort sites into waves by size
    $sites = Import-Csv "C:\Migration\site-inventory.csv"

    $wave1 = $sites | Where-Object { [int]$_.StorageMB -lt 1024 }   # < 1 GB
    $wave2 = $sites | Where-Object { [int]$_.StorageMB -ge 1024 -and [int]$_.StorageMB -lt 10240 }  # 1-10 GB
    $wave3 = $sites | Where-Object { [int]$_.StorageMB -ge 10240 -and [int]$_.StorageMB -lt 102400 } # 10-100 GB
    $wave4 = $sites | Where-Object { [int]$_.StorageMB -ge 102400 } # > 100 GB

    Write-Host "Wave 1 (< 1 GB): $($wave1.Count) sites"
    Write-Host "Wave 2 (1-10 GB): $($wave2.Count) sites"
    Write-Host "Wave 3 (10-100 GB): $($wave3.Count) sites"
    Write-Host "Wave 4 (> 100 GB): $($wave4.Count) sites"
    ```

3. **Parallel execution:** Migration Manager automatically distributes work across agents. Add more agents to increase throughput.

### 7.2 Multi-farm migration

For organizations with multiple SharePoint farms (common in large enterprises and government):

1. Deploy agents near each farm's network segment
2. Add each farm as a separate source in Migration Manager
3. Create per-farm migration batches
4. Schedule to avoid cross-farm network contention

### 7.3 Monitoring dashboard best practices

- Check the dashboard every 2-4 hours during active migration
- Set up email alerts for failed tasks (configured in Migration Manager settings)
- Export daily reports for stakeholder communication
- Track cumulative progress against the migration plan

---

## Step 8: Decommission agents

After migration is complete:

1. Verify all migration tasks show **Completed** status
2. Run a final incremental migration to capture any last changes
3. Validate content in SPO
4. Uninstall Migration Manager agents from agent machines:

```powershell
# Uninstall agent
# Use Programs and Features or:
.\MigrationAgentSetup.exe /uninstall /quiet
```

5. Remove agent registrations from Migration Manager dashboard
6. Set source SharePoint sites to read-only
7. Document final migration metrics for the project record

---

## Migration Manager limits and quotas

| Limit                              | Value          | Notes                               |
| ---------------------------------- | -------------- | ----------------------------------- |
| Maximum agents per tenant          | 50             | Contact Microsoft for higher limits |
| Maximum concurrent tasks per agent | 3              | Automatically managed               |
| Maximum file size                  | 250 GB         | SPO limit                           |
| Maximum path length                | 400 characters | SPO limit                           |
| Throttling threshold               | Varies         | SPO applies adaptive throttling     |
| Maximum items per list             | 30 million     | SPO limit                           |

---

## References

- [Migration Manager documentation](https://learn.microsoft.com/sharepointmigration/mm-get-started)
- [Migration Manager agent setup](https://learn.microsoft.com/sharepointmigration/mm-setup-clients)
- [Migration Manager FAQ](https://learn.microsoft.com/sharepointmigration/mm-faqs)
- [Migration Manager performance](https://learn.microsoft.com/sharepointmigration/mm-performance-guidance)
- [Bulk upload sources](https://learn.microsoft.com/sharepointmigration/mm-bulk-upload-format-csv-json)
- [SharePoint Online throttling](https://learn.microsoft.com/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
