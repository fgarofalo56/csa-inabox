# Workload Migration — TASM/TIWM to Azure Workload Management

> **Audience:** Data platform architects and DBAs responsible for translating Teradata's workload management (TASM, TIWM) into Azure-native patterns. This is one of the most architecturally significant aspects of migration because TASM concepts do not map one-to-one to any Azure service.

---

## 1. Understanding Teradata workload management

### 1.1 TASM architecture

Teradata Active System Management (TASM) provides:

- **Workload classes** — Logical groupings of queries by business priority
- **Classification rules** — Route queries to workload classes based on user, application, SQL pattern, or resource estimate
- **Resource allocation** — Assign CPU, I/O, and memory proportions per class
- **Throttle rules** — Limit concurrent queries per class
- **Exception handling** — Abort or deprioritize runaway queries
- **SLA targets** — Define response time goals per class

Typical enterprise TASM configuration:

| Workload class | Priority | CPU share | Max concurrent | Typical users |
| --- | --- | --- | --- | --- |
| Tier-1 Executive | Highest | 30% | 20 | C-suite dashboards |
| Tier-2 Production | High | 40% | 50 | Scheduled ETL, BI reports |
| Tier-3 Analyst | Medium | 20% | 30 | Ad-hoc analyst queries |
| Tier-4 Development | Low | 10% | 10 | Dev/test, data science |
| Tactical (short queries) | Elevated | Dedicated AMP worker tasks | 100+ | Operational queries <5 sec |

### 1.2 TIWM (Teradata Intelligent Workload Manager)

TIWM extends TASM with AI-driven dynamic adjustment:

- Automatic query complexity estimation
- Dynamic priority adjustment based on system load
- Predictive throttling before resource exhaustion
- Machine learning-based workload classification

### 1.3 Why TASM is hard to replace

TASM manages all workloads in a **single system** with **shared resources**. Azure's architecture separates compute into multiple engines, each with its own resource management. The migration requires **architectural decomposition**, not feature mapping.

---

## 2. Azure workload management architecture

### 2.1 Design principle: separate workloads into dedicated compute

Instead of one system with workload classes, use multiple compute endpoints:

```
┌─────────────────────────────────────────────────────────────┐
│                    Azure Workload Architecture               │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ SQL Warehouse │  │ SQL Warehouse │  │ SQL Warehouse │      │
│  │ "Executive"   │  │ "Production"  │  │ "Analyst"     │      │
│  │ Small (2X)    │  │ Large (8X)    │  │ Medium (4X)   │      │
│  │ Auto-stop 5m  │  │ Always-on     │  │ Auto-stop 15m │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └────────────────┼────────────────┘               │
│                          │                                 │
│                 ┌────────▼────────┐                        │
│                 │   Delta Lake    │                        │
│                 │   (OneLake /    │                        │
│                 │    ADLS Gen2)   │                        │
│                 └─────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Mapping table

| TASM concept | Databricks SQL | Synapse Dedicated | Fabric |
| --- | --- | --- | --- |
| Workload class | Separate SQL warehouse | Resource class + workload group | Separate workspace/capacity |
| Priority level | Warehouse size (DBU) | Workload importance (low/normal/high) | Capacity allocation % |
| CPU share | Cluster size + auto-scale | DWU allocation per workload group | CU allocation |
| Max concurrent | Max clusters * queries/cluster | Concurrency slots per workload group | Capacity smoothing |
| Throttle rule | Warehouse max-clusters cap | Workload group cap_percentage_resource | Capacity limits |
| Exception handling | Query watchdog (timeout) | Query timeout (DMV monitoring) | Capacity guardrails |
| Classification rule | Application routing (DNS/endpoint) | Workload classifier (sp_configure) | Workspace assignment |
| SLA target | Warehouse SLA monitoring | DMV-based custom alerting | Fabric Capacity Metrics |
| Tactical queries | Serverless SQL (instant start) | Serverless SQL pool | Fabric SQL endpoint (auto) |

---

## 3. Databricks SQL workload management

### 3.1 SQL warehouse sizing per workload class

```python
# Databricks workspace configuration (via Terraform or API)

# Tier-1 Executive (low latency, always warm)
executive_warehouse = {
    "name": "executive-tier1",
    "cluster_size": "Small",        # 2X = 16 DBU
    "min_num_clusters": 1,          # Always-on (warm start)
    "max_num_clusters": 2,          # Scale for bursts
    "auto_stop_mins": 30,           # Keep warm during business hours
    "warehouse_type": "PRO",        # Pro for serverless + query queue
    "enable_serverless_compute": True,
    "tags": {"tier": "1", "cost-center": "executive"}
}

# Tier-2 Production (high throughput, dedicated)
production_warehouse = {
    "name": "production-tier2",
    "cluster_size": "Large",         # 8X = 64 DBU
    "min_num_clusters": 2,           # Always-on for ETL
    "max_num_clusters": 8,           # Scale for peak hours
    "auto_stop_mins": 0,            # Never stop (production)
    "warehouse_type": "PRO",
    "tags": {"tier": "2", "cost-center": "data-engineering"}
}

# Tier-3 Analyst (elastic, cost-optimized)
analyst_warehouse = {
    "name": "analyst-tier3",
    "cluster_size": "Medium",        # 4X = 32 DBU
    "min_num_clusters": 0,           # Scale to zero
    "max_num_clusters": 4,           # Burst capacity
    "auto_stop_mins": 15,            # Auto-stop after idle
    "warehouse_type": "PRO",
    "tags": {"tier": "3", "cost-center": "analytics"}
}

# Tier-4 Development (smallest, scale to zero)
dev_warehouse = {
    "name": "dev-tier4",
    "cluster_size": "2X-Small",      # Smallest available
    "min_num_clusters": 0,           # Scale to zero
    "max_num_clusters": 1,           # No burst
    "auto_stop_mins": 10,
    "warehouse_type": "CLASSIC",     # Classic for cost savings
    "tags": {"tier": "4", "cost-center": "development"}
}
```

### 3.2 Query routing

Route queries to the correct warehouse based on the connecting application:

| Application | Warehouse | Connection string |
| --- | --- | --- |
| Executive dashboards (Power BI) | executive-tier1 | `sql/protocolv1/o/.../executive-tier1` |
| Scheduled ETL (dbt / ADF) | production-tier2 | `sql/protocolv1/o/.../production-tier2` |
| Ad-hoc analyst tools (DBeaver, etc.) | analyst-tier3 | `sql/protocolv1/o/.../analyst-tier3` |
| Dev/test notebooks | dev-tier4 | `sql/protocolv1/o/.../dev-tier4` |

### 3.3 Query watchdog (exception handling)

Replace TASM exception rules with Databricks query watchdog:

```sql
-- Set warehouse-level query timeout
-- Via Databricks SQL warehouse configuration:
-- "Statement timeout (seconds)": 3600  (for production)
-- "Statement timeout (seconds)": 600   (for analyst)
-- "Statement timeout (seconds)": 300   (for dev)
```

For custom exception handling, use Databricks SQL Statement API to monitor and cancel:

```python
import requests
import time

DATABRICKS_HOST = "https://your-workspace.azuredatabricks.net"
TOKEN = "dapi_your_token"

def monitor_long_queries(warehouse_id, max_runtime_seconds=3600):
    """Cancel queries exceeding max runtime."""
    headers = {"Authorization": f"Bearer {TOKEN}"}

    # List running statements
    resp = requests.get(
        f"{DATABRICKS_HOST}/api/2.0/sql/statements",
        headers=headers,
        params={"warehouse_id": warehouse_id, "status": "RUNNING"}
    )

    for stmt in resp.json().get("statements", []):
        runtime = time.time() - stmt["created_at"] / 1000
        if runtime > max_runtime_seconds:
            # Cancel the statement
            requests.post(
                f"{DATABRICKS_HOST}/api/2.0/sql/statements/{stmt['statement_id']}/cancel",
                headers=headers
            )
            print(f"Cancelled query {stmt['statement_id']} (runtime: {runtime:.0f}s)")
```

---

## 4. Synapse Dedicated SQL Pool workload management

### 4.1 Workload groups and classifiers

```sql
-- Create workload groups (replaces TASM workload classes)
CREATE WORKLOAD GROUP wg_executive
WITH (
    MIN_PERCENTAGE_RESOURCE = 20,
    CAP_PERCENTAGE_RESOURCE = 40,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 5,
    REQUEST_MAX_RESOURCE_GRANT_PERCENT = 20
);

CREATE WORKLOAD GROUP wg_production
WITH (
    MIN_PERCENTAGE_RESOURCE = 30,
    CAP_PERCENTAGE_RESOURCE = 60,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 5,
    REQUEST_MAX_RESOURCE_GRANT_PERCENT = 30
);

CREATE WORKLOAD GROUP wg_analyst
WITH (
    MIN_PERCENTAGE_RESOURCE = 10,
    CAP_PERCENTAGE_RESOURCE = 30,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 3,
    REQUEST_MAX_RESOURCE_GRANT_PERCENT = 10
);

-- Create classifiers (replaces TASM classification rules)
CREATE WORKLOAD CLASSIFIER cls_executive
WITH (
    WORKLOAD_GROUP = 'wg_executive',
    MEMBERNAME = 'executive_group',        -- Entra ID group
    IMPORTANCE = HIGH
);

CREATE WORKLOAD CLASSIFIER cls_production
WITH (
    WORKLOAD_GROUP = 'wg_production',
    MEMBERNAME = 'production_svc_account',  -- Service principal
    IMPORTANCE = ABOVE_NORMAL
);

CREATE WORKLOAD CLASSIFIER cls_analyst
WITH (
    WORKLOAD_GROUP = 'wg_analyst',
    MEMBERNAME = 'analyst_group',
    IMPORTANCE = NORMAL
);
```

### 4.2 Concurrency management

| TASM setting | Synapse equivalent |
| --- | --- |
| Max concurrent per class | `CAP_PERCENTAGE_RESOURCE` (limits total resource → limits concurrent) |
| System-wide concurrency | DWU level determines total concurrency slots (128 at DW6000c) |
| Queue depth | Synapse queues excess queries automatically |
| Queue timeout | No built-in; implement via DMV monitoring |

### 4.3 Resource class mapping

```sql
-- Map Teradata workload resource allocations to resource classes
-- DW1000c has 32 concurrency slots

-- Executive: staticrc20 (2 slots each, 16 concurrent)
EXEC sp_addrolemember 'staticrc20', 'executive_user';

-- Production: largerc (4 slots each, 8 concurrent)
EXEC sp_addrolemember 'largerc', 'production_svc';

-- Analyst: smallrc (1 slot each, 32 concurrent)
EXEC sp_addrolemember 'smallrc', 'analyst_user';
```

---

## 5. Fabric workload management

### 5.1 Capacity-based isolation

Fabric uses capacity units (CUs) for resource allocation:

| Workload tier | Fabric approach | Configuration |
| --- | --- | --- |
| Tier-1 Executive | Dedicated Fabric capacity (F16+) | Separate capacity for executive workspace |
| Tier-2 Production | Shared Fabric capacity (F64+) | Production workspace with priority |
| Tier-3 Analyst | Shared capacity with smoothing | Analyst workspace with burst allowed |
| Tier-4 Dev | Fabric trial or F2 capacity | Smallest capacity, scale to zero |

### 5.2 Workspace isolation

```
Fabric Tenant
├── Capacity: Executive (F16)
│   └── Workspace: Executive Dashboards
├── Capacity: Production (F64)
│   ├── Workspace: Data Engineering
│   └── Workspace: Production Reports
├── Capacity: Analytics (F32)
│   ├── Workspace: Analyst Sandbox
│   └── Workspace: Data Science
└── Capacity: Development (F4)
    └── Workspace: Dev/Test
```

---

## 6. Performance tuning

### 6.1 Distribution strategy (replaces Primary Index tuning)

| Teradata PI tuning | Azure equivalent |
| --- | --- |
| Choose PI for co-located joins | Synapse: `DISTRIBUTION = HASH(join_column)` |
| Skew analysis | Synapse: `DBCC PDW_SHOWSPACEUSED` |
| Redistribute for new workloads | Synapse: `ALTER TABLE ... REBUILD WITH (DISTRIBUTION = HASH(...))` |
| PI change (requires reload) | Delta: Re-OPTIMIZE with different Z-ORDER |

### 6.2 Partition strategy (replaces PPI tuning)

```sql
-- Teradata PPI → Delta partitioning
-- Rule of thumb: partition on time column used in most WHERE clauses
-- Target: 100MB-1GB per partition (file size)

-- Good: monthly partition for transaction table
CREATE TABLE silver.orders (...)
USING DELTA
PARTITIONED BY (order_month STRING);

-- Bad: daily partition for small table (too many small files)
-- Bad: no partition for very large table (full scans)

-- After loading, optimize:
OPTIMIZE silver.orders ZORDER BY (customer_id);
```

### 6.3 Concurrency scaling

| Scenario | Teradata TASM | Azure approach |
| --- | --- | --- |
| 100 concurrent BI queries | Single system, TASM prioritization | Databricks: multi-cluster SQL warehouse (10 clusters x 10 queries) |
| ETL competing with queries | TASM throttle rules | Separate warehouses for ETL vs queries |
| Runaway query protection | TASM exception rules | Query watchdog + timeout settings |
| Burst capacity | No burst — fixed hardware | Auto-scale warehouses (Databricks) or DWU scaling (Synapse) |

### 6.4 Query performance comparison

| Workload type | Teradata tuning | Azure tuning |
| --- | --- | --- |
| Large joins (fact-dim) | PI on join key | Synapse: HASH distribution on join key. Databricks: Z-ORDER + Photon |
| Aggregations | AMP-level aggregation | Databricks: Photon + Delta statistics. Synapse: columnstore |
| Full table scan | Block-level I/O | Delta: partition pruning + data skipping |
| Point lookups | Secondary Index | Delta: Z-ORDER + bloom filter |
| Complex subqueries | Optimizer rewrites | Databricks: AQE (Adaptive Query Execution) |

---

## 7. Monitoring and alerting

### 7.1 Replacing ViewPoint workload monitors

| ViewPoint metric | Azure equivalent | Tool |
| --- | --- | --- |
| Active queries per class | Queries per warehouse | Databricks SQL Analytics / Synapse DMVs |
| Queue depth | Queued queries | Databricks warehouse metrics / Synapse DMVs |
| Response time p50/p95 | Query latency | Azure Monitor custom metrics |
| Resource utilization | CPU/memory/I/O | Azure Monitor / Databricks Compute metrics |
| Spooling queries | Disk spill | Spark UI / Synapse query diagnostics |

### 7.2 Azure Monitor alerts

```json
{
    "type": "Microsoft.Insights/metricAlerts",
    "properties": {
        "criteria": {
            "allOf": [
                {
                    "metricName": "QueuedQueries",
                    "operator": "GreaterThan",
                    "threshold": 20,
                    "timeAggregation": "Average"
                }
            ]
        },
        "actions": [{
            "actionGroupId": "/subscriptions/.../actionGroups/data-platform-alerts"
        }],
        "description": "Alert when query queue exceeds 20 (equivalent to TASM throttle warning)"
    }
}
```

### 7.3 Custom workload dashboard (Grafana / Power BI)

Key metrics to replicate from ViewPoint:

| Dashboard panel | Data source | Query |
| --- | --- | --- |
| Active queries by tier | Databricks SQL API | Statement list, group by warehouse |
| Query latency by tier | Databricks Query History | AVG/P95 execution time |
| Queue wait time | Databricks Warehouse Events | Queue duration |
| Cost by tier | Databricks Billing API | DBU consumption by warehouse |
| Error rate by tier | Databricks Query History | Failed/total ratio |

---

## 8. Migration checklist for workload management

### Assessment phase

- [ ] Document all TASM workload classes, priorities, and resource allocations
- [ ] Identify classification rules (user-based, application-based, SQL pattern-based)
- [ ] Capture peak concurrency per workload class
- [ ] Document exception rules (timeout, abort, deprioritize)
- [ ] Identify tactical (short query) workloads
- [ ] Profile query response time SLAs per class

### Design phase

- [ ] Map each workload class to an Azure compute endpoint
- [ ] Size each SQL warehouse / SQL pool based on workload profile
- [ ] Design query routing (which application connects to which endpoint)
- [ ] Define auto-scaling rules per endpoint
- [ ] Define query timeout policies per endpoint
- [ ] Design monitoring dashboard replacing ViewPoint

### Implementation phase

- [ ] Create SQL warehouses / workload groups
- [ ] Configure auto-scaling and auto-stop
- [ ] Set up query routing in application connection strings
- [ ] Implement monitoring and alerting
- [ ] Run load tests matching peak Teradata workload
- [ ] Validate SLA targets are met per workload class

### Cutover phase

- [ ] Parallel run: same queries on both Teradata and Azure
- [ ] Compare latency, throughput, and cost per workload class
- [ ] Tune warehouse sizes based on actual usage
- [ ] Gradually shift traffic from Teradata to Azure
- [ ] Monitor for 14 days post-cutover

---

## 9. Related resources

- [Feature Mapping](feature-mapping-complete.md) — TASM/TIWM feature details
- [Benchmarks](benchmarks.md) — Concurrency and performance comparison
- [Best Practices](best-practices.md) — Workload decomposition strategy
- [Teradata Migration Overview](../teradata.md) — TASM mapping summary table
- Databricks SQL Warehouses: <https://docs.databricks.com/sql/admin/sql-endpoints.html>
- Synapse Workload Management: <https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-workload-management>

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
