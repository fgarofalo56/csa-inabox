[← OSS Alternatives](../../csa_platform/oss_alternatives/README.md)

# OSS Migration Playbook


> [!NOTE]
> **TL;DR:** Step-by-step migration guide for moving from Azure PaaS services to open-source alternatives on AKS. Covers entity mapping, pipeline conversion, SQL dialect translation, dashboard recreation, and index schema migration.

This playbook provides detailed migration procedures for each Azure-to-OSS service pair in the CSA-in-a-Box platform. Use it when Azure Government features are limited or when a full OSS deployment is preferred.

## Table of Contents

- [Migration Overview](#migration-overview)
- [Purview → Apache Atlas](#purview--apache-atlas)
- [ADF → Apache NiFi](#adf--apache-nifi)
- [Synapse Serverless → Trino](#synapse-serverless--trino)
- [Power BI → Apache Superset](#power-bi--apache-superset)
- [Azure AI Search → OpenSearch](#azure-ai-search--opensearch)
- [ADF Orchestration → Apache Airflow](#adf-orchestration--apache-airflow)
- [Post-Migration Validation](#post-migration-validation)

---

## Migration Overview

| Azure Service | OSS Alternative | Complexity | Estimated Effort |
|---|---|---|---|
| Microsoft Purview | Apache Atlas | High | 2-4 weeks |
| Azure Data Factory | Apache NiFi | Medium | 1-3 weeks |
| Synapse Serverless | Trino | Medium | 1-2 weeks |
| Power BI | Apache Superset | Medium | 2-3 weeks |
| Azure AI Search | OpenSearch | High | 2-4 weeks |
| ADF Orchestration | Apache Airflow | Medium | 1-2 weeks |

### Prerequisites

- AKS cluster deployed (see `scripts/deploy-oss-stack.sh`)
- OSS Helm charts installed
- ADLS Gen2 storage accessible from AKS
- Network connectivity between Azure PaaS and AKS (if hybrid)

---

## Purview → Apache Atlas

### Entity Type Mapping

| Purview Entity | Atlas Entity | Notes |
|---|---|---|
| `azure_datalake_gen2_resource_set` | `hdfs_path` | Map ADLS paths to HDFS-style paths |
| `azure_sql_table` | `rdbms_table` | Use RDBMS model for relational sources |
| `azure_sql_column` | `rdbms_column` | Column-level lineage preserved |
| `purview_custom_type` | Atlas `typedef` | Recreate custom types via REST API |

### Glossary Migration

Export Purview glossary terms and import into Atlas:

```python
# export_purview_glossary.py
import requests
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
token = credential.get_token("https://purview.azure.net/.default")

# Export glossary from Purview
purview_url = "https://{account}.purview.azure.com"
headers = {"Authorization": f"Bearer {token.token}"}

glossary = requests.get(
    f"{purview_url}/catalog/api/atlas/v2/glossary",
    headers=headers
).json()

# Transform for Atlas import
atlas_url = "http://atlas-service:21000"
atlas_auth = ("admin", "admin")

for term in glossary.get("terms", []):
    atlas_term = {
        "name": term["name"],
        "shortDescription": term.get("shortDescription", ""),
        "longDescription": term.get("longDescription", ""),
        "anchor": {"glossaryGuid": atlas_glossary_guid},
    }
    requests.post(
        f"{atlas_url}/api/atlas/v2/glossary/term",
        json=atlas_term,
        auth=atlas_auth
    )
```

### Classification Translation

| Purview Classification | Atlas Classification | Tag |
|---|---|---|
| `MICROSOFT.PERSONAL.NAME` | `PII_Name` | Custom tag |
| `MICROSOFT.PERSONAL.EMAIL` | `PII_Email` | Custom tag |
| `MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER` | `PCI_CreditCard` | Custom tag |

```python
# Create Atlas classification types
classification_defs = {
    "classificationDefs": [
        {
            "name": "PII_Name",
            "description": "Personally Identifiable Information - Name",
            "superTypes": ["PII"],
            "attributeDefs": []
        },
        {
            "name": "PII_Email",
            "description": "Personally Identifiable Information - Email",
            "superTypes": ["PII"],
            "attributeDefs": []
        },
        {
            "name": "PCI_CreditCard",
            "description": "PCI DSS - Credit Card Number",
            "superTypes": [],
            "attributeDefs": []
        }
    ]
}

requests.post(
    f"{atlas_url}/api/atlas/v2/types/typedefs",
    json=classification_defs,
    auth=atlas_auth
)
```

### Lineage Migration

```python
# Purview lineage → Atlas lineage
# Atlas uses "Process" entities to represent lineage connections

process_entity = {
    "entity": {
        "typeName": "Process",
        "attributes": {
            "name": "ETL_Pipeline_01",
            "qualifiedName": "etl_pipeline_01@csa_platform",
            "inputs": [{"typeName": "hdfs_path", "uniqueAttributes": {"qualifiedName": "adls://raw/data@csa"}}],
            "outputs": [{"typeName": "hdfs_path", "uniqueAttributes": {"qualifiedName": "adls://curated/data@csa"}}]
        }
    }
}

requests.post(
    f"{atlas_url}/api/atlas/v2/entity",
    json=process_entity,
    auth=atlas_auth
)
```

---

## ADF → Apache NiFi

### Pipeline Conversion Patterns

| ADF Activity | NiFi Processor | Notes |
|---|---|---|
| Copy Data | `GetAzureBlobStorage` → `PutAzureBlobStorage` | Use ADLS processors for Gen2 |
| Data Flow | `ExecuteSQL` + `ConvertRecord` | Break into processor chain |
| Lookup | `LookupRecord` / `ExecuteSQL` | Cache lookup results |
| ForEach | `SplitJson` / `SplitRecord` | NiFi handles per-record natively |
| If Condition | `RouteOnAttribute` | Expression Language for conditions |
| Web Activity | `InvokeHTTP` | Full HTTP client support |
| Stored Procedure | `ExecuteSQL` | Direct JDBC execution |

### Example: Copy Pipeline Conversion

**ADF Pipeline (JSON):**
```json
{
  "name": "CopyRawToStaging",
  "activities": [{
    "type": "Copy",
    "source": { "type": "DelimitedTextSource", "storeSettings": { "type": "AzureBlobFSReadSettings" }},
    "sink": { "type": "ParquetSink", "storeSettings": { "type": "AzureBlobFSWriteSettings" }}
  }]
}
```

**NiFi Equivalent Flow:**
```xml
<!-- NiFi template snippet -->
<processor>
    <name>Fetch from ADLS Raw</name>
    <class>org.apache.nifi.processors.azure.storage.FetchAzureDataLakeStorage</class>
    <config>
        <property name="Filesystem Name">raw</property>
        <property name="Directory Name">/data/incoming</property>
        <property name="Storage Account Name">${azure.storage.account}</property>
    </config>
</processor>
<processor>
    <name>Convert CSV to Parquet</name>
    <class>org.apache.nifi.processors.parquet.ConvertAvroToParquet</class>
</processor>
<processor>
    <name>Write to ADLS Staging</name>
    <class>org.apache.nifi.processors.azure.storage.PutAzureDataLakeStorage</class>
    <config>
        <property name="Filesystem Name">staging</property>
        <property name="Directory Name">/data/processed</property>
    </config>
</processor>
```

### Parameter Migration

ADF linked services → NiFi Controller Services:
```
ADF AzureBlobFS Linked Service → NiFi ADLSCredentialsControllerService
ADF AzureSqlDatabase            → NiFi DBCPConnectionPool
ADF AzureKeyVault               → NiFi AzureKeyVaultClientService
```

---

## Synapse Serverless → Trino

### SQL Dialect Differences

| Synapse Serverless | Trino | Notes |
|---|---|---|
| `OPENROWSET(...)` | Direct catalog query | Configure catalog in Trino |
| `TOP N` | `LIMIT N` | Standard SQL |
| `CONVERT(type, expr)` | `CAST(expr AS type)` | ANSI SQL |
| `ISNULL(a, b)` | `COALESCE(a, b)` | Standard SQL |
| `GETDATE()` | `current_timestamp` | ANSI SQL |
| `DATEADD(day, 1, d)` | `d + interval '1' day` | Interval arithmetic |
| `DATEDIFF(day, a, b)` | `date_diff('day', a, b)` | Trino function |
| `FORMAT_DATETIME(...)` | `format_datetime(...)` | Similar syntax |
| Delta Lake via OPENROWSET | Delta Lake connector | Native connector |

### Synapse → Trino Query Translation

**Synapse Serverless:**
```sql
SELECT TOP 100
    customer_id,
    CONVERT(VARCHAR, order_date, 23) AS order_date_str,
    ISNULL(total_amount, 0) AS total_amount
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.usgovcloudapi.net/curated/orders/**',
    FORMAT = 'DELTA'
) AS orders
WHERE order_date >= DATEADD(DAY, -30, GETDATE())
```

**Trino Equivalent:**
```sql
SELECT
    customer_id,
    CAST(order_date AS VARCHAR) AS order_date_str,
    COALESCE(total_amount, 0) AS total_amount
FROM delta.curated.orders
WHERE order_date >= current_timestamp - interval '30' day
LIMIT 100
```

### Catalog Configuration

```properties
# /etc/trino/catalog/delta.properties
connector.name=delta_lake
hive.metastore.uri=thrift://hive-metastore:9083
delta.enable-non-concurrent-writes=true

# For ADLS Gen2 access
hive.azure.abfs-storage-account=<storage-account>
hive.azure.abfs-access-key=<access-key>
```

```properties
# /etc/trino/catalog/postgresql.properties
connector.name=postgresql
connection-url=jdbc:postgresql://pg-host:5432/csa_platform
connection-user=trino_reader
connection-password=${ENV:PG_PASSWORD}
```

---

## Power BI → Apache Superset

### Dashboard Recreation Workflow

1. **Inventory** existing Power BI reports and datasets
2. **Map data sources** to Superset database connections
3. **Recreate datasets** as Superset virtual datasets (SQL Lab)
4. **Build charts** using Superset's chart builder
5. **Assemble dashboards** with layout and filters

### Dataset Connection Setup

```python
# superset_setup.py — Create database connections via Superset API
import requests

superset_url = "http://superset:8088"
session = requests.Session()

# Login
session.post(f"{superset_url}/api/v1/security/login", json={
    "username": "admin",
    "password": "admin",
    "provider": "db"
})

# Add Trino connection (replaces Power BI DirectQuery to Synapse)
session.post(f"{superset_url}/api/v1/database/", json={
    "database_name": "Trino - Data Lake",
    "engine": "trino",
    "sqlalchemy_uri": "trino://trino-coordinator:8080/delta",
    "extra": '{"engine_params": {"connect_args": {"http_scheme": "http"}}}',
    "expose_in_sqllab": True,
    "allow_ctas": False,
    "allow_cvas": True
})

# Add PostgreSQL connection (replaces Power BI Import mode)
session.post(f"{superset_url}/api/v1/database/", json={
    "database_name": "PostgreSQL - Operational",
    "engine": "postgresql",
    "sqlalchemy_uri": "postgresql+psycopg2://user:pass@pg-host:5432/csa_platform",
    "expose_in_sqllab": True
})
```

### Chart Type Mapping

| Power BI Visual | Superset Chart | Notes |
|---|---|---|
| Bar Chart | Bar Chart (ECharts) | Nearly identical |
| Line Chart | Line Chart (ECharts) | Time-series native |
| Table | Table | Pivot support included |
| Card (KPI) | Big Number | Single metric display |
| Map | deck.gl Scatter | Requires Mapbox token |
| Treemap | Treemap (ECharts) | Direct equivalent |
| Gauge | Gauge Chart | Similar look |
| Slicer | Dashboard Filter | Native filter bar |

---

## Azure AI Search → OpenSearch

### Index Schema Mapping

| Azure AI Search | OpenSearch | Notes |
|---|---|---|
| `Edm.String` | `text` / `keyword` | `text` for full-text, `keyword` for exact |
| `Edm.Int32` | `integer` | Direct mapping |
| `Edm.Int64` | `long` | Direct mapping |
| `Edm.Double` | `double` | Direct mapping |
| `Edm.Boolean` | `boolean` | Direct mapping |
| `Edm.DateTimeOffset` | `date` | ISO 8601 format |
| `Edm.GeographyPoint` | `geo_point` | Lat/lon support |
| `Collection(Edm.Single)` | `knn_vector` | For vector search |
| `Edm.ComplexType` | `object` | Nested objects |

### Index Migration Script

```python
# migrate_search_index.py
import requests
from azure.identity import DefaultAzureCredential
from azure.search.documents.indexes import SearchIndexClient

# --- Source: Azure AI Search ---
credential = DefaultAzureCredential()
search_client = SearchIndexClient(
    endpoint="https://<search-service>.search.windows.us",
    credential=credential
)

# Get index definition
az_index = search_client.get_index("products")

# --- Target: OpenSearch ---
os_url = "https://opensearch:9200"
os_auth = ("admin", "admin")

# Map field types
type_map = {
    "Edm.String": "text",
    "Edm.Int32": "integer",
    "Edm.Int64": "long",
    "Edm.Double": "double",
    "Edm.Boolean": "boolean",
    "Edm.DateTimeOffset": "date",
    "Edm.GeographyPoint": "geo_point",
}

def map_fields(az_fields):
    properties = {}
    for field in az_fields:
        os_type = type_map.get(field.type, "text")
        prop = {"type": os_type}

        # Searchable strings get both text and keyword
        if field.type == "Edm.String" and field.searchable:
            prop = {
                "type": "text",
                "fields": {"keyword": {"type": "keyword", "ignore_above": 256}}
            }
        # Filterable-only strings become keyword
        elif field.type == "Edm.String" and field.filterable and not field.searchable:
            prop = {"type": "keyword"}

        # Vector fields
        if "Collection(Edm.Single)" in str(field.type):
            prop = {
                "type": "knn_vector",
                "dimension": field.vector_search_dimensions or 1536,
                "method": {
                    "name": "hnsw",
                    "space_type": "cosinesimil",
                    "engine": "nmslib"
                }
            }

        properties[field.name] = prop
    return properties

# Create OpenSearch index
os_index = {
    "settings": {
        "index": {
            "number_of_shards": 3,
            "number_of_replicas": 1,
            "knn": True
        }
    },
    "mappings": {
        "properties": map_fields(az_index.fields)
    }
}

requests.put(
    f"{os_url}/products",
    json=os_index,
    auth=os_auth,
    verify=False
)
```

### Query Translation

**Azure AI Search:**
```json
{
  "search": "cloud analytics",
  "filter": "category eq 'Data'",
  "orderby": "score desc",
  "top": 10,
  "select": "title,description,category"
}
```

**OpenSearch Equivalent:**
```json
{
  "query": {
    "bool": {
      "must": [
        { "multi_match": { "query": "cloud analytics", "fields": ["title^2", "description"] } }
      ],
      "filter": [
        { "term": { "category.keyword": "Data" } }
      ]
    }
  },
  "sort": [{ "_score": "desc" }],
  "size": 10,
  "_source": ["title", "description", "category"]
}
```

### Vector Search Translation

**Azure AI Search (vector):**
```json
{
  "vectorQueries": [{
    "kind": "vector",
    "vector": [0.1, 0.2, ...],
    "fields": "contentVector",
    "k": 10
  }]
}
```

**OpenSearch (knn):**
```json
{
  "size": 10,
  "query": {
    "knn": {
      "contentVector": {
        "vector": [0.1, 0.2, "..."],
        "k": 10
      }
    }
  }
}
```

---

## ADF Orchestration → Apache Airflow

### Trigger / Schedule Mapping

| ADF Trigger | Airflow Equivalent | Example |
|---|---|---|
| Schedule Trigger | `schedule` param | `schedule="0 6 * * *"` |
| Tumbling Window | `schedule` + `data_interval` | Use catchup=True |
| Event Trigger (Blob) | `S3KeySensor` / custom sensor | Azure sensor for ADLS |
| Manual Trigger | `trigger_dagrun` API | `airflow dags trigger` |
| Pipeline dependency | `ExternalTaskSensor` | Cross-DAG dependency |

### DAG Pattern Examples

**ADF Pipeline with ForEach → Airflow DAG:**

```python
# dags/etl_raw_to_curated.py
from datetime import datetime, timedelta
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.microsoft.azure.sensors.wasb import WasbBlobSensor
from airflow.providers.common.sql.operators.sql import SQLExecuteQueryOperator

default_args = {
    "owner": "csa-platform",
    "depends_on_past": False,
    "email_on_failure": True,
    "email": ["platform-team@contoso.com"],
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
}

with DAG(
    dag_id="etl_raw_to_curated",
    default_args=default_args,
    description="Process raw data to curated zone (replaces ADF Copy + Data Flow)",
    schedule="0 6 * * *",      # Daily at 6 AM — was ADF Schedule Trigger
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["etl", "csa-platform"],
) as dag:

    # Sensor: wait for source file (replaces ADF Event Trigger)
    wait_for_data = WasbBlobSensor(
        task_id="wait_for_raw_data",
        container_name="raw",
        blob_name="data/incoming/{{ ds }}/",
        wasb_conn_id="azure_adls",
        timeout=3600,
        poke_interval=60,
    )

    # Transform: replaces ADF Data Flow
    def transform_data(**context):
        """Read raw CSV, apply transformations, write Parquet to curated."""
        import pandas as pd
        from azure.storage.filedatalake import DataLakeServiceClient

        ds = context["ds"]
        # ... transformation logic ...
        print(f"Processed data for {ds}")

    transform = PythonOperator(
        task_id="transform_raw_to_curated",
        python_callable=transform_data,
    )

    # Catalog: register in Atlas (replaces Purview auto-scan)
    def register_in_atlas(**context):
        """Register processed dataset in Apache Atlas catalog."""
        import requests
        atlas_url = "http://atlas-service:21000"
        # ... entity creation ...

    catalog = PythonOperator(
        task_id="register_in_catalog",
        python_callable=register_in_atlas,
    )

    wait_for_data >> transform >> catalog
```

**ADF Linked Pipelines → Airflow Cross-DAG Dependencies:**

```python
# dags/orchestrator.py
from airflow import DAG
from airflow.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.sensors.external_task import ExternalTaskSensor
from datetime import datetime

with DAG(
    dag_id="master_orchestrator",
    schedule="0 5 * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["orchestration"],
) as dag:

    # Replaces ADF "Execute Pipeline" activity
    trigger_ingestion = TriggerDagRunOperator(
        task_id="trigger_ingestion",
        trigger_dag_id="etl_raw_to_curated",
        wait_for_completion=True,
    )

    trigger_quality = TriggerDagRunOperator(
        task_id="trigger_quality_checks",
        trigger_dag_id="data_quality_checks",
        wait_for_completion=True,
    )

    trigger_analytics = TriggerDagRunOperator(
        task_id="trigger_analytics",
        trigger_dag_id="analytics_refresh",
        wait_for_completion=True,
    )

    trigger_ingestion >> trigger_quality >> trigger_analytics
```

---

## Post-Migration Validation

### Checklist per Service

- [ ] **Data completeness** — Row counts match between source and target
- [ ] **Schema validation** — All columns/fields present with correct types
- [ ] **Query results** — Sample queries return equivalent results
- [ ] **Performance baseline** — Record query latencies for comparison
- [ ] **Access control** — Permissions replicated (Ranger policies if applicable)
- [ ] **Lineage** — End-to-end lineage visible in Atlas
- [ ] **Monitoring** — Prometheus metrics flowing, Grafana dashboards active
- [ ] **Alerting** — PagerDuty/Teams notifications configured

### Validation Script

```bash
#!/usr/bin/env bash
# validate-oss-migration.sh — Quick health check for migrated services
set -euo pipefail

echo "=== OSS Migration Validation ==="

# Atlas
echo -n "Atlas: "
curl -sf http://atlas:21000/api/atlas/admin/version | jq -r '.Version' || echo "FAILED"

# Trino
echo -n "Trino: "
curl -sf http://trino:8080/v1/info | jq -r '.nodeVersion.version' || echo "FAILED"

# Superset
echo -n "Superset: "
curl -sf http://superset:8088/health | head -1 || echo "FAILED"

# OpenSearch
echo -n "OpenSearch: "
curl -sfk https://opensearch:9200 | jq -r '.version.number' || echo "FAILED"

# Airflow
echo -n "Airflow: "
curl -sf http://airflow:8080/health | jq -r '.metadatabase.status' || echo "FAILED"

echo "=== Validation Complete ==="
```

---

## Related Documentation

- [OSS Alternatives README](../../csa_platform/oss_alternatives/README.md)
- [OSS Monitoring Guide](./oss-monitoring.md)
- [Deploy Script](../../scripts/deploy-oss-stack.sh)
- [Architecture](../ARCHITECTURE.md)
