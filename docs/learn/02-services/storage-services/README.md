# 🗃️ Azure Storage Services

![Services](https://img.shields.io/badge/Services-3-blue?style=flat-square)
![Coverage](https://img.shields.io/badge/Coverage-Complete-brightgreen?style=flat-square)

Comprehensive documentation for Azure storage services used in cloud-scale analytics solutions.

---

## 📚 Available Storage Services

### 🏞️ [Azure Data Lake Storage Gen2](azure-data-lake-gen2/README.md)

![Type](https://img.shields.io/badge/Type-Big%20Data%20Storage-darkgreen?style=flat-square)

Hierarchical namespace storage optimized for big data analytics workloads.

__Documentation__:
- [Hierarchical Namespace](azure-data-lake-gen2/hierarchical-namespace.md)
- [Access Control](azure-data-lake-gen2/access-control.md)
- [Data Lifecycle Management](azure-data-lake-gen2/data-lifecycle.md)
- [Performance Optimization](azure-data-lake-gen2/performance-optimization.md)

__Best For__: Data lakes, big data analytics, archival storage

---

### 🌌 [Azure Cosmos DB](azure-cosmos-db/README.md)

![Type](https://img.shields.io/badge/Type-NoSQL%20Database-purple?style=flat-square)

Globally distributed, multi-model NoSQL database service.

__Documentation__:
- [API Selection Guide](azure-cosmos-db/api-selection.md)
- [Partitioning Strategies](azure-cosmos-db/partitioning-strategies.md)
- [Change Feed](azure-cosmos-db/change-feed.md)
- [Analytical Store (HTAP)](azure-cosmos-db/analytical-store.md)

__Best For__: Global applications, low-latency NoSQL, HTAP workloads

---

### 🗄️ [Azure SQL Database](azure-sql-database/README.md)

![Type](https://img.shields.io/badge/Type-Relational%20Database-blue?style=flat-square)

Fully managed relational database service.

__Documentation__:
- [Hyperscale Tier](azure-sql-database/hyperscale.md)
- [Elastic Pools](azure-sql-database/elastic-pools.md)

__Best For__: Relational workloads, transactional applications, data marts

---

## 🎯 Service Selection Guide

| Use Case | Recommended Service | Reason |
|----------|-------------------|---------|
| __Data Lake Foundation__ | ADLS Gen2 | Hierarchical namespace, POSIX ACLs |
| __Real-time Applications__ | Cosmos DB | Global distribution, low latency |
| __Relational Data Warehouse__ | Azure SQL (Hyperscale) | SQL support, massive scale |
| __Multi-tenant SaaS__ | Azure SQL (Elastic Pools) | Resource sharing, cost optimization |
| __IoT Data Storage__ | Cosmos DB (Cassandra) | High write throughput, time-series |

---

*Last Updated: 2025-01-28*
*Total Services: 3*
*Documentation Status: Complete*
