---
title: "Delta Sharing Setup Guide"
description: "Configure Delta Sharing for secure cross-organization data sharing."
tags:
  - implementation
  - databricks
---
# 🔗 Delta Sharing Setup Guide

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)
![Duration](https://img.shields.io/badge/Duration-2--4_hours-blue?style=flat-square)

Configure Delta Sharing for secure cross-organization data sharing.

---

## 🎯 Overview

Delta Sharing is an open protocol for secure data sharing across organizations, platforms, and clouds without copying data.

### Key Features

- **Open Protocol**: Works with any client supporting Delta Sharing
- **No Data Copying**: Share data in place from Delta Lake
- **Fine-Grained Access**: Control access at table and partition level
- **Audit Trail**: Track all data access

---

## 📋 Prerequisites

- [ ] Azure Databricks Premium or Enterprise tier
- [ ] Unity Catalog enabled
- [ ] Metastore admin privileges
- [ ] External storage configured

---

## 🔧 Implementation

### Step 1: Enable Delta Sharing on Metastore

```sql
-- Enable Delta Sharing for your metastore
ALTER METASTORE
SET OWNER TO `metastore-admin@company.com`;

-- Verify Delta Sharing is enabled
DESCRIBE METASTORE;
```

### Step 2: Create a Share

```sql
-- Create a share for external partners
CREATE SHARE IF NOT EXISTS partner_sales_data
COMMENT 'Sales data shared with partners';

-- Verify share creation
SHOW SHARES;
```

### Step 3: Add Tables to Share

```sql
-- Add a table to the share
ALTER SHARE partner_sales_data
ADD TABLE gold.sales.daily_aggregates;

-- Add with partition filter (share only specific partitions)
ALTER SHARE partner_sales_data
ADD TABLE gold.sales.transactions
PARTITION (region = 'NA');

-- View share contents
SHOW ALL IN SHARE partner_sales_data;
```

### Step 4: Create Recipients

```sql
-- Create a recipient for an external organization
CREATE RECIPIENT IF NOT EXISTS partner_acme
COMMENT 'ACME Corporation - Sales Team';

-- Get the activation link (send to recipient)
DESCRIBE RECIPIENT partner_acme;
```

### Step 5: Grant Access

```sql
-- Grant share access to recipient
GRANT SELECT ON SHARE partner_sales_data TO RECIPIENT partner_acme;

-- Verify grants
SHOW GRANTS ON SHARE partner_sales_data;
```

---

## 👥 Recipient Setup

### Python Client (Recipient Side)

```python
import delta_sharing

# Load the share profile (provided by data provider)
profile_file = "partner_share_profile.json"

# List available shares
shares = delta_sharing.list_shares(profile_file)
print(f"Available shares: {shares}")

# List tables in a share
tables = delta_sharing.list_all_tables(profile_file)
for table in tables:
    print(f"Table: {table.share}.{table.schema}.{table.name}")

# Load a shared table into Pandas
df = delta_sharing.load_as_pandas(
    f"{profile_file}#partner_sales_data.gold.daily_aggregates"
)
print(df.head())
```

### Spark Client (Recipient Side)

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder \
    .config("spark.jars.packages", "io.delta:delta-sharing-spark_2.12:1.0.0") \
    .getOrCreate()

# Load shared table
shared_df = spark.read \
    .format("deltaSharing") \
    .load("partner_share_profile.json#partner_sales_data.gold.daily_aggregates")

shared_df.show()
```

---

## 🔐 Security Configuration

### IP Access Lists

```sql
-- Restrict recipient access by IP
ALTER RECIPIENT partner_acme
SET IP_ACCESS_LIST = ('10.0.0.0/8', '192.168.1.0/24');
```

### Token Rotation

```python
# Rotate recipient authentication token
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

# Rotate token for a recipient
new_token = w.recipients.rotate_token(
    name="partner_acme"
)
print(f"New activation link: {new_token.activation_url}")
```

---

## 📊 Monitoring and Auditing

### Access Audit

```sql
-- Query audit logs for share access
SELECT
    event_time,
    user_identity.email as accessor,
    action_name,
    request_params.share_name,
    request_params.table_name
FROM system.access.audit
WHERE service_name = 'deltasharing'
    AND event_date > current_date() - INTERVAL 7 DAYS
ORDER BY event_time DESC;
```

---

## 📚 Related Documentation

- [Unity Catalog External Locations](unity-catalog-external-locations.md)
- [Row-Level Security](row-level-security.md)
- [Data Governance Best Practices](../../05-best-practices/cross-cutting-concerns/data-governance/README.md)

---

*Last Updated: January 2025*
