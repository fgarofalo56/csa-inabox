# MDM Migration Guide: Informatica MDM to Purview + Azure SQL / Cosmos DB

**A comprehensive guide for migrating Informatica Master Data Management (MDM) to Azure-native master data capabilities.**

---

## Overview

Informatica MDM is the most complex product in the Informatica portfolio to migrate. It provides match/merge, survivorship (trust rules), hierarchy management, entity resolution, stewardship workflows, and a real-time API (SIF). There is no single Azure service that replaces all of these capabilities. Instead, the replacement architecture combines multiple Azure services, each handling a specific MDM function.

**Important guidance:** Before committing to a full MDM migration, reassess whether you actually need full MDM capabilities. Many organizations find that 60-80% of their MDM use cases can be solved with good data engineering (dbt deduplication models + Purview governance) without purpose-built MDM software.

---

## Architecture comparison

```mermaid
graph TB
    subgraph "Informatica MDM"
        MDM_Hub[MDM Hub Server] --> MDM_Match[Match Engine]
        MDM_Hub --> MDM_Merge[Merge Engine]
        MDM_Hub --> MDM_Trust[Trust / Survivorship]
        MDM_Hub --> MDM_Hier[Hierarchy Manager]
        MDM_Hub --> MDM_Steward[Data Stewardship (IDD)]
        MDM_Hub --> MDM_SIF[SIF API]
        MDM_Hub --> MDM_DB[(Hub Store DB)]
    end

    subgraph "Azure MDM Architecture"
        AzSQL[(Azure SQL - Master Store)] --> Purview[Purview - Governance]
        AzSQL --> dbt[dbt - Match/Merge Logic]
        AzSQL --> AzML[Azure ML - Fuzzy Matching]
        AzSQL --> APIM[APIM - Master Data API]
        Purview --> PA[Power Automate - Stewardship]
        PBI[Power BI - Entity 360] --> AzSQL
        Func[Azure Functions - Real-time Match] --> AzSQL
    end
```

---

## MDM replacement options

Before choosing an approach, assess your MDM complexity:

### Option 1: dbt + Purview (recommended for 70% of use cases)

**Best for:** Organizations where MDM primarily means deduplication, golden record creation, and basic hierarchy management.

| Capability | Implementation |
|---|---|
| Match (deterministic) | dbt model with exact-match join keys |
| Match (fuzzy) | dbt model with SQL fuzzy functions or Azure ML UDF |
| Merge (survivorship) | dbt model with CASE-based source priority |
| Golden record | dbt mart model producing single-best-record per entity |
| Hierarchy | Azure SQL hierarchical queries (HierarchyID or recursive CTE) |
| Governance | Purview business glossary + data stewardship workflows |
| API access | Azure APIM + Azure Functions reading from Azure SQL |

**Estimated cost:** $30K-$80K/year (vs $150K-$500K+ for Informatica MDM)

### Option 2: Profisee on Azure (for complex MDM needs)

**Best for:** Organizations with complex match rules, high-volume entity resolution, multi-domain mastering (customer + product + vendor), or regulatory requirements for MDM.

| Capability | Implementation |
|---|---|
| Full MDM suite | Profisee platform (Azure-native, FedRAMP authorized) |
| Match engine | Profisee matching (deterministic + fuzzy) |
| Survivorship | Profisee survivorship rules |
| Hierarchy | Profisee hierarchy management |
| Stewardship | Profisee data stewardship portal |
| API | Profisee REST API |
| Integration | Native ADF connector; native Purview integration |

**Estimated cost:** $80K-$200K/year (Profisee license + Azure compute)

### Option 3: Custom Azure ML matching (for advanced entity resolution)

**Best for:** Organizations with complex fuzzy matching needs (person matching across unreliable sources, organization resolution, product matching).

| Capability | Implementation |
|---|---|
| Match engine | Azure ML model trained on labeled match pairs |
| Feature engineering | dbt models preparing match features |
| Scoring | Azure ML batch inference or real-time endpoint |
| Merge | dbt model using ML scores to create golden records |
| Feedback loop | Power Apps form for match review; results feed back to training data |

**Estimated cost:** $50K-$150K/year (Azure ML compute + development effort)

### Decision framework

| Your situation | Recommended option | Rationale |
|---|---|---|
| Simple deduplication (exact + near-exact) | Option 1: dbt + Purview | SQL-based matching handles 80% of dedup needs |
| Multi-domain MDM with complex rules | Option 2: Profisee | Purpose-built MDM; lower migration risk |
| Advanced entity resolution (ML-based) | Option 3: Azure ML | Custom ML model outperforms rule-based matching |
| Minimal actual MDM usage | Skip MDM replacement | Many MDM installations are underutilized |
| Regulatory requirement for MDM audit trail | Option 2: Profisee | Built-in audit and compliance features |

---

## Match/merge migration

### Informatica MDM match process

Informatica MDM uses a multi-step match process:

1. **Tokenization** -- breaks input values into tokens (name parts, address components)
2. **Search** -- finds candidate match pairs using fuzzy search
3. **Scoring** -- applies match rules to score each pair
4. **Decision** -- auto-merge, auto-reject, or route to steward based on thresholds

### dbt-based match/merge (Option 1)

**Step 1: Prepare match candidates**

```sql
-- models/mdm/stg_mdm__customer_match_candidates.sql
-- Prepare standardized match keys for candidate identification

SELECT
    customer_id,
    source_system,
    -- Standardize for matching
    UPPER(TRIM(first_name)) AS first_name_std,
    UPPER(TRIM(last_name)) AS last_name_std,
    LOWER(TRIM(email)) AS email_std,
    REPLACE(REPLACE(REPLACE(phone, '-', ''), '(', ''), ')', '') AS phone_std,
    UPPER(TRIM(city)) AS city_std,
    UPPER(TRIM(state)) AS state_std,
    REPLACE(REPLACE(postal_code, '-', ''), ' ', '') AS postal_code_std,

    -- Create match keys (blocking keys for candidate selection)
    CONCAT(UPPER(LEFT(last_name, 4)), UPPER(LEFT(first_name, 2)), LEFT(postal_code, 5)) AS match_key_1,
    email AS match_key_2,
    REPLACE(REPLACE(REPLACE(phone, '-', ''), '(', ''), ')', '') AS match_key_3

FROM {{ ref('stg_crm__customers') }}
```

**Step 2: Identify match pairs (deterministic)**

```sql
-- models/mdm/int_mdm__customer_match_pairs.sql
-- Find candidate pairs using blocking keys

WITH exact_email_match AS (
    SELECT
        a.customer_id AS customer_id_a,
        b.customer_id AS customer_id_b,
        'email_exact' AS match_type,
        1.0 AS match_score
    FROM {{ ref('stg_mdm__customer_match_candidates') }} a
    JOIN {{ ref('stg_mdm__customer_match_candidates') }} b
        ON a.email_std = b.email_std
        AND a.customer_id < b.customer_id  -- avoid self-match and duplicates
    WHERE a.email_std IS NOT NULL
      AND a.email_std != ''
),

exact_phone_match AS (
    SELECT
        a.customer_id AS customer_id_a,
        b.customer_id AS customer_id_b,
        'phone_exact' AS match_type,
        0.9 AS match_score
    FROM {{ ref('stg_mdm__customer_match_candidates') }} a
    JOIN {{ ref('stg_mdm__customer_match_candidates') }} b
        ON a.phone_std = b.phone_std
        AND a.customer_id < b.customer_id
    WHERE a.phone_std IS NOT NULL
      AND LEN(a.phone_std) >= 10
),

name_address_match AS (
    SELECT
        a.customer_id AS customer_id_a,
        b.customer_id AS customer_id_b,
        'name_address' AS match_type,
        0.85 AS match_score
    FROM {{ ref('stg_mdm__customer_match_candidates') }} a
    JOIN {{ ref('stg_mdm__customer_match_candidates') }} b
        ON a.last_name_std = b.last_name_std
        AND a.first_name_std = b.first_name_std
        AND a.postal_code_std = b.postal_code_std
        AND a.customer_id < b.customer_id
)

SELECT * FROM exact_email_match
UNION ALL
SELECT * FROM exact_phone_match
UNION ALL
SELECT * FROM name_address_match
```

**Step 3: Create match groups (transitive closure)**

```sql
-- models/mdm/int_mdm__customer_match_groups.sql
-- Assign match group IDs using transitive closure

WITH RECURSIVE match_closure AS (
    -- Base: each customer is in its own group
    SELECT
        customer_id_a AS customer_id,
        customer_id_a AS group_root
    FROM {{ ref('int_mdm__customer_match_pairs') }}
    WHERE match_score >= 0.85  -- threshold

    UNION ALL

    -- Recursive: extend groups through match pairs
    SELECT
        p.customer_id_b AS customer_id,
        mc.group_root
    FROM {{ ref('int_mdm__customer_match_pairs') }} p
    JOIN match_closure mc
        ON p.customer_id_a = mc.customer_id
    WHERE p.match_score >= 0.85
)

SELECT
    customer_id,
    MIN(group_root) AS match_group_id
FROM match_closure
GROUP BY customer_id
```

**Note:** Recursive CTEs for transitive closure may not be supported or performant on all SQL engines. For large datasets, consider using Azure Databricks with GraphFrames or a custom Python UDF for connected components.

**Step 4: Apply survivorship rules (golden record)**

```sql
-- models/mdm/mart_mdm__customer_golden.sql
-- Create golden record using survivorship (trust) rules

WITH ranked AS (
    SELECT
        c.*,
        g.match_group_id,
        -- Source priority: CRM > ERP > Legacy
        CASE c.source_system
            WHEN 'CRM' THEN 1
            WHEN 'ERP' THEN 2
            WHEN 'LEGACY' THEN 3
            ELSE 4
        END AS source_priority,
        -- Recency: prefer most recently updated
        ROW_NUMBER() OVER (
            PARTITION BY g.match_group_id
            ORDER BY
                CASE c.source_system WHEN 'CRM' THEN 1 WHEN 'ERP' THEN 2 ELSE 3 END,
                c.updated_at DESC
        ) AS rn
    FROM {{ ref('stg_crm__customers') }} c
    JOIN {{ ref('int_mdm__customer_match_groups') }} g
        ON c.customer_id = g.customer_id
)

SELECT
    match_group_id AS master_customer_id,
    -- Survivorship: best value per attribute
    MAX(CASE WHEN source_priority = 1 THEN first_name END) AS first_name,
    MAX(CASE WHEN source_priority = 1 THEN last_name END) AS last_name,
    -- Email: prefer CRM, then most recent non-null
    COALESCE(
        MAX(CASE WHEN source_system = 'CRM' AND email IS NOT NULL THEN email END),
        MAX(CASE WHEN email IS NOT NULL THEN email END)
    ) AS email,
    -- Phone: prefer most recent non-null
    MAX(CASE WHEN rn = 1 THEN phone END) AS phone,
    -- Address: prefer CRM source
    MAX(CASE WHEN source_priority = 1 THEN street_line_1 END) AS street_line_1,
    MAX(CASE WHEN source_priority = 1 THEN city END) AS city,
    MAX(CASE WHEN source_priority = 1 THEN state END) AS state,
    MAX(CASE WHEN source_priority = 1 THEN postal_code END) AS postal_code,
    -- Metadata
    COUNT(*) AS source_record_count,
    STRING_AGG(DISTINCT source_system, ', ') AS contributing_sources,
    MAX(updated_at) AS last_updated
FROM ranked
GROUP BY match_group_id
```

---

## Hierarchy management migration

### Informatica MDM Hierarchy Manager

Informatica MDM provides a Hierarchy Manager for organizational structures, product hierarchies, geographic hierarchies, and custom relationship types. The Azure equivalents:

| Hierarchy feature | Azure equivalent | Notes |
|---|---|---|
| Parent-child relationships | Azure SQL HierarchyID data type | Native SQL Server feature for hierarchical data |
| Multiple hierarchy types | Separate tables or polymorphic relationships | Design based on use case |
| Hierarchy visualization | Power BI decomposition tree or treemap | Visual hierarchy exploration |
| Hierarchy editing | Power Apps canvas app | Custom edit interface |
| Hierarchy API | Azure Functions + APIM | REST API for hierarchy CRUD |
| Governance | Purview collections | Collections model organizational hierarchy |

### Azure SQL hierarchy implementation

```sql
-- Create hierarchy table using HierarchyID
CREATE TABLE dbo.organization_hierarchy (
    org_id INT PRIMARY KEY,
    org_name NVARCHAR(200),
    org_type NVARCHAR(50),
    hierarchy_node HIERARCHYID NOT NULL,
    hierarchy_level AS hierarchy_node.GetLevel() PERSISTED,
    parent_node AS hierarchy_node.GetAncestor(1) PERSISTED,
    CONSTRAINT UQ_hierarchy_node UNIQUE (hierarchy_node)
);

-- Index for efficient descendant queries
CREATE INDEX IX_hierarchy_depth_first
ON dbo.organization_hierarchy (hierarchy_node);

-- Index for efficient breadth-first (sibling) queries
CREATE INDEX IX_hierarchy_breadth_first
ON dbo.organization_hierarchy (hierarchy_level, hierarchy_node);
```

### Recursive CTE alternative (portable SQL)

```sql
-- models/mdm/mart_mdm__org_hierarchy.sql
-- Portable hierarchy using recursive CTE (works on any SQL engine)

WITH RECURSIVE org_tree AS (
    -- Root nodes
    SELECT
        org_id,
        org_name,
        org_type,
        parent_org_id,
        0 AS hierarchy_level,
        CAST(org_name AS VARCHAR(4000)) AS hierarchy_path
    FROM {{ ref('stg_org__organizations') }}
    WHERE parent_org_id IS NULL

    UNION ALL

    -- Child nodes
    SELECT
        c.org_id,
        c.org_name,
        c.org_type,
        c.parent_org_id,
        p.hierarchy_level + 1,
        CAST(CONCAT(p.hierarchy_path, ' > ', c.org_name) AS VARCHAR(4000))
    FROM {{ ref('stg_org__organizations') }} c
    JOIN org_tree p ON c.parent_org_id = p.org_id
)

SELECT * FROM org_tree
```

---

## Entity resolution with Azure ML

For organizations requiring sophisticated fuzzy matching beyond what SQL can provide:

### Training a match model

```python
# Azure ML entity resolution pipeline

from azure.ai.ml import MLClient
from azure.identity import DefaultAzureCredential
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split

# Load labeled match pairs (from historical MDM match decisions)
match_pairs = pd.read_sql("""
    SELECT
        pair_id,
        -- Features
        name_jaro_winkler_score,
        email_exact_match,
        phone_match,
        address_token_overlap,
        postal_code_match,
        -- Label
        is_match  -- 1 = confirmed match, 0 = non-match
    FROM mdm.historical_match_decisions
""", connection)

X = match_pairs.drop(columns=['pair_id', 'is_match'])
y = match_pairs['is_match']

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)

model = GradientBoostingClassifier(n_estimators=200, max_depth=4)
model.fit(X_train, y_train)

print(f"Accuracy: {model.score(X_test, y_test):.3f}")
print(f"Precision: {precision_score(y_test, model.predict(X_test)):.3f}")
print(f"Recall: {recall_score(y_test, model.predict(X_test)):.3f}")
```

### Feature engineering in dbt

```sql
-- models/mdm/int_mdm__match_features.sql
-- Prepare features for ML-based entity resolution

SELECT
    a.customer_id AS id_a,
    b.customer_id AS id_b,

    -- Name similarity (Jaro-Winkler via SQL CLR or Python UDF)
    dbo.fn_jaro_winkler(a.last_name_std, b.last_name_std) AS name_jaro_winkler_score,

    -- Email exact match
    CASE WHEN a.email_std = b.email_std AND a.email_std IS NOT NULL THEN 1 ELSE 0 END AS email_exact_match,

    -- Phone match
    CASE WHEN a.phone_std = b.phone_std AND a.phone_std IS NOT NULL THEN 1 ELSE 0 END AS phone_match,

    -- Postal code match
    CASE WHEN a.postal_code_std = b.postal_code_std THEN 1 ELSE 0 END AS postal_code_match,

    -- City match
    CASE WHEN a.city_std = b.city_std THEN 1 ELSE 0 END AS city_match

FROM {{ ref('stg_mdm__customer_match_candidates') }} a
JOIN {{ ref('stg_mdm__customer_match_candidates') }} b
    ON a.blocking_key = b.blocking_key  -- blocking key to reduce pairs
    AND a.customer_id < b.customer_id
```

---

## Stewardship workflow migration

### Informatica MDM IDD (Informatica Data Director)

IDD provides a web interface for data stewards to:

- Review match candidates (auto-match vs manual review)
- Merge or reject match pairs
- Edit master records
- Manage hierarchy assignments
- Approve data changes

### Azure replacement: Power Apps + Power Automate

**Step 1: Power Apps stewardship form**

Build a canvas app with:

- **Match review screen:** Display candidate pairs with match scores; steward selects "merge", "reject", or "defer"
- **Master record editor:** View and edit golden record attributes
- **Hierarchy manager:** Tree view of organizational hierarchy with drag-drop editing
- **Dashboard:** Summary of pending reviews, recent decisions, quality metrics

**Step 2: Power Automate workflow**

```
Trigger: New row in mdm.match_review_queue (Dataverse or Azure SQL)
Actions:
  1. Assign to steward based on domain (Finance -> Finance steward)
  2. Send Teams notification with match pair summary
  3. Wait for steward decision (Power Apps button)
  4. If "merge": Execute stored procedure to merge records
  5. If "reject": Update match pair status to "rejected"
  6. Log decision to audit table
  7. Update Power BI dashboard refresh
```

**Step 3: Audit trail**

```sql
-- Stewardship audit table
CREATE TABLE mdm.stewardship_audit (
    audit_id INT IDENTITY(1,1) PRIMARY KEY,
    action_type VARCHAR(20),  -- 'merge', 'reject', 'edit', 'approve'
    entity_type VARCHAR(50),  -- 'customer', 'product', 'vendor'
    entity_id_a INT,
    entity_id_b INT,
    steward_email VARCHAR(200),
    decision_reason VARCHAR(500),
    before_state NVARCHAR(MAX),  -- JSON snapshot before change
    after_state NVARCHAR(MAX),   -- JSON snapshot after change
    decided_at DATETIME2 DEFAULT GETDATE()
);
```

---

## MDM API migration (SIF to Azure)

### Informatica MDM SIF API

The Services Integration Framework (SIF) provides SOAP/REST APIs for:

- Real-time match (send record, get match candidates)
- CRUD operations on master records
- Hierarchy navigation
- Batch operations

### Azure replacement: APIM + Azure Functions

```python
# Azure Function: real-time match endpoint
# Replaces SIF MatchRecord operation

import azure.functions as func
import pyodbc
import json

def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()

    # Extract match criteria
    first_name = body.get('first_name', '').upper().strip()
    last_name = body.get('last_name', '').upper().strip()
    email = body.get('email', '').lower().strip()

    # Query master store for candidates
    conn = pyodbc.connect(os.environ['SQL_CONNECTION_STRING'])
    cursor = conn.cursor()

    cursor.execute("""
        SELECT
            master_customer_id,
            first_name, last_name, email, phone,
            -- Calculate match score
            CASE WHEN email = ? THEN 50 ELSE 0 END +
            CASE WHEN last_name = ? THEN 30 ELSE 0 END +
            CASE WHEN first_name = ? THEN 20 ELSE 0 END AS match_score
        FROM mdm.customer_golden
        WHERE email = ? OR (last_name = ? AND first_name = ?)
        ORDER BY match_score DESC
    """, email, last_name, first_name, email, last_name, first_name)

    candidates = [
        {
            'master_id': row.master_customer_id,
            'first_name': row.first_name,
            'last_name': row.last_name,
            'email': row.email,
            'match_score': row.match_score
        }
        for row in cursor.fetchall()
    ]

    return func.HttpResponse(
        json.dumps({'candidates': candidates, 'count': len(candidates)}),
        mimetype='application/json'
    )
```

Register this function in API Management with:

- Authentication (Entra ID or API key)
- Rate limiting
- Request/response validation
- Monitoring and analytics

---

## Migration timeline

MDM migration is the longest and most complex component. Plan accordingly:

| Phase | Duration | Activities |
|---|---|---|
| 1. Assessment | 3-4 weeks | Inventory match rules, trust rules, hierarchies, API consumers |
| 2. Option selection | 2 weeks | Choose Option 1, 2, or 3 based on assessment |
| 3. Match rule conversion | 6-10 weeks | Implement match logic in dbt/ML/Profisee |
| 4. Survivorship conversion | 3-4 weeks | Implement trust rules as SQL survivorship |
| 5. Hierarchy migration | 3-4 weeks | Migrate hierarchy structures |
| 6. Stewardship setup | 3-4 weeks | Build Power Apps stewardship interface |
| 7. API migration | 4-6 weeks | Replace SIF API with APIM + Functions |
| 8. Parallel run | 6-8 weeks | Run both systems; reconcile golden records |
| 9. Cutover | 2-3 weeks | Repoint consumers; decommission MDM Hub |
| **Total** | **32-45 weeks** | Plan for MDM to be the longest migration track |

---

## Common MDM migration pitfalls

| Pitfall | Mitigation |
|---|---|
| Underestimating match rule complexity | Export all match rules from MDM; test each in dbt before committing |
| Ignoring survivorship logic | Document every trust rule; implement as explicit CASE logic |
| Losing audit trail | Implement audit table from day one; capture before/after state |
| Skipping parallel run | 6-8 week parallel run is mandatory; golden record discrepancies must be resolved |
| Over-engineering the replacement | Start simple (Option 1); add ML (Option 3) only if SQL matching proves insufficient |
| Forgetting API consumers | Inventory all SIF API consumers; provide migration path for each |

---

## Related resources

- [Data Quality Migration Guide](data-quality-migration.md) -- IDQ migration (closely related to MDM)
- [Complete Feature Mapping](feature-mapping-complete.md) -- All MDM features mapped
- [PowerCenter Migration Guide](powercenter-migration.md) -- ETL migration
- [Best Practices](best-practices.md) -- Migration execution guidance
- [Migration Playbook](../informatica.md) -- End-to-end migration guide

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
