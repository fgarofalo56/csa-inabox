---
title: "️ Azure SQL Database"
description: "Azure SQL Database is a fully managed relational database service with built-in intelligence, security, and high availability."
tags:
  - services
  - sql-database
---
# 🗄️ Azure SQL Database

<!-- cross-link-admonition -->
!!! info "See also: CSA-in-a-Box platform guide"
    This is the generic Azure reference for Azure SQL Database. For how CSA-in-a-Box specifically deploys, configures, and integrates this service, see the platform guide: [`Azure SQL Database` guide](../../../../guides/azure-sql.md).

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Type](https://img.shields.io/badge/Type-Relational%20Database-blue?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Azure SQL Database is a fully managed relational database service with built-in intelligence, security, and high availability.

---

## 🌟 Service Overview

Azure SQL Database provides a modern SQL Server database engine in the cloud with automatic updates, scaling, and enterprise-grade features without infrastructure management.

### 🔥 Key Value Propositions

- __Fully Managed__: Automated patching, backups, and high availability
- __Intelligent Performance__: Automatic tuning and query optimization
- __Hyperscale__: Up to 100TB databases with fast backups
- __Built-in Security__: Advanced threat protection and encryption
- __Elastic Scaling__: Scale up/down or scale out with elastic pools

---

## 🏗️ Deployment Options

| Option | Description | Best For |
|--------|-------------|----------|
| __Single Database__ | Standalone database | Simple applications, microservices |
| __Elastic Pool__ | Shared resources across databases | Multi-tenant SaaS |
| __Managed Instance__ | Near 100% SQL Server compatibility | Lift-and-shift migrations |
| __Hyperscale__ | Massively scalable architecture | Large databases (> 4TB) |

---

## 📊 Pricing Tiers

### vCore-based Model

```sql
-- General Purpose - balanced compute and I/O
-- Best for most workloads
CREATE DATABASE ProductionDB
  (EDITION = 'GeneralPurpose', SERVICE_OBJECTIVE = 'GP_Gen5_4');

-- Business Critical - high performance
-- Best for mission-critical applications
CREATE DATABASE CriticalDB
  (EDITION = 'BusinessCritical', SERVICE_OBJECTIVE = 'BC_Gen5_8');

-- Hyperscale - massive scale
-- Best for large databases
CREATE DATABASE LargeDB
  (EDITION = 'Hyperscale', SERVICE_OBJECTIVE = 'HS_Gen5_4');
```

---

## 🚀 Quick Start

### Create Azure SQL Database

```bash
# Create resource group
az group create --name myresourcegroup --location eastus

# Create SQL Server
az sql server create \
  --name mysqlserver \
  --resource-group myresourcegroup \
  --location eastus \
  --admin-user sqladmin \
  --admin-password 'YourPassword123!'

# Create database
az sql db create \
  --resource-group myresourcegroup \
  --server mysqlserver \
  --name mydatabase \
  --service-objective GP_Gen5_2 \
  --backup-storage-redundancy Local

# Configure firewall
az sql server firewall-rule create \
  --resource-group myresourcegroup \
  --server mysqlserver \
  --name AllowAzureServices \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0
```

### Connect with Python

```python
import pyodbc
from azure.identity import DefaultAzureCredential

# Connection string with Azure AD authentication
connection_string = """
    Driver={ODBC Driver 18 for SQL Server};
    Server=tcp:mysqlserver.database.windows.net,1433;
    Database=mydatabase;
    Authentication=ActiveDirectoryInteractive;
    Encrypt=yes;
    TrustServerCertificate=no;
"""

# Connect and query
conn = pyodbc.connect(connection_string)
cursor = conn.cursor()

# Create table
cursor.execute("""
    CREATE TABLE Products (
        ProductID INT PRIMARY KEY,
        Name NVARCHAR(100),
        Price DECIMAL(10,2),
        Category NVARCHAR(50)
    )
""")

# Insert data
cursor.execute("""
    INSERT INTO Products VALUES (1, 'Laptop', 999.99, 'Electronics')
""")

# Query data
cursor.execute("SELECT * FROM Products")
for row in cursor.fetchall():
    print(row)

conn.commit()
conn.close()
```

---

## 🔧 Core Features

### 🚀 [Hyperscale Tier](hyperscale.md)

Massively scalable architecture supporting databases up to 100TB.

__Key Features__:
- Rapid scale up/down (minutes vs. hours)
- Fast database backups (seconds)
- Up to 4 readable replicas
- Flexible storage auto-grow

__[📖 Detailed Guide →](hyperscale.md)__

---

### 💰 [Elastic Pools](elastic-pools.md)

Share resources across multiple databases for cost optimization.

__Key Features__:
- Pool resources across databases
- Automatic scaling
- Cost-effective for variable workloads
- Perfect for SaaS applications

__[📖 Detailed Guide →](elastic-pools.md)__

---

## 🔗 Related Resources

- [Hyperscale Architecture](hyperscale.md)
- [Elastic Pools Guide](elastic-pools.md)

---

*Last Updated: 2025-01-28*
*Service Version: General Availability*
*Documentation Status: Complete*
