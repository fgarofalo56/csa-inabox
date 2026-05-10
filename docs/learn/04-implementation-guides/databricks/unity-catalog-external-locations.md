# 📍 Unity Catalog External Locations

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Configure Unity Catalog external locations for managed access to cloud storage.

---

## 🎯 Overview

External locations provide governed access to cloud storage paths, enabling:

- **Centralized Access Control**: Manage storage permissions through Unity Catalog
- **Credential Management**: Secure credential storage and rotation
- **Audit Logging**: Track all storage access

---

## 🔧 Implementation

### Step 1: Create Storage Credential

```sql
-- Create storage credential for Azure Data Lake
CREATE STORAGE CREDENTIAL azure_datalake_cred
WITH (
    AZURE_MANAGED_IDENTITY = '/subscriptions/{sub-id}/resourceGroups/{rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/{identity-name}'
);

-- Grant usage to groups
GRANT USE STORAGE CREDENTIAL ON STORAGE CREDENTIAL azure_datalake_cred TO `data-engineers`;
```

### Step 2: Create External Location

```sql
-- Create external location for bronze layer
CREATE EXTERNAL LOCATION bronze_data
URL 'abfss://bronze@datalake.dfs.core.windows.net/'
WITH (STORAGE CREDENTIAL azure_datalake_cred)
COMMENT 'Bronze layer - raw data landing zone';

-- Create external location for silver layer
CREATE EXTERNAL LOCATION silver_data
URL 'abfss://silver@datalake.dfs.core.windows.net/'
WITH (STORAGE CREDENTIAL azure_datalake_cred)
COMMENT 'Silver layer - cleansed data';

-- Create external location for gold layer
CREATE EXTERNAL LOCATION gold_data
URL 'abfss://gold@datalake.dfs.core.windows.net/'
WITH (STORAGE CREDENTIAL azure_datalake_cred)
COMMENT 'Gold layer - curated data';
```

### Step 3: Grant Permissions

```sql
-- Grant read access to bronze
GRANT READ FILES ON EXTERNAL LOCATION bronze_data TO `data-analysts`;

-- Grant write access to silver
GRANT CREATE EXTERNAL TABLE, READ FILES, WRITE FILES
ON EXTERNAL LOCATION silver_data TO `data-engineers`;

-- Grant full access to gold
GRANT ALL PRIVILEGES ON EXTERNAL LOCATION gold_data TO `data-engineers`;
```

### Step 4: Create External Tables

```sql
-- Create external table pointing to storage
CREATE EXTERNAL TABLE bronze.sales.raw_transactions
(
    transaction_id STRING,
    customer_id STRING,
    amount DECIMAL(18,2),
    transaction_date TIMESTAMP
)
USING DELTA
LOCATION 'abfss://bronze@datalake.dfs.core.windows.net/sales/transactions/';
```

---

## 🔍 Verification

```sql
-- List external locations
SHOW EXTERNAL LOCATIONS;

-- Check permissions
SHOW GRANTS ON EXTERNAL LOCATION bronze_data;

-- Validate access
LIST 'abfss://bronze@datalake.dfs.core.windows.net/';
```

---

## 📚 Related Documentation

- [Delta Sharing Setup](delta-sharing-setup.md)
- [Row-Level Security](row-level-security.md)
- [Unity Catalog Documentation](../../02-services/analytics-compute/azure-databricks/unity-catalog/README.md)

---

*Last Updated: January 2025*
