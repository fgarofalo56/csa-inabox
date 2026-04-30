# NiFi Migration: NiFi to Azure Data Factory + Logic Apps

**A detailed guide for migrating Apache NiFi data flows to Azure Data Factory, Logic Apps, and supporting Azure services, including processor-by-processor mapping, flow conversion patterns, and worked examples.**

---

## Overview

Apache NiFi is one of Cloudera's strongest components -- a mature, visual data flow platform with 300+ processors, built-in backpressure, data provenance, and real-time routing. Azure Data Factory is not a 1:1 replacement for NiFi. It is a different tool with a different design philosophy.

**NiFi's paradigm:** FlowFiles move through processor chains. Each processor transforms, routes, or delivers a single FlowFile (or small batch). Back-pressure, prioritization, and provenance are built into the framework.

**ADF's paradigm:** Pipelines orchestrate activities. Each activity operates on datasets (tables, files, blobs). Activities run sequentially or in parallel within a pipeline. Data movement is batch-oriented with support for streaming through integration with Event Hubs and Databricks.

Understanding this paradigm difference is essential. Do not attempt to replicate NiFi processor chains as ADF activities 1:1. Instead, redesign the flow to fit ADF's strengths.

---

## Processor-by-processor mapping

### Data ingestion processors

| NiFi processor                                   | Azure equivalent                                          | Migration approach                                                             |
| ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **GetFile** / **ListFile**                       | ADF Copy Activity (file system source)                    | Self-Hosted IR for on-prem file systems.                                       |
| **GetSFTP** / **ListSFTP** / **FetchSFTP**       | ADF Copy Activity (SFTP connector)                        | Built-in SFTP connector with SSH key or password auth.                         |
| **GetFTP** / **ListFTP** / **FetchFTP**          | ADF Copy Activity (FTP connector)                         | FTP/FTPS connector available.                                                  |
| **GetHTTP** / **InvokeHTTP**                     | ADF Web Activity / Logic App HTTP action                  | Web Activity for simple REST calls; Logic App for complex HTTP workflows.      |
| **ListenHTTP**                                   | Logic App (HTTP trigger) / Azure Functions (HTTP trigger) | Event-driven ingestion via webhook.                                            |
| **ConsumeKafka** / **ConsumeKafka_2_6**          | Event Hubs consumer / Databricks Structured Streaming     | Event Hubs for Kafka-compatible consumption; Databricks for stream processing. |
| **PublishKafka** / **PublishKafka_2_6**          | Event Hubs producer / ADF Event Hub sink                  | Event Hubs Kafka endpoint for direct publish.                                  |
| **GetHDFS** / **ListHDFS** / **FetchHDFS**       | ADF Copy Activity (ADLS Gen2 source)                      | Post-migration, HDFS paths become ADLS Gen2 paths.                             |
| **PutHDFS**                                      | ADF Copy Activity (ADLS Gen2 sink)                        | Write to ADLS Gen2 containers.                                                 |
| **GetMongo** / **PutMongo**                      | ADF Copy Activity (Cosmos DB connector)                   | Cosmos DB MongoDB API or NoSQL API.                                            |
| **GetElasticsearch**                             | ADF Copy Activity (REST connector)                        | Custom REST connector to Elasticsearch/OpenSearch API.                         |
| **QueryDatabaseTable** / **GenerateTableFetch**  | ADF Copy Activity (JDBC/ODBC connector)                   | 100+ database connectors with built-in parallelism.                            |
| **PutDatabaseRecord**                            | ADF Copy Activity (database sink)                         | Bulk insert with configurable batch size.                                      |
| **GetS3Object** / **ListS3** / **FetchS3Object** | ADF Copy Activity (S3 connector)                          | Cross-cloud ingestion from S3 to ADLS.                                         |
| **PutS3Object**                                  | ADF Copy Activity (S3 sink)                               | Rarely needed post-migration.                                                  |

### Data transformation processors

| NiFi processor                                | Azure equivalent                                         | Migration approach                                                 |
| --------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| **ConvertRecord**                             | ADF Mapping Data Flow (format conversion)                | Convert between CSV, JSON, Avro, Parquet in data flows.            |
| **ConvertAvroToJSON** / **ConvertJSONToAvro** | ADF Mapping Data Flow                                    | Schema-aware format conversion.                                    |
| **JoltTransformJSON**                         | ADF Mapping Data Flow (derived column) / Azure Functions | Complex JSON transformations; Functions for JOLT-equivalent logic. |
| **TransformXml**                              | ADF Mapping Data Flow / Azure Functions                  | XSLT transforms in Functions; basic XML in data flows.             |
| **UpdateAttribute**                           | ADF Pipeline variables / parameters                      | Metadata manipulation via pipeline expressions.                    |
| **EvaluateJsonPath**                          | ADF expression: `@json(activity('x').output)`            | JSON path extraction in ADF expressions.                           |
| **ExtractText**                               | ADF Mapping Data Flow (regex) / Azure Functions          | Regex extraction in data flows or Functions.                       |
| **ReplaceText**                               | ADF Mapping Data Flow (replace)                          | String replacement in derived columns.                             |
| **SplitText** / **SplitJson** / **SplitXml**  | ADF ForEach activity / Mapping Data Flow                 | Iterate over split records.                                        |
| **MergeContent**                              | ADF Copy Activity (multiple files to one)                | Merge files during copy; or Databricks for complex merges.         |
| **CompressContent** / **UnpackContent**       | ADF Copy Activity (compression settings)                 | Built-in gzip, snappy, lz4 support.                                |
| **EncryptContent** / **DecryptContent**       | Azure Key Vault + Functions                              | Encryption via Key Vault managed keys.                             |
| **LookupRecord**                              | ADF Lookup Activity + Join in Data Flow                  | Lookup activity for reference data; join in data flows.            |
| **ValidateRecord**                            | ADF Mapping Data Flow (conditional split)                | Schema validation via conditional split + assert.                  |

### Routing processors

| NiFi processor                | Azure equivalent                                 | Migration approach                                   |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| **RouteOnAttribute**          | ADF If Condition / Switch Activity               | Conditional branching based on metadata.             |
| **RouteOnContent**            | ADF Mapping Data Flow (conditional split)        | Content-based routing in data flows.                 |
| **DistributeLoad**            | ADF parallel activities / Event Hubs partitions  | Load distribution via partitioning.                  |
| **ControlRate**               | ADF concurrency settings / Event Hubs throttling | Pipeline and activity concurrency limits.            |
| **Wait**                      | ADF Wait Activity                                | Configurable delay between activities.               |
| **RetryFlowFile**             | ADF retry policy (per activity)                  | Built-in retry with configurable count and interval. |
| **UpdateAttribute (routing)** | ADF Set Variable / Append Variable               | Variable manipulation for flow control.              |

### Delivery processors

| NiFi processor              | Azure equivalent                       | Migration approach                               |
| --------------------------- | -------------------------------------- | ------------------------------------------------ |
| **PutAzureBlobStorage**     | ADF Copy Activity (Blob sink)          | Direct replacement.                              |
| **PutAzureDataLakeStorage** | ADF Copy Activity (ADLS Gen2 sink)     | Direct replacement.                              |
| **PutEmail**                | Logic App (Send Email action)          | Logic App with Office 365 or SendGrid connector. |
| **PutSlack**                | Logic App (Slack connector)            | Logic App with Slack webhook.                    |
| **PutSQL**                  | ADF Copy Activity (database sink)      | Bulk write to SQL databases.                     |
| **PutHiveQL**               | Databricks SQL activity in ADF         | Execute SQL on Databricks via ADF.               |
| **PutParquet** / **PutORC** | ADF Copy Activity (Parquet/Delta sink) | Write Parquet or Delta format to ADLS.           |

---

## NiFi Registry to ADF Git integration

| NiFi Registry feature         | ADF equivalent                              | Notes                                                         |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| **Versioned flows**           | ADF Git integration (Azure DevOps / GitHub) | All pipelines stored as ARM/Bicep JSON in Git.                |
| **Flow snapshots**            | Git commits                                 | Each save is a commit; full version history.                  |
| **Bucket organization**       | Git branches + folders                      | Organize pipelines by domain or team.                         |
| **Promote to production**     | Git PR + CI/CD pipeline                     | ADF publish from collaboration branch to live mode.           |
| **Import/export flows**       | ARM template export/import                  | Pipelines exportable as JSON for cross-environment promotion. |
| **Access control on buckets** | Git repository permissions + ADF RBAC       | Entra ID RBAC on ADF; branch policies on Git.                 |

---

## NiFi clustering to ADF Integration Runtime scaling

| NiFi clustering feature         | ADF equivalent                           | Notes                                                |
| ------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| **NiFi cluster (multi-node)**   | Azure Integration Runtime (auto-scaling) | ADF manages IR scaling internally.                   |
| **Primary node election**       | Not applicable                           | No primary/secondary; ADF orchestrates activities.   |
| **Load balancing across nodes** | Parallel copy / data flow scaling        | ADF parallelizes copy activities automatically.      |
| **Site-to-Site transfer**       | Self-Hosted Integration Runtime (SHIR)   | SHIR bridges on-prem networks to Azure.              |
| **NiFi cluster coordinator**    | ADF service (managed)                    | No user-managed coordinator.                         |
| **Back-pressure**               | Pipeline concurrency limits + Event Hubs | Concurrency controls at pipeline and activity level. |

---

## NiFi Record processing to ADF Mapping Data Flows

NiFi's Record-oriented processors (`ConvertRecord`, `QueryRecord`, `LookupRecord`, `UpdateRecord`, `PartitionRecord`) provide in-flow data transformation. The ADF equivalent is Mapping Data Flows.

### Mapping Data Flow equivalents

| NiFi Record operation             | ADF Mapping Data Flow transformation    | Notes                                            |
| --------------------------------- | --------------------------------------- | ------------------------------------------------ |
| **QueryRecord** (SQL on records)  | SQL-based source query / Derived Column | SQL queries on inline datasets.                  |
| **UpdateRecord** (modify fields)  | Derived Column transformation           | Create/modify columns with expressions.          |
| **LookupRecord**                  | Lookup transformation                   | Join with reference datasets.                    |
| **PartitionRecord**               | Window / Aggregate transformations      | Partition-based operations.                      |
| **SplitRecord**                   | Conditional Split                       | Route records based on conditions.               |
| **ConvertRecord** (format change) | Sink format configuration               | Set output format (Parquet, JSON, CSV, Delta).   |
| **ValidateRecord**                | Assert / Conditional Split              | Validate records against schema; route failures. |

### Example: NiFi Record flow to ADF Data Flow

```
NiFi flow:
  ConsumeKafka → ConvertRecord (JSON→Avro) → UpdateRecord (add timestamp)
  → LookupRecord (enrich from DB) → RouteOnAttribute (valid/invalid)
  → PutAzureDataLakeStorage (valid) / PutKafka (invalid → DLQ)

ADF equivalent:
  Event Hubs trigger → Databricks Structured Streaming job:
    - Read from Event Hubs (JSON)
    - Add timestamp column (withColumn)
    - Join with reference table (broadcast join)
    - Filter valid/invalid
    - Write valid to ADLS (Delta)
    - Write invalid to Event Hubs DLQ
```

---

## NiFi Site-to-Site to ADF Self-Hosted IR

NiFi Site-to-Site (S2S) transfers data between NiFi instances across networks. The ADF equivalent is the Self-Hosted Integration Runtime (SHIR).

| NiFi S2S feature                               | ADF SHIR equivalent                                              |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| **Push data from remote NiFi to central NiFi** | SHIR reads from on-prem sources, pushes to ADF                   |
| **Pull data from central NiFi to remote NiFi** | ADF pipeline triggers SHIR to fetch from on-prem                 |
| **Encrypted transfer (TLS)**                   | SHIR uses TLS by default; private endpoint support               |
| **Compression**                                | Automatic compression in transit                                 |
| **Multiple Remote Process Groups**             | Multiple SHIR nodes (high availability group)                    |
| **Port-based communication**                   | Outbound HTTPS only (port 443); no inbound firewall rules needed |

---

## Worked example: convert NiFi flow to ADF pipeline

### Original NiFi flow

A common NiFi pattern: ingest data from an SFTP server, validate and transform the files, and load into HDFS (now ADLS Gen2).

```
NiFi Flow: "Daily Vendor File Ingestion"

ListSFTP (vendor-sftp.example.com:/outbound/)
  → FetchSFTP (download file)
    → ValidateRecord (CSV schema validation)
      → [valid] → ConvertRecord (CSV → Parquet)
        → UpdateAttribute (add ingestion_timestamp, source_system)
          → PutHDFS (/data/raw/vendor_files/)
      → [invalid] → PutEmail (alert data-eng@example.com)
        → PutHDFS (/data/quarantine/vendor_files/)
```

### Converted ADF pipeline

```json
{
    "name": "daily_vendor_file_ingestion",
    "properties": {
        "activities": [
            {
                "name": "list_vendor_files",
                "type": "GetMetadata",
                "typeProperties": {
                    "dataset": { "referenceName": "sftp_vendor_outbound" },
                    "fieldList": ["childItems"]
                }
            },
            {
                "name": "for_each_file",
                "type": "ForEach",
                "dependsOn": [
                    {
                        "activity": "list_vendor_files",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "items": "@activity('list_vendor_files').output.childItems",
                    "isSequential": false,
                    "batchCount": 10,
                    "activities": [
                        {
                            "name": "copy_and_convert",
                            "type": "Copy",
                            "typeProperties": {
                                "source": {
                                    "type": "DelimitedTextSource",
                                    "storeSettings": {
                                        "type": "SftpReadSettings"
                                    }
                                },
                                "sink": {
                                    "type": "ParquetSink",
                                    "storeSettings": {
                                        "type": "AzureBlobFSWriteSettings"
                                    }
                                },
                                "enableStaging": false
                            }
                        }
                    ]
                }
            },
            {
                "name": "validate_data",
                "type": "DatabricksNotebook",
                "dependsOn": [
                    {
                        "activity": "for_each_file",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "notebookPath": "/pipelines/vendor_files/validate_and_quarantine",
                    "baseParameters": {
                        "source_path": "abfss://bronze@storage.dfs.core.windows.net/vendor_files/",
                        "quarantine_path": "abfss://quarantine@storage.dfs.core.windows.net/vendor_files/"
                    }
                }
            }
        ],
        "annotations": ["vendor-ingestion", "daily"]
    }
}
```

### Key design decisions in the conversion

| NiFi pattern                  | ADF decision                                       | Rationale                                                                       |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| ListSFTP + FetchSFTP          | GetMetadata + ForEach + Copy                       | ADF separates listing from fetching. ForEach enables parallelism.               |
| ValidateRecord (in-flow)      | Databricks notebook (post-copy)                    | ADF Copy Activity cannot validate mid-stream. Validate after landing in bronze. |
| ConvertRecord (CSV → Parquet) | Copy Activity sink format = Parquet                | ADF Copy Activity handles format conversion natively.                           |
| UpdateAttribute               | Pipeline parameters / notebook logic               | Metadata added during Databricks validation step.                               |
| PutEmail (on failure)         | Logic App triggered by ADF failure webhook         | ADF triggers Logic App for alerting.                                            |
| PutHDFS (quarantine)          | Databricks notebook writes to quarantine container | Invalid records written to separate storage container.                          |

---

## When to use Logic Apps instead of ADF

Some NiFi patterns map better to Logic Apps than ADF:

| Pattern                                 | Use Logic Apps                     | Use ADF                                |
| --------------------------------------- | ---------------------------------- | -------------------------------------- |
| **Webhook / event-driven**              | Yes                                | No                                     |
| **Email / Teams / Slack notifications** | Yes                                | No (trigger Logic App from ADF)        |
| **REST API orchestration**              | Yes (complex multi-step API calls) | ADF Web Activity (simple GET/POST)     |
| **File polling (SFTP/FTP)**             | Logic App SFTP trigger             | ADF schedule + Copy Activity           |
| **Low-latency event routing**           | Yes                                | No (ADF has pipeline startup overhead) |
| **Batch data movement**                 | No                                 | Yes                                    |
| **Data transformation**                 | No                                 | Yes (Mapping Data Flows)               |
| **Complex orchestration**               | No                                 | Yes (pipelines with dependencies)      |

---

## Migration strategy for complex NiFi environments

### Phase 1: Inventory (1-2 weeks)

1. Export all NiFi flow definitions (XML or JSON via NiFi REST API)
2. Categorize flows by type: batch ingestion, real-time streaming, API integration, file processing
3. Identify processor usage frequency (which processors are used most)
4. Map data lineage from source to sink for each flow

### Phase 2: Classify migration approach (1 week)

| NiFi flow type                     | Migration target                    | Complexity |
| ---------------------------------- | ----------------------------------- | ---------- |
| Batch file ingestion (SFTP/FTP/FS) | ADF Copy Activity + pipeline        | Low        |
| Database ingestion (JDBC)          | ADF Copy Activity                   | Low        |
| Kafka/Event streaming              | Event Hubs + Databricks Streaming   | Medium     |
| Complex real-time routing          | Logic Apps + Functions + Event Grid | High       |
| Record transformation pipelines    | ADF Mapping Data Flows              | Medium     |
| API integration flows              | Logic Apps                          | Medium     |

### Phase 3: Convert and test (4-8 weeks)

- Convert flows by priority (highest business value first)
- Run NiFi and ADF in parallel for validation
- Compare throughput, latency, and data quality
- Decommission NiFi flows only after ADF equivalent is validated

### Phase 4: Decommission NiFi (2 weeks)

- Redirect all data sources to ADF endpoints
- Archive NiFi flow definitions for reference
- Shut down NiFi cluster
- Reassign NiFi administrators to ADF pipeline management

---

## Next steps

1. **Walk through the [NiFi to ADF Tutorial](tutorial-nifi-to-adf.md)** for a hands-on conversion exercise
2. **Review the [Feature Mapping](feature-mapping-complete.md)** for the full component comparison
3. **See the [Benchmarks](benchmarks.md)** for NiFi vs ADF throughput comparisons

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
