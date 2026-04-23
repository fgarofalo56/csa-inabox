# Data Quality — CSA-in-a-Box

This guide covers quality rules via Great Expectations, Purview Data Quality,
quality scoring, dashboards, and automated remediation.

---

## Quality Framework Overview

CSA-in-a-Box implements data quality at two levels:

1. **Great Expectations** — Code-driven expectations executed in Databricks and
   CI/CD pipelines (see `csa_platform/governance/dataquality/`)
2. **Purview Data Quality** — No-code rules defined in Purview Studio for
   continuous monitoring

Quality rules are defined in `csa_platform/governance/dataquality/quality-rules.yaml`
and organized by medallion layer.

---

## Great Expectations — Quality Rules per Layer

### Bronze Layer: Ingestion Validation

Bronze expectations verify that raw data arrived correctly.

```python
# csa_platform/governance/dataquality/expectations/bronze_suite.py
import great_expectations as gx

context = gx.get_context()

# Create the bronze validation suite
suite = context.add_expectation_suite("bronze_ingestion_suite")

# Completeness — required columns must not be null
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToNotBeNull(column="customer_id")
)
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToNotBeNull(column="_ingested_at")
)

# Schema conformance — expected columns exist
suite.add_expectation(
    gx.expectations.ExpectTableColumnsToMatchSet(
        column_set=["customer_id", "email", "first_name", "last_name",
                     "_ingested_at", "_source_file"],
        exact_match=False,  # Allow additional columns
    )
)

# Freshness — data arrived within the SLA window
suite.add_expectation(
    gx.expectations.ExpectColumnMaxToBeBetween(
        column="_ingested_at",
        min_value={"$PARAMETER": "now() - interval 24 hours"},
    )
)

# Row count — minimum expected volume
suite.add_expectation(
    gx.expectations.ExpectTableRowCountToBeBetween(
        min_value=100,
    )
)
```

### Silver Layer: Cleansing Validation

```python
# Silver suite — data has been cleansed and conformed
suite = context.add_expectation_suite("silver_cleansing_suite")

# Uniqueness — surrogate keys are unique
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeUnique(column="customer_sk")
)

# Referential integrity — FK values exist in parent table
suite.add_expectation(
    gx.expectations.ExpectColumnDistinctValuesToBeInSet(
        column="customer_id",
        value_set={"$PARAMETER": "query:SELECT DISTINCT customer_id FROM silver.slv_customers"},
    )
)

# Range checks — business-valid ranges
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeBetween(
        column="total_amount",
        min_value=0,
        max_value=10_000_000,
    )
)

# Enum validation
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeInSet(
        column="order_status",
        value_set=["pending", "confirmed", "shipped", "delivered",
                   "cancelled", "returned"],
    )
)

# Null rate — at most 5% nulls in optional fields
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToNotBeNull(
        column="email",
        mostly=0.95,
    )
)
```

### Gold Layer: Business Rule Compliance

```python
# Gold suite — business-ready aggregates
suite = context.add_expectation_suite("gold_business_suite")

# Aggregation accuracy — revenue cannot be negative
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeBetween(
        column="total_revenue",
        min_value=0,
    )
)

# Business rule compliance — segment must match value
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeInSet(
        column="customer_segment",
        value_set=["active", "at_risk", "churned", "never_purchased"],
    )
)

# Cross-column validation — active customers must have positive revenue
suite.add_expectation(
    gx.expectations.ExpectColumnPairValuesAToBeGreaterThanB(
        column_A="lifetime_revenue",
        column_B={"$PARAMETER": "literal:0"},
        or_equal=True,
        condition_parser="pandas",
        row_condition="customer_segment == 'active'",
    )
)

# Tier distribution — no single tier should exceed 60% of rows
suite.add_expectation(
    gx.expectations.ExpectColumnProportionOfUniqueValuesToBeBetween(
        column="value_tier",
        min_value=0.01,
    )
)
```

### Run Expectations in Databricks

```python
# In a Databricks notebook
import great_expectations as gx

context = gx.get_context(project_config="csa_platform/governance/dataquality/great_expectations.yml")

# Create a Spark datasource for ADLS
datasource = context.sources.add_or_update_spark("adls_silver")
asset = datasource.add_dataframe_asset("slv_customers")

batch_request = asset.build_batch_request(dataframe=spark.table("silver.slv_customers"))
results = context.run_checkpoint(
    checkpoint_name="daily_quality",
    batch_request=batch_request,
    expectation_suite_name="silver_cleansing_suite",
)

# Check results
if not results.success:
    failed = [r for r in results.run_results.values() if not r.success]
    print(f"QUALITY CHECK FAILED: {len(failed)} expectations failed")
    for f in failed:
        print(f"  - {f.expectation_config.expectation_type}: {f.result}")
```

---

## Purview Data Quality Rules (No-Code)

Purview's built-in Data Quality feature lets you define rules without code
via the portal.

### Create Rules in Purview Studio

1. Navigate to **Data Quality** → **Quality rules**
2. Click **+ New rule**
3. Configure:

| Rule Type | Example Configuration |
|---|---|
| Completeness | Column `customer_id` must not be null, threshold 99% |
| Uniqueness | Column `order_sk` must be unique, threshold 100% |
| Freshness | Table must have rows updated within 24 hours |
| Range | Column `total_amount` must be between 0 and 10,000,000 |
| Regex | Column `email` must match `^[a-zA-Z0-9+_.-]+@[a-zA-Z0-9.-]+$` |

### Assign Rules to Assets

1. Go to the asset in the Data Catalog
2. Click **Data Quality** tab
3. Click **+ Add rule**
4. Select the rule(s) and set the evaluation schedule

---

## Quality Scoring

CSA-in-a-Box computes a composite quality score using four dimensions:

### Scoring Formula

```
Quality Score = (w₁ × Completeness) + (w₂ × Accuracy) + (w₃ × Timeliness) + (w₄ × Consistency)
```

Default weights:

| Dimension | Weight | Description | How Measured |
|---|---|---|---|
| Completeness | 0.30 | % of non-null values in required columns | GE `expect_column_values_to_not_be_null` |
| Accuracy | 0.30 | % of values passing business rules | GE custom expectations |
| Timeliness | 0.20 | Whether data arrived within SLA | `_ingested_at` vs SLA threshold |
| Consistency | 0.20 | % of values matching expected formats/ranges | GE range/regex expectations |

### Compute Quality Score

```python
def compute_quality_score(
    completeness: float,
    accuracy: float,
    timeliness: float,
    consistency: float,
    weights: dict[str, float] | None = None,
) -> float:
    """Compute weighted quality score (0.0 to 1.0).

    Args:
        completeness: Fraction of non-null required values (0.0-1.0).
        accuracy: Fraction of values passing business rules (0.0-1.0).
        timeliness: 1.0 if within SLA, 0.0 if stale, linear decay between.
        consistency: Fraction of values matching expected format (0.0-1.0).
        weights: Override default weights.

    Returns:
        Composite quality score between 0.0 and 1.0.
    """
    w = weights or {
        "completeness": 0.30,
        "accuracy": 0.30,
        "timeliness": 0.20,
        "consistency": 0.20,
    }
    return (
        w["completeness"] * completeness
        + w["accuracy"] * accuracy
        + w["timeliness"] * timeliness
        + w["consistency"] * consistency
    )


# Example
score = compute_quality_score(
    completeness=0.98,
    accuracy=0.95,
    timeliness=1.0,
    consistency=0.97,
)
print(f"Quality Score: {score:.2%}")  # 97.30%
```

### Quality Tiers

| Score Range | Tier | Action |
|---|---|---|
| ≥ 0.95 | 🟢 Excellent | Eligible for Certified endorsement |
| 0.85–0.94 | 🟡 Good | Endorsed, minor improvements needed |
| 0.70–0.84 | 🟠 Fair | Requires remediation plan |
| < 0.70 | 🔴 Poor | Block downstream consumption, alert data steward |

---

## Quality Dashboards and Alerting

### Push Metrics to Azure Monitor

```python
import requests

def push_quality_metric(
    workspace_id: str,
    table_name: str,
    score: float,
    dimension: str,
) -> None:
    """Push a quality score as a custom metric to Azure Monitor."""
    from azure.identity import DefaultAzureCredential
    from azure.monitor.ingestion import LogsIngestionClient

    credential = DefaultAzureCredential()
    client = LogsIngestionClient(
        endpoint=f"https://{workspace_id}.ods.opinsights.azure.com",
        credential=credential,
    )

    client.upload(
        rule_id="dcr-quality-metrics",
        stream_name="Custom-DataQuality_CL",
        logs=[{
            "TimeGenerated": datetime.utcnow().isoformat(),
            "TableName": table_name,
            "Dimension": dimension,
            "Score": score,
            "Tier": "excellent" if score >= 0.95 else "good" if score >= 0.85 else "fair" if score >= 0.70 else "poor",
        }],
    )
```

### Alert on Quality Failures

Configure Azure Monitor alerts using the quality-rules.yaml alert channels:

```bash
# Create an alert rule for quality score drops
az monitor metrics alert create \
  --name "data-quality-alert" \
  --resource-group "rg-dmlz-dev" \
  --scopes "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-dmlz-dev/providers/Microsoft.OperationalInsights/workspaces/csadmlzdevlaw" \
  --condition "avg Custom.DataQuality_CL.Score < 0.70" \
  --description "Data quality score dropped below 70%" \
  --action-group "dq-alerts-ag" \
  --severity 2
```

### Teams Notification

```python
import requests

def notify_teams(webhook_url: str, table: str, score: float, failures: list[str]) -> None:
    """Send a Teams notification for quality failures."""
    card = {
        "@type": "MessageCard",
        "summary": f"Data Quality Alert: {table}",
        "themeColor": "FF0000" if score < 0.70 else "FFA500",
        "sections": [{
            "activityTitle": f"Quality Alert: {table}",
            "facts": [
                {"name": "Score", "value": f"{score:.1%}"},
                {"name": "Failed Checks", "value": ", ".join(failures)},
            ],
        }],
    }
    requests.post(webhook_url, json=card, timeout=10)
```

---

## Push Quality Scores to Purview

Update asset business metadata with quality scores so they are searchable
in the data catalog:

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/guid/$ENTITY_GUID/businessmetadata?isOverwrite=true" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "CSA_DataGovernance": {
      "quality_tier": "gold",
      "sla_hours": 4
    }
  }'
```

For a richer integration, create a dedicated `CSA_DataQuality` business metadata
type:

```bash
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/types/typedefs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessMetadataDefs": [{
      "name": "CSA_DataQuality",
      "description": "Data quality scores from Great Expectations",
      "attributeDefs": [
        { "name": "quality_score", "typeName": "float", "description": "Composite quality score 0.0-1.0", "isOptional": true, "cardinality": "SINGLE", "options": { "applicableEntityTypes": "[\"DataSet\"]" } },
        { "name": "completeness_score", "typeName": "float", "isOptional": true, "cardinality": "SINGLE", "options": { "applicableEntityTypes": "[\"DataSet\"]" } },
        { "name": "accuracy_score", "typeName": "float", "isOptional": true, "cardinality": "SINGLE", "options": { "applicableEntityTypes": "[\"DataSet\"]" } },
        { "name": "last_checked", "typeName": "string", "isOptional": true, "cardinality": "SINGLE", "options": { "applicableEntityTypes": "[\"DataSet\"]" } }
      ]
    }]
  }'
```

---

## Automated Remediation Workflows

### Quarantine Pattern

When quality checks fail on bronze data, move the batch to a quarantine
container for investigation:

```python
from azure.storage.filedatalake import DataLakeServiceClient
from azure.identity import DefaultAzureCredential

def quarantine_bad_batch(
    storage_account: str,
    source_path: str,     # e.g., "bronze/customers/2025/01/12/"
    reason: str,
) -> str:
    """Move a failed batch to the quarantine container."""
    credential = DefaultAzureCredential()
    client = DataLakeServiceClient(
        account_url=f"https://{storage_account}.dfs.core.windows.net",
        credential=credential,
    )

    source_fs = client.get_file_system_client("bronze")
    quarantine_fs = client.get_file_system_client("quarantine")

    # Copy each file to quarantine
    for path in source_fs.get_paths(path=source_path):
        if path.is_directory:
            continue
        source_file = source_fs.get_file_client(path.name)
        dest_path = f"bronze/{path.name}"
        dest_file = quarantine_fs.get_file_client(dest_path)

        dest_file.upload_data(
            source_file.download_file().readall(),
            overwrite=True,
            metadata={"quarantine_reason": reason},
        )
        source_file.delete_file()

    return f"quarantine/bronze/{source_path}"
```

### Auto-Retry Pattern

For transient quality failures (e.g., late-arriving data), schedule a re-check:

```python
def schedule_recheck(table_name: str, delay_minutes: int = 30) -> None:
    """Schedule a quality re-check after a delay."""
    from azure.servicebus import ServiceBusClient, ServiceBusMessage
    import json
    from datetime import datetime, timedelta, timezone

    client = ServiceBusClient.from_connection_string(conn_str)
    sender = client.get_queue_sender("quality-recheck")

    message = ServiceBusMessage(
        body=json.dumps({"table": table_name, "retry_count": 1}),
        scheduled_enqueue_time_utc=datetime.now(timezone.utc) + timedelta(minutes=delay_minutes),
    )
    sender.send_messages(message)
```

---

## Next Steps

- [Data Access](DATA_ACCESS.md) — Gate access based on quality scores
- [Data Lineage](DATA_LINEAGE.md) — Track quality propagation across lineage
