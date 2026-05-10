# Video Script: Disaster Recovery for Azure Synapse

![Duration: 28 minutes](https://img.shields.io/badge/Duration-28%20minutes-blue)
![Level: Advanced](https://img.shields.io/badge/Level-Advanced-red)
![Version: 1.0](https://img.shields.io/badge/Version-1.0-blue)

## Video Metadata

- **Title**: Disaster Recovery Strategies for Azure Synapse Analytics
- **Duration**: 28:00
- **Target Audience**: Cloud architects, platform engineers
- **Skill Level**: Advanced
- **Prerequisites**:
  - Understanding of Azure Synapse components
  - Knowledge of Azure regions and availability zones
  - Familiarity with backup concepts
  - Azure subscription with multiple regions

## Learning Objectives

1. Design multi-region Synapse architectures
2. Implement backup and restore procedures
3. Configure geo-redundant storage
4. Set up automated failover mechanisms
5. Test disaster recovery procedures
6. Define RPO and RTO for analytics workloads

## Video Script

### Opening (0:00 - 1:30)

**NARRATOR**:
"Disasters happen. Hardware fails. Regions go down. Human errors occur. In this tutorial, you'll learn how to build resilient Azure Synapse Analytics solutions that can withstand failures and recover quickly with minimal data loss."

### Section 1: DR Fundamentals (1:30 - 6:00)

#### Understanding RPO and RTO (1:30 - 3:30)

**[VISUAL: Timeline diagram showing RPO and RTO]**

```
Disaster Event
     |
     v
[Last Backup]----RPO----|----RTO----[Service Restored]
     ^                  ^           ^
  Data Loss        Outage Begins   Recovery Complete
```

**Key Definitions**:
- **RPO (Recovery Point Objective)**: Maximum acceptable data loss
- **RTO (Recovery Time Objective)**: Maximum acceptable downtime

**Typical Requirements**:
- **Tier 1**: RPO < 1 hour, RTO < 4 hours
- **Tier 2**: RPO < 24 hours, RTO < 24 hours
- **Tier 3**: RPO < 7 days, RTO < 72 hours

#### DR Architecture Patterns (3:30 - 6:00)

```
Primary Region (East US 2)              Secondary Region (West US 2)
┌─────────────────────────┐            ┌─────────────────────────┐
│ Synapse Workspace       │            │ Synapse Workspace       │
│ ├─ SQL Pool (Active)    │◄──────────►│ ├─ SQL Pool (Standby)   │
│ ├─ Spark Pool           │ Replication│ ├─ Spark Pool           │
│ └─ Pipelines            │            │ └─ Pipelines            │
└─────────────────────────┘            └─────────────────────────┘
         │                                        │
         v                                        v
┌─────────────────────────┐            ┌─────────────────────────┐
│ Data Lake (GRS)         │◄──────────►│ Data Lake (GRS)         │
│ └─ Geo-replicated       │  Automatic │ └─ Replicated Copy      │
└─────────────────────────┘            └─────────────────────────┘
```

### Section 2: Data Lake Redundancy (6:00 - 11:00)

#### Geo-Redundant Storage (6:00 - 8:00)

```bash
# Create storage account with GRS
az storage account create \
  --name synapsedr001 \
  --resource-group synapse-dr-rg \
  --location eastus2 \
  --sku Standard_RAGRS \
  --kind StorageV2 \
  --enable-hierarchical-namespace true

# Check replication status
az storage account show \
  --name synapsedr001 \
  --query '{Name:name, Replication:sku.name, SecondaryLocation:secondaryLocation}'
```

#### Disaster Recovery Configuration (8:00 - 11:00)

```powershell
# Enable failover capability
$storageAccount = Get-AzStorageAccount `
    -ResourceGroupName "synapse-dr-rg" `
    -Name "synapsedr001"

# Initiate failover (only during actual disaster)
Invoke-AzStorageAccountFailover `
    -ResourceGroupName "synapse-dr-rg" `
    -Name "synapsedr001" `
    -Confirm:$false

# Verify failover status
Get-AzStorageAccount `
    -ResourceGroupName "synapse-dr-rg" `
    -Name "synapsedr001" |
    Select-Object PrimaryLocation, SecondaryLocation, StatusOfPrimary
```

### Section 3: Dedicated SQL Pool Backup (11:00 - 17:00)

#### Automatic Restore Points (11:00 - 13:00)

```sql
-- View available restore points
SELECT
    restore_point_time,
    restore_point_type,
    restore_point_label
FROM
    sys.pdw_loader_backup_runs
ORDER BY
    restore_point_time DESC;

-- Create user-defined restore point
EXEC sp_create_restore_point 'BeforeMajorETL';
```

#### Cross-Region Restore (13:00 - 15:00)

```powershell
# Get latest restore point
$restorePoints = Get-AzSqlDatabaseRestorePoint `
    -ResourceGroupName "synapse-primary-rg" `
    -ServerName "synapse-primary" `
    -DatabaseName "DW"

$latestRP = $restorePoints |
    Sort-Object RestorePointCreationDate -Descending |
    Select-Object -First 1

# Restore to secondary region
Restore-AzSqlDatabase `
    -FromPointInTimeBackup `
    -PointInTime $latestRP.RestorePointCreationDate `
    -ResourceGroupName "synapse-dr-rg" `
    -ServerName "synapse-dr" `
    -TargetDatabaseName "DW-DR" `
    -ResourceId $latestRP.ResourceId
```

#### Geo-Backup Configuration (15:00 - 17:00)

```sql
-- Enable geo-backup (default for Dedicated SQL Pools)
ALTER DATABASE DW
SET GEO_BACKUP_POLICY = 'ENABLED';

-- View geo-backup status
SELECT
    name,
    is_geo_backup_enabled
FROM
    sys.databases
WHERE
    name = 'DW';
```

### Section 4: Workspace Configuration Backup (17:00 - 21:00)

#### Export Workspace Artifacts (17:00 - 19:00)

```powershell
# Export all workspace artifacts
$workspace = "synapse-primary"
$exportPath = "./backup/$(Get-Date -Format 'yyyy-MM-dd')"

New-Item -ItemType Directory -Path $exportPath -Force

# Export pipelines
$pipelines = Get-AzSynapsePipeline -WorkspaceName $workspace
foreach ($pipeline in $pipelines) {
    $pipeline | ConvertTo-Json -Depth 100 |
        Out-File "$exportPath/pipeline_$($pipeline.Name).json"
}

# Export notebooks
$notebooks = Get-AzSynapseNotebook -WorkspaceName $workspace
foreach ($notebook in $notebooks) {
    $notebook | ConvertTo-Json -Depth 100 |
        Out-File "$exportPath/notebook_$($notebook.Name).json"
}

# Export linked services
$linkedServices = Get-AzSynapseLinkedService -WorkspaceName $workspace
foreach ($ls in $linkedServices) {
    $ls | ConvertTo-Json -Depth 100 |
        Out-File "$exportPath/linkedservice_$($ls.Name).json"
}
```

#### Automated Backup Script (19:00 - 21:00)

```powershell
# scheduled-backup.ps1
param(
    [string]$WorkspaceName,
    [string]$StorageAccount,
    [string]$Container = "workspace-backups"
)

$date = Get-Date -Format "yyyy-MM-dd-HHmmss"
$tempPath = "./temp-backup"
$zipPath = "./backup-$date.zip"

# Export artifacts
New-Item -ItemType Directory -Path $tempPath -Force

# ... export logic from previous example ...

# Create archive
Compress-Archive -Path $tempPath -DestinationPath $zipPath

# Upload to storage
$ctx = New-AzStorageContext -StorageAccountName $StorageAccount -UseConnectedAccount

Set-AzStorageBlobContent `
    -File $zipPath `
    -Container $Container `
    -Blob "backups/backup-$date.zip" `
    -Context $ctx

# Cleanup
Remove-Item $tempPath -Recurse -Force
Remove-Item $zipPath -Force

Write-Host "Backup completed: backup-$date.zip"
```

### Section 5: Failover Procedures (21:00 - 25:00)

#### Failover Automation (21:00 - 23:00)

```powershell
# failover.ps1
param(
    [string]$PrimaryWorkspace,
    [string]$SecondaryWorkspace,
    [string]$PrimaryRegion = "eastus2",
    [string]$SecondaryRegion = "westus2"
)

Write-Host "Initiating failover from $PrimaryRegion to $SecondaryRegion"

# 1. Pause primary SQL pool
Write-Host "Pausing primary SQL pool..."
Suspend-AzSynapseSqlPool `
    -WorkspaceName $PrimaryWorkspace `
    -Name "DW"

# 2. Failover storage account
Write-Host "Initiating storage failover..."
Invoke-AzStorageAccountFailover `
    -ResourceGroupName "synapse-primary-rg" `
    -Name "synapseprimary001"

# 3. Update DNS/Traffic Manager
Write-Host "Updating Traffic Manager..."
$endpoint = Get-AzTrafficManagerEndpoint `
    -ResourceGroupName "synapse-rg" `
    -ProfileName "synapse-tm" `
    -Name "secondary-endpoint" `
    -Type AzureEndpoints

$endpoint.EndpointStatus = "Enabled"
Set-AzTrafficManagerEndpoint -TrafficManagerEndpoint $endpoint

# 4. Resume secondary SQL pool
Write-Host "Resuming secondary SQL pool..."
Resume-AzSynapseSqlPool `
    -WorkspaceName $SecondaryWorkspace `
    -Name "DW"

# 5. Validate
Write-Host "Validating failover..."
$health = Test-SynapseHealth -Workspace $SecondaryWorkspace

if ($health.Status -eq "Healthy") {
    Write-Host "Failover completed successfully!" -ForegroundColor Green
} else {
    Write-Host "Failover validation failed!" -ForegroundColor Red
    Write-Host $health.Details
}
```

#### Failback Procedures (23:00 - 25:00)

```powershell
# failback.ps1
param(
    [string]$PrimaryWorkspace,
    [string]$SecondaryWorkspace
)

Write-Host "Initiating failback to primary region"

# 1. Sync data from secondary to primary
Write-Host "Syncing data..."
& azcopy sync `
    "https://synapsesecondary.dfs.core.windows.net/" `
    "https://synapseprimary.dfs.core.windows.net/" `
    --recursive

# 2. Restore SQL pool from latest geo-backup
Write-Host "Restoring primary SQL pool..."
Restore-AzSqlDatabase `
    -FromGeoBackup `
    -ResourceGroupName "synapse-primary-rg" `
    -ServerName "synapse-primary" `
    -TargetDatabaseName "DW" `
    -ResourceId $geoBackup.ResourceId

# 3. Switch traffic back
Write-Host "Switching traffic to primary..."
# Update Traffic Manager or DNS

# 4. Pause secondary
Write-Host "Pausing secondary SQL pool..."
Suspend-AzSynapseSqlPool `
    -WorkspaceName $SecondaryWorkspace `
    -Name "DW"

Write-Host "Failback completed!"
```

### Section 6: Testing DR (25:00 - 27:00)

#### DR Test Checklist (25:00 - 26:00)

```markdown
## DR Test Procedure

### Pre-Test
- [ ] Notify stakeholders
- [ ] Document current state
- [ ] Verify backup completeness
- [ ] Prepare rollback plan

### Test Execution
- [ ] Initiate failover
- [ ] Validate data accessibility
- [ ] Test application connectivity
- [ ] Verify data consistency
- [ ] Measure RTO actual vs target

### Post-Test
- [ ] Perform failback
- [ ] Document lessons learned
- [ ] Update DR procedures
- [ ] Schedule next test
```

#### Automated DR Testing (26:00 - 27:00)

```powershell
# dr-test.ps1
Write-Host "Starting DR Test..."

$startTime = Get-Date

# Clone secondary to test environment
$testWorkspace = New-AzSynapseWorkspace `
    -ResourceGroupName "synapse-test-rg" `
    -Name "synapse-dr-test" `
    -Location "westus2" `
    -DefaultDataLakeStorageAccountName "testdatalake" `
    -DefaultDataLakeStorageFilesystem "test"

# Measure RTO
$rto = (Get-Date) - $startTime
Write-Host "RTO: $($rto.TotalMinutes) minutes"

# Cleanup
Remove-AzSynapseWorkspace -Name "synapse-dr-test" -Force
```

### Conclusion (27:00 - 28:00)

**Best Practices**:
1. Test DR procedures regularly (quarterly minimum)
2. Document all procedures
3. Automate failover where possible
4. Monitor replication lag
5. Keep RTO/RPO requirements updated

## Related Resources

- [Advanced Features](advanced-features.md)
- [CI/CD Pipelines](ci-cd-pipelines.md)
- [Monitoring Dashboards](monitoring-dashboards.md)

---

*Last Updated: January 2025*
