---
title: "Batch Architecture Patterns"
description: "Reference architectures and patterns for batch data processing workloads."
tags:
  - architecture
  - batch-architectures
---
# 📦 Batch Architecture Patterns

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


![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Patterns](https://img.shields.io/badge/Patterns-5+-blue?style=flat-square)
![Last Updated](https://img.shields.io/badge/Updated-2025-blue?style=flat-square)

Reference architectures and patterns for batch data processing workloads.

---

## 🎯 Overview

Batch processing handles large volumes of data in scheduled intervals, ideal for:

- **ETL/ELT pipelines**: Transforming and loading data into analytics systems
- **Data warehousing**: Building dimensional models for reporting
- **Historical analysis**: Processing accumulated data for insights
- **Machine learning**: Training models on large datasets

---

## 📊 Pattern Catalog

### [Data Warehouse Patterns](data-warehouse-patterns.md)

Classic dimensional modeling and modern lakehouse approaches.

| Pattern | Use Case | Azure Services |
|---------|----------|----------------|
| Star Schema | OLAP reporting | Synapse Dedicated SQL |
| Snowflake Schema | Complex hierarchies | Synapse Dedicated SQL |
| Data Vault | Auditable history | Databricks, Synapse |
| Medallion | Lakehouse layers | Databricks, Synapse Spark |

### Lambda Architecture

Combining batch and real-time processing layers.

```mermaid
graph LR
    subgraph "Data Sources"
        S[Event Stream]
    end

    subgraph "Speed Layer"
        SP[Stream Analytics]
    end

    subgraph "Batch Layer"
        B1[Data Lake]
        B2[Spark Processing]
    end

    subgraph "Serving Layer"
        SV[Query Engine]
    end

    S --> SP
    S --> B1
    B1 --> B2
    SP --> SV
    B2 --> SV
```

### Kappa Architecture

Simplified architecture using stream processing for both real-time and batch.

```mermaid
graph LR
    S[Event Stream] --> K[Kafka/Event Hubs]
    K --> P[Stream Processor]
    P --> ST[Data Lake]
    ST --> Q[Query Layer]
```

---

## 🏗️ Reference Architecture

### Modern Data Warehouse

```mermaid
graph TB
    subgraph "Sources"
        S1[Operational DBs]
        S2[Files/APIs]
        S3[SaaS Apps]
    end

    subgraph "Ingestion"
        I1[Data Factory]
    end

    subgraph "Storage"
        L1[Bronze Layer<br/>Raw Data]
        L2[Silver Layer<br/>Cleansed]
        L3[Gold Layer<br/>Curated]
    end

    subgraph "Processing"
        P1[Synapse Spark]
        P2[Databricks]
    end

    subgraph "Serving"
        SV1[Synapse SQL]
        SV2[Power BI]
    end

    S1 --> I1
    S2 --> I1
    S3 --> I1
    I1 --> L1
    L1 --> P1
    L1 --> P2
    P1 --> L2
    P2 --> L2
    L2 --> L3
    L3 --> SV1
    SV1 --> SV2
```

---

## 📚 Related Documentation

- [Streaming Architectures](../streaming-architectures/README.md)
- [Hybrid Architectures](../hybrid-architectures/README.md)
- [Implementation Guides](../../04-implementation-guides/README.md)

---

*Last Updated: January 2025*
