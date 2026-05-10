---
title: "️ Delta Lakehouse Architecture Description"
description: "Detailed description and visual representation of the Delta Lakehouse architecture pattern in Azure Synapse Analytics."
tags:
  - diagrams
---
# 🏞️ Delta Lakehouse Architecture Description

![Status](https://img.shields.io/badge/Status-Reference-blue?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)
![Pattern](https://img.shields.io/badge/Pattern-Lakehouse-gold?style=flat-square)

Detailed description and visual representation of the Delta Lakehouse architecture pattern in Azure Synapse Analytics.

---

## 🎯 Overview

The Delta Lakehouse architecture combines the best features of data lakes and data warehouses, providing a unified platform for both batch and streaming analytics with ACID transaction support, schema enforcement, and time travel capabilities.

## 📊 Visual Architecture

### High-Level Architecture Diagram

```mermaid
graph TB
    subgraph "Data Sources"
        IoT[IoT Devices & Sensors]
        Apps[Enterprise Applications]
        DB[Databases & SaaS]
        Files[Files & Logs]
    end

    subgraph "Ingestion Layer"
        ADF[Azure Data Factory<br/>Batch Ingestion]
        EH[Event Hubs<br/>Streaming Ingestion]
        IoTHub[IoT Hub<br/>Device Telemetry]
    end

    subgraph "Storage Foundation - Data Lake Gen2"
        subgraph "Bronze Layer - Raw Data"
            Bronze[Raw Data<br/>As-Is from Source<br/>Immutable Historical Record]
        end

        subgraph "Silver Layer - Refined Data"
            Silver[Cleaned & Validated<br/>Standardized Schema<br/>Deduplicated Records]
        end

        subgraph "Gold Layer - Business Ready"
            Gold[Aggregated & Enriched<br/>Business Logic Applied<br/>Optimized for Analytics]
        end
    end

    subgraph "Delta Lake Storage Format"
        DeltaFiles[Parquet Data Files<br/>+<br/>Transaction Logs<br/>+<br/>Statistics & Indexes]
    end

    subgraph "Compute Engines - Synapse Analytics"
        SparkPool[Spark Pools<br/>Data Engineering<br/>ML Workloads]
        ServerlessSQL[Serverless SQL Pool<br/>Ad-hoc Queries<br/>Data Exploration]
        DedicatedSQL[Dedicated SQL Pool<br/>Enterprise DW<br/>BI Workloads]
    end

    subgraph "Metadata & Governance"
        Metastore[Spark Metastore<br/>Table Definitions<br/>Schema Registry]
        Purview[Azure Purview<br/>Data Catalog<br/>Lineage Tracking]
    end

    subgraph "Consumption Layer"
        PowerBI[Power BI<br/>Dashboards & Reports]
        AzureML[Azure ML<br/>Model Training & Inference]
        APIApps[APIs & Applications<br/>Custom Solutions]
    end

    IoT --> IoTHub
    Apps --> ADF
    DB --> ADF
    Files --> ADF
    IoT --> EH
    Apps --> EH

    IoTHub --> Bronze
    EH --> Bronze
    ADF --> Bronze

    Bronze --> SparkPool
    SparkPool --> Silver
    Silver --> SparkPool
    SparkPool --> Gold

    Bronze -.->|Delta Format| DeltaFiles
    Silver -.->|Delta Format| DeltaFiles
    Gold -.->|Delta Format| DeltaFiles

    DeltaFiles --> ServerlessSQL
    DeltaFiles --> DedicatedSQL
    DeltaFiles --> SparkPool

    SparkPool -.->|Registers Tables| Metastore
    Metastore -.->|Shared Metadata| ServerlessSQL
    Bronze -.->|Tracks| Purview
    Silver -.->|Tracks| Purview
    Gold -.->|Tracks| Purview

    Gold --> PowerBI
    Gold --> AzureML
    Gold --> APIApps
    ServerlessSQL --> PowerBI
    DedicatedSQL --> PowerBI

    style Bronze fill:#cd7f32,color:#000
    style Silver fill:#c0c0c0,color:#000
    style Gold fill:#ffd700,color:#000
    style DeltaFiles fill:#e1f5fe
    style SparkPool fill:#fff3e0
    style ServerlessSQL fill:#e8f5e9
    style DedicatedSQL fill:#f3e5f5
```

---

## 🏗️ Architecture Components

### 1. Data Sources Layer

Multiple heterogeneous data sources feeding into the lakehouse:

| Source Type | Examples | Ingestion Method | Frequency |
|------------|----------|------------------|-----------|
| __IoT Devices__ | Sensors, smart devices, industrial equipment | IoT Hub, Event Hubs | Real-time streaming |
| __Enterprise Applications__ | ERP, CRM, custom apps | Data Factory, CDC | Batch, scheduled |
| __Databases__ | SQL Server, Oracle, PostgreSQL | Data Factory, linked services | Incremental, CDC |
| __Files & Logs__ | CSV, JSON, Parquet, logs | Data Factory, auto-loader | Batch, event-driven |

### 2. Ingestion Layer

#### Azure Data Factory

- __Purpose__: Orchestrate batch data ingestion and transformation
- __Capabilities__:
  - 90+ native connectors for data sources
  - Code-free ETL pipeline design
  - Incremental data loading with watermarking
  - Scheduled and trigger-based execution

#### Event Hubs

- __Purpose__: High-throughput streaming data ingestion
- __Capabilities__:
  - Millions of events per second
  - Kafka protocol compatibility
  - Event capture to Data Lake
  - Partition-based scalability

#### IoT Hub

- __Purpose__: Specialized IoT device connectivity
- __Capabilities__:
  - Per-device security and authentication
  - Bidirectional communication
  - Device management and provisioning
  - Edge intelligence support

### 3. Storage Foundation - Medallion Architecture

#### Bronze Layer (Raw Zone)

```mermaid
graph LR
    subgraph "Bronze Layer Characteristics"
        Raw[Raw Data Files]
        Immutable[Immutable<br/>Historical Record]
        Source[Source Schema<br/>Preserved]
        Audit[Full Audit Trail]
    end

    Raw --> Immutable
    Immutable --> Source
    Source --> Audit

    style Raw fill:#cd7f32
    style Immutable fill:#ffe0b2
    style Source fill:#ffccbc
    style Audit fill:#d7ccc8
```

__Characteristics__:

- **Data Quality**: As-is from source, no transformations
- **Schema**: Source system schema preserved
- **Format**: Delta Lake (Parquet + transaction log)
- **Purpose**: Historical record, replay capability, audit trail
- **Retention**: Long-term (years), move to archive tier

__Example Table Structure__:

```sql
-- Bronze layer table
CREATE TABLE bronze.iot_telemetry (
    event_data STRING,          -- Raw JSON payload
    event_timestamp TIMESTAMP,  -- Source timestamp
    device_id STRING,
    _ingestion_time TIMESTAMP,  -- System ingestion time
    _source_file STRING,        -- Source file reference
    _partition_date DATE        -- Partition key
)
USING DELTA
PARTITIONED BY (_partition_date)
LOCATION 'abfss://bronze@datalake.dfs.core.windows.net/iot_telemetry';
```

#### Silver Layer (Refined Zone)

```mermaid
graph LR
    subgraph "Silver Layer Characteristics"
        Clean[Cleaned Data]
        Validated[Validated & Typed]
        Dedup[Deduplicated]
        Standard[Standardized Schema]
    end

    Clean --> Validated
    Validated --> Dedup
    Dedup --> Standard

    style Clean fill:#c0c0c0
    style Validated fill:#e0e0e0
    style Dedup fill:#f5f5f5
    style Standard fill:#eeeeee
```

__Characteristics__:

- **Data Quality**: Cleaned, validated, deduplicated
- **Schema**: Standardized across sources
- **Format**: Delta Lake with schema enforcement
- **Purpose**: Source of truth for analytics
- **Retention**: Medium-term (months to years)

__Transformations Applied__:

1. **Data Cleansing**
   - Null handling and default values
   - Invalid data filtering
   - Data type conversions

2. **Standardization**
   - Consistent naming conventions
   - Uniform date/time formats
   - Standardized units and measures

3. **Deduplication**
   - Remove exact duplicates
   - Handle late-arriving data
   - Merge updates and corrections

__Example Table Structure__:

```sql
-- Silver layer table
CREATE TABLE silver.iot_telemetry (
    device_id STRING NOT NULL,
    event_timestamp TIMESTAMP NOT NULL,
    temperature DOUBLE,
    humidity DOUBLE,
    pressure DOUBLE,
    battery_level INT,
    device_status STRING,
    location_lat DOUBLE,
    location_long DOUBLE,
    _source STRING,
    _processed_time TIMESTAMP,
    _quality_score DOUBLE
)
USING DELTA
PARTITIONED BY (DATE(event_timestamp))
LOCATION 'abfss://silver@datalake.dfs.core.windows.net/iot_telemetry';
```

#### Gold Layer (Consumption Zone)

```mermaid
graph LR
    subgraph "Gold Layer Characteristics"
        Aggregated[Aggregated Metrics]
        Business[Business Logic]
        Optimized[Query Optimized]
        Enriched[Enriched & Joined]
    end

    Aggregated --> Business
    Business --> Optimized
    Optimized --> Enriched

    style Aggregated fill:#ffd700
    style Business fill:#ffeb3b
    style Optimized fill:#fff59d
    style Enriched fill:#fff9c4
```

__Characteristics__:

- **Data Quality**: Business-ready, aggregated
- **Schema**: Dimensional models, business entities
- **Format**: Delta Lake optimized for queries
- **Purpose**: Direct consumption by BI tools
- **Retention**: Active data (days to months)

__Data Models__:

1. **Fact Tables**: Metrics and measurements
2. **Dimension Tables**: Descriptive attributes
3. **Aggregated Views**: Pre-computed summaries
4. **Business Entities**: Customer 360, Product catalogs

__Example Table Structure__:

```sql
-- Gold layer fact table
CREATE TABLE gold.device_daily_metrics (
    device_id STRING NOT NULL,
    metric_date DATE NOT NULL,
    avg_temperature DOUBLE,
    max_temperature DOUBLE,
    min_temperature DOUBLE,
    avg_humidity DOUBLE,
    total_events BIGINT,
    uptime_minutes INT,
    alert_count INT,
    device_type STRING,      -- Enriched from dimension
    location_name STRING,    -- Enriched from dimension
    customer_segment STRING  -- Business categorization
)
USING DELTA
PARTITIONED BY (metric_date)
LOCATION 'abfss://gold@datalake.dfs.core.windows.net/device_daily_metrics'
TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);
```

### 4. Delta Lake Storage Format

#### Core Components

```mermaid
graph TB
    subgraph "Delta Lake File Structure"
        DataFiles[Parquet Data Files<br/>Columnar Storage<br/>Compressed]
        TxLog[Transaction Log<br/>_delta_log/<br/>JSON Logs]
        Checkpoints[Checkpoints<br/>Parquet Snapshots<br/>Every 10 commits]
        Stats[Statistics<br/>Min/Max Values<br/>Record Counts]
    end

    subgraph "ACID Guarantees"
        Atomicity[Atomicity<br/>All or nothing commits]
        Consistency[Consistency<br/>Schema enforcement]
        Isolation[Isolation<br/>Snapshot isolation]
        Durability[Durability<br/>Persistent storage]
    end

    DataFiles --> TxLog
    TxLog --> Checkpoints
    DataFiles --> Stats

    TxLog --> Atomicity
    TxLog --> Consistency
    TxLog --> Isolation
    TxLog --> Durability

    style DataFiles fill:#e1f5fe
    style TxLog fill:#fff3e0
    style Checkpoints fill:#f3e5f5
    style Stats fill:#e8f5e9
```

#### Key Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| __ACID Transactions__ | Full ACID compliance for data operations | Data reliability and consistency |
| __Time Travel__ | Query historical versions of data | Audit, rollback, reproduce analyses |
| __Schema Evolution__ | Add, rename, change columns safely | Flexibility without breaking changes |
| __Upserts/Merges__ | Efficient UPDATE and MERGE operations | Simplified CDC and SCD patterns |
| __Data Skipping__ | Statistics-based file pruning | Faster queries through data skipping |
| __Compaction__ | Automatic small file optimization | Better query performance |

#### Delta Lake Operations

**Write Operations**:

```python
# Append new data
df.write.format("delta").mode("append").save("/path/to/delta-table")

# Overwrite partition
df.write.format("delta") \
    .mode("overwrite") \
    .option("replaceWhere", "date = '2025-01-28'") \
    .save("/path/to/delta-table")

# Merge (Upsert)
from delta.tables import DeltaTable

deltaTable = DeltaTable.forPath(spark, "/path/to/delta-table")
deltaTable.alias("target").merge(
    updates.alias("source"),
    "target.id = source.id"
).whenMatchedUpdateAll() \
 .whenNotMatchedInsertAll() \
 .execute()
```

**Read Operations**:

```python
# Current version
df = spark.read.format("delta").load("/path/to/delta-table")

# Time travel - specific version
df = spark.read.format("delta") \
    .option("versionAsOf", 5) \
    .load("/path/to/delta-table")

# Time travel - specific timestamp
df = spark.read.format("delta") \
    .option("timestampAsOf", "2025-01-28") \
    .load("/path/to/delta-table")
```

### 5. Compute Engines

#### Synapse Spark Pools

```mermaid
graph TB
    subgraph "Spark Pool Capabilities"
        DataEng[Data Engineering<br/>ETL/ELT Processing]
        ML[Machine Learning<br/>Feature Engineering<br/>Model Training]
        Streaming[Structured Streaming<br/>Real-time Processing]
        Languages[Multi-language<br/>Python, Scala, SQL, .NET]
    end

    subgraph "Optimizations"
        AutoScale[Auto-scaling<br/>Dynamic Allocation]
        Caching[Intelligent Caching<br/>Delta Cache]
        Optimization[Query Optimization<br/>Adaptive Execution]
    end

    DataEng --> AutoScale
    ML --> Caching
    Streaming --> AutoScale
    Languages --> Optimization

    style DataEng fill:#fff3e0
    style ML fill:#f3e5f5
    style Streaming fill:#e1f5fe
    style Languages fill:#e8f5e9
```

__Primary Use Cases__:

- **ETL/ELT Processing**: Transform data between medallion layers
- **Machine Learning**: Feature engineering and model training
- **Streaming**: Real-time data processing with Spark Structured Streaming
- **Data Engineering**: Complex transformations and data quality rules

__Configuration Guidance__:

| Workload Type | Node Size | Node Count | Auto-scaling |
|--------------|-----------|------------|--------------|
| Development/Testing | Small (4 cores, 32GB) | 3-5 | Enabled |
| Production ETL | Medium (8 cores, 64GB) | 5-20 | Enabled |
| ML Training | Large (16 cores, 128GB) | 10-50 | Enabled |
| Streaming | Medium (8 cores, 64GB) | 5-10 | Limited |

#### Synapse Serverless SQL Pool

__Architecture__:

```mermaid
graph LR
    User[User Query] --> Parser[Query Parser]
    Parser --> Optimizer[Query Optimizer]
    Optimizer --> Executor[Distributed Executor]
    Executor --> DataLake[Data Lake Gen2<br/>Delta Files]
    DataLake --> Results[Result Set]

    style User fill:#e8f5e9
    style Parser fill:#fff3e0
    style Optimizer fill:#f3e5f5
    style Executor fill:#e1f5fe
    style DataLake fill:#fff9c4
```

__Characteristics__:

- **Pricing**: Pay-per-query (per TB scanned)
- **Startup**: Instant, no cluster management
- **Language**: T-SQL compatible
- **Formats**: Parquet, Delta, CSV, JSON
- **Best For**: Ad-hoc queries, data exploration, BI queries

__Query Optimization Tips__:

1. **Partitioning**: Leverage partition pruning
2. **File Size**: Larger files (>100MB) perform better
3. **Statistics**: Use OPENROWSET hints
4. **Caching**: Query results cached for 48 hours

#### Synapse Dedicated SQL Pool

__Purpose**: Enterprise data warehousing for consistent, high-performance workloads

__Architecture Pattern**:

```mermaid
graph TB
    subgraph "Dedicated SQL Pool"
        Control[Control Node<br/>Query Coordination]
        Compute1[Compute Node 1]
        Compute2[Compute Node 2]
        Compute3[Compute Node N]
        Storage[Azure Storage<br/>Distributed Storage]
    end

    Control --> Compute1
    Control --> Compute2
    Control --> Compute3
    Compute1 --> Storage
    Compute2 --> Storage
    Compute3 --> Storage

    style Control fill:#fff3e0
    style Compute1 fill:#e1f5fe
    style Compute2 fill:#e1f5fe
    style Compute3 fill:#e1f5fe
    style Storage fill:#e8f5e9
```

__When to Use__:

- Consistent query workloads
- Predictable performance requirements
- Complex dimensional models
- High concurrency BI workloads

### 6. Metadata & Governance

#### Spark Metastore

- **Purpose**: Centralized catalog of tables and schemas
- **Scope**: Shared across Spark pools
- **Compatibility**: Hive metastore compatible
- **Storage**: Backed by Azure SQL Database

#### Azure Purview

- **Data Catalog**: Discover and understand data assets
- **Data Lineage**: Track data movement and transformations
- **Classification**: Automatically classify sensitive data
- **Compliance**: Support regulatory compliance requirements

---

## 🔄 Data Flow Patterns

### Batch Processing Flow

```mermaid
sequenceDiagram
    participant Source as Data Source
    participant ADF as Data Factory
    participant Bronze as Bronze Layer
    participant Spark as Spark Pool
    participant Silver as Silver Layer
    participant Gold as Gold Layer
    participant BI as Power BI

    Source->>ADF: Extract data
    ADF->>Bronze: Load raw data (Delta)
    Note over Bronze: Immutable historical record

    Bronze->>Spark: Read raw data
    Spark->>Spark: Clean & validate
    Spark->>Silver: Write refined data (Delta)
    Note over Silver: Cleaned, deduplicated

    Silver->>Spark: Read refined data
    Spark->>Spark: Aggregate & enrich
    Spark->>Gold: Write business data (Delta)
    Note over Gold: Business-ready metrics

    Gold->>BI: Query for visualization
    BI->>BI: Render dashboards
```

### Streaming Processing Flow

```mermaid
sequenceDiagram
    participant Device as IoT Devices
    participant EH as Event Hubs
    participant Spark as Spark Streaming
    participant Silver as Silver Layer
    participant Gold as Gold Layer
    participant RT as Real-time Views

    Device->>EH: Send telemetry events
    EH->>Spark: Stream events
    Spark->>Spark: Transform & validate
    Spark->>Silver: Micro-batch writes (Delta)

    par Batch Aggregation
        Silver->>Spark: Trigger batch job
        Spark->>Gold: Write aggregates
    and Real-time Aggregation
        Spark->>RT: Update real-time metrics
    end

    Note over Gold,RT: Both paths available for queries
```

### Time Travel & Versioning

```mermaid
graph LR
    subgraph "Delta Table Versions"
        V0[Version 0<br/>Initial Load]
        V1[Version 1<br/>Update 1]
        V2[Version 2<br/>Update 2]
        V3[Version 3<br/>Current]
    end

    subgraph "Query Options"
        Current[Current Query<br/>Version 3]
        Historic[Time Travel<br/>Version 1]
        Rollback[Rollback<br/>Restore Version 2]
    end

    V0 --> V1
    V1 --> V2
    V2 --> V3

    V3 -.-> Current
    V1 -.-> Historic
    V2 -.-> Rollback

    style V3 fill:#4caf50
    style Current fill:#4caf50
    style Historic fill:#2196f3
    style Rollback fill:#ff9800
```

---

## 💡 Key Benefits

### 1. Unified Platform

- **Single storage layer** for both batch and streaming
- **Consistent data format** across all compute engines
- **Shared metadata** accessible from SQL and Spark

### 2. ACID Guarantees

- **Reliable writes** with transaction support
- **Consistent reads** with snapshot isolation
- **Safe concurrent operations** from multiple users
- **Data quality** with schema enforcement

### 3. Performance

- **Data skipping** with statistics-based pruning
- **Partition pruning** for efficient queries
- **Compaction** for optimal file sizes
- **Caching** with Delta Cache in Spark

### 4. Cost Efficiency

- **Storage costs**: Parquet compression reduces storage needs
- **Compute costs**: Serverless SQL for ad-hoc queries
- **Lifecycle management**: Auto-archive old data to cool/archive tiers

### 5. Flexibility

- **Schema evolution** without breaking changes
- **Time travel** for audit and analysis
- **Multiple compute engines** for different workloads
- **Open format** based on Parquet and open-source Delta Lake

---

## 🎯 Implementation Best Practices

### 1. Data Organization

- **Layer Separation**: Strictly separate Bronze, Silver, Gold
- **Partitioning**: Partition by date for time-series data
- **File Sizes**: Target 100MB-1GB per file
- **Naming Conventions**: Consistent, descriptive table names

### 2. Performance Optimization

- **Z-ordering**: Optimize for common query patterns
- **Compaction**: Regular small file compaction
- **Statistics**: Maintain up-to-date statistics
- **Caching**: Leverage Delta Cache for hot data

### 3. Data Quality

- **Validation**: Implement data quality checks at each layer
- **Schema Management**: Use schema evolution carefully
- **Deduplication**: Handle duplicates in Silver layer
- **Audit Trail**: Preserve raw data in Bronze

### 4. Governance

- **Access Control**: Implement fine-grained ACLs
- **Data Classification**: Tag sensitive data
- **Lineage**: Track data movement with Purview
- **Retention**: Define retention policies per layer

---

## 🔗 Related Resources

### Architecture Documentation

- [Delta Lakehouse Overview](../architecture/delta-lakehouse-overview.md)
- [Detailed Architecture](../architecture/delta-lakehouse/detailed-architecture.md)
- [Architecture Patterns](../03-architecture-patterns/README.md)

### Implementation Guides

- [Delta Lake Guide](../code-examples/delta-lake-guide.md)
- [Synapse Spark Tutorial](../tutorials/synapse/README.md)
- [Best Practices](../best-practices/delta-lake-optimization.md)

### Code Examples

- [Auto-loader Implementation](../code-examples/delta-lake/ingestion/auto-loader.md)
- [Table Optimization](../code-examples/delta-lake/optimization/table-optimization.md)
- [Change Data Capture](../code-examples/delta-lake/cdc/change-data-capture.md)

---

*Last Updated: 2025-01-28*
*Architecture Version: 2.0*
*Pattern: Medallion + Delta Lake*
