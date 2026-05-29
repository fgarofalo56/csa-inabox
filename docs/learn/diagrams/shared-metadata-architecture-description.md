---
title: "Shared Metadata Architecture Description"
description: "Detailed description and visual representation of the shared metadata architecture in Azure Synapse Analytics, enabling cross-engine data access and unified governance."
tags:
  - diagrams
---
# 🔗 Shared Metadata Architecture Description

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


![Status](https://img.shields.io/badge/Status-Reference-blue?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)
![Pattern](https://img.shields.io/badge/Pattern-Unified_Catalog-purple?style=flat-square)

Detailed description and visual representation of the shared metadata architecture in Azure Synapse Analytics, enabling cross-engine data access and unified governance.

---

## 🎯 Overview

Shared metadata in Azure Synapse Analytics provides a unified catalog that allows different compute engines (Spark, SQL, Pipelines) to discover and access the same data assets seamlessly. This eliminates data silos, reduces duplication, and enables a truly unified analytics platform.

## 📊 Visual Architecture

### High-Level Metadata Architecture

```mermaid
graph TB
    subgraph "Synapse Workspace"
        subgraph "Metadata Management Layer"
            MetaService[Metadata Service<br/>Central Orchestrator]
            Catalog[Unified Catalog<br/>Cross-engine Registry]
        end

        subgraph "Compute Engines"
            SparkPool[Spark Pools<br/>Hive Metastore]
            ServerlessSQL[Serverless SQL Pool<br/>SQL Metadata]
            DedicatedSQL[Dedicated SQL Pool<br/>DW Metadata]
            Pipeline[Synapse Pipelines<br/>Dataset Metadata]
        end

        subgraph "Metadata Storage"
            SparkMetastore[(Spark Metastore<br/>Hive-compatible<br/>Azure SQL DB)]
            SQLMetadata[(SQL Metadata<br/>sys.tables<br/>sys.columns)]
            WorkspaceDB[(Workspace Database<br/>Shared Catalog<br/>Azure SQL DB)]
        end

        subgraph "External Metadata Integration"
            Purview[Azure Purview<br/>Data Catalog<br/>Lineage]
            ExternalCatalog[External Catalogs<br/>HMS, Glue, etc.]
        end
    end

    subgraph "Data Storage"
        DataLake[Data Lake Gen2<br/>Physical Data Files]
        DedicatedStorage[Dedicated SQL Storage<br/>Columnar Format]
    end

    subgraph "Users & Applications"
        SparkNotebook[Spark Notebooks<br/>Python, Scala, SQL]
        SQLClient[SQL Clients<br/>SSMS, Azure Data Studio]
        PowerBI[Power BI<br/>DirectQuery, Import]
        DataFactory[Azure Data Factory<br/>External Pipelines]
    end

    SparkPool -.->|Register Tables| SparkMetastore
    ServerlessSQL -.->|Create Views| SQLMetadata
    DedicatedSQL -.->|Define Schema| SQLMetadata

    SparkMetastore <-.->|Synchronize| MetaService
    SQLMetadata <-.->|Synchronize| MetaService
    MetaService <-.->|Update| Catalog

    Catalog <-.->|Discover| SparkPool
    Catalog <-.->|Discover| ServerlessSQL
    Catalog <-.->|Discover| DedicatedSQL

    SparkPool --> DataLake
    ServerlessSQL --> DataLake
    DedicatedSQL --> DedicatedStorage
    Pipeline --> DataLake

    Catalog -.->|Publish| Purview
    Purview -.->|Enrich| Catalog
    ExternalCatalog -.->|Import| MetaService

    WorkspaceDB -.->|Shared Definitions| Catalog

    SparkNotebook --> SparkPool
    SQLClient --> ServerlessSQL
    SQLClient --> DedicatedSQL
    PowerBI --> ServerlessSQL
    PowerBI --> DedicatedSQL
    DataFactory --> Pipeline

    style MetaService fill:#fff3e0
    style Catalog fill:#e1f5fe
    style SparkPool fill:#e8f5e9
    style ServerlessSQL fill:#f3e5f5
    style DedicatedSQL fill:#fce4ec
    style Purview fill:#fff9c4
    style DataLake fill:#e0f2f1
```

---

## 🏗️ Architecture Components

### 1. Metadata Management Layer

#### Metadata Service

**Purpose**: Central orchestrator for metadata synchronization across engines

**Responsibilities**:

- Synchronize metadata between Spark and SQL engines
- Handle schema evolution and versioning
- Manage metadata conflicts and resolution
- Provide unified discovery interface
- Track metadata lineage and dependencies

```mermaid
graph LR
    subgraph "Metadata Service Operations"
        Register[Register<br/>New Table]
        Sync[Synchronize<br/>Metadata]
        Discover[Discover<br/>Tables]
        Update[Update<br/>Schema]
    end

    subgraph "Metadata Flow"
        SparkCreate[Spark Creates<br/>Delta Table] --> Register
        Register --> Catalog
        Catalog --> Sync
        Sync --> SQLVisible[Visible in<br/>SQL Pool]
        SQLVisible --> Discover
        SparkUpdate[Spark Updates<br/>Schema] --> Update
        Update --> Catalog
    end

    style Register fill:#e8f5e9
    style Sync fill:#e1f5fe
    style Catalog fill:#fff3e0
    style SQLVisible fill:#f3e5f5
```

#### Unified Catalog

**Data Model**:

```mermaid
erDiagram
    DATABASE ||--o{ SCHEMA : contains
    SCHEMA ||--o{ TABLE : contains
    TABLE ||--o{ COLUMN : has
    TABLE ||--o{ PARTITION : partitioned_by
    TABLE }o--|| STORAGE_LOCATION : stored_in
    TABLE }o--o{ TABLE_PROPERTY : has
    COLUMN }o--|| DATA_TYPE : typed_as

    DATABASE {
        string name
        string description
        timestamp created_time
        string owner
    }

    SCHEMA {
        string name
        string database_name
        string description
        timestamp created_time
    }

    TABLE {
        string name
        string schema_name
        string table_type
        string storage_format
        string location
        timestamp created_time
        timestamp modified_time
    }

    COLUMN {
        string name
        string table_name
        int ordinal_position
        string data_type
        boolean nullable
        string description
    }

    PARTITION {
        string column_name
        string data_type
        int ordinal_position
    }
```

**Catalog Queries**:

```sql
-- Query catalog for all databases
SELECT * FROM sys.databases;

-- Query catalog for tables in a schema
SELECT
    t.name as table_name,
    s.name as schema_name,
    t.type_desc as table_type,
    t.create_date,
    t.modify_date
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'gold';

-- Query catalog for column information
SELECT
    c.name as column_name,
    t.name as table_name,
    ty.name as data_type,
    c.max_length,
    c.precision,
    c.scale,
    c.is_nullable
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE t.name = 'customer_metrics';
```

### 2. Compute Engine Metadata

#### Spark Metastore

**Hive Metastore Compatibility**:

```mermaid
graph TB
    subgraph "Spark Metastore Structure"
        DB[Database/Schema]
        TB[Tables]
        Part[Partitions]
        Cols[Columns]
        SerDe[SerDe Info<br/>Storage Format]
        Stats[Statistics<br/>Row counts, sizes]
    end

    DB --> TB
    TB --> Part
    TB --> Cols
    TB --> SerDe
    TB --> Stats

    subgraph "Backend Storage"
        AzureSQL[(Azure SQL Database<br/>Metastore Backend)]
    end

    DB -.-> AzureSQL
    TB -.-> AzureSQL
    Part -.-> AzureSQL

    style DB fill:#fff3e0
    style TB fill:#e1f5fe
    style AzureSQL fill:#e8f5e9
```

**Spark SQL DDL Examples**:

```python
# Create database
spark.sql("""
    CREATE DATABASE IF NOT EXISTS sales
    COMMENT 'Sales analytics database'
    LOCATION 'abfss://gold@datalake.dfs.core.windows.net/sales'
""")

# Create managed Delta table (metadata + data in catalog)
spark.sql("""
    CREATE TABLE sales.transactions (
        transaction_id BIGINT,
        customer_id INT,
        amount DECIMAL(10,2),
        transaction_date DATE
    )
    USING DELTA
    PARTITIONED BY (transaction_date)
""")

# Create external Delta table (metadata in catalog, data in specified location)
spark.sql("""
    CREATE EXTERNAL TABLE sales.customer_dim (
        customer_id INT,
        customer_name STRING,
        email STRING,
        segment STRING
    )
    USING DELTA
    LOCATION 'abfss://gold@datalake.dfs.core.windows.net/dimensions/customer'
""")

# Describe table metadata
spark.sql("DESCRIBE EXTENDED sales.transactions").show(100, False)

# Show table properties
spark.sql("SHOW TBLPROPERTIES sales.transactions").show()
```

#### SQL Pool Metadata

**Metadata Views**:

```sql
-- System catalog views
SELECT * FROM INFORMATION_SCHEMA.TABLES;
SELECT * FROM INFORMATION_SCHEMA.COLUMNS;
SELECT * FROM INFORMATION_SCHEMA.VIEWS;

-- Extended metadata
SELECT * FROM sys.tables;
SELECT * FROM sys.columns;
SELECT * FROM sys.views;
SELECT * FROM sys.external_tables;
SELECT * FROM sys.external_data_sources;

-- Table statistics
SELECT * FROM sys.dm_pdw_nodes_db_partition_stats;
```

**Creating SQL Objects Over Spark Tables**:

```sql
-- Create external data source pointing to data lake
CREATE EXTERNAL DATA SOURCE DataLakeSource
WITH (
    LOCATION = 'abfss://gold@datalake.dfs.core.windows.net',
    CREDENTIAL = DataLakeCredential
);

-- Create external file format for Delta
CREATE EXTERNAL FILE FORMAT DeltaFormat
WITH (
    FORMAT_TYPE = DELTA
);

-- Create external table over Spark-created Delta table
CREATE EXTERNAL TABLE sales.transactions_sql
WITH (
    LOCATION = '/sales/transactions/',
    DATA_SOURCE = DataLakeSource,
    FILE_FORMAT = DeltaFormat
);

-- Create view with business logic
CREATE VIEW sales.monthly_summary AS
SELECT
    YEAR(transaction_date) as year,
    MONTH(transaction_date) as month,
    SUM(amount) as total_sales,
    COUNT(DISTINCT customer_id) as unique_customers
FROM sales.transactions_sql
GROUP BY YEAR(transaction_date), MONTH(transaction_date);
```

### 3. Cross-Engine Metadata Sharing

#### Metadata Synchronization Flow

```mermaid
sequenceDiagram
    participant Spark as Spark Pool
    participant HMS as Hive Metastore
    participant MetaService as Metadata Service
    participant Catalog as Unified Catalog
    participant SQL as SQL Pool

    Note over Spark,SQL: Create Table in Spark

    Spark->>Spark: CREATE TABLE sales.transactions
    Spark->>HMS: Register table metadata
    HMS->>MetaService: Notify table creation
    MetaService->>Catalog: Update unified catalog
    Catalog->>SQL: Publish table availability

    Note over Spark,SQL: Discover Table in SQL

    SQL->>Catalog: Query available tables
    Catalog->>SQL: Return table list (including sales.transactions)
    SQL->>SQL: Create external table definition
    SQL->>Catalog: Register SQL view
    Catalog->>MetaService: Update unified catalog

    Note over Spark,SQL: Schema Evolution in Spark

    Spark->>Spark: ALTER TABLE ADD COLUMN
    Spark->>HMS: Update table metadata
    HMS->>MetaService: Notify schema change
    MetaService->>Catalog: Update unified catalog
    Catalog->>SQL: Notify schema change
    Note over SQL: Existing queries may need refresh

    Note over Spark,SQL: Both engines access same data
    Spark->>DataLake: Query data
    SQL->>DataLake: Query same data
```

#### Automatic Table Discovery

**Spark to SQL Discovery**:

```python
# Step 1: Create table in Spark
spark.sql("""
    CREATE TABLE gold.product_metrics (
        product_id INT,
        product_name STRING,
        category STRING,
        total_sales DECIMAL(15,2),
        metric_date DATE
    )
    USING DELTA
    PARTITIONED BY (metric_date)
    LOCATION 'abfss://gold@datalake.dfs.core.windows.net/products/metrics'
""")

# Step 2: Automatically visible in Serverless SQL Pool
# (No additional steps needed for discovery)
```

```sql
-- Step 3: Query from SQL Pool
-- Table is discoverable through catalog
SELECT
    schema_name,
    table_name,
    create_date
FROM INFORMATION_SCHEMA.TABLES
WHERE schema_name = 'gold'
  AND table_name = 'product_metrics';

-- Step 4: Create external table in SQL to access
CREATE EXTERNAL TABLE gold.product_metrics
WITH (
    LOCATION = '/products/metrics/',
    DATA_SOURCE = DataLakeSource,
    FILE_FORMAT = DeltaFormat
);

-- Step 5: Query the data
SELECT
    category,
    SUM(total_sales) as category_sales
FROM gold.product_metrics
WHERE metric_date >= '2025-01-01'
GROUP BY category;
```

### 4. External Metadata Integration

#### Azure Purview Integration

```mermaid
graph TB
    subgraph "Synapse Workspace"
        SynapseCatalog[Unified Catalog]
        SparkTables[Spark Tables]
        SQLTables[SQL Tables]
    end

    subgraph "Azure Purview"
        DataCatalog[Data Catalog<br/>Search & Discovery]
        Lineage[Data Lineage<br/>End-to-end Tracking]
        Classification[Data Classification<br/>Sensitive Data]
        Glossary[Business Glossary<br/>Terms & Definitions]
    end

    subgraph "Enriched Metadata"
        Business[Business Context]
        Technical[Technical Metadata]
        Operational[Operational Metadata]
    end

    SynapseCatalog -.->|Automatic Scan| DataCatalog
    SparkTables -.->|Publish| DataCatalog
    SQLTables -.->|Publish| DataCatalog

    DataCatalog --> Lineage
    DataCatalog --> Classification
    DataCatalog --> Glossary

    Lineage --> Business
    Classification --> Business
    Glossary --> Business

    SparkTables --> Technical
    SQLTables --> Technical

    SynapseCatalog --> Operational

    Business -.->|Enrich| SynapseCatalog
    Technical -.->|Augment| DataCatalog

    style SynapseCatalog fill:#e1f5fe
    style DataCatalog fill:#fff3e0
    style Lineage fill:#e8f5e9
    style Classification fill:#f3e5f5
```

**Purview Capabilities**:

| Capability | Description | Benefit |
|-----------|-------------|---------|
| __Automatic Scanning__ | Discover Synapse tables automatically | Complete asset inventory |
| __Data Lineage__ | Track data flow end-to-end | Impact analysis, debugging |
| __Classification__ | Identify sensitive data (PII, PHI) | Compliance, security |
| __Business Glossary__ | Define business terms | Shared understanding |
| __Search & Discovery__ | Find data assets easily | Reduced time to insight |

**Lineage Example**:

```mermaid
graph LR
    Source1[SQL Server<br/>Orders DB] --> ADF1[Data Factory<br/>Copy Activity]
    Source2[Cosmos DB<br/>Customer DB] --> ADF2[Data Factory<br/>Copy Activity]

    ADF1 --> Bronze1[Bronze Layer<br/>raw_orders]
    ADF2 --> Bronze2[Bronze Layer<br/>raw_customers]

    Bronze1 --> Spark1[Spark Notebook<br/>Cleanse Orders]
    Bronze2 --> Spark2[Spark Notebook<br/>Cleanse Customers]

    Spark1 --> Silver1[Silver Layer<br/>orders_cleaned]
    Spark2 --> Silver2[Silver Layer<br/>customers_cleaned]

    Silver1 --> Spark3[Spark Notebook<br/>Join & Aggregate]
    Silver2 --> Spark3

    Spark3 --> Gold1[Gold Layer<br/>customer_order_summary]

    Gold1 --> PowerBI[Power BI<br/>Sales Dashboard]

    style Bronze1 fill:#cd7f32
    style Bronze2 fill:#cd7f32
    style Silver1 fill:#c0c0c0
    style Silver2 fill:#c0c0c0
    style Gold1 fill:#ffd700
    style PowerBI fill:#e8f5e9
```

---

## 🔄 Metadata Lifecycle

### Table Creation Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Planned: Design table schema

    Planned --> Created_Spark: Create in Spark
    Planned --> Created_SQL: Create in SQL

    Created_Spark --> Registered_HMS: Register in Hive Metastore
    Created_SQL --> Registered_SQL: Register in SQL Metadata

    Registered_HMS --> Synced: Metadata Service sync
    Registered_SQL --> Synced: Metadata Service sync

    Synced --> Discoverable: Available in Unified Catalog

    Discoverable --> In_Use_Spark: Query from Spark
    Discoverable --> In_Use_SQL: Query from SQL
    Discoverable --> In_Use_Pipeline: Reference in Pipeline

    In_Use_Spark --> Schema_Evolution: ALTER TABLE
    In_Use_SQL --> Schema_Evolution: ALTER TABLE

    Schema_Evolution --> Synced: Re-synchronize metadata

    In_Use_Spark --> Deprecated: Mark as deprecated
    In_Use_SQL --> Deprecated: Mark as deprecated

    Deprecated --> Archived: Move to archive
    Archived --> [*]: Metadata retained for audit
```

### Schema Evolution Scenarios

#### Adding Columns

```python
# Spark: Add column to Delta table
spark.sql("""
    ALTER TABLE sales.transactions
    ADD COLUMN payment_method STRING
""")

# Automatic sync to catalog
# SQL Pool: Column visible after sync (< 5 minutes)
```

```sql
-- SQL: Verify new column
SELECT column_name, data_type
FROM INFORMATION_SCHEMA.COLUMNS
WHERE table_name = 'transactions'
  AND column_name = 'payment_method';
```

#### Column Type Changes (with Delta)

```python
# Spark: Change column type (Delta supports type widening)
spark.sql("""
    ALTER TABLE sales.transactions
    ALTER COLUMN amount TYPE DECIMAL(15,2)
""")

# Note: Type narrowing may require data validation
# Old data remains readable with type casting
```

#### Partition Evolution

```python
# Spark: Add new partition column
spark.sql("""
    ALTER TABLE sales.transactions
    ADD PARTITION (region='US', year=2025)
""")

# Spark: Drop partition
spark.sql("""
    ALTER TABLE sales.transactions
    DROP PARTITION (region='EU', year=2024)
""")
```

---

## 🎯 Use Cases & Patterns

### Use Case 1: Unified Data Engineering & Analytics

**Scenario**: Data engineers use Spark for ETL, analysts use SQL for querying

```mermaid
graph LR
    subgraph "Data Engineering - Spark"
        Engineer[Data Engineer]
        SparkNotebook[Spark Notebook]
        ETL[ETL Processing<br/>Bronze → Silver → Gold]
    end

    subgraph "Shared Metadata"
        Catalog[Unified Catalog]
    end

    subgraph "Data Analytics - SQL"
        Analyst[Data Analyst]
        SQLQuery[SQL Queries]
        Dashboard[Power BI Dashboard]
    end

    Engineer --> SparkNotebook
    SparkNotebook --> ETL
    ETL -.->|Register Tables| Catalog

    Catalog -.->|Discover Tables| SQLQuery
    Analyst --> SQLQuery
    SQLQuery --> Dashboard

    style ETL fill:#fff3e0
    style Catalog fill:#e1f5fe
    style SQLQuery fill:#e8f5e9
    style Dashboard fill:#f3e5f5
```

**Implementation**:

```python
# Data Engineer: Create gold tables in Spark
spark.sql("""
    CREATE TABLE gold.daily_sales_summary (
        sale_date DATE,
        region STRING,
        total_revenue DECIMAL(15,2),
        order_count INT,
        avg_order_value DECIMAL(10,2)
    )
    USING DELTA
    PARTITIONED BY (sale_date)
""")

# Populate with ETL logic
daily_summary = spark.sql("""
    SELECT
        DATE(order_timestamp) as sale_date,
        region,
        SUM(amount) as total_revenue,
        COUNT(*) as order_count,
        AVG(amount) as avg_order_value
    FROM silver.orders
    GROUP BY DATE(order_timestamp), region
""")

daily_summary.write.format("delta") \
    .mode("overwrite") \
    .partitionBy("sale_date") \
    .saveAsTable("gold.daily_sales_summary")
```

```sql
-- Data Analyst: Query in SQL (automatically available)
-- Create external table
CREATE EXTERNAL TABLE gold.daily_sales_summary_sql
WITH (
    LOCATION = '/daily_sales_summary/',
    DATA_SOURCE = DataLakeSource,
    FILE_FORMAT = DeltaFormat
);

-- Query for dashboard
SELECT
    region,
    SUM(total_revenue) as total_revenue,
    SUM(order_count) as total_orders,
    AVG(avg_order_value) as avg_order_value
FROM gold.daily_sales_summary_sql
WHERE sale_date >= DATEADD(day, -30, GETDATE())
GROUP BY region
ORDER BY total_revenue DESC;
```

### Use Case 2: Machine Learning Feature Store

**Scenario**: ML engineers create features in Spark, data scientists consume via SQL

```mermaid
graph TB
    subgraph "Feature Engineering - Spark"
        RawData[Raw Telemetry Data]
        FeatureEng[Feature Engineering<br/>Spark Pipeline]
        FeatureStore[Feature Store<br/>Delta Tables]
    end

    subgraph "Shared Metadata"
        Catalog[Feature Catalog<br/>Metadata + Lineage]
    end

    subgraph "Model Training - SQL/Spark"
        FeatureSelect[Feature Selection<br/>SQL Queries]
        TrainingData[Training Dataset<br/>Exported to ML]
        ModelTrain[Model Training<br/>Azure ML / Databricks]
    end

    RawData --> FeatureEng
    FeatureEng --> FeatureStore
    FeatureStore -.->|Register Features| Catalog

    Catalog -.->|Discover Features| FeatureSelect
    FeatureSelect --> TrainingData
    TrainingData --> ModelTrain

    style FeatureEng fill:#fff3e0
    style FeatureStore fill:#e1f5fe
    style Catalog fill:#e8f5e9
    style ModelTrain fill:#f3e5f5
```

### Use Case 3: Cross-Engine Data Validation

**Scenario**: Validate data quality across Spark and SQL engines

```python
# Spark: Calculate data quality metrics
quality_metrics = spark.sql("""
    SELECT
        COUNT(*) as total_rows,
        COUNT(DISTINCT customer_id) as unique_customers,
        SUM(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) as null_amounts,
        AVG(amount) as avg_amount,
        MIN(transaction_date) as min_date,
        MAX(transaction_date) as max_date
    FROM silver.transactions
""")

quality_metrics.write.format("delta") \
    .mode("overwrite") \
    .saveAsTable("monitoring.data_quality_metrics")
```

```sql
-- SQL: Query quality metrics for dashboard
SELECT
    total_rows,
    unique_customers,
    null_amounts,
    CAST(null_amounts AS FLOAT) / total_rows * 100 as null_percentage,
    avg_amount,
    min_date,
    max_date
FROM monitoring.data_quality_metrics;
```

---

## 💡 Best Practices

### Metadata Management

1. **Consistent Naming Conventions**
   - Use lowercase for database and table names
   - Use underscores for multi-word names
   - Prefix with layer (bronze, silver, gold)

2. **Documentation**
   - Add table and column descriptions
   - Document data lineage
   - Maintain business glossary

3. **Schema Evolution**
   - Plan for backward compatibility
   - Use schema evolution features of Delta Lake
   - Communicate changes to consumers

4. **Governance**
   - Implement access controls at multiple layers
   - Use Azure Purview for data catalog
   - Track sensitive data classifications

### Performance Optimization

1. **Metadata Caching**
   - Metadata is cached by compute engines
   - Cache refresh happens automatically
   - Manual refresh if needed: `REFRESH TABLE tablename`

2. **Statistics Maintenance**
   - Keep statistics up to date
   - Run ANALYZE TABLE periodically
   - Use auto-optimize features in Delta

3. **Partition Strategy**
   - Partition by commonly filtered columns
   - Avoid over-partitioning (< 1GB per partition)
   - Align partitioning across related tables

---

## 🔗 Related Resources

### Architecture Documentation

- [Shared Metadata Overview](../03-architecture-patterns/service-architectures/shared-metadata/shared-metadata.md)
- [Shared Metadata Visuals](../03-architecture-patterns/service-architectures/shared-metadata/shared-metadata-visuals.md)
- [Architecture Patterns](../03-architecture-patterns/README.md)

### Implementation Guides

- [Delta Lake Guide](../06-code-examples/delta-lake-guide.md)
- [Serverless SQL Guide](../06-code-examples/serverless-sql-guide.md)
- [Integration Guide](../06-code-examples/integration-guide.md)

### Best Practices

- [Performance Optimization](../05-best-practices/cross-cutting-concerns/performance/performance-optimization.md)
- [Data Governance](../best-practices-extra/data-governance/README.md)
- [Security Best Practices](../best-practices-extra/security/README.md)

---

*Last Updated: 2025-01-28*
*Architecture Version: 2.0*
*Pattern: Unified Metadata Catalog*
