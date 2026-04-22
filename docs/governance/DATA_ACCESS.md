# Data Access — CSA-in-a-Box

This guide covers self-service access policies, approval workflows, RBAC
through collection hierarchy, data contract integration, audit logging, and
access review automation.

---

## Self-Service Access Policies

Purview Data Access Policies allow you to grant read/modify access to data
sources directly from the governance portal, without managing individual
Azure IAM role assignments.

### Prerequisites

1. Purview account must be registered as a "Data Use Management" source
2. The managed identity must have Owner or User Access Administrator on the target
3. The data source must support Purview policies (ADLS Gen2, Azure SQL)

### Enable Data Use Management on ADLS Gen2

```bash
TOKEN=$(az account get-access-token --resource "https://purview.azure.net" --query accessToken -o tsv)
PURVIEW_ENDPOINT="https://$PURVIEW_ACCOUNT.purview.azure.com"
SOURCE_NAME="adls-csadlzdevst"

# Enable data use management for the source
curl -s -X PATCH \
  "$PURVIEW_ENDPOINT/scan/datasources/$SOURCE_NAME?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "dataUseGovernance": "Enabled"
    }
  }'
```

### Create a Read Policy

```bash
# Grant a user read access to the gold container
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/policyStore/dataPolicies/read-gold-finance?api-version=2022-12-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "read-gold-finance",
    "properties": {
      "description": "Allow Finance team read access to gold/finance/ container",
      "decisionRules": [
        {
          "effect": "Permit",
          "dnfCondition": [
            [
              {
                "attributeName": "resource.path",
                "attributeValueIncludes": "gold/finance"
              },
              {
                "attributeName": "principal.microsoft.groups",
                "attributeValueIncludedIn": ["sg-finance-analysts"]
              },
              {
                "attributeName": "action.id",
                "attributeValueIncludes": "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"
              }
            ]
          ]
        }
      ],
      "collection": {
        "referenceName": "prod-finance",
        "type": "CollectionReference"
      }
    }
  }'
```

### Create a Read Policy for Azure SQL

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/policyStore/dataPolicies/read-sql-finance-reporting?api-version=2022-12-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "read-sql-finance-reporting",
    "properties": {
      "description": "Allow Finance team SELECT on the reporting schema",
      "decisionRules": [
        {
          "effect": "Permit",
          "dnfCondition": [
            [
              {
                "attributeName": "resource.path",
                "attributeValueIncludes": "reporting"
              },
              {
                "attributeName": "principal.microsoft.groups",
                "attributeValueIncludedIn": ["sg-finance-analysts"]
              },
              {
                "attributeName": "action.id",
                "attributeValueIncludes": "Microsoft.Sql/sqlservers/databases/schemas/tables/rows/select"
              }
            ]
          ]
        }
      ]
    }
  }'
```

---

## Approval Workflows for Sensitive Data

For data classified as Restricted or Confidential, require explicit approval
before granting access.

### Workflow Design

```
User requests access (Purview Studio or custom portal)
  └─→ Check classification level
       ├─ Public/Internal → Auto-approve via Purview policy
       ├─ Confidential → Domain Data Steward approval (1 approver)
       └─ Restricted → Data Governance Board approval (2 approvers)
           └─→ Approved? → Create time-limited Purview policy (90 days)
                └─→ Denied? → Notify requester with reason
```

### Implement with Azure Logic Apps

```json
{
  "definition": {
    "triggers": {
      "access_request": {
        "type": "Request",
        "inputs": {
          "schema": {
            "properties": {
              "requester_email": { "type": "string" },
              "asset_qualified_name": { "type": "string" },
              "justification": { "type": "string" },
              "classification_level": { "type": "string" }
            }
          }
        }
      }
    },
    "actions": {
      "check_classification": {
        "type": "Switch",
        "expression": "@triggerBody()?['classification_level']",
        "cases": {
          "restricted": {
            "actions": {
              "send_approval": {
                "type": "ApiConnection",
                "inputs": {
                  "host": { "connection": { "name": "office365" } },
                  "method": "post",
                  "path": "/approvalmail",
                  "body": {
                    "to": "data-governance-board@contoso.com",
                    "subject": "Access Request: Restricted Data",
                    "body": "Requester: @{triggerBody()?['requester_email']}\nAsset: @{triggerBody()?['asset_qualified_name']}\nJustification: @{triggerBody()?['justification']}"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

---

## RBAC Inheritance Through Collection Hierarchy

Purview collections form a hierarchy. Role assignments on parent collections
inherit to children.

### Collection RBAC Roles

| Role | Permissions | Typical Assignment |
|---|---|---|
| Collection Admin | Full control on collection and children | Platform team |
| Data Source Admin | Register/scan sources in collection | Data engineers |
| Data Curator | Edit metadata, glossary terms, classifications | Data stewards |
| Data Reader | Browse and search assets | All data consumers |
| Policy Author | Create and manage access policies | Governance team |

### Assign Roles via REST API

```bash
# Add a group as Data Reader on the Finance collection
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/account/collections/prod-finance/metadataPolicy?api-version=2019-11-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "attributeRules": [
        {
          "kind": "attributerule",
          "id": "purviewmetadatarole_builtin_data-reader",
          "name": "purviewmetadatarole_builtin_data-reader",
          "dnfCondition": [
            [
              {
                "attributeName": "principal.microsoft.id",
                "attributeValueIncludedIn": ["<aad-group-object-id>"]
              },
              {
                "attributeName": "derived.purview.role",
                "attributeValueIncludes": "purviewmetadatarole_builtin_data-reader"
              }
            ]
          ]
        }
      ]
    }
  }'
```

### Inheritance Model

```
Root (Collection Admin: Platform Team)
├── Production (Data Source Admin: Data Engineering)
│   ├── Finance (Data Reader: sg-finance-analysts)
│   │   └── inherits: Platform Team (Admin), Data Engineering (Source Admin)
│   └── Healthcare (Data Reader: sg-healthcare-analysts)
│       └── inherits: same as above
└── Development (Data Reader: sg-all-developers)
```

---

## Integration with Data Contracts

CSA-in-a-Box data contracts (see `csa_platform/governance/contracts/`) define
access requirements. The `pipeline_enforcer.py` checks Purview policies before
pipeline execution.

### Contract-Driven Access

A `contract.yaml` specifies who can consume the data:

```yaml
# Example contract for gold customer data
name: gld_customer_lifetime_value
version: "2.0"
owner: finance-team@contoso.com
classification: Confidential

access:
  read:
    - group: sg-finance-analysts
      purpose: "Financial reporting and CLV analysis"
    - group: sg-marketing-analytics
      purpose: "Customer segmentation campaigns"
      expires: "2025-06-30"
  write:
    - group: sg-data-engineering
      purpose: "Pipeline output"

sla:
  freshness_hours: 4
  quality_score_minimum: 0.90
```

### Sync Contract to Purview Policy

```python
import yaml

def sync_contract_to_purview(contract_path: str, purview: PurviewAutomation) -> None:
    """Create Purview access policies from a data contract."""
    with open(contract_path) as f:
        contract = yaml.safe_load(f)

    for access in contract.get("access", {}).get("read", []):
        policy_name = f"contract-{contract['name']}-{access['group']}"
        purview._make_request("PUT", f"/policyStore/dataPolicies/{policy_name}?api-version=2022-12-01-preview", body={
            "name": policy_name,
            "properties": {
                "description": f"Auto-generated from contract {contract['name']}: {access['purpose']}",
                "decisionRules": [{
                    "effect": "Permit",
                    "dnfCondition": [[
                        {"attributeName": "principal.microsoft.groups", "attributeValueIncludedIn": [access["group"]]},
                        {"attributeName": "action.id", "attributeValueIncludes": "read"},
                    ]],
                }],
            },
        })
```

---

## Audit Logging and Compliance Reporting

### Enable Diagnostic Logging

The DMLZ Bicep template enables diagnostic settings on the Purview account.
Query access events in Log Analytics:

```kusto
// All data access policy evaluations in the last 7 days
PurviewSecurityLogs
| where TimeGenerated > ago(7d)
| where OperationName == "PolicyEvaluation"
| project TimeGenerated, CallerIdentity, ResourcePath, Decision, PolicyName
| order by TimeGenerated desc

// Denied access attempts
PurviewSecurityLogs
| where TimeGenerated > ago(30d)
| where Decision == "Deny"
| summarize DeniedCount=count() by CallerIdentity, ResourcePath
| order by DeniedCount desc

// Access pattern summary for compliance
PurviewSecurityLogs
| where TimeGenerated > ago(90d)
| summarize
    TotalAccess=count(),
    UniqueUsers=dcount(CallerIdentity),
    UniqueResources=dcount(ResourcePath)
  by bin(TimeGenerated, 1d)
| render timechart
```

### Export Compliance Report

```bash
# Export access audit for the last 90 days
az monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --analytics-query "
    PurviewSecurityLogs
    | where TimeGenerated > ago(90d)
    | project TimeGenerated, CallerIdentity, ResourcePath, Decision, PolicyName
    | order by TimeGenerated desc
  " \
  -o table > access_audit_report.csv
```

---

## Access Review Automation

### Periodic Access Review

Automate quarterly access reviews by comparing active policies against
actual usage:

```python
from azure.identity import DefaultAzureCredential
from csa_platform.governance.purview.purview_automation import PurviewAutomation
from datetime import datetime, timedelta, timezone

def review_stale_policies(purview: PurviewAutomation, days_unused: int = 90) -> list[dict]:
    """Find access policies with no usage in the specified period."""
    # List all active policies
    policies = purview._make_request("GET", "/policyStore/dataPolicies?api-version=2022-12-01-preview")

    stale = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_unused)

    for policy in policies.get("value", []):
        last_used = policy.get("properties", {}).get("lastUsedDate")
        if last_used and datetime.fromisoformat(last_used) < cutoff:
            stale.append({
                "name": policy["name"],
                "last_used": last_used,
                "description": policy.get("properties", {}).get("description", ""),
            })

    return stale


# Run review
purview = PurviewAutomation("csadmlzdevpview", DefaultAzureCredential())
stale_policies = review_stale_policies(purview, days_unused=90)
for p in stale_policies:
    print(f"STALE: {p['name']} (last used: {p['last_used']})")
```

### Expire Time-Limited Access

```python
def expire_policies(purview: PurviewAutomation) -> list[str]:
    """Delete policies past their expiration date."""
    policies = purview._make_request("GET", "/policyStore/dataPolicies?api-version=2022-12-01-preview")
    expired = []

    for policy in policies.get("value", []):
        expires = policy.get("properties", {}).get("expiresAt")
        if expires and datetime.fromisoformat(expires) < datetime.now(timezone.utc):
            purview._make_request("DELETE", f"/policyStore/dataPolicies/{policy['name']}?api-version=2022-12-01-preview")
            expired.append(policy["name"])

    return expired
```

---

## Next Steps

- [Purview Setup](PURVIEW_SETUP.md) — Initial deployment and configuration
- [Data Cataloging](DATA_CATALOGING.md) — Classify assets to drive access decisions
- [Data Quality](DATA_QUALITY.md) — Gate access on quality scores
