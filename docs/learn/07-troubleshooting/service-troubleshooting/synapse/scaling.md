# Azure Synapse Scaling Troubleshooting

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow)

Comprehensive guide for troubleshooting scaling issues, resource contention, and cost management in Azure Synapse Analytics.

## Table of Contents

- [Overview](#overview)
- [Common Scaling Issues](#common-scaling-issues)
- [Resource Limits and Quotas](#resource-limits-and-quotas)
- [Scaling Operations](#scaling-operations)
- [Resource Contention](#resource-contention)
- [Cost Management](#cost-management)
- [Resolution Procedures](#resolution-procedures)

---

## Overview

Scaling issues in Azure Synapse can manifest as failed scaling operations, resource contention, unexpected costs, or performance degradation. This guide provides systematic troubleshooting for all scaling-related problems.

> **💡 Tip:** Understanding your workload patterns is key to efficient scaling. Monitor resource utilization before making scaling decisions.

---

## Common Scaling Issues

### Issue 1: Failed Scaling Operation

**Symptoms:**
- Scaling operation fails to complete
- Pool stuck in "Scaling" state
- Error messages during scale up/down

**Error Messages:**
```text
Error 40613: Database or pool is currently unavailable for scaling
Error 40020: Resource limit has been reached
Error 40501: The service is currently busy
```

**Step-by-Step Resolution:**

#### 1. Check Current Scaling Status

```bash
# Azure CLI: Check pool status
az synapse sql pool show \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --query "{Name:name, Status:status, CurrentDWU:sku.capacity, ProvisioningState:provisioningState}"
```

**PowerShell:**
```powershell
Get-AzSynapseSqlPool `
    -WorkspaceName <workspace-name> `
    -Name <pool-name> `
    -ResourceGroupName <rg-name> |
    Select-Object Name, Status, Sku, ProvisioningState
```

**Expected Status:**
- `Online` - Pool is ready
- `Paused` - Pool is paused (can't scale)
- `Scaling` - Scaling in progress
- `Resuming` - Pool starting up

#### 2. Verify No Active Operations

```sql
-- Check for active queries
SELECT
    request_id,
    session_id,
    status,
    command,
    total_elapsed_time/1000 AS elapsed_seconds,
    start_time
FROM sys.dm_pdw_exec_requests
WHERE status IN ('Running', 'Suspended')
ORDER BY start_time;

-- Check for long-running transactions
SELECT
    transaction_id,
    name,
    transaction_begin_time,
    DATEDIFF(SECOND, transaction_begin_time, GETDATE()) AS duration_seconds
FROM sys.dm_pdw_transactions
WHERE state = 'Active'
ORDER BY transaction_begin_time;
```

> **⚠️ Warning:** Scaling can fail if there are active transactions. Complete or rollback transactions before scaling.

#### 3. Cancel Stuck Scaling Operation

```bash
# If pool stuck in "Scaling" state for >30 minutes
# Pause the pool first
az synapse sql pool pause \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name>

# Wait for pause to complete
az synapse sql pool show \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --query "status"

# Resume with target scale
az synapse sql pool resume \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name>

# Then scale
az synapse sql pool update \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --performance-level DW500c
```

---

### Issue 2: Resource Limit Reached

**Error Message:**
```text
Error 40613: Database or pool 'poolname' is currently busy with another operation.
Error 40020: The resource limit for the subscription has been reached.
```

**Diagnostic Queries:**

```sql
-- Check current resource utilization
SELECT
    GETDATE() AS check_time,
    COUNT(*) AS active_sessions,
    SUM(CASE WHEN r.status = 'Running' THEN 1 ELSE 0 END) AS running_queries,
    SUM(CASE WHEN r.status = 'Suspended' THEN 1 ELSE 0 END) AS queued_queries
FROM sys.dm_pdw_exec_sessions s
LEFT JOIN sys.dm_pdw_exec_requests r ON s.session_id = r.session_id
WHERE s.is_user_process = 1;

-- Check concurrency slots usage
SELECT
    r.session_id,
    r.command,
    r.resource_class,
    r.importance,
    rc.concurrency_slots_used,
    rc.resource_allocation_percentage
FROM sys.dm_pdw_exec_requests r
INNER JOIN sys.dm_pdw_resource_waits rc ON r.request_id = rc.request_id
WHERE r.status IN ('Running', 'Suspended')
ORDER BY rc.concurrency_slots_used DESC;
```

**Resolution:**

#### Check Subscription Quotas

```bash
# Check current quota usage
az vm list-usage \
    --location <region> \
    --output table | grep -i synapse

# Request quota increase if needed
# File support request in Azure Portal:
# Support + troubleshooting > New support request > Service limits (quotas)
```

#### Optimize Concurrency

```sql
-- Reduce concurrency slot usage by adjusting resource classes
-- Move users to smaller resource classes if appropriate
EXEC sp_droprolemember 'largerc', 'user@domain.com';
EXEC sp_addrolemember 'mediumrc', 'user@domain.com';

-- Check available concurrency slots
SELECT
    MAX(concurrency_slots) AS max_concurrency_slots,
    SUM(CASE WHEN r.status = 'Running' THEN rc.concurrency_slots_used ELSE 0 END) AS used_slots,
    MAX(concurrency_slots) -
    SUM(CASE WHEN r.status = 'Running' THEN rc.concurrency_slots_used ELSE 0 END) AS available_slots
FROM sys.dm_pdw_resource_waits rc
CROSS JOIN (SELECT MAX(effective_request_max_concurrency_slots) AS concurrency_slots
            FROM sys.dm_pdw_resource_waits) AS max_slots
LEFT JOIN sys.dm_pdw_exec_requests r ON rc.request_id = r.request_id;
```

---

## Resource Limits and Quotas

### Understanding DWU Limits

| Service Level | Gen2 Capacity | Compute Nodes | Concurrency Queries |
|:--------------|:-------------:|:-------------:|:-------------------:|
| DW100c | 100 | 1 | 4 |
| DW200c | 200 | 1 | 8 |
| DW500c | 500 | 1 | 20 |
| DW1000c | 1000 | 2 | 32 |
| DW2000c | 2000 | 4 | 48 |
| DW3000c | 3000 | 6 | 64 |
| DW5000c | 5000 | 10 | 128 |
| DW6000c | 6000 | 12 | 128 |
| DW10000c | 10000 | 20 | 128 |
| DW30000c | 30000 | 60 | 128 |

### Check Current Limits

```sql
-- Get current DWU and limits
SELECT
    DATABASEPROPERTYEX(DB_NAME(), 'ServiceObjective') AS current_dwu,
    DATABASEPROPERTYEX(DB_NAME(), 'Edition') AS edition;

-- Check effective concurrency limits
SELECT
    effective_request_max_concurrency_slots AS max_concurrency_slots,
    effective_request_min_resource_grant_percent AS min_resource_grant_pct,
    effective_request_max_resource_grant_percent AS max_resource_grant_pct
FROM sys.dm_pdw_resource_waits
WHERE state = 'Granted'
ORDER BY request_time DESC;
```

### Subscription Quotas

```bash
# Check regional quotas
az synapse workspace list \
    --resource-group <rg-name> \
    --output table

# View service limits
az synapse sql pool list \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --output table
```

**Common Limits:**
- Max DW30000c per subscription per region (requestable increase)
- Max 128 concurrent queries at DW3000c and above
- Max database size varies by service level

---

## Scaling Operations

### Manual Scaling

#### Scale Up (Increase Performance)

```bash
# Azure CLI
az synapse sql pool update \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --performance-level DW1000c

# Monitor scaling progress
az synapse sql pool show \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --query "{Status:status, DWU:sku.capacity}"
```

**PowerShell:**
```powershell
# Scale up
Update-AzSynapseSqlPool `
    -WorkspaceName <workspace-name> `
    -Name <pool-name> `
    -ResourceGroupName <rg-name> `
    -PerformanceLevel DW1000c

# Check status
Get-AzSynapseSqlPool `
    -WorkspaceName <workspace-name> `
    -Name <pool-name> `
    -ResourceGroupName <rg-name> |
    Select-Object Status, Sku
```

**T-SQL:**
```sql
-- Scale using ALTER DATABASE (Gen2 only)
ALTER DATABASE <database-name>
MODIFY (SERVICE_OBJECTIVE = 'DW1000c');
```

#### Scale Down (Reduce Costs)

```bash
# Ensure no active queries before scaling down
# Then scale
az synapse sql pool update \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --performance-level DW500c
```

> **💡 Cost Saving Tip:** Pause pools when not in use. You only pay for storage while paused.

---

### Automated Scaling

#### Using Azure Automation

**PowerShell Runbook:**
```powershell
# Scale-SynapseSQLPool.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory=$true)]
    [string]$WorkspaceName,

    [Parameter(Mandatory=$true)]
    [string]$PoolName,

    [Parameter(Mandatory=$true)]
    [ValidateSet('DW100c','DW200c','DW500c','DW1000c','DW2000c','DW3000c')]
    [string]$TargetDWU
)

# Connect using managed identity
Connect-AzAccount -Identity

# Get current status
$pool = Get-AzSynapseSqlPool `
    -ResourceGroupName $ResourceGroupName `
    -WorkspaceName $WorkspaceName `
    -Name $PoolName

Write-Output "Current DWU: $($pool.Sku.Capacity)"
Write-Output "Current Status: $($pool.Status)"

# Only scale if online
if ($pool.Status -eq 'Online') {
    Write-Output "Scaling to $TargetDWU..."

    Update-AzSynapseSqlPool `
        -ResourceGroupName $ResourceGroupName `
        -WorkspaceName $WorkspaceName `
        -Name $PoolName `
        -PerformanceLevel $TargetDWU

    Write-Output "Scaling operation initiated."
}
else {
    Write-Warning "Pool is not online. Current status: $($pool.Status)"
}
```

#### Using Logic Apps

**Schedule-Based Scaling:**

```json
{
    "definition": {
        "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
        "actions": {
            "Scale_Up_Morning": {
                "type": "Http",
                "inputs": {
                    "method": "PATCH",
                    "uri": "https://management.azure.com/subscriptions/{subscription-id}/resourceGroups/{rg-name}/providers/Microsoft.Synapse/workspaces/{workspace-name}/sqlPools/{pool-name}?api-version=2021-06-01",
                    "body": {
                        "sku": {
                            "name": "DW1000c"
                        }
                    },
                    "authentication": {
                        "type": "ManagedServiceIdentity"
                    }
                }
            }
        },
        "triggers": {
            "Recurrence": {
                "type": "Recurrence",
                "recurrence": {
                    "frequency": "Day",
                    "interval": 1,
                    "schedule": {
                        "hours": ["8"],
                        "minutes": [0]
                    },
                    "timeZone": "Eastern Standard Time"
                }
            }
        }
    }
}
```

---

## Resource Contention

### Identify Contention

```sql
-- Check query queue
SELECT
    r.request_id,
    r.session_id,
    r.status,
    r.submit_time,
    r.start_time,
    DATEDIFF(SECOND, r.submit_time, COALESCE(r.start_time, GETDATE())) AS queue_time_seconds,
    r.command,
    r.resource_class,
    rw.concurrency_slots_used,
    rw.state AS resource_wait_state
FROM sys.dm_pdw_exec_requests r
LEFT JOIN sys.dm_pdw_resource_waits rw ON r.request_id = rw.request_id
WHERE r.status IN ('Running', 'Suspended')
ORDER BY r.submit_time;

-- Check blocking
SELECT
    lw.request_id,
    lw.session_id,
    lw.type AS lock_type,
    lw.state AS lock_state,
    lw.object_name,
    r.command,
    r.resource_class
FROM sys.dm_pdw_lock_waits lw
INNER JOIN sys.dm_pdw_exec_requests r ON lw.request_id = r.request_id
ORDER BY lw.request_time;
```

### Resolution Strategies

#### 1. Optimize Resource Classes

```sql
-- Check current assignments
SELECT
    s.login_name,
    r.resource_class,
    COUNT(*) AS query_count,
    AVG(r.total_elapsed_time/1000) AS avg_elapsed_seconds
FROM sys.dm_pdw_exec_sessions s
LEFT JOIN sys.dm_pdw_exec_requests r ON s.session_id = r.session_id
WHERE s.is_user_process = 1
    AND r.start_time >= DATEADD(HOUR, -1, GETDATE())
GROUP BY s.login_name, r.resource_class
ORDER BY query_count DESC;

-- Assign appropriate resource class
-- Small queries: smallrc (3% memory)
EXEC sp_addrolemember 'smallrc', 'reporting_user@domain.com';

-- Medium queries: mediumrc (12% memory)
EXEC sp_addrolemember 'mediumrc', 'analytics_user@domain.com';

-- Large queries: largerc (22% memory)
EXEC sp_addrolemember 'largerc', 'etl_user@domain.com';

-- Extra large queries: xlargerc (70% memory)
EXEC sp_addrolemember 'xlargerc', 'admin_user@domain.com';
```

#### 2. Use Workload Importance

```sql
-- Create workload classifiers for prioritization
CREATE WORKLOAD CLASSIFIER [wgc_high_priority]
WITH (
    WORKLOAD_GROUP = 'largerc',
    MEMBERNAME = 'etl_service_account',
    IMPORTANCE = HIGH
);

CREATE WORKLOAD CLASSIFIER [wgc_low_priority]
WITH (
    WORKLOAD_GROUP = 'smallrc',
    MEMBERNAME = 'reporting_users',
    IMPORTANCE = LOW
);

-- Check classifier effectiveness
SELECT
    r.request_id,
    r.command,
    r.importance,
    r.resource_class,
    r.total_elapsed_time/1000 AS elapsed_seconds
FROM sys.dm_pdw_exec_requests r
WHERE r.start_time >= DATEADD(HOUR, -1, GETDATE())
ORDER BY r.importance DESC, r.submit_time;
```

---

## Cost Management

### Monitor Costs

```bash
# Check current consumption
az consumption usage list \
    --start-date 2025-12-01 \
    --end-date 2025-12-09 \
    --query "[?contains(instanceName, 'synapse')]" \
    --output table

# Get cost details
az synapse sql pool show \
    --name <pool-name> \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --query "{Name:name, DWU:sku.capacity, Status:status}"
```

### Cost Optimization Strategies

#### 1. Implement Pause/Resume Schedule

```powershell
# Pause during off-hours
$params = @{
    WorkspaceName = '<workspace-name>'
    Name = '<pool-name>'
    ResourceGroupName = '<rg-name>'
}

# Pause
Suspend-AzSynapseSqlPool @params

# Resume
Resume-AzSynapseSqlPool @params
```

**Automated Schedule (Azure Automation):**
```powershell
# Runbook: Pause-Synapse-OffHours.ps1
Connect-AzAccount -Identity

$pools = @(
    @{RG='rg-name'; Workspace='workspace-name'; Pool='pool-name'}
)

foreach ($pool in $pools) {
    $current = Get-AzSynapseSqlPool `
        -ResourceGroupName $pool.RG `
        -WorkspaceName $pool.Workspace `
        -Name $pool.Pool

    if ($current.Status -eq 'Online') {
        Write-Output "Pausing $($pool.Pool)..."
        Suspend-AzSynapseSqlPool `
            -ResourceGroupName $pool.RG `
            -WorkspaceName $pool.Workspace `
            -Name $pool.Pool
    }
}
```

#### 2. Right-Size Your DWU

**Analyze Usage Patterns:**
```sql
-- Historical query patterns
SELECT
    DATEPART(HOUR, start_time) AS hour_of_day,
    COUNT(*) AS query_count,
    AVG(total_elapsed_time/1000) AS avg_elapsed_seconds,
    MAX(total_elapsed_time/1000) AS max_elapsed_seconds
FROM sys.dm_pdw_exec_requests
WHERE start_time >= DATEADD(DAY, -7, GETDATE())
    AND status = 'Completed'
GROUP BY DATEPART(HOUR, start_time)
ORDER BY hour_of_day;

-- Resource utilization
SELECT
    CAST(end_time AS DATE) AS date,
    AVG(cpu_percent) AS avg_cpu,
    MAX(cpu_percent) AS max_cpu,
    AVG(data_io_percent) AS avg_io,
    MAX(data_io_percent) AS max_io
FROM sys.dm_pdw_nodes_resource_stats
WHERE end_time >= DATEADD(DAY, -7, GETDATE())
GROUP BY CAST(end_time AS DATE)
ORDER BY date;
```

**Recommendation Logic:**
| Avg CPU | Avg I/O | Recommendation |
|:--------|:--------|:--------------|
| < 30% | < 30% | **Scale Down** - Over-provisioned |
| 30-70% | 30-70% | **Optimal** - Right-sized |
| > 70% | > 70% | **Scale Up** - Under-provisioned |

#### 3. Use Spot/Paused State for Development

```bash
# Keep dev/test pools paused when not in use
az synapse sql pool pause \
    --name dev-pool \
    --workspace-name <workspace-name> \
    --resource-group <rg-name>

# Only pay for storage (~$23/TB/month instead of compute)
```

---

## Resolution Procedures

### Procedure 1: Emergency Scale Up

**When to Use:** Production performance degradation

**Steps:**

1. **Verify Current State:**
   ```bash
   az synapse sql pool show \
       --name <pool-name> \
       --workspace-name <workspace-name> \
       --resource-group <rg-name>
   ```

2. **Check Active Queries:**
   ```sql
   SELECT COUNT(*) FROM sys.dm_pdw_exec_requests WHERE status = 'Running';
   ```

3. **Scale Up:**
   ```bash
   az synapse sql pool update \
       --name <pool-name> \
       --workspace-name <workspace-name> \
       --resource-group <rg-name> \
       --performance-level DW2000c  # 2x current if DW1000c
   ```

4. **Monitor:**
   ```bash
   # Wait for scaling to complete (typically 5-10 minutes)
   watch -n 30 "az synapse sql pool show --name <pool-name> --workspace-name <workspace-name> --resource-group <rg-name> --query 'status'"
   ```

5. **Verify Performance:**
   ```sql
   SELECT
       AVG(total_elapsed_time/1000) AS avg_elapsed_seconds
   FROM sys.dm_pdw_exec_requests
   WHERE start_time >= DATEADD(MINUTE, -15, GETDATE())
       AND status = 'Completed';
   ```

---

### Procedure 2: Resolve Stuck Scaling

**When to Use:** Pool stuck in "Scaling" state

**Steps:**

1. **Check Scaling Duration:**
   ```bash
   # Scaling should complete within 10-15 minutes
   az monitor activity-log list \
       --resource-group <rg-name> \
       --namespace Microsoft.Synapse \
       --offset 1h \
       --query "[?contains(operationName.value, 'sqlPools')]"
   ```

2. **Force Cancel (if > 30 minutes):**
   ```bash
   # Pause the pool
   az synapse sql pool pause \
       --name <pool-name> \
       --workspace-name <workspace-name> \
       --resource-group <rg-name>

   # Wait 5 minutes for pause to complete
   sleep 300

   # Resume
   az synapse sql pool resume \
       --name <pool-name> \
       --workspace-name <workspace-name> \
       --resource-group <rg-name>
   ```

3. **Retry Scaling:**
   ```bash
   az synapse sql pool update \
       --name <pool-name> \
       --workspace-name <workspace-name> \
       --resource-group <rg-name> \
       --performance-level DW1000c
   ```

---

### Procedure 3: Cost Reduction Analysis

**When to Use:** Monthly cost review

**Steps:**

1. **Generate Usage Report:**
   ```sql
   -- Save to CSV for analysis
   SELECT
       CAST(start_time AS DATE) AS date,
       COUNT(*) AS total_queries,
       SUM(total_elapsed_time)/1000.0/3600 AS total_hours,
       AVG(total_elapsed_time)/1000.0 AS avg_seconds
   FROM sys.dm_pdw_exec_requests
   WHERE start_time >= DATEADD(DAY, -30, GETDATE())
   GROUP BY CAST(start_time AS DATE)
   ORDER BY date;
   ```

2. **Identify Idle Periods:**
   ```sql
   -- Find hours with no activity
   SELECT
       DATEPART(HOUR, dt) AS hour_of_day,
       AVG(query_count) AS avg_queries
   FROM (
       SELECT
           DATEADD(HOUR, DATEDIFF(HOUR, 0, start_time), 0) AS dt,
           COUNT(*) AS query_count
       FROM sys.dm_pdw_exec_requests
       WHERE start_time >= DATEADD(DAY, -7, GETDATE())
       GROUP BY DATEADD(HOUR, DATEDIFF(HOUR, 0, start_time), 0)
   ) sub
   GROUP BY DATEPART(HOUR, dt)
   ORDER BY hour_of_day;
   ```

3. **Calculate Potential Savings:**
   ```text
   Current: DW1000c = $1.20/hour * 24 hours * 30 days = $864/month
   Optimized: DW500c (12 hours/day) = $0.60/hour * 12 * 30 = $216/month
   Savings: $648/month (75%)
   ```

4. **Implement Automation:**
   - Schedule pause/resume based on usage patterns
   - Scale down during low-activity periods
   - Use smaller DWU for development/testing

---

## When to Contact Support

Contact Microsoft Support if:

- [ ] Scaling stuck for >30 minutes
- [ ] Repeated scaling failures with no clear error
- [ ] Quota increase needed
- [ ] Unexpected billing charges
- [ ] Performance issues persist after scaling up
- [ ] Pool becomes unresponsive during scaling

**Information to Provide:**
- Pool name and workspace
- Target DWU and current DWU
- Timestamp of scaling operation
- Activity log entries
- Screenshots of errors
- Resource utilization metrics

---

## Related Resources

- [Connectivity Troubleshooting](connectivity.md)
- [Query Performance](query-performance.md)
- [Cost Optimization Best Practices](../../../best-practices/cost-optimization.md)
- [Performance Optimization](../../../best-practices/performance-optimization.md)
- [Synapse Capacity Management](https://docs.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-manage-compute-overview)

---

> **💡 Scaling Best Practice:** Monitor usage patterns weekly, automate pause/resume for predictable schedules, and right-size DWU based on actual needs, not peak capacity.
