---
title: "Data Quality Best Practices"
description: "> **[Home](../index.md)** | **[Best Practices](index.md)** | **Data Quality**"
tags:
  - best-practices
---
# Data Quality Best Practices

> **[Home](../index.md)** | **[Best Practices](index.md)** | **Data Quality**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)

Best practices for ensuring data quality in Cloud Scale Analytics.

---

## Data Quality Dimensions

| Dimension | Definition | Metric |
|-----------|------------|--------|
| Completeness | Data is not missing | % of non-null values |
| Accuracy | Data reflects reality | % matching source |
| Consistency | Data is uniform | % passing validation |
| Timeliness | Data is current | Freshness in hours |
| Uniqueness | No duplicates | % unique records |
| Validity | Data meets rules | % passing constraints |

---

## Implementation

### Great Expectations Framework

```python
import great_expectations as gx

# Create expectation suite
context = gx.get_context()
suite = context.add_expectation_suite("sales_quality")

# Define expectations
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToNotBeNull(column="order_id")
)
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeBetween(
        column="amount",
        min_value=0,
        max_value=1000000
    )
)
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToMatchRegex(
        column="email",
        regex=r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$"
    )
)

# Run validation
results = context.run_checkpoint(
    checkpoint_name="sales_checkpoint",
    batch_request=batch_request
)
```

### Delta Lake Constraints

```sql
-- Add constraints to Delta tables
ALTER TABLE gold.customers
ADD CONSTRAINT valid_email CHECK (email RLIKE '^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+$');

ALTER TABLE gold.orders
ADD CONSTRAINT positive_amount CHECK (amount > 0);

ALTER TABLE gold.orders
ADD CONSTRAINT valid_status CHECK (status IN ('pending', 'shipped', 'delivered', 'cancelled'));
```

### Data Quality Monitoring

```python
# PySpark data quality checks
from pyspark.sql import functions as F

def run_quality_checks(df, table_name):
    """Run data quality checks and return metrics."""

    total_rows = df.count()

    metrics = {
        "table": table_name,
        "total_rows": total_rows,
        "null_checks": {},
        "duplicate_check": 0
    }

    # Null checks per column
    for col in df.columns:
        null_count = df.filter(F.col(col).isNull()).count()
        metrics["null_checks"][col] = {
            "null_count": null_count,
            "null_pct": (null_count / total_rows) * 100
        }

    # Duplicate check
    distinct_count = df.distinct().count()
    metrics["duplicate_count"] = total_rows - distinct_count

    return metrics
```

---

## Quality Gates

### Pipeline Integration

```python
def quality_gate(df, thresholds):
    """Quality gate that fails pipeline if thresholds not met."""

    metrics = run_quality_checks(df, "staging_table")

    # Check completeness
    for col, threshold in thresholds.get("completeness", {}).items():
        null_pct = metrics["null_checks"][col]["null_pct"]
        if null_pct > (100 - threshold):
            raise ValueError(f"Column {col} completeness below {threshold}%")

    # Check duplicates
    if metrics["duplicate_count"] > thresholds.get("max_duplicates", 0):
        raise ValueError(f"Too many duplicates: {metrics['duplicate_count']}")

    return True

# Usage in pipeline
quality_gate(df, {
    "completeness": {"customer_id": 100, "email": 99},
    "max_duplicates": 0
})
```

---

## Related Documentation

- [Data Governance](data-governance/README.md)
- Delta Lake Optimization

---

*Last Updated: January 2025*
