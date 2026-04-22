# Data Cataloging — CSA-in-a-Box

This guide covers the business glossary, custom classifications, sensitivity
labels, asset certification, and search/discovery best practices in Purview.

---

## Business Glossary

The business glossary provides a shared vocabulary that bridges technical asset
names and business concepts. CSA-in-a-Box organizes glossary terms into
hierarchical categories.

### Glossary Structure

```
CSA Business Glossary
├── Cloud Scale Analytics
│   ├── Medallion Architecture
│   ├── Data Lake
│   ├── Data Lakehouse
│   ├── Bronze Layer (raw ingestion)
│   ├── Silver Layer (cleansed, conformed)
│   └── Gold Layer (business-ready aggregates)
├── Data Governance
│   ├── Data Contract
│   ├── Data Quality
│   ├── Data Lineage
│   ├── Data Classification
│   └── Sensitivity Label
├── Finance Domain
│   ├── Revenue
│   │   ├── Gross Revenue
│   │   └── Net Revenue
│   ├── Cost of Goods Sold
│   └── Customer Lifetime Value
├── Healthcare Domain
│   ├── Protected Health Information
│   ├── Medical Record Number
│   └── Diagnosis Code
└── Metrics
    ├── Completeness Score
    ├── Accuracy Score
    └── Timeliness Score
```

### Create Term Hierarchies

```bash
TOKEN=$(az account get-access-token --resource "https://purview.azure.net" --query accessToken -o tsv)
PURVIEW_ENDPOINT="https://$PURVIEW_ACCOUNT.purview.azure.com"

# Step 1: Get or create the root glossary
GLOSSARY_GUID=$(curl -s "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].guid // empty')

if [ -z "$GLOSSARY_GUID" ]; then
  GLOSSARY_GUID=$(curl -s -X POST \
    "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "CSA Business Glossary",
      "shortDescription": "Enterprise glossary for CSA-in-a-Box",
      "longDescription": "Business vocabulary for the Cloud Scale Analytics platform."
    }' | jq -r '.guid')
fi

echo "Glossary GUID: $GLOSSARY_GUID"

# Step 2: Create a parent term
PARENT_GUID=$(curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary/term" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Finance Domain",
    "shortDescription": "Financial data concepts and metrics",
    "longDescription": "Terms related to financial data within the CSA platform.",
    "status": "Approved",
    "anchor": { "glossaryGuid": "'$GLOSSARY_GUID'" }
  }' | jq -r '.guid')

# Step 3: Create child terms under the parent
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary/term" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Gross Revenue",
    "shortDescription": "Total revenue before deductions",
    "longDescription": "Sum of all revenue from product and service sales before returns, discounts, and allowances are subtracted.",
    "status": "Approved",
    "anchor": { "glossaryGuid": "'$GLOSSARY_GUID'" },
    "parentRelatedTerm": { "termGuid": "'$PARENT_GUID'" },
    "contacts": {
      "Expert": [{ "id": "finance-team@contoso.com", "info": "Finance Analytics Team" }]
    },
    "resources": [
      { "displayName": "Revenue Recognition Policy", "url": "https://wiki.contoso.com/revenue" }
    ]
  }'

curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary/term" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Net Revenue",
    "shortDescription": "Revenue after deductions",
    "longDescription": "Gross revenue minus returns, refunds, discounts, and sales allowances. The primary top-line metric for financial reporting.",
    "status": "Approved",
    "anchor": { "glossaryGuid": "'$GLOSSARY_GUID'" },
    "parentRelatedTerm": { "termGuid": "'$PARENT_GUID'" }
  }'
```

### Bulk Import via Python

Use the automation script to import all terms from YAML:

```bash
python -m csa_platform.governance.purview.purview_automation \
  --account csadmlzdevpview \
  --action import-glossary \
  --glossary-file scripts/governance/glossary-terms.yaml
```

Or use `scripts/governance/seed-glossary.py` for hierarchical import:

```bash
python scripts/governance/seed-glossary.py \
  --purview-account csadmlzdevpview \
  --glossary-file scripts/governance/glossary-terms.yaml
```

---

## Link Glossary Terms to Technical Assets

Once terms exist, link them to discovered data assets so business users can
search by business concept rather than table name.

```bash
# Find the asset GUID for the gold customers table
ENTITY_GUID=$(curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "keywords": "gld_customer_lifetime_value", "limit": 1 }' \
  | jq -r '.value[0].id')

# Link the "Customer Lifetime Value" glossary term
CLV_TERM_GUID="<guid-of-CLV-term>"
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/glossary/terms/$CLV_TERM_GUID/assignedEntities" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{ "guid": "'$ENTITY_GUID'" }]'
```

---

## Custom Classifications

CSA-in-a-Box defines custom classifiers beyond Microsoft's built-in set.
Classification rules are stored in
`csa_platform/governance/purview/classifications/`.

### Create Regex-Based Classifiers

```bash
# US Social Security Number (custom pattern with dashes and without)
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/classificationrules/CSA_PII_SSN?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "Custom",
    "properties": {
      "description": "US Social Security Number with or without dashes",
      "classificationName": "CSA_PII_SSN",
      "ruleStatus": "Enabled",
      "minimumPercentageMatch": 60.0,
      "dataPatterns": [
        { "pattern": "\\b(?!000|666|9\\d{2})\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b" },
        { "pattern": "\\b(?!000|666|9\\d{2})\\d{3}(?!00)\\d{2}(?!0000)\\d{4}\\b" }
      ],
      "columnPatterns": [
        { "pattern": "(?i)(ssn|social_security|social_sec|ss_number|ss_num)" }
      ]
    }
  }'

# Employer Identification Number (EIN)
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/classificationrules/CSA_GOV_EIN?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "Custom",
    "properties": {
      "description": "US Employer Identification Number (XX-XXXXXXX)",
      "classificationName": "CSA_GOV_EIN",
      "ruleStatus": "Enabled",
      "minimumPercentageMatch": 70.0,
      "dataPatterns": [
        { "pattern": "\\b\\d{2}-\\d{7}\\b" }
      ],
      "columnPatterns": [
        { "pattern": "(?i)(ein|employer_id|tax_id|fein|federal_ein)" }
      ]
    }
  }'

# Tribal Enrollment ID (custom for government/tribal data)
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/scan/classificationrules/CSA_GOV_TRIBAL_ENROLLMENT_ID?api-version=2022-07-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "Custom",
    "properties": {
      "description": "Tribal enrollment identification number",
      "classificationName": "CSA_GOV_TRIBAL_ENROLLMENT_ID",
      "ruleStatus": "Enabled",
      "minimumPercentageMatch": 60.0,
      "dataPatterns": [
        { "pattern": "\\b[A-Z]{2,4}-\\d{4,8}\\b" }
      ],
      "columnPatterns": [
        { "pattern": "(?i)(tribal_id|enrollment_id|tribal_enrollment|member_id)" }
      ]
    }
  }'
```

### Apply Classifications via YAML Files

```bash
python -m csa_platform.governance.purview.purview_automation \
  --account csadmlzdevpview \
  --action apply-classifications \
  --rules-dir csa_platform/governance/purview/classifications/
```

---

## Sensitivity Labels via MIP Integration

Microsoft Information Protection (MIP) sensitivity labels can be applied
automatically based on classification results.

### Prerequisites

1. Microsoft 365 E5 or Microsoft Purview Information Protection license
2. Sensitivity labels created in Microsoft Purview compliance portal
3. Purview account linked to the M365 tenant

### Auto-Labeling Policies

Define auto-labeling rules in the classification YAML files:

```yaml
# In pii_classifications.yaml
autoLabelingPolicies:
  - name: pii-restricted-policy
    targetLabel: "Restricted"
    classificationNames:
      - CSA_PII_SSN
      - CSA_PHI_MRN
      - MICROSOFT.PERSONAL.US.SOCIAL_SECURITY_NUMBER
  - name: financial-confidential-policy
    targetLabel: "Confidential"
    classificationNames:
      - CSA_FIN_ACCOUNT_NUMBER
      - MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER
  - name: internal-general-policy
    targetLabel: "Internal"
    classificationNames:
      - MICROSOFT.PERSONAL.EMAIL
      - MICROSOFT.PERSONAL.PHONE_NUMBER
```

Apply policies:

```bash
python -m csa_platform.governance.purview.purview_automation \
  --account csadmlzdevpview \
  --action apply-labels \
  --rules-file csa_platform/governance/purview/classifications/pii_classifications.yaml
```

---

## Asset Certification Workflows

Purview supports three endorsement levels for data assets. CSA-in-a-Box
defines a promotion workflow:

```
Discovered → Endorsed → Certified → Deprecated
```

| Status | Meaning | Who can set |
|---|---|---|
| No endorsement | Raw discovered asset, uncurated | Automatic on scan |
| **Endorsed** | Reviewed by domain team, metadata complete | Domain Data Steward |
| **Certified** | Production-quality, SLA-bound, quality-tested | Data Governance Board |
| **Deprecated** | Scheduled for removal, replaced by another asset | Data Steward or Admin |

### Endorse an Asset

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/guid/$ENTITY_GUID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "entity": {
      "guid": "'$ENTITY_GUID'",
      "typeName": "azure_datalake_gen2_resource_set",
      "attributes": {
        "endorsement": "Endorsed",
        "endorsementDescription": "Reviewed by Finance domain team. Metadata complete. Quality checks passing."
      }
    }
  }'
```

### Certify an Asset

```bash
curl -s -X PUT \
  "$PURVIEW_ENDPOINT/catalog/api/atlas/v2/entity/guid/$ENTITY_GUID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "entity": {
      "guid": "'$ENTITY_GUID'",
      "typeName": "azure_datalake_gen2_resource_set",
      "attributes": {
        "endorsement": "Certified",
        "endorsementDescription": "Approved by Data Governance Board. Meets all quality and lineage requirements. SLA: 4 hours."
      }
    }
  }'
```

---

## Search and Discovery Best Practices

### Effective Search Queries

```bash
# Search by business term
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": "customer lifetime value",
    "filter": {
      "and": [
        { "objectType": "Tables" },
        { "endorsement": "Certified" }
      ]
    },
    "limit": 10,
    "orderby": [{ "name": "ASC" }]
  }' | jq '.value[] | {name, qualifiedName, endorsement: .endorsement, classifications: [.classifications[].typeName]}'

# Search by classification
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": "*",
    "filter": {
      "and": [
        { "classification": "CSA_PII_SSN" },
        { "collectionId": "production" }
      ]
    },
    "limit": 50
  }'

# Search by custom metadata
curl -s -X POST \
  "$PURVIEW_ENDPOINT/catalog/api/search/query?api-version=2022-08-01-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": "*",
    "filter": {
      "and": [
        { "objectType": "Tables" },
        { "term": { "CSA_DataGovernance.quality_tier": "gold" } }
      ]
    },
    "limit": 25
  }'
```

### Discovery Tips

1. **Use glossary terms** — Tag every gold-layer asset with business terms so
   analysts search by business concept, not table name.
2. **Set endorsements** — Filter search to "Certified" assets for trusted data.
3. **Maintain descriptions** — Add `userDescription` to assets; Purview
   indexes this field for full-text search.
4. **Use collections as facets** — Organize assets by domain collection for
   filtered browsing.
5. **Audit search queries** — Review Purview diagnostic logs to understand what
   users search for and whether they find results.

---

## Next Steps

- [Data Lineage](DATA_LINEAGE.md) — Trace data origins and transformations
- [Data Quality](DATA_QUALITY.md) — Define and enforce quality rules
