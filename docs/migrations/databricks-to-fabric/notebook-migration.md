# Notebook Migration — Databricks to Microsoft Fabric

**Status:** Authored 2026-04-30
**Audience:** Data engineers and platform teams migrating PySpark notebooks from Databricks to Fabric.
**Scope:** Notebook conversion patterns, magic command translation, library management, dbutils equivalents, Databricks Connect replacement, and testing strategies.

---

## 1. Overview

Databricks notebooks and Fabric notebooks share the same underlying engine: Apache Spark. Most PySpark code runs on Fabric with minimal changes. The differences are in:

- **Magic commands** (`%sql`, `%python`, `%scala`) -- Fabric uses cell-type selectors
- **dbutils** -- replaced by `mssparkutils`
- **Library management** -- cluster libraries replaced by Fabric environments
- **Scala support** -- not available in Fabric notebooks
- **Databricks Connect** -- no direct equivalent; use Fabric APIs
- **Cluster configuration** -- Fabric Spark is serverless; no cluster spec

This guide walks through each difference with before/after code examples.

---

## 2. Decision: migrate or rewrite?

Not every notebook should be migrated as-is. Use this decision tree:

| Notebook type | Recommendation |
| --- | --- |
| PySpark ETL (read, transform, write) | **Migrate** -- minimal changes needed |
| SQL-only transformations | **Convert to dbt** -- better long-term maintainability |
| Notebook spaghetti (many %run chains) | **Rewrite** -- convert to Data Pipelines + modular notebooks |
| Scala notebooks | **Rewrite in PySpark** -- Fabric does not support Scala notebooks |
| ML training notebooks | **Keep on Databricks** or migrate to Azure ML |
| Ad-hoc exploration | **Migrate** -- Fabric notebooks are excellent for ad-hoc |

---

## 3. Magic command translation

### 3.1 Cell language switching

**Databricks** uses magic commands at the top of each cell:

```python
# Databricks cell 1
%python
df = spark.read.format("delta").load("/mnt/data/customers")

# Databricks cell 2
%sql
SELECT * FROM customers WHERE state = 'VA'

# Databricks cell 3
%scala
val df = spark.read.format("delta").load("/mnt/data/customers")

# Databricks cell 4
%r
library(SparkR)
df <- read.df("/mnt/data/customers", source = "delta")
```

**Fabric** uses a cell language selector dropdown instead of magic commands:

```python
# Fabric cell 1 (language: PySpark)
df = spark.read.format("delta").load("Tables/customers")

# Fabric cell 2 (language: Spark SQL)
SELECT * FROM lakehouse1.customers WHERE state = 'VA'

# Fabric cell 3 -- Scala is NOT available in Fabric
# Rewrite in PySpark:
df = spark.read.format("delta").load("Tables/customers")

# Fabric cell 4 (language: SparkR)
library(SparkR)
df <- read.df("Tables/customers", source = "delta")
```

### 3.2 %run (notebook inclusion)

**Databricks:**
```python
%run ./shared/utilities
%run ./config/settings
```

**Fabric:**
```python
# Option 1: mssparkutils.notebook.run() -- executes in a new session
result = mssparkutils.notebook.run("shared/utilities", timeout_seconds=120)

# Option 2: mssparkutils.notebook.runMultiple() -- parallel execution
mssparkutils.notebook.runMultiple(["shared/utilities", "config/settings"])

# Option 3: %run is also supported in Fabric (same syntax)
%run shared/utilities
```

### 3.3 %pip and %conda

**Databricks:**
```python
%pip install pandas==2.1.0 scikit-learn==1.3.0
%conda install -c conda-forge lightgbm
```

**Fabric:**
```python
# %pip works the same way
%pip install pandas==2.1.0 scikit-learn==1.3.0

# %conda is NOT supported in Fabric
# Use %pip or Fabric environments for conda-managed packages

# For persistent library management, use Fabric environments (see section 6)
```

### 3.4 %md (markdown)

**Databricks:**
```
%md
## Section Title
This is documentation within the notebook.
```

**Fabric:**
```
# Fabric uses markdown cells (cell type: Markdown)
# Same markdown syntax, different cell type selector
## Section Title
This is documentation within the notebook.
```

---

## 4. dbutils to mssparkutils translation

### 4.1 File system utilities

| Databricks (`dbutils.fs`) | Fabric (`mssparkutils.fs`) | Notes |
| --- | --- | --- |
| `dbutils.fs.ls("/mnt/data")` | `mssparkutils.fs.ls("Files/data")` | Path format changes |
| `dbutils.fs.cp(src, dst)` | `mssparkutils.fs.cp(src, dst)` | Same API |
| `dbutils.fs.rm(path, True)` | `mssparkutils.fs.rm(path, True)` | Same API |
| `dbutils.fs.head(path, 100)` | `mssparkutils.fs.head(path, 100)` | Same API |
| `dbutils.fs.mkdirs(path)` | `mssparkutils.fs.mkdirs(path)` | Same API |
| `dbutils.fs.mv(src, dst)` | `mssparkutils.fs.mv(src, dst)` | Same API |
| `dbutils.fs.put(path, content)` | `mssparkutils.fs.put(path, content)` | Same API |
| `dbutils.fs.mount(source, mount_point)` | OneLake shortcuts | No mount concept; use shortcuts |

### 4.2 Path translation

Databricks paths use `/mnt/`, DBFS, or Unity Catalog volumes. Fabric paths use OneLake:

| Databricks path | Fabric equivalent | Notes |
| --- | --- | --- |
| `/mnt/adls/container/path` | `abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Files/path` | Full ABFSS path |
| `/mnt/adls/container/path` | `Files/path` | Relative path within Lakehouse |
| `dbfs:/path` | `Files/path` | DBFS maps to Lakehouse Files |
| `hive_metastore.db.table` | `lakehouse1.table` | Lakehouse name replaces metastore |
| `catalog.schema.table` (UC) | `lakehouse1.table` | See unity-catalog-migration.md |

**Simplified path example:**

```python
# Databricks
df = spark.read.format("delta").load("/mnt/bronze/customers")
df.write.format("delta").mode("overwrite").save("/mnt/silver/customers_clean")

# Fabric (relative paths within default Lakehouse)
df = spark.read.format("delta").load("Tables/bronze_customers")
df.write.format("delta").mode("overwrite").saveAsTable("silver_customers_clean")
```

### 4.3 Secret management

```python
# Databricks
secret = dbutils.secrets.get(scope="my-scope", key="storage-key")

# Fabric -- uses Azure Key Vault via mssparkutils
secret = mssparkutils.credentials.getSecret(
    "https://my-keyvault.vault.azure.net/",
    "storage-key"
)

# Fabric -- using linked Key Vault
secret = mssparkutils.credentials.getSecret(
    "my-keyvault",       # linked service name
    "storage-key"        # secret name
)
```

### 4.4 Widgets (parameterized notebooks)

```python
# Databricks -- create widgets
dbutils.widgets.text("start_date", "2024-01-01", "Start Date")
dbutils.widgets.dropdown("environment", "dev", ["dev", "staging", "prod"])
start_date = dbutils.widgets.get("start_date")
environment = dbutils.widgets.get("environment")

# Fabric -- receive parameters (passed from Data Pipeline or notebook.run)
# Parameters are automatically available as variables when called from:
#   mssparkutils.notebook.run("notebook", params={"start_date": "2024-01-01"})
# Or from a Data Pipeline notebook activity with parameters

# In the notebook, use mssparkutils to get parameters:
start_date = mssparkutils.notebook.getParam("start_date", "2024-01-01")
environment = mssparkutils.notebook.getParam("environment", "dev")
```

### 4.5 Notebook exit values

```python
# Databricks
dbutils.notebook.exit("SUCCESS: processed 1000 rows")

# Fabric
mssparkutils.notebook.exit("SUCCESS: processed 1000 rows")
```

---

## 5. Spark configuration differences

### 5.1 Spark session

```python
# Databricks -- spark session is pre-configured with cluster settings
# Custom config:
spark.conf.set("spark.sql.shuffle.partitions", "200")
spark.conf.set("spark.databricks.delta.optimizeWrite.enabled", "true")  # Databricks-specific

# Fabric -- spark session is pre-configured with capacity settings
# Custom config:
spark.conf.set("spark.sql.shuffle.partitions", "200")
# Databricks-specific configs (spark.databricks.*) are NOT available
# Fabric equivalent for optimize write:
spark.conf.set("spark.microsoft.delta.optimizeWrite.enabled", "true")   # Fabric-specific
```

### 5.2 Delta table operations

```python
# Databricks
spark.sql("OPTIMIZE my_table ZORDER BY (customer_id)")
spark.sql("VACUUM my_table RETAIN 168 HOURS")

# Fabric -- auto-optimization handles most cases
# V-Order is applied automatically on write
# Manual OPTIMIZE is available but rarely needed:
spark.sql("OPTIMIZE my_table")  # ZORDER syntax is supported
spark.sql("VACUUM my_table RETAIN 168 HOURS")  # Same syntax
```

### 5.3 Table reads/writes

```python
# Databricks (Unity Catalog)
df = spark.table("catalog.schema.customers")
df.write.mode("overwrite").saveAsTable("catalog.schema.customers_clean")

# Fabric (Lakehouse)
df = spark.table("lakehouse1.customers")
df.write.mode("overwrite").saveAsTable("customers_clean")
# Or with explicit lakehouse reference:
df.write.mode("overwrite").saveAsTable("lakehouse1.customers_clean")
```

---

## 6. Library management

### 6.1 Databricks approach

Databricks manages libraries at multiple levels:
- **Cluster libraries** -- installed on all nodes when cluster starts
- **Notebook-scoped** -- `%pip install` in a cell
- **Unity Catalog volumes** -- host custom wheels
- **Init scripts** -- arbitrary bash at cluster startup

### 6.2 Fabric approach

Fabric uses **environments** for persistent library management:

1. **Create a Fabric environment** in the workspace
2. **Add public libraries** from PyPI (specify package + version)
3. **Upload custom libraries** (.whl, .tar.gz, .jar)
4. **Attach the environment** to a notebook or Spark job definition
5. Libraries are installed when the Spark session starts

```python
# In a notebook, you can also use inline installation:
%pip install great-expectations==0.18.0

# For production, use Fabric environments (admin portal):
# Workspace > Environments > New Environment > Add Libraries
```

### 6.3 Common library mapping

| Databricks library pattern | Fabric equivalent |
| --- | --- |
| Cluster library (always available) | Fabric environment (attached to notebook) |
| `%pip install` (notebook-scoped) | `%pip install` (same, session-scoped) |
| Init script (custom setup) | Not supported; use environment + %pip |
| Custom wheel on DBFS | Upload .whl to Fabric environment |
| Maven/Ivy JARs (Scala/Java) | Upload .jar to Fabric environment |
| Conda environment | Not supported; use pip equivalents |

---

## 7. Databricks Connect replacement

Databricks Connect allows IDE-based Spark development by connecting a local Python process to a remote Databricks cluster. Fabric does not have a direct equivalent.

### 7.1 Alternatives in Fabric

| Use case | Fabric alternative | Notes |
| --- | --- | --- |
| IDE development with Spark | VS Code for Fabric (preview) | Edit notebooks in VS Code, execute on Fabric |
| Remote DataFrame operations | Fabric REST API + Lakehouse JDBC/ODBC | Submit SQL queries via JDBC; no remote Spark context |
| Local testing before deployment | Local Spark + Fabric deployment | Test locally with PySpark, deploy to Fabric |
| CI/CD pipeline execution | Fabric REST API (notebook run) | Trigger notebook execution from CI/CD |
| Interactive exploration | Fabric notebook (browser) | Browser-based notebook experience |

### 7.2 JDBC/ODBC connection

```python
# Connect to Fabric Lakehouse SQL endpoint from local Python
import pyodbc

connection_string = (
    "Driver={ODBC Driver 18 for SQL Server};"
    "Server=<workspace-guid>.datawarehouse.fabric.microsoft.com;"
    "Database=<lakehouse-name>;"
    "Authentication=ActiveDirectoryInteractive;"
    "Encrypt=yes;"
    "TrustServerCertificate=no;"
)

conn = pyodbc.connect(connection_string)
cursor = conn.cursor()
cursor.execute("SELECT * FROM customers LIMIT 10")
rows = cursor.fetchall()
```

---

## 8. Migration checklist per notebook

For each notebook being migrated:

- [ ] **Inventory magic commands** -- identify `%sql`, `%scala`, `%run`, `%pip`
- [ ] **Replace dbutils calls** -- map to `mssparkutils` equivalents
- [ ] **Update file paths** -- `/mnt/` and `dbfs:/` to OneLake/Lakehouse paths
- [ ] **Replace table references** -- `catalog.schema.table` to `lakehouse.table`
- [ ] **Remove Databricks-specific configs** -- `spark.databricks.*` settings
- [ ] **Rewrite Scala cells** -- convert to PySpark
- [ ] **Test library availability** -- verify all `%pip` packages install on Fabric
- [ ] **Create Fabric environment** -- for production library management
- [ ] **Test data access** -- verify shortcuts or tables are accessible
- [ ] **Validate output** -- compare row counts, schema, and sample data between platforms
- [ ] **Set up scheduling** -- use Data Pipeline notebook activity for scheduled runs
- [ ] **Update downstream consumers** -- point Power BI, APIs, etc. to Fabric tables

---

## 9. Automated migration script

The following Python script automates basic notebook conversion. It handles the most common patterns but manual review is always required.

```python
"""
databricks_to_fabric_notebook.py
Converts Databricks notebook source to Fabric-compatible format.
Handles: dbutils -> mssparkutils, path translation, magic commands.
Does NOT handle: Scala code, complex init scripts, Databricks-specific Spark configs.
"""

import re
import json
from pathlib import Path

def convert_notebook(source_path: str, output_path: str):
    """Convert a Databricks .py notebook export to Fabric-compatible format."""

    with open(source_path, "r") as f:
        content = f.read()

    # Replace dbutils.fs with mssparkutils.fs
    content = content.replace("dbutils.fs.", "mssparkutils.fs.")

    # Replace dbutils.secrets with mssparkutils.credentials
    content = re.sub(
        r'dbutils\.secrets\.get\(scope="([^"]+)",\s*key="([^"]+)"\)',
        r'mssparkutils.credentials.getSecret("key-vault-name", "\2")',
        content
    )

    # Replace dbutils.widgets.get with mssparkutils equivalent
    content = re.sub(
        r'dbutils\.widgets\.get\("([^"]+)"\)',
        r'mssparkutils.notebook.getParam("\1", "")',
        content
    )

    # Replace dbutils.notebook.exit
    content = content.replace("dbutils.notebook.exit", "mssparkutils.notebook.exit")

    # Replace dbutils.notebook.run
    content = content.replace("dbutils.notebook.run", "mssparkutils.notebook.run")

    # Replace /mnt/ paths with Fabric-style paths
    content = re.sub(
        r'/mnt/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_/-]+)',
        r'Files/\1/\2',
        content
    )

    # Replace Databricks-specific Spark configs
    content = content.replace(
        "spark.databricks.delta.optimizeWrite.enabled",
        "spark.microsoft.delta.optimizeWrite.enabled"
    )

    # Remove widget creation (handled differently in Fabric)
    content = re.sub(
        r'dbutils\.widgets\.(text|dropdown|combobox|multiselect)\([^)]+\)\n?',
        '# Widget removed -- use notebook parameters instead\n',
        content
    )

    # Flag Scala cells for manual rewrite
    content = re.sub(
        r'# MAGIC %scala',
        '# TODO: Rewrite Scala cell in PySpark (Fabric does not support Scala notebooks)',
        content
    )

    with open(output_path, "w") as f:
        f.write(content)

    print(f"Converted: {source_path} -> {output_path}")
    print("IMPORTANT: Manual review required for Scala code, complex configs, and path patterns.")
```

---

## 10. Common pitfalls

| Pitfall | Mitigation |
| --- | --- |
| Assuming Photon performance | Benchmark query-heavy notebooks; Fabric Spark is slower for Photon-optimized code |
| Copying Scala notebooks | Rewrite in PySpark; no Fabric Scala notebook support |
| Hardcoded `/mnt/` paths | Use find-and-replace; update to Lakehouse relative paths |
| `spark.databricks.*` configs | Audit and remove; replace with Fabric equivalents where available |
| Init scripts for system packages | Use Fabric environments; some system-level packages may not be available |
| Databricks Connect workflows | Replace with Fabric REST API or VS Code for Fabric |
| Large notebooks (>500 lines) | Refactor into modular notebooks + Data Pipeline orchestration |

---

## Related

- [Feature Mapping](feature-mapping-complete.md) -- full feature-by-feature mapping
- [Tutorial: Notebook to Fabric](tutorial-notebook-to-fabric.md) -- hands-on walkthrough
- [Unity Catalog Migration](unity-catalog-migration.md) -- table reference changes
- [Best Practices](best-practices.md) -- notebook conversion checklist
- [Parent guide: 5-phase migration](../databricks-to-fabric.md)
- Fabric notebooks documentation: <https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook>

---

**Maintainers:** csa-inabox core team
**Source finding:** CSA-0083 (HIGH, XL) -- approved via AQ-0010 ballot B6
**Last updated:** 2026-04-30
