# Tutorial: Migrating a Foundry Ontology to Purview

**Estimated time:** 1--2 hours
**Difficulty:** Intermediate
**Running example:** Federal Case Management ontology (4 object types, 3 link types)

---

## Prerequisites

Before you begin, ensure you have:

- A **Microsoft Purview account** provisioned with Data Map and Unified Catalog enabled.
- **dbt-core** installed (`pip install dbt-core dbt-fabric`).
- **Python 3.10+** with `requests` and `pyyaml` (`pip install requests pyyaml`).
- **Azure CLI** authenticated (`az login`) with permissions to call the Purview REST API.
- Access to Power BI Desktop (or Power BI service with a Fabric workspace).
- A copy of your Foundry ontology definition, or the [sample-ontology.yaml](sample-ontology.yaml) included in this repository.

---

## What you will build

By the end of this tutorial you will have:

1. A documented inventory of every Foundry object type, property, and link type.
2. Purview glossary terms with classifications and stewards for each object type.
3. dbt gold-layer models (`dim_` and `fact_` tables) with column descriptions and tests.
4. dbt relationship tests that replace Foundry link types.
5. A data contract YAML file with schema, SLA, and compliance metadata.
6. A Power BI semantic model connected to dbt gold models via Direct Lake.
7. A validation checklist confirming parity with the original Foundry ontology.

> **Foundry vs. Azure -- key framing.** Foundry bundles its ontology, semantic layer, governance catalog, and presentation layer into a single proprietary platform. On Azure the same capabilities are delivered by purpose-built services -- Purview for governance, dbt for the semantic/transformation layer, and Power BI for presentation. This separation gives you independent upgrade cycles, open-standard tooling, and the ability to swap any component without re-platforming.

---

## Step 1: Export and document the Foundry ontology

The first step is to create a complete inventory of your Foundry ontology so that nothing is lost during migration. If you have API access to Foundry, export programmatically; otherwise, document manually from the Ontology Manager UI.

### 1.1 List all object types, properties, and link types

Open `sample-ontology.yaml` (or your own export) and identify:

- **Object types** -- top-level entities such as `Case`, `Party`, `Evidence`, `Action`.
- **Properties** -- every attribute on each object type, including its data type, nullability, classification, and whether it is a primary or foreign key.
- **Link types** -- relationships between object types, including cardinality (`one_to_many`, `many_to_many`).

For the case-management ontology the inventory looks like this:

| Object Type | Properties | Primary Key | Classification | Role |
|---|---|---|---|---|
| Case | 8 | `case_id` | CUI-Specified | Dimension |
| Party | 5 | `party_id` | PII | Dimension |
| Evidence | 7 | `evidence_id` | CUI-Specified | Fact |
| Action | 6 | `action_id` | Internal | Fact |

Link types:

| Source | Target | Name | Cardinality |
|---|---|---|---|
| Case | Party | involves | many_to_many |
| Case | Evidence | contains | one_to_many |
| Case | Action | triggers | one_to_many |

### 1.2 Create a mapping spreadsheet

Create a spreadsheet (or a YAML file) that maps each Foundry component to its Azure target. The `sample-ontology.yaml` already contains these mappings in its `purview_glossary_term`, `target_dbt_model`, and `powerbi_role` fields. If you are working from a live Foundry instance, replicate this structure:

```yaml
# mapping-example.yaml (excerpt)
- foundry_object: Case
  purview_term: Case
  purview_classification: CUI-Specified
  dbt_model: gold/dim_case.sql
  powerbi_role: dimension
```

> **Foundry comparison.** In Foundry, the Ontology Manager is the single source of truth for schema, relationships, and governance metadata. On Azure, this metadata is distributed across Purview (governance), dbt (schema and lineage), and Power BI (presentation). The mapping spreadsheet bridges all three during migration.

---

## Step 2: Set up the Purview business glossary

Purview's business glossary replaces Foundry's ontology registry as the authoritative catalog of business terms, classifications, and data stewardship.

### 2.1 Create glossary terms for each object type

For each Foundry object type, create a Purview glossary term that captures the business definition, data steward, and compliance classification. You can do this manually in the Purview portal or automate it with the script below.

### 2.2 Add classifications

Map Foundry markings to Purview classifications:

| Foundry marking | Purview classification |
|---|---|
| `pii` | Microsoft.Personal.All (PII) |
| `cui_basic` | CUI-Basic (custom) |
| `cui_specified` | CUI-Specified (custom) |
| `phi` | Microsoft.Health (PHI) |

Create any custom classifications (CUI-Basic, CUI-Specified) in Purview before running the automation script.

### 2.3 Assign stewards

Each glossary term should have a steward -- typically the domain owner from the original Foundry ontology. In the case-management example, the steward is `case_management_domain_team`.

### 2.4 Automate with Python

The following script creates glossary terms for every object type in the sample ontology. It uses the Purview REST API (Atlas endpoint).

```python
#!/usr/bin/env python3
"""create_purview_glossary.py -- Populate Purview glossary from ontology YAML."""

import yaml
import requests
from azure.identity import DefaultAzureCredential

# --- Configuration ---
PURVIEW_ACCOUNT = "your-purview-account"
PURVIEW_ENDPOINT = f"https://{PURVIEW_ACCOUNT}.purview.azure.com"
GLOSSARY_API = f"{PURVIEW_ENDPOINT}/catalog/api/atlas/v2/glossary"

CLASSIFICATION_MAP = {
    "PII": "Microsoft.Personal.All",
    "CUI-Specified": "CUI-Specified",
    "CUI-Basic": "CUI-Basic",
    "Internal": "Microsoft.General",
}

def get_token():
    credential = DefaultAzureCredential()
    token = credential.get_token("https://purview.azure.net/.default")
    return token.token

def load_ontology(path: str) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)

def get_glossary_id(headers: dict) -> str:
    resp = requests.get(GLOSSARY_API, headers=headers)
    resp.raise_for_status()
    glossaries = resp.json()
    # Use the first (default) glossary
    return glossaries[0]["guid"] if isinstance(glossaries, list) else glossaries["guid"]

def create_glossary_term(headers: dict, glossary_guid: str, obj: dict):
    term_payload = {
        "name": obj["purview_glossary_term"],
        "qualifiedName": f"{obj['purview_glossary_term']}@Glossary",
        "longDescription": obj["description"].strip(),
        "anchor": {"glossaryGuid": glossary_guid},
        "classifications": [
            {"typeName": CLASSIFICATION_MAP.get(obj["purview_classification"], obj["purview_classification"])}
        ],
        "contacts": {
            "Expert": [{"id": "case_management_domain_team", "info": "Domain steward"}],
            "Steward": [{"id": "case_management_domain_team", "info": "Domain steward"}],
        },
        "attributes": {
            "foundry_source": obj.get("foundry_source", ""),
            "dbt_model": obj.get("target_dbt_model", ""),
            "powerbi_role": obj.get("powerbi_role", ""),
        },
    }
    resp = requests.post(
        f"{GLOSSARY_API}/term",
        headers=headers,
        json=term_payload,
    )
    resp.raise_for_status()
    print(f"  Created term: {obj['purview_glossary_term']} ({resp.status_code})")

def main():
    ontology = load_ontology("sample-ontology.yaml")
    token = get_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    glossary_guid = get_glossary_id(headers)
    print(f"Using glossary: {glossary_guid}")

    for obj in ontology["ontology"]["object_types"]:
        create_glossary_term(headers, glossary_guid, obj)

    print("\nDone. Verify terms in the Purview portal under Data Catalog > Glossary.")

if __name__ == "__main__":
    main()
```

Run the script:

```bash
az login
python create_purview_glossary.py
```

> **Foundry comparison.** Foundry stores governance metadata (classifications, stewards) directly on the object type definition. Purview separates governance into its own service, which means your classifications persist independently of the transformation layer and can govern assets across Fabric, Synapse, SQL Server, and other sources -- not just Foundry datasets.

---

## Step 3: Map Foundry properties to dbt columns

Each Foundry object type becomes a dbt model in the gold layer. Dimension objects (`Case`, `Party`) become `dim_` models; fact objects (`Evidence`, `Action`) become `fact_` models.

### 3.1 Create dbt model files

Below is the dbt model for `dim_case`, derived from the `Case` object type in the sample ontology.

**`models/gold/dim_case.sql`**

```sql
-- dim_case.sql
-- Migrated from: Foundry object type "Case" (case_object)
-- Classification: CUI-Specified

WITH source AS (
    SELECT * FROM {{ ref('stg_case') }}
)

SELECT
    case_id,
    case_number,
    status,
    priority,
    opened_at,
    closed_at,
    assigned_officer_id,
    jurisdiction,
    DATEDIFF(day, opened_at, COALESCE(closed_at, CURRENT_DATE)) AS days_open
FROM source
```

**`models/gold/fact_evidence.sql`**

```sql
-- fact_evidence.sql
-- Migrated from: Foundry object type "Evidence" (evidence_object)
-- Classification: CUI-Specified

WITH source AS (
    SELECT * FROM {{ ref('stg_evidence') }}
)

SELECT
    evidence_id,
    case_id,
    type        AS evidence_type,
    collected_at,
    collected_by,
    storage_location,
    chain_of_custody_hash
FROM source
```

### 3.2 Add column descriptions and tests

Use a `schema.yml` file alongside the models to document every column and add data quality tests. This replaces Foundry's property-level metadata.

**`models/gold/schema.yml`**

```yaml
version: 2

models:
  - name: dim_case
    description: >
      A legal, investigative, or adjudicative matter tracked from intake
      through disposition. Migrated from Foundry object type "Case".
    columns:
      - name: case_id
        description: Unique identifier for the case.
        data_tests:
          - unique
          - not_null
      - name: case_number
        description: Agency-assigned human-readable identifier.
        data_tests:
          - not_null
      - name: status
        description: Current case status.
        data_tests:
          - accepted_values:
              values: ["open", "under_review", "closed", "appealed"]
      - name: priority
        description: Case priority level.
        data_tests:
          - accepted_values:
              values: ["low", "normal", "high", "urgent"]
      - name: opened_at
        description: Timestamp when the case was opened.
        data_tests:
          - not_null
      - name: closed_at
        description: Timestamp when the case was closed. Null if still open.
      - name: assigned_officer_id
        description: ID of the assigned case officer. PII -- must be masked in lower environments.
      - name: jurisdiction
        description: Jurisdiction handling the case.
      - name: days_open
        description: Computed property -- number of days the case has been open.

  - name: fact_evidence
    description: >
      A document, digital artifact, or physical item preserved under
      chain-of-custody for a case. Migrated from Foundry object type "Evidence".
    columns:
      - name: evidence_id
        description: Unique identifier for the evidence item.
        data_tests:
          - unique
          - not_null
      - name: case_id
        description: Foreign key to dim_case.
        data_tests:
          - not_null
          - relationships:
              to: ref('dim_case')
              field: case_id
      - name: evidence_type
        description: Category of evidence.
        data_tests:
          - accepted_values:
              values: ["document", "digital_media", "physical", "testimony"]
      - name: collected_at
        description: Timestamp when evidence was collected.
      - name: collected_by
        description: Identifier of the person who collected the evidence. PII.
      - name: storage_location
        description: Physical or logical storage location.
      - name: chain_of_custody_hash
        description: Tamper-evident audit hash for chain-of-custody verification.
```

> **Foundry comparison.** Foundry properties include inline type constraints and classifications. In dbt, column descriptions live in `schema.yml` and data quality tests (`unique`, `not_null`, `accepted_values`, `relationships`) replace Foundry's built-in property validation. The advantage is that dbt tests run in CI, giving you a gate before bad data reaches consumers.

---

## Step 4: Create dbt relationships (foreign keys)

Foundry link types express how object types relate to one another. In dbt these become `relationships` tests and `ref()` calls that document lineage.

### 4.1 Map Foundry link types to dbt relationships

| Foundry Link | Cardinality | dbt Implementation |
|---|---|---|
| Case --involves--> Party | many_to_many | Bridge table `bridge_case_party` with two FK tests |
| Case --contains--> Evidence | one_to_many | FK column `case_id` on `fact_evidence` with relationship test |
| Case --triggers--> Action | one_to_many | FK column `case_id` on `fact_action` with relationship test |

### 4.2 One-to-many relationships

For `Case --contains--> Evidence`, the relationship is already captured in the `fact_evidence` model via `case_id`. The `relationships` test in `schema.yml` (shown in Step 3) validates referential integrity.

### 4.3 Many-to-many relationships

For `Case --involves--> Party`, create a bridge model:

**`models/gold/bridge_case_party.sql`**

```sql
-- bridge_case_party.sql
-- Replaces Foundry link type: Case --involves--> Party (many_to_many)

WITH source AS (
    SELECT * FROM {{ ref('stg_case_party_link') }}
)

SELECT
    case_id,
    party_id,
    role  -- complainant, subject, witness, counsel, other
FROM source
```

Add tests in `schema.yml`:

```yaml
  - name: bridge_case_party
    description: >
      Many-to-many bridge between cases and parties.
      Replaces Foundry link type "involves".
    columns:
      - name: case_id
        data_tests:
          - not_null
          - relationships:
              to: ref('dim_case')
              field: case_id
      - name: party_id
        data_tests:
          - not_null
          - relationships:
              to: ref('dim_party')
              field: party_id
```

### 4.4 Using ref() for link traversal

In Foundry, you traverse links with expressions like `Case.involves.Party`. In dbt, the equivalent is a JOIN using `ref()`:

```sql
-- Find all parties involved in high-priority cases
SELECT
    c.case_number,
    p.full_name,
    b.role
FROM {{ ref('dim_case') }} c
JOIN {{ ref('bridge_case_party') }} b ON c.case_id = b.case_id
JOIN {{ ref('dim_party') }} p ON b.party_id = p.party_id
WHERE c.priority = 'urgent'
```

> **Foundry comparison.** Foundry link traversal is abstracted behind a graph API -- you never write JOINs. In dbt, JOINs are explicit, which makes lineage visible and debuggable. The `ref()` function automatically tracks dependencies so `dbt docs generate` produces a full lineage graph comparable to Foundry's object explorer.

---

## Step 5: Create a data contract

A data contract formalizes the schema, quality guarantees, SLA, and compliance requirements for a data product. This replaces the implicit contract that Foundry enforces through its ontology definition.

**`data-products/case/contract.yaml`**

```yaml
apiVersion: datacontract/v1.0
kind: DataContract
metadata:
  name: case-data-product
  version: 1.0.0
  owner: case_management_domain_team
  domain: case-management
  description: >
    Curated case-management data product exposing dim_case, dim_party,
    fact_evidence, and fact_action for downstream analytics and reporting.

schema:
  models:
    - ref: dim_case
      primary_key: case_id
      columns: 8
    - ref: dim_party
      primary_key: party_id
      columns: 5
    - ref: fact_evidence
      primary_key: evidence_id
      foreign_keys: [case_id]
      columns: 7
    - ref: fact_action
      primary_key: action_id
      foreign_keys: [case_id]
      columns: 6

quality:
  tests:
    - type: not_null
      scope: all_primary_keys
    - type: unique
      scope: all_primary_keys
    - type: referential_integrity
      scope: all_foreign_keys
    - type: accepted_values
      model: dim_case
      column: status
      values: [open, under_review, closed, appealed]
  freshness:
    max_staleness: 24h
    check_column: opened_at
    model: dim_case

sla:
  availability: 99.5%
  refresh_cadence: daily
  support_contact: case-data-team@agency.gov

compliance:
  frameworks: [fedramp_high, cmmc_2_l2]
  classifications:
    - model: dim_case
      classification: CUI-Specified
    - model: dim_party
      classification: PII
    - model: fact_evidence
      classification: CUI-Specified
    - model: fact_action
      classification: Internal
  data_residency: us-gov-regions-only
```

### 5.1 Wire the contract to CI validation

Add a CI step that validates the contract against dbt test results:

```yaml
# .github/workflows/data-contract-check.yml (excerpt)
- name: Run dbt tests
  run: dbt test --target prod

- name: Validate data contract
  run: |
    python scripts/validate_contract.py \
      --contract data-products/case/contract.yaml \
      --dbt-results target/run_results.json
```

> **Foundry comparison.** Foundry enforces its ontology contract implicitly -- if a backing dataset violates the schema, pipeline builds fail. With dbt + a contract YAML, you get the same enforcement but with the added benefits of version-controlled contracts, CI gating, and SLA tracking that are visible to non-engineers.

---

## Step 6: Build the Power BI semantic model

The Power BI semantic model replaces the Foundry Workshop/Slate presentation layer. With Direct Lake mode in Microsoft Fabric, Power BI reads directly from OneLake parquet files produced by dbt, eliminating an import step.

### 6.1 Connect to dbt gold models via Direct Lake

1. Open Power BI Desktop and connect to your Fabric lakehouse.
2. Select the gold-layer tables: `dim_case`, `dim_party`, `fact_evidence`, `fact_action`, and `bridge_case_party`.
3. Set the storage mode to **Direct Lake** (available in Fabric workspaces).

### 6.2 Define relationships matching Foundry link types

Create the following relationships in the Power BI model view:

| Relationship | From (FK) | To (PK) | Cardinality |
|---|---|---|---|
| Evidence to Case | `fact_evidence.case_id` | `dim_case.case_id` | Many-to-one |
| Action to Case | `fact_action.case_id` | `dim_case.case_id` | Many-to-one |
| Bridge to Case | `bridge_case_party.case_id` | `dim_case.case_id` | Many-to-one |
| Bridge to Party | `bridge_case_party.party_id` | `dim_party.party_id` | Many-to-one |

These relationships mirror the Foundry link types exactly. The bridge table handles the many-to-many relationship between `Case` and `Party`.

### 6.3 Create DAX measures matching Foundry computed properties

Foundry ontologies support computed properties -- derived values calculated on read. In Power BI these become DAX measures:

```dax
// Days Open -- replaces Foundry computed property on Case
Days Open =
IF(
    ISBLANK(dim_case[closed_at]),
    DATEDIFF(dim_case[opened_at], TODAY(), DAY),
    DATEDIFF(dim_case[opened_at], dim_case[closed_at], DAY)
)

// Open Case Count -- common KPI
Open Cases = COUNTROWS(FILTER(dim_case, dim_case[status] = "open"))

// Evidence Count per Case -- replaces Foundry aggregation link metric
Evidence Count = COUNTROWS(RELATEDTABLE(fact_evidence))

// Average Resolution Time -- replaces Foundry analytics function
Avg Resolution Days =
AVERAGEX(
    FILTER(dim_case, NOT ISBLANK(dim_case[closed_at])),
    DATEDIFF(dim_case[opened_at], dim_case[closed_at], DAY)
)
```

> **Foundry comparison.** Foundry computed properties are defined in the ontology YAML and evaluated server-side. Power BI DAX measures serve the same purpose but are evaluated by the VertiPaq engine, which is optimized for interactive analytics. DAX measures also integrate with row-level security, which maps to Foundry's permission model.

---

## Step 7: Validate

With all components in place, run a validation pass to confirm parity with the original Foundry ontology.

### 7.1 Run dbt tests

```bash
dbt test --target prod
```

Expected output:

```
Completed successfully
  Pass: 18  Warn: 0  Error: 0  Skip: 0  Total: 18
```

Verify that all `not_null`, `unique`, `accepted_values`, and `relationships` tests pass. These collectively enforce the same constraints that Foundry's ontology definition enforced.

### 7.2 Check Purview glossary

Open the Purview portal and verify:

- [ ] All four glossary terms exist (`Case`, `Party (Case Participant)`, `Evidence Item`, `Case Action`).
- [ ] Each term has the correct classification (CUI-Specified, PII, Internal).
- [ ] Stewards are assigned to each term.
- [ ] Custom attributes (`foundry_source`, `dbt_model`, `powerbi_role`) are populated.

### 7.3 Verify Power BI relationships

In Power BI Desktop, open the Model view and confirm:

- [ ] Four relationships are defined (two fact-to-dim, two bridge-to-dim).
- [ ] Cardinalities match the Foundry link types.
- [ ] Cross-filter direction is set correctly (single for facts, both for the bridge).
- [ ] DAX measures return expected values against sample data.

### 7.4 Compare against original Foundry ontology

Use the following checklist to confirm full migration:

| Foundry Component | Azure Equivalent | Status |
|---|---|---|
| Object type `Case` | Purview term + `dim_case` | [ ] |
| Object type `Party` | Purview term + `dim_party` | [ ] |
| Object type `Evidence` | Purview term + `fact_evidence` | [ ] |
| Object type `Action` | Purview term + `fact_action` | [ ] |
| Link: Case--involves-->Party | `bridge_case_party` + PBI relationship | [ ] |
| Link: Case--contains-->Evidence | FK `case_id` + dbt relationship test | [ ] |
| Link: Case--triggers-->Action | FK `case_id` + dbt relationship test | [ ] |
| Classifications (PII, CUI) | Purview classifications | [ ] |
| Computed property: days open | DAX measure `Days Open` | [ ] |
| Action: EscalateOverdueCase | Data Activator rule (separate migration) | [ ] |
| Data contract | `contract.yaml` + CI validation | [ ] |

---

## Summary

You have migrated a Foundry ontology with four object types, three link types, and one automated action to a fully governed Azure-native stack:

| Layer | Foundry | Azure |
|---|---|---|
| Governance catalog | Ontology Manager | Purview Unified Catalog |
| Semantic/transform | Ontology + Contour | dbt models + `schema.yml` |
| Relationships | Link Types | dbt relationship tests + Power BI relationships |
| Data quality | Ontology constraints | dbt tests + data contract |
| Presentation | Workshop / Slate | Power BI (Direct Lake) |
| Automation | Foundry Actions | Data Activator + Power Automate |

Each component is independently version-controlled, testable in CI, and governed by Purview -- giving your agency the same analytical power as Foundry with full control over your data platform.

---

## Next steps

- **Migrate pipelines**: See [Pipeline Migration](pipeline-migration.md) for moving Foundry transforms to dbt + Fabric.
- **Migrate data integration**: See [Data Integration Migration](data-integration-migration.md) for ingestion patterns.
- **Set up row-level security**: Map Foundry's per-object markings to Power BI RLS and Purview access policies.
- **Automate actions**: Migrate Foundry Actions to Data Activator rules -- see the `foundry_actions_migrated` section in `sample-ontology.yaml` for the case-escalation example.
