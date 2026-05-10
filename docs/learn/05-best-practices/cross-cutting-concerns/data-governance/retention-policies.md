# Data Retention Policies

> **[Home](../../../../README.md)** | **[Best Practices](../../README.md)** | **[Cross-Cutting](../README.md)** | **Retention Policies**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Governance-purple?style=flat-square)

Data retention policy implementation for Azure analytics platforms.

---

## Overview

Effective data retention ensures compliance, cost optimization, and performance across your data platform.

---

## Retention Strategy

### Tiered Retention Model

| Tier | Retention Period | Storage Class | Use Case |
|------|------------------|---------------|----------|
| Hot | 0-30 days | Premium/Hot | Active analytics |
| Warm | 30-90 days | Standard/Cool | Recent history |
| Cold | 90-365 days | Cool | Compliance |
| Archive | 1-7 years | Archive | Legal hold |

### Implementation Pattern

```python
# Delta Lake retention configuration
from delta.tables import DeltaTable

def configure_table_retention(table_path: str, retention_days: int = 30):
    """Configure Delta Lake table retention."""
    spark.sql(f"""
        ALTER TABLE delta.`{table_path}`
        SET TBLPROPERTIES (
            'delta.deletedFileRetentionDuration' = 'interval {retention_days} days',
            'delta.logRetentionDuration' = 'interval {retention_days} days'
        )
    """)

# Apply retention with VACUUM
def enforce_retention(table_path: str, retention_hours: int = 168):
    """Remove files older than retention period."""
    delta_table = DeltaTable.forPath(spark, table_path)
    delta_table.vacuum(retention_hours)
```

---

## Storage Lifecycle Management

### Azure Storage Policy

```json
{
    "rules": [
        {
            "name": "move-to-cool-tier",
            "enabled": true,
            "type": "Lifecycle",
            "definition": {
                "filters": {
                    "blobTypes": ["blockBlob"],
                    "prefixMatch": ["bronze/", "silver/"]
                },
                "actions": {
                    "baseBlob": {
                        "tierToCool": {"daysAfterModificationGreaterThan": 30},
                        "tierToArchive": {"daysAfterModificationGreaterThan": 180},
                        "delete": {"daysAfterModificationGreaterThan": 730}
                    }
                }
            }
        },
        {
            "name": "gold-retention",
            "enabled": true,
            "type": "Lifecycle",
            "definition": {
                "filters": {
                    "blobTypes": ["blockBlob"],
                    "prefixMatch": ["gold/"]
                },
                "actions": {
                    "baseBlob": {
                        "tierToCool": {"daysAfterModificationGreaterThan": 90},
                        "delete": {"daysAfterModificationGreaterThan": 2555}
                    }
                }
            }
        }
    ]
}
```

### Terraform Configuration

```hcl
resource "azurerm_storage_management_policy" "retention" {
  storage_account_id = azurerm_storage_account.datalake.id

  rule {
    name    = "bronze-retention"
    enabled = true

    filters {
      prefix_match = ["bronze/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        tier_to_cool_after_days_since_modification_greater_than    = 30
        tier_to_archive_after_days_since_modification_greater_than = 180
        delete_after_days_since_modification_greater_than          = 730
      }
    }
  }
}
```

---

## Compliance Requirements

### Regulatory Mapping

| Regulation | Min Retention | Max Retention | Notes |
|------------|---------------|---------------|-------|
| GDPR | None | As needed | Right to erasure |
| HIPAA | 6 years | None | From last use |
| SOX | 7 years | None | Financial records |
| PCI DSS | 1 year | None | Audit logs |

### Implementation

```python
class RetentionPolicyManager:
    """Manage retention policies by data classification."""

    POLICIES = {
        "pii": {"retention_days": 365, "archive_days": 730},
        "financial": {"retention_days": 2555, "archive_days": 3650},
        "operational": {"retention_days": 90, "archive_days": 365},
        "telemetry": {"retention_days": 30, "archive_days": 90}
    }

    def apply_policy(self, table_path: str, classification: str):
        """Apply retention policy based on data classification."""
        policy = self.POLICIES.get(classification, self.POLICIES["operational"])

        # Configure Delta Lake
        configure_table_retention(table_path, policy["retention_days"])

        # Schedule VACUUM
        self.schedule_vacuum(table_path, policy["retention_days"])
```

---

## Automated Enforcement

### Scheduled Jobs

```python
# Databricks job for retention enforcement
def daily_retention_job():
    """Daily job to enforce retention policies."""
    tables = spark.sql("""
        SELECT table_path, classification
        FROM governance.table_registry
        WHERE retention_enabled = true
    """).collect()

    for table in tables:
        try:
            policy_manager.apply_policy(
                table.table_path,
                table.classification
            )
            log_success(table.table_path)
        except Exception as e:
            log_failure(table.table_path, str(e))
            alert_on_failure(table.table_path)
```

### Monitoring

```sql
-- Track retention compliance
SELECT
    table_path,
    classification,
    last_vacuum_date,
    DATEDIFF(current_date(), last_vacuum_date) as days_since_vacuum,
    CASE
        WHEN DATEDIFF(current_date(), last_vacuum_date) > 7 THEN 'OVERDUE'
        ELSE 'COMPLIANT'
    END as status
FROM governance.retention_audit
ORDER BY days_since_vacuum DESC;
```

---

## Related Documentation

- [Data Governance](../governance/metadata-governance.md)
- [Storage Best Practices](../../service-specific/storage/README.md)
- [Compliance Guide](../../../../security/compliance-guide.md)

---

*Last Updated: January 2025*
