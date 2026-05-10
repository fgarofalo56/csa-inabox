# 🗄️ Dedicated SQL Pool

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)
![Last Updated](https://img.shields.io/badge/Updated-2025-blue?style=flat-square)

Enterprise data warehousing solution within Azure Synapse Analytics.

---

## 🎯 Overview

Dedicated SQL Pool (formerly Azure SQL Data Warehouse) provides a massively parallel processing (MPP) engine for enterprise-scale analytics workloads.

### Key Capabilities

- **Petabyte-scale** data warehousing
- **Massively parallel** query processing
- **T-SQL compatibility** for existing SQL skills
- **Workload isolation** with resource classes
- **Pause/Resume** for cost optimization

---

## 📚 Documentation

| Topic | Description |
|-------|-------------|
| [Sizing Guide](sizing.md) | DWU selection and capacity planning |
| [Performance Tuning](../../../../05-best-practices/service-specific/synapse/dedicated-sql-best-practices.md) | Query optimization techniques |
| [Cost Management](../../../../05-best-practices/cross-cutting-concerns/cost-optimization/dedicated-sql-costs.md) | Cost optimization strategies |
| [Troubleshooting](../../../../07-troubleshooting/service-troubleshooting/synapse/README.md) | Common issues and solutions |

---

## 🚀 Quick Start

```sql
-- Create a simple table
CREATE TABLE dbo.sales_fact
(
    sale_id BIGINT NOT NULL,
    customer_key INT NOT NULL,
    product_key INT NOT NULL,
    sale_amount DECIMAL(18,2),
    sale_date DATE
)
WITH
(
    DISTRIBUTION = HASH(customer_key),
    CLUSTERED COLUMNSTORE INDEX
);

-- Load data from Data Lake
COPY INTO dbo.sales_fact
FROM 'https://datalake.dfs.core.windows.net/bronze/sales/*.parquet'
WITH (
    FILE_TYPE = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'Managed Identity')
);
```

---

*Last Updated: January 2025*
