# Hive to dbt / SparkSQL Migration

**A comprehensive guide for migrating Apache Hive workloads to dbt models and SparkSQL on Databricks or Microsoft Fabric, covering metastore migration, HiveQL conversion, UDF porting, and worked before/after examples.**

---

## Overview

Apache Hive is the most common SQL interface in Hadoop environments. Migrating Hive involves three distinct concerns:

1. **Metastore migration** — Moving table definitions, schemas, partitions, and statistics from the Hive Metastore to Unity Catalog or Purview
2. **SQL migration** — Converting HiveQL to SparkSQL (minor differences) and modernizing to dbt models
3. **Operational migration** — Replacing HiveServer2, Hive LLAP, Tez, and scheduled Hive scripts with Databricks SQL, Fabric SQL endpoints, and dbt-core

This guide addresses all three in detail.

---

## 1. Metastore migration: Hive Metastore to Unity Catalog

### Hive Metastore architecture

The Hive Metastore Service (HMS) stores metadata in a relational database (MySQL, PostgreSQL, or Derby):

- Database definitions
- Table schemas (columns, types, SerDe info)
- Partition metadata (partition values, locations, statistics)
- Table properties and parameters
- UDF registrations

### Unity Catalog architecture

Databricks Unity Catalog provides a three-level namespace that maps directly to Hive's model:

| Hive concept     | Unity Catalog equivalent                |
| ---------------- | --------------------------------------- |
| Database         | Schema (within a catalog)               |
| Table            | Table (managed or external)             |
| Partition        | Partition (Delta handles automatically) |
| View             | View                                    |
| UDF              | UDF (registered per catalog)            |
| Table properties | Table properties (TBLPROPERTIES)        |

### Export Hive DDL

```bash
# Export all DDL from Hive Metastore
hive -e "SHOW DATABASES;" | while read db; do
    echo "-- Database: $db"
    hive -e "USE $db; SHOW TABLES;" | while read tbl; do
        hive -e "USE $db; SHOW CREATE TABLE $tbl;"
        echo ";"
    done
done > hive_ddl_export.sql
```

### Convert DDL to Unity Catalog

```python
# Python script to convert Hive DDL to Unity Catalog DDL
import re

def convert_hive_to_unity(hive_ddl, catalog="main", adls_base="abfss://silver@storage.dfs.core.windows.net"):
    """Convert Hive CREATE TABLE to Unity Catalog Delta table."""

    # Replace STORED AS ORC/PARQUET with USING DELTA
    ddl = re.sub(
        r"STORED AS (ORC|PARQUET|AVRO|TEXTFILE|SEQUENCEFILE|RCFILE)",
        "USING DELTA",
        hive_ddl,
        flags=re.IGNORECASE
    )

    # Replace ROW FORMAT SERDE ... WITH SERDEPROPERTIES (...)
    ddl = re.sub(
        r"ROW FORMAT SERDE\s+'[^']+'\s*(WITH SERDEPROPERTIES\s*\([^)]+\))?",
        "",
        ddl,
        flags=re.IGNORECASE
    )

    # Replace ROW FORMAT DELIMITED ...
    ddl = re.sub(
        r"ROW FORMAT DELIMITED\s+FIELDS TERMINATED BY\s+'[^']+'\s*"
        r"(COLLECTION ITEMS TERMINATED BY\s+'[^']+')?\s*"
        r"(MAP KEYS TERMINATED BY\s+'[^']+')?\s*"
        r"(LINES TERMINATED BY\s+'[^']+')?\s*",
        "",
        ddl,
        flags=re.IGNORECASE
    )

    # Replace HDFS location with ADLS
    ddl = re.sub(
        r"LOCATION\s+'hdfs://[^']+/([^']+)'",
        f"LOCATION '{adls_base}/\\1'",
        ddl,
        flags=re.IGNORECASE
    )

    # Add catalog prefix to database.table references
    ddl = re.sub(
        r"CREATE (EXTERNAL )?TABLE\s+(\w+)\.(\w+)",
        f"CREATE TABLE {catalog}.\\2.\\3",
        ddl,
        flags=re.IGNORECASE
    )

    # Remove EXTERNAL keyword (Unity Catalog manages this differently)
    ddl = ddl.replace("CREATE EXTERNAL TABLE", "CREATE TABLE")

    return ddl
```

### Migrate partitions

For tables with thousands of partitions, use the Hive Metastore API or MSCK REPAIR after data migration:

```sql
-- After data migration to ADLS, repair partition metadata
-- In Databricks (Unity Catalog)
MSCK REPAIR TABLE silver.orders;

-- Or for Delta tables, partitions are discovered automatically
-- No MSCK REPAIR needed if using CONVERT TO DELTA
```

---

## 2. HiveQL to SparkSQL: key differences

SparkSQL is highly compatible with HiveQL. Most queries run without changes. The differences that matter are listed below.

### Syntax differences

| HiveQL                                           | SparkSQL                                               | Notes                             |
| ------------------------------------------------ | ------------------------------------------------------ | --------------------------------- |
| `LATERAL VIEW explode(arr) t AS val`             | `LATERAL VIEW explode(arr) t AS val`                   | Identical syntax                  |
| `DISTRIBUTE BY col`                              | `DISTRIBUTE BY col`                                    | Identical syntax                  |
| `SORT BY col`                                    | `SORT BY col`                                          | Identical (within-partition sort) |
| `CLUSTER BY col`                                 | `CLUSTER BY col`                                       | Identical                         |
| `INSERT OVERWRITE TABLE t SELECT ...`            | `INSERT OVERWRITE TABLE t SELECT ...`                  | Identical                         |
| `TABLESAMPLE (10 PERCENT)`                       | `TABLESAMPLE (10 PERCENT)`                             | Identical                         |
| `ADD JAR hdfs:///lib/my-udf.jar`                 | N/A — use cluster libraries                            | See UDF section                   |
| `SET hive.exec.parallel=true`                    | N/A — Spark parallelizes by default                    | Remove SET statements             |
| `SET hive.exec.dynamic.partition.mode=nonstrict` | N/A — Spark allows dynamic partitions by default       | Remove                            |
| `SET mapreduce.job.reduces=10`                   | `spark.conf.set("spark.sql.shuffle.partitions", "10")` | Different config key              |

### Functions with different behavior

| Function                        | HiveQL behavior         | SparkSQL behavior                       | Migration action          |
| ------------------------------- | ----------------------- | --------------------------------------- | ------------------------- |
| `CAST(x AS INT)`                | Returns NULL on failure | Returns NULL on failure                 | No change                 |
| `unix_timestamp()`              | Current time            | Current time                            | No change                 |
| `from_unixtime(ts, fmt)`        | Java SimpleDateFormat   | Java SimpleDateFormat                   | No change                 |
| `regexp_extract(s, p, i)`       | Java regex              | Java regex                              | No change                 |
| `percentile(col, 0.5)`          | Exact percentile (UDAF) | Use `percentile_approx` or `percentile` | Verify precision needs    |
| `collect_set(col)`              | Returns array           | Returns array                           | No change                 |
| `NVL(a, b)`                     | Null-safe value         | Use `COALESCE(a, b)`                    | Replace NVL with COALESCE |
| `IF(cond, true_val, false_val)` | Conditional             | Identical                               | No change                 |

### Worked before/after examples

**Example 1: Daily aggregation job**

```sql
-- BEFORE: HiveQL
SET hive.exec.parallel=true;
SET hive.exec.dynamic.partition.mode=nonstrict;
SET hive.exec.max.dynamic.partitions=10000;

INSERT OVERWRITE TABLE analytics.daily_orders
PARTITION (order_date)
SELECT
    customer_id,
    COUNT(*) AS order_count,
    SUM(amount) AS total_amount,
    AVG(amount) AS avg_amount,
    order_date
FROM raw.orders
WHERE order_date >= '${hiveconf:start_date}'
GROUP BY customer_id, order_date;

-- AFTER: SparkSQL (Databricks)
INSERT OVERWRITE TABLE silver.daily_orders
SELECT
    customer_id,
    COUNT(*) AS order_count,
    SUM(amount) AS total_amount,
    AVG(amount) AS avg_amount,
    order_date
FROM bronze.orders
WHERE order_date >= :start_date
GROUP BY customer_id, order_date;
```

**Example 2: Complex ETL with multiple joins**

```sql
-- BEFORE: HiveQL
CREATE TABLE IF NOT EXISTS analytics.customer_360
STORED AS ORC
AS
SELECT
    c.customer_id,
    c.name,
    c.segment,
    o.order_count,
    o.total_revenue,
    p.last_payment_date,
    COALESCE(s.support_tickets, 0) AS support_tickets,
    CASE
        WHEN o.total_revenue > 10000 THEN 'high'
        WHEN o.total_revenue > 1000 THEN 'medium'
        ELSE 'low'
    END AS value_tier
FROM raw.customers c
LEFT JOIN (
    SELECT customer_id, COUNT(*) AS order_count, SUM(amount) AS total_revenue
    FROM raw.orders
    GROUP BY customer_id
) o ON c.customer_id = o.customer_id
LEFT JOIN (
    SELECT customer_id, MAX(payment_date) AS last_payment_date
    FROM raw.payments
    GROUP BY customer_id
) p ON c.customer_id = p.customer_id
LEFT JOIN (
    SELECT customer_id, COUNT(*) AS support_tickets
    FROM raw.support
    GROUP BY customer_id
) s ON c.customer_id = s.customer_id;

-- AFTER: SparkSQL / Delta Lake
CREATE OR REPLACE TABLE gold.customer_360
USING DELTA
AS
SELECT
    c.customer_id,
    c.name,
    c.segment,
    o.order_count,
    o.total_revenue,
    p.last_payment_date,
    COALESCE(s.support_tickets, 0) AS support_tickets,
    CASE
        WHEN o.total_revenue > 10000 THEN 'high'
        WHEN o.total_revenue > 1000 THEN 'medium'
        ELSE 'low'
    END AS value_tier
FROM silver.customers c
LEFT JOIN (
    SELECT customer_id, COUNT(*) AS order_count, SUM(amount) AS total_revenue
    FROM silver.orders
    GROUP BY customer_id
) o ON c.customer_id = o.customer_id
LEFT JOIN (
    SELECT customer_id, MAX(payment_date) AS last_payment_date
    FROM silver.payments
    GROUP BY customer_id
) p ON c.customer_id = p.customer_id
LEFT JOIN (
    SELECT customer_id, COUNT(*) AS support_tickets
    FROM silver.support
    GROUP BY customer_id
) s ON c.customer_id = s.customer_id;
```

Note: The SQL is nearly identical. Changes are: `STORED AS ORC` becomes `USING DELTA`, `CREATE TABLE IF NOT EXISTS` becomes `CREATE OR REPLACE TABLE`, and table references move from `raw.*` to the medallion architecture (`silver.*`, `gold.*`).

---

## 3. Managed vs external tables: migration to Delta

### Hive table types

| Type               | Data lifecycle             | Metadata lifecycle         | HDFS path                        |
| ------------------ | -------------------------- | -------------------------- | -------------------------------- |
| Managed (internal) | Deleted when table dropped | Deleted when table dropped | `/user/hive/warehouse/db/table/` |
| External           | Survives table drop        | Deleted when table dropped | Custom location                  |

### Delta Lake table types (Databricks)

| Type                    | Data lifecycle             | Catalog                        | Best for                      |
| ----------------------- | -------------------------- | ------------------------------ | ----------------------------- |
| Managed (Unity Catalog) | Deleted when table dropped | Unity Catalog manages location | New tables, governed data     |
| External                | Survives table drop        | Unity Catalog tracks location  | Migrated data, shared storage |

**Recommendation:** Migrate Hive external tables as Delta external tables pointing to ADLS Gen2. Migrate Hive managed tables as Delta managed tables in Unity Catalog. Use external tables for the initial migration (data stays at known ADLS paths), then convert to managed tables when governance is established.

---

## 4. Bucketing to Z-ORDER and liquid clustering

### Hive bucketing

```sql
-- Hive bucketed table
CREATE TABLE orders_bucketed (
    order_id BIGINT,
    customer_id BIGINT,
    amount DECIMAL(10,2),
    order_date DATE
)
CLUSTERED BY (customer_id) INTO 256 BUCKETS
STORED AS ORC;
```

### Delta Z-ORDER (replacement)

```sql
-- Delta table with Z-ORDER optimization
CREATE TABLE silver.orders (
    order_id BIGINT,
    customer_id BIGINT,
    amount DECIMAL(10,2),
    order_date DATE
)
USING DELTA;

-- Run Z-ORDER after data load
OPTIMIZE silver.orders ZORDER BY (customer_id);
```

### Delta liquid clustering (modern replacement)

```sql
-- Liquid clustering (auto-managed, no manual OPTIMIZE needed)
CREATE TABLE silver.orders (
    order_id BIGINT,
    customer_id BIGINT,
    amount DECIMAL(10,2),
    order_date DATE
)
USING DELTA
CLUSTER BY (customer_id, order_date);
```

Liquid clustering replaces both Hive bucketing and manual Z-ORDER operations. It continuously optimizes data layout based on the clustering columns.

---

## 5. Hive UDFs to Spark UDFs

### Identifying UDFs in your Hive environment

```bash
# List all registered UDFs
hive -e "SHOW FUNCTIONS;" | grep -v "^[a-z_]*$"  # Filter out built-in functions

# Show UDF details
hive -e "DESCRIBE FUNCTION EXTENDED my_custom_udf;"
```

### Common Hive UDF patterns and Spark equivalents

| Hive UDF pattern                 | Spark equivalent                                           |
| -------------------------------- | ---------------------------------------------------------- |
| `GenericUDF` (Java)              | Python UDF or Spark built-in function                      |
| `GenericUDAF` (Java aggregation) | PySpark UDAF or pandas UDF                                 |
| `GenericUDTF` (table-generating) | `explode()`, `posexplode()`, or Python UDTF                |
| Simple string manipulation       | Spark built-in `regexp_replace`, `substring`, `trim`, etc. |
| Date manipulation                | Spark built-in `date_add`, `datediff`, `date_format`, etc. |
| Custom hashing                   | Spark built-in `sha2`, `md5`, `xxhash64`                   |

### Migration example: Java UDF to Python UDF

```java
// BEFORE: Hive Java UDF
package com.example.udf;

import org.apache.hadoop.hive.ql.exec.UDF;
import org.apache.hadoop.io.Text;

public class MaskSSN extends UDF {
    public Text evaluate(Text input) {
        if (input == null) return null;
        String ssn = input.toString();
        if (ssn.length() == 9) {
            return new Text("***-**-" + ssn.substring(5));
        }
        return new Text("INVALID");
    }
}
```

```python
# AFTER: Spark Python UDF
from pyspark.sql.functions import udf
from pyspark.sql.types import StringType

@udf(returnType=StringType())
def mask_ssn(ssn):
    if ssn is None:
        return None
    if len(ssn) == 9:
        return f"***-**-{ssn[5:]}"
    return "INVALID"

# Usage
df = df.withColumn("masked_ssn", mask_ssn(df["ssn"]))
```

```python
# BETTER: Use Spark built-in functions (no UDF overhead)
from pyspark.sql.functions import when, length, concat, lit, substring

df = df.withColumn(
    "masked_ssn",
    when(
        length("ssn") == 9,
        concat(lit("***-**-"), substring("ssn", 6, 4))
    ).otherwise(lit("INVALID"))
)
```

**Best practice:** Always check if a Spark built-in function can replace your UDF. Built-in functions use Catalyst optimization and Photon acceleration. Python UDFs run in a separate Python process with serialization overhead.

---

## 6. SerDe to Delta schema evolution

### Hive SerDe pattern

```sql
-- Hive table with custom SerDe for JSON data
CREATE EXTERNAL TABLE raw.events (
    event_id STRING,
    event_type STRING,
    payload STRING
)
ROW FORMAT SERDE 'org.apache.hive.hcatalog.data.JsonSerDe'
STORED AS TEXTFILE
LOCATION 'hdfs:///data/events/';
```

### Delta Lake replacement

```sql
-- Delta table with native JSON support
-- Step 1: Read JSON and write as Delta
-- (in a Databricks notebook)

-- Read JSON files natively
CREATE TABLE bronze.events
USING DELTA
AS SELECT * FROM json.`abfss://raw@storage.dfs.core.windows.net/events/`;

-- Step 2: Schema evolution is automatic
-- New fields in JSON files are added automatically with:
ALTER TABLE bronze.events SET TBLPROPERTIES ('delta.columnMapping.mode' = 'name');
```

### Schema evolution comparison

| Feature         | Hive SerDe                     | Delta Lake                                                |
| --------------- | ------------------------------ | --------------------------------------------------------- |
| Add column      | `ALTER TABLE ADD COLUMNS`      | `ALTER TABLE ADD COLUMNS` or automatic with `mergeSchema` |
| Rename column   | Not supported (recreate table) | `ALTER TABLE RENAME COLUMN` (with column mapping)         |
| Reorder columns | Not supported                  | `ALTER TABLE ALTER COLUMN ... FIRST/AFTER`                |
| Drop column     | Not supported (recreate table) | `ALTER TABLE DROP COLUMN` (with column mapping)           |
| Type widening   | Manual `ALTER TABLE CHANGE`    | Automatic with `delta.enableTypeWidening`                 |

---

## 7. Hive partitioning to Delta partitioning

### Hive static and dynamic partitioning

```sql
-- Static partition insert
INSERT INTO TABLE orders PARTITION (year=2025, month=04)
SELECT order_id, customer_id, amount FROM staging_orders;

-- Dynamic partition insert
INSERT INTO TABLE orders PARTITION (year, month)
SELECT order_id, customer_id, amount, year, month FROM staging_orders;
```

### Delta partitioning (preserved)

```sql
-- Delta supports the same partition semantics
INSERT INTO silver.orders
SELECT order_id, customer_id, amount, year, month FROM bronze.orders;
-- Delta automatically writes to partition directories based on partitionBy columns
```

### When to change partitioning strategy

| Hive pattern                              | Delta recommendation                       | Reason                             |
| ----------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `PARTITIONED BY (year, month, day)`       | Keep if > 1 GB per partition               | Works well at scale                |
| `PARTITIONED BY (year, month, day, hour)` | Reduce to `(year, month)` + Z-ORDER on day | Too many small partitions          |
| `PARTITIONED BY (customer_id)`            | Use liquid clustering instead              | High-cardinality partitions        |
| `PARTITIONED BY (region)`                 | Keep if < 20 distinct values               | Low cardinality is fine            |
| No partitioning (small table)             | No partitioning                            | Tables < 1 GB need no partitioning |

---

## 8. Modernizing to dbt

### Why dbt instead of raw SparkSQL scripts?

| Capability        | Hive scripts                  | Raw SparkSQL      | dbt                                     |
| ----------------- | ----------------------------- | ----------------- | --------------------------------------- |
| Version control   | Manual file management        | Manual            | Built-in (dbt project = Git repo)       |
| Testing           | None                          | Manual assertions | Built-in `schema.yml` tests             |
| Documentation     | External wiki                 | External          | Auto-generated from YAML + SQL comments |
| Lineage           | Atlas (if configured)         | None              | Built-in DAG visualization              |
| Incremental loads | Custom logic per script       | Custom logic      | `incremental` materialization           |
| Environments      | Different configs per cluster | Different configs | `profiles.yml` (dev/staging/prod)       |

### dbt model example (converted from Hive)

```sql
-- models/silver/daily_orders.sql

{{ config(
    materialized='incremental',
    unique_key='customer_id || order_date',
    partition_by=['order_date'],
    file_format='delta'
) }}

SELECT
    customer_id,
    COUNT(*) AS order_count,
    SUM(amount) AS total_amount,
    AVG(amount) AS avg_amount,
    order_date
FROM {{ ref('stg_orders') }}

{% if is_incremental() %}
WHERE order_date > (SELECT MAX(order_date) FROM {{ this }})
{% endif %}

GROUP BY customer_id, order_date
```

```yaml
# models/silver/schema.yml
models:
    - name: daily_orders
      description: "Daily order aggregates by customer"
      columns:
          - name: customer_id
            description: "Unique customer identifier"
            tests:
                - not_null
          - name: order_count
            description: "Number of orders on this date"
            tests:
                - not_null
                - dbt_utils.accepted_range:
                      min_value: 1
          - name: total_amount
            description: "Sum of order amounts"
            tests:
                - not_null
          - name: order_date
            description: "Date of the orders"
            tests:
                - not_null
```

---

## Common pitfalls

| Pitfall                                   | Mitigation                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Assuming HiveQL = SparkSQL                | Test every query; pay attention to NULL handling, type coercion         |
| Migrating UDFs without checking built-ins | Audit all UDFs; 60-80% can be replaced by Spark built-in functions      |
| Keeping static partition inserts          | Use Delta's automatic partitioning; simpler and less error-prone        |
| Not testing metastore migration           | Validate table count, column count, and partition count after migration |
| Ignoring Hive views                       | Views must be recreated manually; they do not export via DistCp         |
| Skipping data quality checks              | Run dbt tests on migrated data before decommissioning Hive              |

---

## Related

- [Tutorial: Hive to dbt](tutorial-hive-to-dbt.md) — step-by-step tutorial
- [HDFS Migration](hdfs-migration.md) — storage migration (prerequisite)
- [Feature Mapping](feature-mapping-complete.md) — all component mappings
- [Migration Hub](index.md) — full migration center

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Tutorial: Hive to dbt](tutorial-hive-to-dbt.md) | [HDFS Migration](hdfs-migration.md) | [Migration Hub](index.md)
