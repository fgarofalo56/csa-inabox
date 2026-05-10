# Delta Lakehouse Architecture Diagram

[🏠 Home](../../README.md) > [📊 Diagrams](README.md) > Delta Lakehouse Architecture

## Overview

This diagram illustrates the comprehensive Delta Lakehouse architecture pattern using Azure Synapse Analytics and Data Lake Storage Gen2. The architecture implements the Medallion pattern (Bronze/Silver/Gold) with Delta Lake format for ACID transactions and data versioning.

---

## Complete Architecture Diagram

```mermaid
graph TB
    subgraph "Data Sources"
        DB[(Databases<br/>SQL Server, Oracle)]
        Files[File Systems<br/>CSV, JSON, Parquet]
        Apps[Applications<br/>APIs, SaaS]
        Stream[Streaming<br/>IoT, Events]
    end

    subgraph "Ingestion Layer"
        ADF[Azure Data Factory<br/>ETL/ELT Pipelines]
        EH[Event Hubs<br/>Stream Ingestion]
        ASA[Stream Analytics<br/>Real-time Processing]
    end

    subgraph "Azure Data Lake Storage Gen2"
        subgraph "Bronze Layer - Raw Zone"
            BronzeDB[Database Extracts]
            BronzeFiles[Raw Files]
            BronzeStream[Streaming Data]
        end

        subgraph "Silver Layer - Refined Zone"
            SilverCleaned[Cleansed Data]
            SilverConformed[Conformed Data]
            SilverValidated[Validated Data]
        end

        subgraph "Gold Layer - Curated Zone"
            GoldDim[Dimension Tables]
            GoldFact[Fact Tables]
            GoldAgg[Aggregated Metrics]
            GoldML[ML Feature Tables]
        end
    end

    subgraph "Delta Lake Format"
        DeltaACID[ACID Transactions]
        DeltaVersion[Time Travel]
        DeltaSchema[Schema Evolution]
        DeltaOptimize[Z-Ordering & Compaction]
    end

    subgraph "Processing - Synapse Spark Pools"
        SparkETL[ETL Processing<br/>PySpark, Scala]
        SparkML[ML Workloads<br/>MLlib, AutoML]
        SparkStream[Streaming Jobs<br/>Structured Streaming]
    end

    subgraph "Query & Analytics - Synapse SQL"
        ServerlessSQL[Serverless SQL Pool<br/>On-demand Queries]
        DedicatedSQL[Dedicated SQL Pool<br/>Data Warehouse]
    end

    subgraph "Consumption Layer"
        PowerBI[Power BI<br/>Dashboards & Reports]
        AzureML[Azure ML<br/>ML Models]
        Apps2[Applications<br/>APIs & Services]
        Excel[Excel<br/>Self-service BI]
    end

    subgraph "Governance & Security"
        Purview[Azure Purview<br/>Data Catalog & Lineage]
        AAD[Azure AD<br/>Authentication]
        RBAC[RBAC & ACLs<br/>Authorization]
        Encryption[Encryption<br/>At Rest & In Transit]
    end

    subgraph "Operations & Monitoring"
        Monitor[Azure Monitor<br/>Metrics & Logs]
        LogAnalytics[Log Analytics<br/>Diagnostics]
        Alerts[Alerts & Actions<br/>Automation]
    end

    %% Data Flow Connections
    DB --> ADF
    Files --> ADF
    Apps --> ADF
    Stream --> EH
    EH --> ASA

    ADF --> BronzeDB
    ADF --> BronzeFiles
    ASA --> BronzeStream

    BronzeDB --> SparkETL
    BronzeFiles --> SparkETL
    BronzeStream --> SparkStream

    SparkETL --> SilverCleaned
    SilverCleaned --> SilverConformed
    SilverConformed --> SilverValidated
    SparkStream --> SilverCleaned

    SilverValidated --> SparkETL
    SparkETL --> GoldDim
    SparkETL --> GoldFact
    SparkETL --> GoldAgg
    SparkML --> GoldML

    %% Delta Lake Integration
    BronzeDB -.-> DeltaACID
    SilverCleaned -.-> DeltaACID
    GoldDim -.-> DeltaACID
    SilverValidated -.-> DeltaVersion
    GoldFact -.-> DeltaSchema
    GoldAgg -.-> DeltaOptimize

    %% Query Layer
    GoldDim --> ServerlessSQL
    GoldFact --> ServerlessSQL
    GoldAgg --> ServerlessSQL
    GoldDim --> DedicatedSQL
    GoldFact --> DedicatedSQL

    %% Consumption
    ServerlessSQL --> PowerBI
    DedicatedSQL --> PowerBI
    ServerlessSQL --> Excel
    GoldML --> AzureML
    DedicatedSQL --> Apps2

    %% Governance
    SparkETL -.-> Purview
    ServerlessSQL -.-> Purview
    ADF -.-> Purview

    AAD -.-> ServerlessSQL
    AAD -.-> SparkETL
    RBAC -.-> BronzeDB
    RBAC -.-> SilverCleaned
    RBAC -.-> GoldDim

    %% Monitoring
    SparkETL -.-> Monitor
    ServerlessSQL -.-> Monitor
    DedicatedSQL -.-> Monitor
    Monitor --> LogAnalytics
    LogAnalytics --> Alerts

    %% Styling
    style BronzeDB fill:#CD7F32,color:#000
    style BronzeFiles fill:#CD7F32,color:#000
    style BronzeStream fill:#CD7F32,color:#000

    style SilverCleaned fill:#C0C0C0,color:#000
    style SilverConformed fill:#C0C0C0,color:#000
    style SilverValidated fill:#C0C0C0,color:#000

    style GoldDim fill:#FFD700,color:#000
    style GoldFact fill:#FFD700,color:#000
    style GoldAgg fill:#FFD700,color:#000
    style GoldML fill:#FFD700,color:#000

    style DeltaACID fill:#90EE90
    style DeltaVersion fill:#90EE90
    style DeltaSchema fill:#90EE90
    style DeltaOptimize fill:#90EE90

    style SparkETL fill:#E1F5FE
    style SparkML fill:#E1F5FE
    style SparkStream fill:#E1F5FE

    style ServerlessSQL fill:#FFF3E0
    style DedicatedSQL fill:#FFF3E0

    style PowerBI fill:#F3E5F5
    style AzureML fill:#F3E5F5
```

---

## Medallion Architecture Layers

### Bronze Layer (Raw Data)

```mermaid
graph LR
    subgraph "Bronze Layer Characteristics"
        Raw[Raw Data<br/>Exact Copy]
        Immutable[Immutable<br/>Append-Only]
        Source[Source Schema<br/>Preserved]
        Audit[Full Audit Trail]
    end

    Raw --> Immutable
    Immutable --> Source
    Source --> Audit

    style Raw fill:#CD7F32,color:#000
    style Immutable fill:#CD7F32,color:#000
    style Source fill:#CD7F32,color:#000
    style Audit fill:#CD7F32,color:#000
```

**Purpose**: Land all raw data exactly as received from sources

**Characteristics**:
- No transformation beyond format conversion
- Preserves original data structure
- Includes metadata (timestamp, source system, batch ID)
- Supports data reprocessing and lineage

---

### Silver Layer (Refined Data)

```mermaid
graph LR
    subgraph "Silver Layer Transformations"
        Clean[Data Cleansing<br/>Quality Rules]
        Conform[Standardization<br/>Common Schema]
        Dedupe[Deduplication<br/>Business Keys]
        Enrich[Enrichment<br/>Reference Data]
    end

    Clean --> Conform
    Conform --> Dedupe
    Dedupe --> Enrich

    style Clean fill:#C0C0C0,color:#000
    style Conform fill:#C0C0C0,color:#000
    style Dedupe fill:#C0C0C0,color:#000
    style Enrich fill:#C0C0C0,color:#000
```

**Purpose**: Cleansed, conformed, and validated data ready for analytics

**Transformations**:
- Data quality validation and cleansing
- Standardized schemas across sources
- Deduplication using business keys
- Reference data enrichment
- Type casting and format standardization

---

### Gold Layer (Business-Ready Data)

```mermaid
graph TB
    subgraph "Gold Layer Organization"
        direction LR
        Dim[Dimensional<br/>Models]
        Fact[Fact<br/>Tables]
        Agg[Aggregated<br/>Metrics]
        ML[ML Feature<br/>Tables]
    end

    subgraph "Use Cases"
        BI[Business Intelligence]
        Reporting[Reporting]
        Analytics[Advanced Analytics]
        AI[AI/ML Models]
    end

    Dim --> BI
    Fact --> BI
    Agg --> Reporting
    ML --> AI
    Fact --> Analytics

    style Dim fill:#FFD700,color:#000
    style Fact fill:#FFD700,color:#000
    style Agg fill:#FFD700,color:#000
    style ML fill:#FFD700,color:#000
```

**Purpose**: Business-ready aggregates and dimensional models

**Organization**:
- Star/snowflake dimensional models
- Pre-aggregated metrics and KPIs
- Feature stores for ML models
- Business-friendly naming conventions
- Optimized for query performance

---

## Data Flow Patterns

### Batch Processing Flow

```mermaid
sequenceDiagram
    participant Source as Data Sources
    participant ADF as Data Factory
    participant Bronze as Bronze Layer
    participant Spark as Spark Processing
    participant Silver as Silver Layer
    participant Gold as Gold Layer
    participant SQL as Synapse SQL

    Source->>ADF: Extract Data
    ADF->>Bronze: Land Raw Data
    Note over Bronze: Delta Lake Format<br/>Immutable Log

    Spark->>Bronze: Read Raw Data
    Spark->>Spark: Clean & Transform
    Spark->>Silver: Write Refined Data
    Note over Silver: Schema Validation<br/>Quality Checks

    Spark->>Silver: Read Silver Data
    Spark->>Spark: Aggregate & Model
    Spark->>Gold: Write Curated Data
    Note over Gold: Dimensional Models<br/>Optimized for BI

    SQL->>Gold: Query Analytics Data
```

---

### Streaming Processing Flow

```mermaid
sequenceDiagram
    participant IoT as IoT Devices
    participant EH as Event Hubs
    participant ASA as Stream Analytics
    participant Bronze as Bronze Layer
    participant Spark as Spark Streaming
    participant Silver as Silver Layer
    participant Cosmos as Cosmos DB

    IoT->>EH: Send Events
    EH->>ASA: Stream Processing
    ASA->>Bronze: Archive Raw Events
    ASA->>Cosmos: Real-time Aggregates

    Spark->>Bronze: Read Event Stream
    Spark->>Spark: Windowed Operations
    Spark->>Silver: Write Processed Stream
    Note over Silver: Micro-batch Updates<br/>Delta Lake ACID
```

---

## Delta Lake Features

### ACID Transactions

```mermaid
graph TB
    subgraph "Delta Lake ACID Properties"
        A[Atomicity<br/>All or Nothing]
        C[Consistency<br/>Valid State Always]
        I[Isolation<br/>Concurrent Operations]
        D[Durability<br/>Permanent Writes]
    end

    subgraph "Benefits"
        Safety[Data Safety<br/>No Partial Writes]
        Concurrent[Concurrent<br/>Reads/Writes]
        Rollback[Transaction<br/>Rollback]
        Quality[Data Quality<br/>Guaranteed]
    end

    A --> Safety
    C --> Quality
    I --> Concurrent
    D --> Safety

    style A fill:#90EE90
    style C fill:#90EE90
    style I fill:#90EE90
    style D fill:#90EE90
```

---

### Time Travel & Versioning

```mermaid
graph LR
    subgraph "Delta Lake Versions"
        V1[Version 1<br/>Initial Load]
        V2[Version 2<br/>Update 1]
        V3[Version 3<br/>Update 2]
        V4[Version 4<br/>Current]
    end

    subgraph "Operations"
        Query[Query Historic<br/>Version]
        Restore[Restore to<br/>Previous Version]
        Audit[Audit Changes<br/>Over Time]
        Rollback[Rollback Bad<br/>Changes]
    end

    V1 --> V2
    V2 --> V3
    V3 --> V4

    V1 -.-> Query
    V2 -.-> Restore
    V3 -.-> Audit
    V4 -.-> Rollback

    style V1 fill:#E3F2FD
    style V2 fill:#E3F2FD
    style V3 fill:#E3F2FD
    style V4 fill:#90EE90
```

**Time Travel Queries**:
```sql
-- Query data as of specific version
SELECT * FROM delta.`/path/to/table` VERSION AS OF 2

-- Query data as of specific timestamp
SELECT * FROM delta.`/path/to/table` TIMESTAMP AS OF '2025-01-01'
```

---

## Performance Optimization

### Z-Ordering & Data Skipping

```mermaid
graph TB
    subgraph "Optimization Techniques"
        ZOrder[Z-Ordering<br/>Multi-dimensional Clustering]
        Partition[Partitioning<br/>Physical Separation]
        Compact[Compaction<br/>Small File Optimization]
        Stats[Statistics<br/>Data Skipping]
    end

    subgraph "Query Performance Impact"
        FileSkip[Files Skipped<br/>Faster Queries]
        IOReduce[Reduced I/O<br/>Lower Costs]
        Parallel[Better Parallelism<br/>Faster Processing]
    end

    ZOrder --> FileSkip
    Partition --> FileSkip
    Compact --> Parallel
    Stats --> FileSkip

    FileSkip --> IOReduce
    FileSkip --> Parallel

    style ZOrder fill:#FFF3E0
    style Partition fill:#FFF3E0
    style Compact fill:#FFF3E0
    style Stats fill:#FFF3E0
```

**Optimization Commands**:
```sql
-- Z-Order optimization (multi-column)
OPTIMIZE table_name ZORDER BY (col1, col2, col3)

-- Compact small files
OPTIMIZE table_name

-- Vacuum old files (cleanup)
VACUUM table_name RETAIN 168 HOURS
```

---

## Security & Governance

### Multi-Layer Security

```mermaid
graph TB
    subgraph "Security Layers"
        Network[Network Security<br/>VNet, Private Endpoints]
        Identity[Identity & Access<br/>Azure AD, Managed Identity]
        Data[Data Security<br/>Encryption, Masking]
        Audit[Auditing & Compliance<br/>Logs, Purview]
    end

    subgraph "Access Control"
        RBAC[Azure RBAC<br/>Service Level]
        ACL[ACLs<br/>File/Folder Level]
        RowLevel[Row-Level Security<br/>Table Level]
        Column[Column Masking<br/>Field Level]
    end

    Identity --> RBAC
    Data --> ACL
    Data --> RowLevel
    Data --> Column
    Audit -.-> RBAC
    Audit -.-> ACL

    style Network fill:#FFEBEE
    style Identity fill:#E8F5E9
    style Data fill:#E1F5FE
    style Audit fill:#FFF3E0
```

---

## Reference Architecture Links

- [Detailed Architecture](../architecture/delta-lakehouse/detailed-architecture.md)
- [Implementation Guide](../tutorials/synapse/delta-lakehouse-tutorial.md)
- [Best Practices](../best-practices/delta-lake-optimization.md)
- [Code Examples](../code-examples/delta-lake/README.md)

---

*Last Updated: 2025-01-28*
*Diagram Type: Architecture Pattern*
*Technology: Azure Synapse, Delta Lake, Data Lake Gen2*
