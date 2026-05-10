# Azure Analytics Glossary

[🏠 Home](../../README.md) > [📖 Reference](./README.md) > 📚 Glossary

> 📚 __Terminology Reference__
> Comprehensive glossary of Azure analytics terms, acronyms, and concepts.

---

## Navigation

- [A](#a) | [B](#b) | [C](#c) | [D](#d) | [E](#e) | [F](#f) | [G](#g) | [H](#h) | [I](#i) | [J](#j) | [K](#k) | [L](#l) | [M](#m)
- [N](#n) | [O](#o) | [P](#p) | [Q](#q) | [R](#r) | [S](#s) | [T](#t) | [U](#u) | [V](#v) | [W](#w) | [X](#x) | [Y](#y) | [Z](#z)

---

## A

### ACID

__Atomicity, Consistency, Isolation, Durability__
Properties that guarantee database transactions are processed reliably. Delta Lake provides ACID guarantees for data lakes.

__Related:__ [Delta Lake Guide](../code-examples/delta-lake-guide.md)

### ADF

__Azure Data Factory__
Cloud-based data integration service for creating, scheduling, and orchestrating data workflows.

__Related:__ [Azure Data Factory Integration](../code-examples/integration/azure-data-factory.md)

### ADLS

__Azure Data Lake Storage__
Scalable and secure data lake for high-performance analytics workloads. ADLS Gen2 combines the capabilities of ADLS Gen1 and Azure Blob Storage.

__Related:__ [Architecture Overview](../architecture/README.md)

### Apache Spark

Open-source distributed computing system for big data processing. Synapse Spark pools run Apache Spark workloads.

__Related:__ [Spark Performance](../best-practices/spark-performance.md)

### Auto Loader

Delta Lake feature for incrementally and efficiently processing new data files as they arrive in cloud storage.

__Related:__ [Auto Loader Tutorial](../code-examples/delta-lake/ingestion/auto-loader.md)

### Azure Active Directory (Azure AD)

Microsoft's cloud-based identity and access management service. Now known as Microsoft Entra ID.

__Related:__ [Security Best Practices](../best-practices/security.md)

### Azure Purview

Unified data governance service that helps manage and govern on-premises, multi-cloud, and SaaS data. Now part of Microsoft Purview.

__Related:__ [Azure Purview Integration](../code-examples/integration/azure-purview.md)

### Azure Synapse Analytics

Unified analytics service that brings together enterprise data warehousing and big data analytics.

__Related:__ [Platform Overview](../01-overview/README.md)

---

## B

### Batch Processing

Processing large volumes of data collected over a period of time. Contrasts with stream processing.

__Related:__ [Pipeline Optimization](../best-practices/pipeline-optimization.md)

### Broadcast Join

Spark optimization technique where smaller datasets are broadcasted to all executors to avoid shuffling large datasets.

__Related:__ [Spark Performance](../best-practices/spark-performance.md)

### Built-in Serverless Pool

Pre-configured serverless SQL pool included with every Synapse workspace at no additional cost.

__Related:__ [Serverless SQL Overview](../architecture/serverless-sql/README.md)

---

## C

### CDC

__Change Data Capture__
Process of identifying and capturing changes made to data in a database, typically for replication or synchronization.

__Related:__ [CDC Tutorial](../code-examples/delta-lake/cdc/change-data-capture.md)

### CETAS

__CREATE EXTERNAL TABLE AS SELECT__
T-SQL command in serverless SQL pool to create external tables and export query results to storage.

__Related:__ [Serverless SQL Best Practices](../best-practices/serverless-sql-best-practices.md)

### Columnar Storage

Data storage format that stores data tables by column rather than by row. Examples: Parquet, ORC.

__Related:__ [Performance Optimization](../best-practices/performance-optimization.md)

### Compute Node

Individual server in a distributed computing cluster that performs data processing tasks.

__Related:__ [Spark Configuration](./spark-configuration.md)

### Concurrency

Number of simultaneous operations or queries that can run at the same time.

__Related:__ [Performance Optimization](../best-practices/performance-optimization.md)

### Copy Activity

Azure Data Factory activity used to copy data from source to destination with various transformations.

__Related:__ [Azure Data Factory Integration](../code-examples/integration/azure-data-factory.md)

---

## D

### Data Distribution

Strategy for spreading data across compute nodes in a distributed system. Types include hash, round-robin, and replicate.

__Related:__ [SQL Performance](../best-practices/sql-performance.md)

### Data Flow

Visual data transformation tool in Azure Data Factory and Synapse for building ETL logic without coding.

__Related:__ [Integration Guide](../code-examples/integration-guide.md)

### Data Lake

Storage repository that holds vast amounts of raw data in its native format until needed.

__Related:__ [Delta Lakehouse Architecture](../architecture/delta-lakehouse/README.md)

### Data Lakehouse

Architecture that combines the best features of data lakes and data warehouses.

__Related:__ [Delta Lakehouse Overview](../architecture/delta-lakehouse/README.md)

### Data Partitioning

Dividing large datasets into smaller, manageable pieces based on specific criteria (e.g., date, region).

__Related:__ [Delta Lake Optimization](../best-practices/delta-lake-optimization.md)

### Data Skew

Uneven distribution of data across partitions, causing some nodes to process more data than others.

__Related:__ [Spark Performance](../best-practices/spark-performance.md)

### Data Warehouse Unit (DWU)

Measure of compute resources (CPU, memory, I/O) allocated to a dedicated SQL pool.

__Related:__ [Performance Optimization](../best-practices/performance-optimization.md)

### Dedicated SQL Pool

Provisioned resource offering enterprise-scale data warehousing capabilities with guaranteed resources.

__Related:__ [Architecture Overview](../architecture/README.md)

### Delta Lake

Open-source storage layer that brings ACID transactions to data lakes.

__Related:__ [Delta Lake Guide](../code-examples/delta-lake-guide.md)

### Delta Table

Table format in Delta Lake that supports ACID transactions, schema enforcement, and time travel.

__Related:__ [Table Optimization](../code-examples/delta-lake/optimization/table-optimization.md)

### DIU

__Data Integration Unit__
Measure of compute power in Azure Data Factory representing a combination of CPU, memory, and network resources.

__Related:__ [Pipeline Optimization](../best-practices/pipeline-optimization.md)

### Driver

Master process in Apache Spark that coordinates and schedules work across executors.

__Related:__ [Spark Configuration](./spark-configuration.md)

### DW Unit (DWU)

See Data Warehouse Unit.

---

## E

### ETL

__Extract, Transform, Load__
Traditional data integration process that extracts data from sources, transforms it, then loads into destination.

__Related:__ [Integration Guide](../code-examples/integration-guide.md)

### ELT

__Extract, Load, Transform__
Modern approach that loads raw data first, then transforms it in the destination system.

__Related:__ [Delta Lakehouse Architecture](../architecture/delta-lakehouse/README.md)

### Executor

Worker process in Apache Spark that runs tasks and stores data for the application.

__Related:__ [Spark Configuration](./spark-configuration.md)

### External Table

Table definition that references data stored outside the database, typically in a data lake.

__Related:__ [Serverless SQL Guide](../code-examples/serverless-sql-guide.md)

---

## F

### Fault Tolerance

System's ability to continue operating properly in the event of failures.

__Related:__ [Best Practices](../best-practices/README.md)

### File Format

Structure in which data is stored. Common formats: Parquet, CSV, JSON, ORC, Avro.

__Related:__ [Serverless SQL Best Practices](../best-practices/serverless-sql-best-practices.md)

### Firewall Rule

Network security rule that controls incoming and outgoing traffic to Azure resources.

__Related:__ [Network Security](../best-practices/network-security.md)

---

## G

### Graph Database

Database designed to treat relationships between data as equally important as the data itself.

__Related:__ [Architecture Patterns](../03-architecture-patterns/README.md)

---

## H

### Hive Metastore

Central repository of metadata for Hadoop, used by Spark to store table schemas and partition information.

__Related:__ [Shared Metadata](../architecture/shared-metadata/README.md)

### Hot Path

Real-time data processing path for immediate insights. Contrasts with cold path (batch processing).

__Related:__ [Real-time Analytics](../08-solutions/azure-realtime-analytics/README.md)

---

## I

### Idempotent

Operation that produces the same result regardless of how many times it's executed.

__Related:__ [Pipeline Best Practices](../best-practices/pipeline-optimization.md)

### Indexing

Database optimization technique that improves query performance by creating efficient data lookup structures.

__Related:__ [SQL Performance](../best-practices/sql-performance.md)

### Integration Runtime

Compute infrastructure used by Azure Data Factory to provide data integration across different network environments.

__Related:__ [Azure Data Factory Integration](../code-examples/integration/azure-data-factory.md)

---

## J

### JSON

__JavaScript Object Notation__
Lightweight data interchange format that is easy to read and write.

__Related:__ [Serverless SQL Guide](../code-examples/serverless-sql-guide.md)

---

## K

### Key Vault

Azure service for securely storing and accessing secrets, keys, and certificates.

__Related:__ [Security Best Practices](../best-practices/security.md)

---

## L

### Lakehouse

See Data Lakehouse.

### Lazy Evaluation

Execution model where transformations are not executed until an action is called. Used in Apache Spark.

__Related:__ [Spark Performance](../best-practices/spark-performance.md)

### Lineage

Tracking of data's origin, transformations, and movement through systems.

__Related:__ [Azure Purview Integration](../code-examples/integration/azure-purview.md)

### Linked Service

Connection definition to external data sources or compute resources in Azure Synapse or Data Factory.

__Related:__ [Integration Guide](../code-examples/integration-guide.md)

---

## M

### Managed Identity

Azure AD identity managed by Azure, eliminating the need for credentials in code.

__Related:__ [Security Best Practices](../best-practices/security.md)

### Managed Private Endpoint

Private endpoint managed by Azure Synapse for secure connectivity to Azure services.

__Related:__ [Private Link Architecture](../architecture/private-link-architecture.md)

### Mapping Data Flow

Code-free data transformation feature in Azure Data Factory and Synapse.

__Related:__ [Integration Guide](../code-examples/integration-guide.md)

### Medallion Architecture

Data architecture pattern with bronze (raw), silver (cleaned), and gold (aggregated) layers.

__Related:__ [Delta Lakehouse Architecture](../architecture/delta-lakehouse/README.md)

### Merge Operation

Upsert operation (update if exists, insert if not) supported by Delta Lake.

__Related:__ [CDC Tutorial](../code-examples/delta-lake/cdc/change-data-capture.md)

### Metadata

Data that provides information about other data (e.g., schema, statistics, lineage).

__Related:__ [Shared Metadata](../architecture/shared-metadata/README.md)

### MPP

__Massively Parallel Processing__
Architecture that uses many processors working in parallel to quickly execute large-scale data operations.

__Related:__ [Architecture Overview](../architecture/README.md)

---

## N

### Notebook

Interactive document combining code, visualizations, and narrative text. Synapse supports Spark notebooks.

__Related:__ [PySpark Fundamentals](../tutorials/code-labs/pyspark-fundamentals.md)

### NSG

__Network Security Group__
Azure firewall containing security rules to filter network traffic.

__Related:__ [Network Security](../best-practices/network-security.md)

---

## O

### OPENROWSET

T-SQL function in serverless SQL pool for querying files in data lakes without creating external tables.

__Related:__ [Serverless SQL Guide](../code-examples/serverless-sql-guide.md)

### Optimize

Delta Lake command to compact small files into larger ones for better query performance.

__Related:__ [Table Optimization](../code-examples/delta-lake/optimization/table-optimization.md)

### ORC

__Optimized Row Columnar__
Columnar storage file format optimized for Hadoop workloads.

__Related:__ [Performance Optimization](../best-practices/performance-optimization.md)

---

## P

### Parquet

Open-source columnar storage format designed for efficient data storage and retrieval.

__Related:__ [Serverless SQL Guide](../code-examples/serverless-sql-guide.md)

### Partition

Logical division of a large dataset for improved query performance and manageability.

__Related:__ [Delta Lake Optimization](../best-practices/delta-lake-optimization.md)

### Pipeline

Workflow that orchestrates data movement and transformation activities.

__Related:__ [Pipeline Optimization](../best-practices/pipeline-optimization.md)

### PolyBase

Data virtualization feature for querying external data sources using T-SQL.

__Related:__ [SQL Performance](../best-practices/sql-performance.md)

### Private Endpoint

Network interface that connects privately and securely to Azure services using Azure Private Link.

__Related:__ [Private Link Architecture](../architecture/private-link-architecture.md)

### PySpark

Python API for Apache Spark, enabling Spark programming using Python.

__Related:__ [PySpark Fundamentals](../tutorials/code-labs/pyspark-fundamentals.md)

---

## Q

### Query Optimization

Process of improving query performance through various techniques like indexing, statistics, and query rewriting.

__Related:__ [Query Optimization](../code-examples/serverless-sql/query-optimization.md)

---

## R

### RBAC

__Role-Based Access Control__
Authorization system for managing who has access to Azure resources and what they can do.

__Related:__ [Security Best Practices](../best-practices/security.md)

### RDD

__Resilient Distributed Dataset__
Fundamental data structure in Apache Spark representing an immutable distributed collection.

__Related:__ [Spark Performance](../best-practices/spark-performance.md)

### Resource Group

Container that holds related resources for an Azure solution.

__Related:__ [Architecture Overview](../architecture/README.md)

---

## S

### Schema Evolution

Ability to handle changes in data schema over time without breaking existing queries.

__Related:__ [Delta Lake Guide](../code-examples/delta-lake-guide.md)

### Schema on Read

Approach where data schema is applied when data is read, not when it's written. Used in data lakes.

__Related:__ [Serverless SQL Guide](../code-examples/serverless-sql-guide.md)

### Serverless SQL Pool

On-demand SQL query service with pay-per-query pricing model. No infrastructure to manage.

__Related:__ [Serverless SQL Overview](../architecture/serverless-sql/README.md)

### Service Principal

Identity created for use with applications, services, and automation tools to access Azure resources.

__Related:__ [Security Best Practices](../best-practices/security.md)

### Shuffle

Expensive operation in Spark where data is redistributed across partitions.

__Related:__ [Spark Performance](../best-practices/spark-performance.md)

### SLA

__Service Level Agreement__
Commitment between service provider and customer regarding performance and availability.

__Related:__ [Best Practices](../best-practices/README.md)

### Slowly Changing Dimension (SCD)

Dimension that changes slowly over time rather than changing on regular schedule. Types include SCD Type 1, 2, 3.

__Related:__ [CDC Tutorial](../code-examples/delta-lake/cdc/change-data-capture.md)

### Spark Pool

Managed Apache Spark cluster in Azure Synapse Analytics.

__Related:__ [Spark Configuration](./spark-configuration.md)

### SQL Pool

Collective term for both dedicated SQL pools and serverless SQL pools in Synapse.

__Related:__ [Architecture Overview](../architecture/README.md)

### Statistics

Metadata about data distribution that helps query optimizer create efficient execution plans.

__Related:__ [SQL Performance](../best-practices/sql-performance.md)

### Storage Account

Azure resource that provides cloud storage for data objects including blobs, files, queues, and tables.

__Related:__ [Architecture Overview](../architecture/README.md)

### Streaming

Continuous processing of data in real-time as it arrives.

__Related:__ [Real-time Analytics](../08-solutions/azure-realtime-analytics/README.md)

### Synapse Studio

Web-based integrated development environment for Azure Synapse Analytics.

__Related:__ [Environment Setup](../tutorials/synapse/01-environment-setup.md)

### Synapse Workspace

Collaborative environment for cloud-based enterprise analytics in Azure.

__Related:__ [Platform Overview](../01-overview/README.md)

---

## T

### Table Distribution

Strategy for spreading table data across compute nodes. Types: hash, round-robin, replicated.

__Related:__ [SQL Performance](../best-practices/sql-performance.md)

### Time Travel

Delta Lake feature allowing queries of historical versions of data.

__Related:__ [Delta Lake Guide](../code-examples/delta-lake-guide.md)

### Transformation

Operation that modifies data from source format to desired destination format.

__Related:__ [Integration Guide](../code-examples/integration-guide.md)

### Trigger

Automation that determines when a pipeline should run (scheduled, tumbling window, event-based).

__Related:__ [Pipeline Optimization](../best-practices/pipeline-optimization.md)

---

## U

### Upsert

Combination of update and insert operations. Updates existing records or inserts new ones if they don't exist.

__Related:__ [CDC Tutorial](../code-examples/delta-lake/cdc/change-data-capture.md)

---

## V

### Vacuum

Delta Lake command to remove old data files that are no longer referenced.

__Related:__ [Table Optimization](../code-examples/delta-lake/optimization/table-optimization.md)

### VNet

__Virtual Network__
Isolated network in Azure that enables Azure resources to securely communicate with each other.

__Related:__ [Network Security](../best-practices/network-security.md)

### VNet Integration

Connecting Azure services to a virtual network for enhanced security and isolation.

__Related:__ [Private Link Architecture](../architecture/private-link-architecture.md)

---

## W

### Watermark

Marker used in incremental data loading to track which data has been processed.

__Related:__ [Pipeline Optimization](../best-practices/pipeline-optimization.md)

### Workspace

See Synapse Workspace.

---

## X

### XML

__Extensible Markup Language__
Markup language for encoding documents in a format that is both human-readable and machine-readable.

---

## Y

### YARN

__Yet Another Resource Negotiator__
Resource management layer in Hadoop ecosystem. Not directly used in Synapse but relevant for understanding Spark.

---

## Z

### Z-Order

Delta Lake optimization technique that co-locates related information in the same set of files for faster queries.

__Related:__ [Table Optimization](../code-examples/delta-lake/optimization/table-optimization.md)

### Zone Redundancy

Azure storage redundancy option that replicates data across availability zones.

__Related:__ [Best Practices](../best-practices/README.md)

---

## Acronym Quick Reference

| Acronym | Full Term | Category |
|---------|-----------|----------|
| ACID | Atomicity, Consistency, Isolation, Durability | Database |
| ADF | Azure Data Factory | Service |
| ADLS | Azure Data Lake Storage | Service |
| CDC | Change Data Capture | Technique |
| CETAS | CREATE EXTERNAL TABLE AS SELECT | SQL |
| DIU | Data Integration Unit | Performance |
| DWU | Data Warehouse Unit | Performance |
| ELT | Extract, Load, Transform | Pattern |
| ETL | Extract, Transform, Load | Pattern |
| MPP | Massively Parallel Processing | Architecture |
| NSG | Network Security Group | Security |
| ORC | Optimized Row Columnar | File Format |
| RBAC | Role-Based Access Control | Security |
| RDD | Resilient Distributed Dataset | Spark |
| SCD | Slowly Changing Dimension | Data Warehouse |
| SLA | Service Level Agreement | Operations |
| VNet | Virtual Network | Networking |
| YARN | Yet Another Resource Negotiator | Hadoop |

---

## Related Resources

| Resource | Description |
|----------|-------------|
| [Architecture Overview](../architecture/README.md) | Architectural concepts and patterns |
| [Best Practices](../best-practices/README.md) | Implementation best practices |
| [Tutorials](../tutorials/README.md) | Hands-on learning materials |
| [Code Examples](../code-examples/README.md) | Practical code samples |
| [FAQ](../faq.md) | Frequently asked questions |

---

> 💡 __Tip:__ Use Ctrl+F (or Cmd+F on Mac) to quickly search for specific terms on this page.

*Last Updated: January 2025*
