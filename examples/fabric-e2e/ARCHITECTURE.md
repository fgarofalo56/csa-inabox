# Architecture — Fabric E2E Retail Sales

## High-level data flow

```mermaid
flowchart LR
    subgraph Source[Source Systems]
        ERP[ERP / Order entry]
        CRM[CRM]
        Web[Web events]
    end

    subgraph ADLS[ADLS Gen2 — single source of truth]
        Bronze[(Bronze<br/>raw parquet<br/>partitioned by date)]
        Silver[(Silver<br/>cleansed Delta<br/>SCD2 dims)]
        Gold[(Gold<br/>star schema Delta<br/>fact_sales + 3 dims)]
    end

    subgraph Fabric[Microsoft Fabric Workspace]
        Lake[Lakehouse<br/>OneLake]
        Shortcut[OneLake Shortcut<br/>→ ADLS gold]
        SQLEndpoint[SQL Endpoint<br/>auto-generated]
        SemModel[Semantic Model<br/>Direct Lake mode]
        Report[Power BI Report<br/>Direct Lake]
    end

    subgraph Consumers[Consumers]
        Analyst[Business analyst]
        Exec[Executive dashboard]
        Copilot[Copilot in Power BI]
    end

    ERP --> Bronze
    CRM --> Bronze
    Web --> Bronze
    Bronze -- dbt run silver --> Silver
    Silver -- dbt run gold --> Gold

    Gold -. OneLake shortcut .-> Lake
    Lake -- auto-generated --> SQLEndpoint
    Lake -- Direct Lake --> SemModel
    SemModel --> Report

    Report --> Analyst
    Report --> Exec
    SemModel -- DAX query --> Copilot
```

**Key design choice:** ADLS gold is the **source of truth**, not OneLake. We use a OneLake shortcut so Fabric reads gold via OneLake metadata + ADLS bytes — zero copy, single retention story, multi-cloud-friendly.

## Star schema (gold layer)

```mermaid
erDiagram
    DimCustomer ||--o{ FactSales : "customer_key"
    DimProduct  ||--o{ FactSales : "product_key"
    DimDate     ||--o{ FactSales : "order_date_key"
    DimDate     ||--o{ FactSales : "ship_date_key (role-playing)"

    DimCustomer {
        bigint customer_key PK
        string customer_id
        string customer_name
        string customer_segment
        string country
        string region
        timestamp valid_from
        timestamp valid_to
        boolean is_current
    }
    DimProduct {
        bigint product_key PK
        string product_id
        string product_name
        string category
        string subcategory
        decimal list_price
        timestamp valid_from
        timestamp valid_to
        boolean is_current
    }
    DimDate {
        bigint date_key PK
        date date
        int year
        int quarter
        int month
        string month_name
        int day_of_week
        boolean is_weekend
        boolean is_holiday
    }
    FactSales {
        bigint sales_key PK
        bigint customer_key FK
        bigint product_key FK
        bigint order_date_key FK
        bigint ship_date_key FK
        string order_id
        int quantity
        decimal unit_price
        decimal discount_pct
        decimal extended_amount
        decimal cost_amount
        decimal margin_amount
    }
```

Surrogate keys (`*_key`) are bigint identity values; natural keys (`*_id`) are kept for traceability. SCD Type 2 on dimensions via `valid_from` / `valid_to` / `is_current`.

## Direct Lake mode mechanics

```mermaid
flowchart TB
    User[Power BI report<br/>opens visual]
    User --> SemModel[Semantic Model<br/>Direct Lake]

    SemModel -- needed columns? --> Cache{In memory?}
    Cache -- yes --> Vertipaq[Vertipaq<br/>columnar engine]
    Cache -- no, transcode --> OneLake[OneLake metadata]
    OneLake --> ADLS[ADLS gold parquet/delta]
    ADLS -- column read --> Vertipaq
    Vertipaq --> Result[Query result]
    Result --> User
```

- First query for a column = transcode from parquet to Vertipaq columnar (fast, ~ms).
- Subsequent queries hit the in-memory cache — same as Import mode.
- When ADLS gold is updated by dbt, Direct Lake **picks up the new data on next query** — no refresh job.
- Capacity throttling: Direct Lake throttles to DirectQuery if memory pressure exceeds the F-SKU's allocation. Right-size your capacity for your model.

## Identity & secrets flow

```mermaid
flowchart TB
    subgraph Entra[Entra ID]
        AdminUser[Capacity admin user]
        AppSP[Service principal<br/>fabric-deployer]
        WorkspaceMI[Workspace MI<br/>system-assigned]
    end

    subgraph Deploy[Deployment]
        Bicep[main.bicep<br/>provisions capacity]
        DeployScript[deploy.sh<br/>az rest calls]
    end

    subgraph Fabric[Fabric Resources]
        Capacity[Fabric Capacity F2]
        Workspace[Workspace]
        Lakehouse[Lakehouse]
        Shortcut[Shortcut → ADLS]
        SemModel[Semantic Model]
    end

    subgraph Storage[ADLS Gen2]
        Gold[gold container]
    end

    AdminUser -- creates --> Capacity
    AppSP -- workspace.create REST --> Workspace
    AppSP -- assign Capacity --> Workspace

    Workspace -. inherits .-> WorkspaceMI
    WorkspaceMI -. Storage Blob Data Reader .-> Gold
    Shortcut -. uses MI .-> Gold

    AppSP -- import semantic model --> SemModel
    SemModel -. Direct Lake reads via .-> Lakehouse
    Lakehouse -. OneLake metadata .-> Shortcut
```

**Auth model:**
- Capacity admin assigns the SP to the workspace as `Member` (REST: `groups/{id}/users`).
- Workspace MI gets `Storage Blob Data Reader` on the ADLS gold container — that's how the OneLake shortcut authenticates to ADLS.
- End users get Power BI roles on the workspace + RLS roles on the semantic model.
- No SAS tokens, no embedded keys.

## dbt project layout

```mermaid
flowchart LR
    Sources[ADLS bronze<br/>raw CSV/Parquet] --> Bronze[bronze_*<br/>1:1 typed]
    Bronze --> SilverDims[silver_dim_*<br/>cleansed]
    Bronze --> SilverFacts[silver_fact_*<br/>cleansed]
    SilverDims --> GoldDims[gold/dim_*.sql<br/>SCD2]
    SilverFacts --> GoldFacts[gold/fact_*.sql<br/>star schema]
    GoldDims --> GoldFacts
```

| Layer | dbt materialization | Tests |
|-------|---------------------|-------|
| bronze | view (no transformation) | freshness only |
| silver | incremental (insert-only by ingestion_ts) | not_null on PKs |
| gold | dim_*: incremental (SCD2 merge); fact_*: incremental (insert-only) | not_null + unique on surrogate keys; relationships test for FKs |

## Deployment topology

```mermaid
flowchart TB
    subgraph Cloud[Azure Tenant]
        subgraph SubA[Subscription — Data Platform]
            subgraph RGdata[RG — rg-data-platform-prod]
                ADLSprd[ADLS Gen2<br/>data lake]
                KV[Key Vault]
                AppI[App Insights]
            end
        end

        subgraph SubB[Subscription — Fabric]
            subgraph RGfabric[RG — rg-fabric-e2e-prod]
                Capacity[Fabric Capacity F64]
            end
            FabricWorkspace[Fabric Workspace<br/>csa-retail-sales-prod<br/>tenant-level resource]
        end

        Capacity -. assigned to .-> FabricWorkspace
        FabricWorkspace -- shortcut --> ADLSprd
    end
```

Key:
- **Fabric workspaces are tenant-level resources**, not Azure resources — they don't live in a subscription/RG. They're "assigned to" a capacity.
- Common pattern: capacity in one subscription, data lake in another. Cross-sub access works because shortcut authenticates via workspace MI which gets RBAC at the storage level.

## TMDL workflow

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Local as PBI Desktop / VS Code
    participant Git as git
    participant CI as CI
    participant Fabric as Fabric Portal

    Dev->>Local: Edit semantic model
    Local->>Local: Save as PBIP (TMDL files)
    Dev->>Git: git commit + push to PR branch
    CI->>Git: lint TMDL (BPA-style rules)
    CI->>Git: dry-run deploy + diff
    Dev->>Git: PR review (diffs are real diffs!)
    Git->>Fabric: deploy.sh imports model on merge
    Fabric->>Fabric: refresh / reload Direct Lake
```

This is the **whole point** of using PBIP / TMDL: the semantic model is **code**. Diff-able, review-able, testable.

## Capacity sizing

| F-SKU | RAM | Recommendation |
|-------|-----|----------------|
| F2 | 3 GB | Dev only — 1-2 users at a time, model <500 MB |
| F4 | 6 GB | Small team test, model <1 GB |
| F8 | 12 GB | Real prod for small workloads, ~5-10 concurrent users |
| F16 | 25 GB | Mid-size prod, 20-30 concurrent |
| F32 | 50 GB | Departmental prod, 50 concurrent |
| F64 | 112 GB | Org-wide prod, 100+ concurrent — also unlocks Copilot in Power BI |

If you want **Copilot in Power BI**, you need **F64 minimum**. This is a real cost cliff; budget accordingly.

## Trade-offs

| ✅ Why this architecture | ⚠️ When to choose differently |
|--------------------------|-------------------------------|
| Single source of truth (ADLS gold) — Fabric is just a consumption surface | If you're all-in on OneLake, can drop ADLS and use OneLake as primary |
| TMDL = real version control for semantic model | If team isn't ready for code workflow, fall back to PBIX in Power BI Desktop (lose diffability) |
| Direct Lake = no refresh, fast queries | If you have complex DAX patterns Direct Lake doesn't yet support, fall back to Import |
| dbt-fabric for transformation | If you have an existing Spark codebase, can use Fabric Notebooks instead |
| Star schema in gold | Wide-table / OBT pattern is cheaper to build but worse for ad-hoc analysis at scale |

## Related

- [README](README.md)
- [`semantic-model/`](semantic-model/retail-sales.SemanticModel/) — the actual TMDL files
- [`dbt/`](dbt/) — transformation project
- [`contracts/`](contracts/) — gold table contracts
- [Pattern — Power BI & Fabric Roadmap](../../docs/patterns/power-bi-fabric-roadmap.md)
- [Reference Architecture — Data Flow (Medallion)](../../docs/reference-architecture/data-flow-medallion.md)
