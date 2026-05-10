# Serverless SQL Pool Architecture Diagram

[🏠 Home](../../README.md) > [📊 Diagrams](README.md) > Serverless SQL Architecture

## Overview

This diagram illustrates the Azure Synapse Serverless SQL Pool architecture, showing how it enables on-demand querying of data lake files using familiar T-SQL syntax without managing infrastructure or dedicated resources.

---

## Complete Serverless SQL Architecture

```mermaid
graph TB
    subgraph "Data Sources & Storage"
        subgraph "Azure Data Lake Storage Gen2"
            Raw[Raw Zone<br/>CSV, JSON, Logs]
            Parquet[Optimized Zone<br/>Parquet, Delta Lake]
            Structured[Structured Zone<br/>Relational Format]
        end

        Blob[Azure Blob Storage<br/>Archive, Backup]
        CosmosDB[Cosmos DB<br/>Analytical Store]
    end

    subgraph "Serverless SQL Pool"
        subgraph "Query Processing"
            Parser[SQL Parser<br/>T-SQL Compatibility]
            Optimizer[Query Optimizer<br/>Pushdown Predicates]
            Executor[Distributed Execution<br/>Auto-scaling]
        end

        subgraph "Metadata Services"
            Schema[Schema Inference<br/>Auto-discovery]
            Stats[Statistics<br/>Cost-based Optimization]
            Cache[Result Cache<br/>Query Acceleration]
        end

        subgraph "Security & Access"
            AAD[Azure AD Auth<br/>Managed Identity]
            ACL[ACL Enforcement<br/>File/Folder Level]
            RBAC[RBAC<br/>Database Objects]
        end
    end

    subgraph "Data Virtualization"
        ExtTable[External Tables<br/>Schema-on-Read]
        OpenRowset[OPENROWSET<br/>Ad-hoc Queries]
        Views[Views & Procs<br/>Logical Layer]
        ExtDataSource[External Data Sources<br/>Connection Strings]
    end

    subgraph "Query Interfaces"
        SSMS[SQL Server<br/>Management Studio]
        AzureStudio[Azure Data<br/>Studio]
        PowerBI[Power BI<br/>DirectQuery]
        Apps[Applications<br/>JDBC/ODBC]
    end

    subgraph "Monitoring & Management"
        QueryInsights[Query Insights<br/>Performance Analysis]
        Monitor[Azure Monitor<br/>Metrics & Logs]
        CostMgmt[Cost Management<br/>Data Processed Tracking]
    end

    %% Data Flow
    Raw --> Parser
    Parquet --> Parser
    Structured --> Parser
    Blob --> Parser
    CosmosDB --> Parser

    Parser --> Optimizer
    Optimizer --> Schema
    Optimizer --> Stats
    Schema --> Executor
    Stats --> Executor

    Executor --> Cache
    Cache --> ExtTable
    Cache --> OpenRowset

    ExtTable --> Views
    OpenRowset --> Views
    ExtDataSource -.-> ExtTable
    ExtDataSource -.-> OpenRowset

    %% Security
    AAD -.-> Parser
    ACL -.-> Executor
    RBAC -.-> Views

    %% Query Interface
    SSMS --> Parser
    AzureStudio --> Parser
    PowerBI --> Parser
    Apps --> Parser

    Views --> PowerBI
    Views --> Apps
    Views --> SSMS

    %% Monitoring
    Executor -.-> QueryInsights
    Parser -.-> Monitor
    Optimizer -.-> CostMgmt

    %% Styling
    style Raw fill:#E3F2FD
    style Parquet fill:#E8F5E9
    style Structured fill:#FFF3E0

    style Parser fill:#E1F5FE
    style Optimizer fill:#E1F5FE
    style Executor fill:#E1F5FE

    style Schema fill:#F3E5F5
    style Stats fill:#F3E5F5
    style Cache fill:#C8E6C9

    style ExtTable fill:#FFF9C4
    style OpenRowset fill:#FFF9C4
    style Views fill:#FFF9C4

    style PowerBI fill:#FFCCBC
```

---

## Query Processing Flow

### Ad-hoc Query with OPENROWSET

```mermaid
sequenceDiagram
    participant User as User/Application
    participant SQL as Serverless SQL Pool
    participant Meta as Metadata Service
    participant Storage as Data Lake Gen2
    participant Cache as Result Cache

    User->>SQL: Submit OPENROWSET Query
    Note over User,SQL: SELECT * FROM OPENROWSET(...)<br/>WHERE date > '2024-01-01'

    SQL->>Meta: Infer Schema
    Meta->>Storage: Read Sample Files
    Storage-->>Meta: Return Sample Data
    Meta-->>SQL: Schema Definition

    SQL->>SQL: Parse & Optimize Query
    Note over SQL: Apply predicate pushdown<br/>Partition elimination

    SQL->>Storage: Read Filtered Data
    Note over Storage: Only scan required files<br/>Based on predicates

    Storage-->>SQL: Return Query Results
    SQL->>Cache: Store Result Set
    Cache-->>User: Return Results

    Note over User,Cache: Subsequent identical queries<br/>served from cache
```

---

### External Table Query

```mermaid
sequenceDiagram
    participant User as User/Application
    participant SQL as Serverless SQL Pool
    participant Meta as Metadata Catalog
    participant Storage as Data Lake Gen2

    User->>SQL: CREATE EXTERNAL TABLE
    Note over User,SQL: Define schema once

    SQL->>Meta: Store Table Definition
    Meta-->>SQL: Confirmation

    User->>SQL: SELECT FROM External Table
    SQL->>Meta: Retrieve Schema
    Meta-->>SQL: Table Metadata

    SQL->>SQL: Query Optimization
    Note over SQL: Use statistics if available<br/>Apply filters

    SQL->>Storage: Execute Query
    Storage-->>SQL: Return Results
    SQL-->>User: Query Results
```

---

## Data Virtualization Patterns

### OPENROWSET Pattern (Schema-on-Read)

```mermaid
graph LR
    subgraph "Query Types with OPENROWSET"
        Single[Single File<br/>OPENROWSET&#40;...file.parquet&#41;]
        Wildcard[Multiple Files<br/>OPENROWSET&#40;.../*.parquet&#41;]
        Partitioned[Partitioned Data<br/>OPENROWSET&#40;.../year=*/...&#41;]
    end

    subgraph "Format Support"
        Parquet[Parquet<br/>Columnar]
        CSV[CSV<br/>Delimited Text]
        JSON[JSON<br/>Semi-structured]
        Delta[Delta Lake<br/>Versioned]
    end

    subgraph "Schema Handling"
        Auto[Auto Schema<br/>Inference]
        Explicit[Explicit Schema<br/>WITH Clause]
        Metadata[Metadata Columns<br/>filename&#40;&#41;, filepath&#40;&#41;]
    end

    Single --> Parquet
    Wildcard --> CSV
    Partitioned --> Delta

    Parquet --> Auto
    CSV --> Explicit
    JSON --> Metadata

    style Single fill:#E1F5FE
    style Wildcard fill:#E1F5FE
    style Partitioned fill:#E1F5FE
```

**Example Query**:
```sql
-- Ad-hoc query with schema inference
SELECT *
FROM OPENROWSET(
    BULK 'https://datalake.dfs.core.windows.net/data/sales/*.parquet',
    FORMAT = 'PARQUET'
) AS sales
WHERE order_date >= '2024-01-01';
```

---

### External Table Pattern (Schema-on-Write)

```mermaid
graph TB
    subgraph "External Table Components"
        DataSource[External Data Source<br/>Connection String]
        FileFormat[External File Format<br/>Parquet, CSV, JSON]
        ExtTable[External Table<br/>Schema Definition]
    end

    subgraph "Benefits"
        Reuse[Schema Reusability<br/>Define Once]
        Security[Security Management<br/>Credentials Abstracted]
        Perf[Performance<br/>Statistics Available]
    end

    subgraph "Management"
        Create[CREATE EXTERNAL TABLE]
        Alter[ALTER EXTERNAL TABLE]
        Drop[DROP EXTERNAL TABLE]
        Stats[CREATE STATISTICS]
    end

    DataSource --> ExtTable
    FileFormat --> ExtTable
    ExtTable --> Reuse
    ExtTable --> Security
    ExtTable --> Perf

    Create --> ExtTable
    Stats --> Perf

    style DataSource fill:#FFF3E0
    style FileFormat fill:#FFF3E0
    style ExtTable fill:#E8F5E9
```

**Example Setup**:
```sql
-- Create external data source
CREATE EXTERNAL DATA SOURCE SalesDataLake
WITH (
    LOCATION = 'https://datalake.dfs.core.windows.net/sales'
);

-- Create external file format
CREATE EXTERNAL FILE FORMAT ParquetFormat
WITH (
    FORMAT_TYPE = PARQUET,
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec'
);

-- Create external table
CREATE EXTERNAL TABLE SalesOrders (
    OrderID INT,
    CustomerID INT,
    OrderDate DATE,
    Amount DECIMAL(10,2)
)
WITH (
    LOCATION = '/orders/*.parquet',
    DATA_SOURCE = SalesDataLake,
    FILE_FORMAT = ParquetFormat
);

-- Query like a regular table
SELECT * FROM SalesOrders WHERE OrderDate >= '2024-01-01';
```

---

## Query Optimization Strategies

### Predicate Pushdown & Partition Elimination

```mermaid
graph TB
    subgraph "Query Submitted"
        Q[SELECT *<br/>FROM sales<br/>WHERE year = 2024<br/>AND region = 'West']
    end

    subgraph "Optimizer Actions"
        Parse[Parse Query<br/>Extract Predicates]
        Analyze[Analyze Storage<br/>Partitioning Scheme]
        Pushdown[Apply Pushdown<br/>Filter at Source]
        Eliminate[Eliminate Partitions<br/>Skip Irrelevant Data]
    end

    subgraph "Storage Scan"
        Before[Before Optimization<br/>Scan 1000 files]
        After[After Optimization<br/>Scan 10 files]
    end

    subgraph "Performance Impact"
        Time[90% Faster<br/>Query Time]
        Cost[90% Lower<br/>Data Scanned]
        Concurrency[More Concurrent<br/>Queries]
    end

    Q --> Parse
    Parse --> Analyze
    Analyze --> Pushdown
    Pushdown --> Eliminate

    Before -.->|Without Optimization| Time
    After --> Time
    After --> Cost
    After --> Concurrency

    style Q fill:#FFEBEE
    style Parse fill:#E1F5FE
    style Eliminate fill:#C8E6C9
    style After fill:#C8E6C9
    style Time fill:#A5D6A7
```

---

### Result Set Caching

```mermaid
graph LR
    subgraph "First Query Execution"
        Q1[Query Submitted]
        Exec1[Execute Against<br/>Data Lake]
        Cache1[Store in<br/>Result Cache]
        Return1[Return Results<br/>60 sec]
    end

    subgraph "Subsequent Executions"
        Q2[Same Query]
        Check[Check Cache]
        Return2[Return from Cache<br/>< 1 sec]
    end

    subgraph "Cache Management"
        TTL[Time-to-Live<br/>24-48 hours]
        Invalidate[Invalidate on<br/>Data Change]
        Size[Size Limits<br/>Auto-eviction]
    end

    Q1 --> Exec1
    Exec1 --> Cache1
    Cache1 --> Return1

    Q2 --> Check
    Check -->|Cache Hit| Return2
    Check -->|Cache Miss| Exec1

    Cache1 -.-> TTL
    Cache1 -.-> Invalidate
    Cache1 -.-> Size

    style Cache1 fill:#C8E6C9
    style Return2 fill:#A5D6A7
    style Return1 fill:#FFF9C4
```

---

## File Format Optimization

### Format Comparison

```mermaid
graph TB
    subgraph "File Formats Performance"
        direction LR

        subgraph "CSV"
            CSV1[Text Format]
            CSV2[Row-based]
            CSV3[No Compression]
            CSV4[Slow Queries]
        end

        subgraph "Parquet"
            P1[Binary Format]
            P2[Columnar]
            P3[Built-in Compression]
            P4[Fast Queries]
        end

        subgraph "Delta Lake"
            D1[Parquet + Logs]
            D2[ACID Transactions]
            D3[Time Travel]
            D4[Optimized Performance]
        end
    end

    subgraph "Query Performance"
        Fast[< 1 sec]
        Medium[1-10 sec]
        Slow[> 10 sec]
    end

    subgraph "Cost per Query"
        Low[$]
        Med[$$]
        High[$$$]
    end

    CSV4 --> Slow
    P4 --> Medium
    D4 --> Fast

    CSV4 --> High
    P4 --> Med
    D4 --> Low

    style P1 fill:#E8F5E9
    style P2 fill:#E8F5E9
    style P3 fill:#E8F5E9
    style P4 fill:#C8E6C9

    style D1 fill:#E8F5E9
    style D2 fill:#E8F5E9
    style D3 fill:#E8F5E9
    style D4 fill:#A5D6A7
```

### Recommended Format Strategy

| Data Stage | Format | Reason | Cost Impact |
|------------|--------|--------|-------------|
| __Raw/Landing__ | CSV, JSON | Source format preservation | Higher query cost |
| __Refined/Cleansed__ | Parquet | Optimized for analytics | Medium cost |
| __Curated/Gold__ | Delta Lake | Best performance + ACID | Lowest cost |

---

## Cost Optimization Strategies

### Data Scanned vs Query Cost

```mermaid
graph TB
    subgraph "Factors Affecting Cost"
        DataSize[Amount of Data<br/>Scanned in TB]
        FileType[File Format<br/>CSV vs Parquet]
        Partition[Partition<br/>Elimination]
        Compression[Compression<br/>Codec]
    end

    subgraph "Cost Calculation"
        Formula[Cost = Data Scanned &#40;TB&#41;<br/>× $5 per TB]
    end

    subgraph "Optimization Techniques"
        Convert[Convert to<br/>Parquet/Delta]
        PartitionData[Partition by<br/>Date/Category]
        CreateStats[Create<br/>Statistics]
        FilterEarly[Apply Filters<br/>in WHERE Clause]
    end

    subgraph "Cost Savings"
        S1[60-80% Reduction<br/>Parquet vs CSV]
        S2[80-95% Reduction<br/>With Partitioning]
        S3[Result Caching<br/>Near Zero Cost]
    end

    DataSize --> Formula
    FileType --> Formula
    Partition --> Formula

    Convert --> S1
    PartitionData --> S2
    CreateStats --> S2
    FilterEarly --> S2

    style Formula fill:#FFEBEE
    style S1 fill:#C8E6C9
    style S2 fill:#A5D6A7
    style S3 fill:#81C784
```

**Cost Optimization Example**:
```sql
-- High Cost: Full table scan on CSV
SELECT AVG(amount)
FROM OPENROWSET(
    BULK 'https://.../sales/**/*.csv',
    FORMAT = 'CSV'
) AS sales;
-- Scans: 100 GB, Cost: $0.50

-- Optimized: Filtered query on Parquet with partitioning
SELECT AVG(amount)
FROM OPENROWSET(
    BULK 'https://.../sales/year=2024/month=01/*.parquet',
    FORMAT = 'PARQUET'
) AS sales
WHERE region = 'West';
-- Scans: 2 GB, Cost: $0.01 (98% savings)
```

---

## Security Architecture

### Multi-Layer Security Model

```mermaid
graph TB
    subgraph "Authentication Layer"
        AAD[Azure Active Directory<br/>Identity Management]
        MI[Managed Identity<br/>Service Principal]
        SAS[Shared Access Signature<br/>Limited Access]
    end

    subgraph "Authorization Layer"
        StorageRBAC[Storage RBAC<br/>Blob Data Reader]
        ACLs[ACLs<br/>File/Folder Permissions]
        SQLRBAC[SQL RBAC<br/>Database Roles]
    end

    subgraph "Data Protection"
        Encryption[Encryption at Rest<br/>Storage Service Encryption]
        TLS[Encryption in Transit<br/>TLS 1.2+]
        Masking[Dynamic Data Masking<br/>Sensitive Fields]
    end

    subgraph "Access Control"
        User[User/Application]
        Credential[Database Scoped<br/>Credential]
        DataSource[External Data<br/>Source]
        Storage[Data Lake Storage]
    end

    AAD --> StorageRBAC
    MI --> StorageRBAC
    SAS --> ACLs

    User --> AAD
    User --> Credential
    Credential --> DataSource
    DataSource --> Storage

    StorageRBAC -.-> Storage
    ACLs -.-> Storage
    Encryption -.-> Storage

    style AAD fill:#E8F5E9
    style StorageRBAC fill:#FFF3E0
    style Encryption fill:#E1F5FE
    style Storage fill:#F3E5F5
```

---

## Use Case Patterns

### Pattern 1: Ad-hoc Data Exploration

```mermaid
graph LR
    Analyst[Data Analyst] --> SSMS[SQL Server<br/>Management Studio]
    SSMS --> Query[OPENROWSET Query<br/>Explore Raw Files]
    Query --> DataLake[Data Lake<br/>Raw Zone]
    DataLake --> Results[Quick Insights<br/>Pay-per-Query]

    style Query fill:#E1F5FE
    style Results fill:#C8E6C9
```

**Best For**:
- Exploring new data sources
- One-time analysis
- Prototyping queries
- Data quality checks

---

### Pattern 2: Self-Service BI

```mermaid
graph TB
    Users[Business Users] --> PowerBI[Power BI]
    PowerBI --> ExtTables[External Tables<br/>Semantic Layer]
    ExtTables --> Views[Views & Stored Procs<br/>Business Logic]
    Views --> DataLake[Data Lake<br/>Curated Zone]

    style ExtTables fill:#FFF3E0
    style Views fill:#E8F5E9
    style DataLake fill:#E1F5FE
```

**Best For**:
- Business intelligence dashboards
- Self-service reporting
- Departmental analytics
- Cost-effective queries

---

### Pattern 3: Data Lake Querying

```mermaid
graph LR
    DataLake[Data Lake<br/>Multi-Zone] --> Bronze[Bronze Layer<br/>OPENROWSET]
    DataLake --> Silver[Silver Layer<br/>External Tables]
    DataLake --> Gold[Gold Layer<br/>Views]

    Bronze --> Exploration[Data Exploration]
    Silver --> Integration[Data Integration]
    Gold --> Analytics[Business Analytics]

    style Bronze fill:#CD7F32,color:#000
    style Silver fill:#C0C0C0,color:#000
    style Gold fill:#FFD700,color:#000
```

**Best For**:
- Medallion architecture
- Progressive data refinement
- Cost-optimized analytics
- Scalable queries

---

## Performance Best Practices

### Query Optimization Checklist

```mermaid
graph TB
    subgraph "Before Writing Query"
        Format[✓ Use Parquet or Delta Lake]
        Partition[✓ Leverage Partitioning]
        Columns[✓ Select Only Needed Columns]
    end

    subgraph "Query Design"
        Where[✓ Apply WHERE Filters]
        Stats[✓ Create Statistics]
        Aggregate[✓ Aggregate in SQL]
        Join[✓ Optimize JOIN Order]
    end

    subgraph "Schema Management"
        ExtTable[✓ Use External Tables]
        DataTypes[✓ Explicit Data Types]
        Compress[✓ Enable Compression]
    end

    subgraph "Monitoring"
        QPI[✓ Review Query Performance Insights]
        Cost[✓ Monitor Data Scanned]
        Optimize[✓ Iteratively Optimize]
    end

    Format --> Where
    Partition --> Where
    Where --> ExtTable
    Stats --> Join
    ExtTable --> QPI

    style Format fill:#C8E6C9
    style Where fill:#C8E6C9
    style ExtTable fill:#C8E6C9
    style QPI fill:#C8E6C9
```

---

## Reference Links

- [Serverless SQL Overview](../architecture/serverless-sql/serverless-overview.md)
- [Detailed Architecture](../architecture/serverless-sql/detailed-architecture.md)
- [Best Practices](../best-practices/serverless-sql-best-practices.md)
- [Code Examples](../code-examples/serverless-sql/README.md)
- [Performance Optimization](../best-practices/sql-performance.md)

---

*Last Updated: 2025-01-28*
*Diagram Type: Service Architecture*
*Technology: Azure Synapse Serverless SQL Pool*
