---
title: "Elastic Pools - Azure SQL Database"
description: "Elastic Pools enable resource sharing across multiple databases, ideal for SaaS applications with unpredictable or variable workloads."
tags:
  - services
  - sql-database
---
# 💰 Elastic Pools - Azure SQL Database

![Cost](https://img.shields.io/badge/Cost-Optimized-orange?style=flat-square)

Elastic Pools enable resource sharing across multiple databases, ideal for SaaS applications with unpredictable or variable workloads.

---

## 🎯 Overview

Elastic Pools allow multiple databases to share compute and storage resources, providing cost efficiency while maintaining performance isolation.

### Key Benefits

- __Cost Efficiency__: Share resources across databases (up to 50% savings)
- __Performance Isolation__: Each database gets guaranteed resources
- __Automatic Scaling__: Pool adjusts to database demands
- __Simple Management__: Manage multiple databases as one unit

---

## 🏗️ Pool Configuration

```bash
# Create elastic pool
az sql elastic-pool create \
  --resource-group myresourcegroup \
  --server mysqlserver \
  --name mypool \
  --edition GeneralPurpose \
  --family Gen5 \
  --capacity 4 \
  --db-max-capacity 2 \
  --db-min-capacity 0.25 \
  --max-size 500GB

# Add database to pool
az sql db create \
  --resource-group myresourcegroup \
  --server mysqlserver \
  --name tenant1db \
  --elastic-pool mypool
```

### Multi-tenant Pattern

```python
import pyodbc

def get_tenant_connection(tenant_id: str):
    """Get connection to tenant-specific database."""
    connection_string = f"""
        Server=tcp:mysqlserver.database.windows.net,1433;
        Database=tenant_{tenant_id};
        Authentication=ActiveDirectoryInteractive;
    """
    return pyodbc.connect(connection_string)

# Each tenant gets their own database in the pool
tenant1_conn = get_tenant_connection("001")
tenant2_conn = get_tenant_connection("002")

# Queries isolated per tenant
cursor1 = tenant1_conn.cursor()
cursor1.execute("SELECT * FROM Orders")
```

---

## 📊 Monitoring Pool Usage

```sql
-- Check pool resource utilization
SELECT
    database_name,
    AVG(avg_cpu_percent) as avg_cpu,
    MAX(max_worker_percent) as max_workers,
    AVG(avg_data_io_percent) as avg_io
FROM sys.dm_db_resource_stats
WHERE start_time > DATEADD(hour, -1, GETDATE())
GROUP BY database_name
ORDER BY avg_cpu DESC;
```

---

## 💡 Best Practices

### When to Use Elastic Pools

✅ __Good Fit__:
- SaaS applications with many tenants
- Databases with variable usage patterns
- Development/test environments
- Databases with low average but occasional spikes

❌ __Poor Fit__:
- Single database with consistent high load
- Databases requiring maximum performance
- Databases with incompatible resource needs

---

## 🔗 Related Resources

- [Azure SQL Database Overview](README.md)
- [Hyperscale Tier](hyperscale.md)

---

*Last Updated: 2025-01-28*
