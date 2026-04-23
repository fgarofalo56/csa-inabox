---
title: Antitrust Analytics on Azure
description: Reference architecture and implementation guide for antitrust enforcement analytics using CSA-in-a-Box patterns on Azure
---

## Antitrust Analytics on Azure

Antitrust enforcement generates vast amounts of structured and semi-structured public data — merger filings, criminal enforcement actions, sentencing statistics, and judicial opinions. This use case demonstrates how CSA-in-a-Box patterns transform these disparate sources into a unified analytics platform on Azure.

---

## What is Antitrust Analytics?

Antitrust analytics applies data engineering and analytical techniques to competition law enforcement data. The goal is to identify trends in merger review activity, criminal prosecution outcomes, penalty severity, and enforcement priorities over time.

Typical consumers of antitrust analytics include:

- **Law firms** advising clients on merger clearance risk and criminal exposure
- **Corporate compliance teams** benchmarking enforcement trends
- **Economists** studying market concentration and competition policy
- **Policy researchers** evaluating the effectiveness of enforcement programs
- **Government agencies** tracking their own enforcement metrics

---

## DOJ Antitrust Division Overview

The U.S. Department of Justice Antitrust Division is the federal agency responsible for enforcing federal antitrust laws. Its mission is to promote economic competition through enforcement, advocacy, and education.

The Division's work falls into two main categories:

### Civil Enforcement

Civil enforcement focuses on mergers and acquisitions that may substantially lessen competition, as well as civil non-merger conduct cases (monopolization, anticompetitive agreements). The Hart-Scott-Rodino (HSR) Act requires parties to notify the DOJ and FTC before completing transactions above certain thresholds.

### Criminal Enforcement

Criminal enforcement targets per se violations of the Sherman Act — price-fixing, bid-rigging, and market allocation schemes. These cases carry significant penalties including corporate fines and individual imprisonment.

---

## Types of Antitrust Violations

The three primary federal antitrust statutes create the analytical framework for enforcement data:

| Statute | Year | Scope | Key Provisions |
|---|---|---|---|
| **Sherman Act** | 1890 | Criminal & Civil | Section 1: agreements in restraint of trade; Section 2: monopolization |
| **Clayton Act** | 1914 | Civil | Section 7: mergers that substantially lessen competition; Section 3: tying arrangements |
| **FTC Act** | 1914 | Civil (FTC only) | Section 5: unfair methods of competition; unfair or deceptive acts |

!!! info "Criminal vs. Civil"
    Only the Sherman Act carries criminal penalties. Clayton Act and FTC Act violations are civil matters. The DOJ has exclusive authority over criminal antitrust enforcement; the FTC shares civil merger review authority under the HSR Act.

### Common Violation Categories

```mermaid
graph TD
    A[Antitrust Violations] --> B[Per Se Criminal]
    A --> C[Civil Conduct]
    A --> D[Merger Review]

    B --> B1[Price Fixing]
    B --> B2[Bid Rigging]
    B --> B3[Market Allocation]

    C --> C1[Monopolization]
    C --> C2[Tying Arrangements]
    C --> C3[Exclusive Dealing]

    D --> D1[Horizontal Mergers]
    D --> D2[Vertical Mergers]
    D --> D3[Conglomerate Mergers]
```

---

## Key Data Sources

Antitrust analytics draws from several authoritative public data sources. Each maps to a distinct ingestion pattern in the CSA-in-a-Box medallion architecture.

| Source | Publisher | Data Type | Update Frequency | URL |
|---|---|---|---|---|
| **HSR Annual Reports** | FTC & DOJ (joint) | Merger filings, second requests, enforcement actions | Annual | [ftc.gov/legal-library](https://www.ftc.gov/legal-library/browse/reports) |
| **Criminal Enforcement Charts** | DOJ Antitrust Division | Fines, jail sentences, cases by year | Periodic | [justice.gov/atr](https://www.justice.gov/atr/criminal-enforcement-fine-and-jail-charts) |
| **DOJ Antitrust Division** | DOJ | Press releases, case filings, policy documents | Ongoing | [justice.gov/atr](https://www.justice.gov/atr) |
| **FJC Integrated Database** | Federal Judicial Center | Federal court case filings and terminations | Quarterly | [fjc.gov/research/idb](https://www.fjc.gov/research/idb) |
| **USSC Datafiles** | U.S. Sentencing Commission | Individual sentencing records | Annual | [ussc.gov/research/datafiles](https://www.ussc.gov/research/datafiles/commission-datafiles) |

!!! tip "Data Freshness"
    Most antitrust data sources update on annual or quarterly cycles. Design your ingestion pipelines with appropriate scheduling — daily polling is unnecessary and may trigger rate limiting on government sites.

---

## Reference Architecture

The antitrust analytics platform follows the standard CSA-in-a-Box medallion architecture with domain-specific adaptations.

```mermaid
graph LR
    subgraph Sources
        S1[HSR Reports<br/>PDF/CSV]
        S2[Criminal Charts<br/>HTML/PDF]
        S3[FJC Database<br/>CSV/SAS]
        S4[USSC Datafiles<br/>CSV/SAS]
    end

    subgraph Ingestion
        ADF[Azure Data Factory]
    end

    subgraph Bronze
        B1[(raw_hsr_filings)]
        B2[(raw_criminal_cases)]
        B3[(raw_fjc_cases)]
        B4[(raw_ussc_sentences)]
    end

    subgraph Silver
        SV1[(stg_hsr_filings)]
        SV2[(stg_criminal_cases)]
        SV3[(stg_fjc_antitrust_cases)]
        SV4[(stg_ussc_antitrust_sentences)]
    end

    subgraph Gold
        G1[(fact_enforcement_actions)]
        G2[(fact_merger_reviews)]
        G3[(fact_criminal_sentences)]
        G4[(dim_violation_types)]
        G5[(dim_industries)]
        G6[(dim_courts)]
    end

    subgraph Serving
        PBI[Power BI]
        NB[Databricks<br/>Notebooks]
        API[Data Product<br/>API]
    end

    S1 & S2 & S3 & S4 --> ADF
    ADF --> B1 & B2 & B3 & B4
    B1 --> SV1
    B2 --> SV2
    B3 --> SV3
    B4 --> SV4
    SV1 & SV2 & SV3 & SV4 --> G1 & G2 & G3 & G4 & G5 & G6
    G1 & G2 & G3 --> PBI & NB & API
```

### Azure Services Used

| Service | Role |
|---|---|
| **Azure Data Factory** | Orchestration and ingestion from public data sources |
| **Azure Data Lake Storage Gen2** | Medallion layer storage (Bronze/Silver/Gold) |
| **Azure Databricks** | dbt transformations and analytical notebooks |
| **Delta Lake** | Table format for ACID transactions and time travel |
| **Microsoft Purview** | Data catalog, lineage, and governance |
| **Power BI** | Dashboards and self-service analytics |
| **Azure Key Vault** | Secrets management for service connections |

---

## Example Analytics

### Merger Review Trends

Track HSR filing volumes, second request rates, and enforcement outcomes over time to identify shifts in merger review intensity.

```sql
-- Gold layer: Annual merger review summary
SELECT
    fiscal_year,
    total_hsr_filings,
    second_requests_issued,
    ROUND(second_requests_issued * 100.0 / NULLIF(total_hsr_filings, 0), 2)
        AS second_request_rate_pct,
    mergers_challenged,
    mergers_abandoned_after_second_request
FROM {{ ref('fact_merger_reviews') }}
ORDER BY fiscal_year DESC
```

### Criminal Enforcement Patterns

Analyze criminal prosecution trends including case volumes, fine amounts, and imprisonment rates by violation type.

```sql
-- Gold layer: Criminal enforcement by violation type
SELECT
    violation_type,
    fiscal_year,
    COUNT(*) AS cases_filed,
    SUM(corporate_fine_amount) AS total_corporate_fines,
    AVG(individual_sentence_months) AS avg_sentence_months,
    SUM(CASE WHEN imprisonment_imposed THEN 1 ELSE 0 END) AS individuals_imprisoned
FROM {{ ref('fact_criminal_sentences') }}
GROUP BY violation_type, fiscal_year
ORDER BY fiscal_year DESC, total_corporate_fines DESC
```

### Penalty Analysis

Compare penalty severity across time periods and violation categories to identify sentencing trends.

```sql
-- Gold layer: Penalty trend analysis
SELECT
    fiscal_year,
    violation_category,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fine_amount) AS median_fine,
    MAX(fine_amount) AS max_fine,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sentence_months) AS median_sentence_months
FROM {{ ref('fact_enforcement_actions') }}
WHERE enforcement_type = 'criminal'
GROUP BY fiscal_year, violation_category
```

---

## How the DOJ Domain Demonstrates the Pattern

The `domains/doj_antitrust/` directory in this repository is a complete, working implementation of the antitrust analytics use case. It demonstrates every layer of the CSA-in-a-Box pattern:

| Layer | Implementation |
|---|---|
| **Seed data** | Public enforcement statistics loaded as dbt seeds |
| **Bronze models** | Raw ingestion with source metadata and load timestamps |
| **Silver models** | Cleaned, typed, and deduplicated staging models |
| **Gold models** | Business-ready fact and dimension tables |
| **Data quality** | Flag-don't-drop pattern for enforcement data integrity |
| **Data contracts** | YAML-based data product contracts for downstream consumers |
| **Analytics** | Databricks notebooks with enforcement trend analysis |

!!! tip "Try It Yourself"
    See the [DOJ Antitrust: Step-by-Step Domain Build](doj-antitrust-deep-dive.md) for a complete walkthrough of how this domain was constructed.

---

## Published Resources

### Official Reports & White Papers

| Publication | Publisher | Description |
|---|---|---|
| [Hart-Scott-Rodino Annual Report FY 2024](https://www.ftc.gov/news-events/news/press-releases/2025/09/ftc-doj-issue-fiscal-year-2024-hart-scott-rodino-annual-report) | FTC & DOJ (Sept 2025) | 47th annual HSR report — merger filing activity Oct 2023–Sept 2024 |
| [Big Data: A Tool for Inclusion or Exclusion?](https://www.ftc.gov/system/files/documents/reports/big-data-tool-inclusion-or-exclusion-understanding-issues/160106big-data-rpt.pdf) | FTC (Jan 2016) | FTC study on big data analytics in enforcement — benefits, risks, and consumer protection |
| [Criminal Enforcement Fine and Jail Charts](https://www.justice.gov/atr/criminal-enforcement-fine-and-jail-charts) | DOJ Antitrust Division (Dec 2025) | Historical criminal enforcement fine and jail trend data |
| [Division Operations & Accomplishments](https://www.justice.gov/atr/division-operations) | DOJ Antitrust Division (2024) | Workload statistics, enforcement trends, prosecution outcomes |
| [Microsoft Digital Defense Report 2025](https://aka.ms/Microsoft-Digital-Defense-Report-2025) | Microsoft Security (Oct 2025) | Annual threat landscape analysis — relevant to securing enforcement data platforms |
| [Azure Synapse Security White Paper](https://learn.microsoft.com/azure/synapse-analytics/guidance/security-white-paper-introduction) | Microsoft | Multi-part white paper on securing analytics workloads — data protection, access control, network security |

### Government Data Sources

- [DOJ Antitrust Division](https://www.justice.gov/atr) — Official division homepage with press releases, case filings, and policy documents
- [Hart-Scott-Rodino Annual Reports](https://www.ftc.gov/legal-library/browse/reports) — Joint FTC/DOJ merger filing statistics
- [Federal Judicial Center Integrated Database](https://www.fjc.gov/research/idb) — Federal court case data
- [U.S. Sentencing Commission Datafiles](https://www.ussc.gov/research/datafiles/commission-datafiles) — Individual-level sentencing data

### Azure Architecture References

- [Analytics End-to-End with Azure](https://learn.microsoft.com/en-us/azure/architecture/example-scenario/dataplate2e/data-platform-end-to-end) — Microsoft reference architecture
- [Cloud-Scale Analytics](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/) — Cloud Adoption Framework analytics scenario
- [Azure FedRAMP High Authorization](https://learn.microsoft.com/azure/compliance/offerings/offering-fedramp) — Compliance documentation for government analytics workloads
