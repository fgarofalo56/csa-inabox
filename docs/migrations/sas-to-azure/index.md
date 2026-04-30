# SAS to Azure Migration Center

**The definitive resource for migrating from SAS Institute analytics to Microsoft Azure, Microsoft Fabric, Azure ML, and CSA-in-a-Box.**

---

## Who this is for

This migration center serves federal CIOs, CDOs, Chief Analytics Officers, statistical program directors, SAS administrators, data scientists, and SAS programmers who are evaluating or executing a migration from SAS analytics (Base SAS, SAS/STAT, SAS/ETS, SAS Viya, SAS Visual Analytics, SAS Data Integration Studio, SAS Model Manager, SAS Enterprise Guide) to Azure-native services. Whether you are pursuing a full SAS replacement to reduce licensing costs and expand your talent pool, a lift-and-shift of SAS Viya to Azure for data-center exit, or a hybrid coexistence leveraging SAS on Fabric --- these resources provide the evidence, patterns, and step-by-step guidance to execute confidently.

---

## Quick-start decision matrix

| Your situation                                  | Start here                                                |
| ----------------------------------------------- | --------------------------------------------------------- |
| Executive evaluating Azure vs SAS for analytics | [Why Azure over SAS](why-azure-over-sas.md)               |
| Need cost justification for migration           | [Total Cost of Ownership Analysis](tco-analysis.md)       |
| Need a feature-by-feature comparison            | [Complete Feature Mapping](feature-mapping-complete.md)   |
| Ready to plan a migration                       | [Migration Playbook](../sas-to-azure.md)                  |
| Want to keep SAS but move it to Azure           | [Lift-and-Shift Migration](lift-shift-migration.md)       |
| Migrating SAS statistical procedures to Python  | [Analytics Migration](analytics-migration.md)             |
| Migrating SAS Data Integration to ADF/dbt       | [Data Management Migration](data-management-migration.md) |
| Migrating SAS VA to Power BI                    | [Reporting Migration](reporting-migration.md)             |
| Migrating SAS models to Azure ML                | [Model Migration](model-migration.md)                     |
| Federal/government-specific requirements        | [Federal Migration Guide](federal-migration-guide.md)     |

---

## Migration path decision framework

Before diving into specific guides, choose your migration strategy. Most organizations adopt a hybrid approach, but the dominant path depends on your SAS footprint and strategic direction.

### Path 1: Lift-and-shift --- SAS on Azure

**Deploy SAS Viya on Azure Kubernetes Service; programs run unchanged.**

- **Best for:** Agencies with regulatory mandates requiring SAS output formats, heavy SAS macro investment (500+ macros), immediate data-center exit deadlines, or pending SAS Viya upgrades
- **Timeline:** 3--6 months
- **Cost impact:** Eliminates hardware costs; SAS licensing remains; Azure compute replaces on-premises servers
- **SAS products required:** SAS Viya 4.x license (includes Cloud-Native Architecture deployment)
- **Key guide:** [Lift-and-Shift Migration](lift-shift-migration.md) | [Tutorial: SAS Viya on Azure](tutorial-sas-viya-azure.md)

### Path 2: Replace --- Azure ML + Fabric + Power BI

**Rewrite SAS programs in Python/R; deploy on Azure-native services.**

- **Best for:** Organizations seeking 55--70% cost reduction, talent pool expansion (Python developers outnumber SAS programmers 20:1), AI/GenAI integration, or elimination of vendor lock-in
- **Timeline:** 12--24 months for full migration; can start delivering value in 8--12 weeks with pilot domain
- **Cost impact:** Eliminates SAS licensing entirely; one-time reskilling and migration investment pays back in 12--18 months
- **Key guides:** [Analytics Migration](analytics-migration.md) | [Data Management Migration](data-management-migration.md) | [Model Migration](model-migration.md) | [Reporting Migration](reporting-migration.md)

### Path 3: Hybrid coexistence --- SAS + Azure side-by-side

**SAS Viya on Azure reads/writes Fabric lakehouses; new workloads built on Azure ML; SAS programs migrated incrementally.**

- **Best for:** Most federal agencies. Preserves existing SAS investment while building toward Azure-native over 18--36 months. Leverages the December 2025 SAS on Fabric integration.
- **Timeline:** 6--18 months for bridge setup; ongoing incremental migration
- **Cost impact:** Transitional. SAS licensing reduces as programs migrate; Azure costs ramp. Break-even typically at 40--50% program migration.
- **Key guides:** [Lift-and-Shift Migration](lift-shift-migration.md) + [Analytics Migration](analytics-migration.md) | [Tutorial: SAS to Python](tutorial-sas-to-python.md)

### Decision matrix: which SAS products drive which path

| SAS product in use                      | Recommended path             | Rationale                                                                      |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Base SAS + SAS/STAT (general analytics) | **Replace**                  | Python/statsmodels covers 95%+ of these capabilities                           |
| SAS Visual Analytics                    | **Replace**                  | Power BI is a direct upgrade with better Copilot integration                   |
| SAS Data Integration Studio             | **Replace**                  | ADF + dbt is more capable, lower cost, and open-source                         |
| SAS Enterprise Guide                    | **Replace**                  | Fabric notebooks + Power BI provide equivalent point-and-click + code workflow |
| SAS Viya (cloud deployment)             | **Hybrid**                   | Keep Viya for specialized procedures; build new on Azure ML                    |
| SAS Drug Development / Clinical         | **Lift-and-shift**           | Regulatory acceptance of SAS outputs is a hard constraint for now              |
| SAS/OR (Operations Research)            | **Lift-and-shift or Hybrid** | PuLP/OR-Tools cover basics; complex optimization stays on SAS                  |
| SAS Risk Management for Banking         | **Lift-and-shift**           | Domain-specific regulatory models require SAS validation                       |
| SAS Anti-Money Laundering               | **Hybrid**                   | Core detection stays on SAS; alerting and case management can move             |
| SAS Survey procedures                   | **Hybrid**                   | R `survey` package is mature; Python `samplics` is improving                   |

---

## Strategic resources

| Document                                                | Audience                     | Description                                                                                                                                                               |
| ------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Why Azure over SAS](why-azure-over-sas.md)             | CIO / CDO / Board            | Executive white paper covering open-source ecosystem advantages, cloud-native ML, cost analysis, talent availability, SAS-Microsoft partnership, and AI/GenAI integration |
| [Total Cost of Ownership Analysis](tco-analysis.md)     | CFO / CIO / Procurement      | Detailed pricing: SAS licensing stack vs Azure consumption across three federal tenant sizes, 5-year TCO projections, reskilling investment, and ROI timeline             |
| [Complete Feature Mapping](feature-mapping-complete.md) | CTO / Analytics Architecture | 40+ SAS features mapped to Azure equivalents with code examples, migration complexity ratings, and gap analysis                                                           |

---

## Migration guides

Domain-specific deep dives covering every aspect of a SAS-to-Azure migration.

| Guide                                                     | SAS capability                         | Azure destination                             |
| --------------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| [Lift-and-Shift Migration](lift-shift-migration.md)       | SAS Viya, SAS Grid Manager             | AKS, Azure VMs, ANF storage                   |
| [Analytics Migration](analytics-migration.md)             | PROC MEANS/FREQ/REG/LOGISTIC/GLM/ARIMA | pandas, scikit-learn, statsmodels, PySpark    |
| [Data Management Migration](data-management-migration.md) | DATA Step, SAS DI Studio, SAS Formats  | ADF, dbt, Fabric Data Pipelines, Delta tables |
| [Reporting Migration](reporting-migration.md)             | SAS Visual Analytics, ODS, SAS/GRAPH   | Power BI, Fabric notebooks, matplotlib/plotly |
| [Model Migration](model-migration.md)                     | SAS Model Manager, SAS scoring         | Azure ML, MLflow, managed endpoints           |

---

## Tutorials

Step-by-step walkthroughs for common migration scenarios.

| Tutorial                                                    | Description                                                                                                                                  | Time       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [Deploy SAS Viya on Azure](tutorial-sas-viya-azure.md)      | Deploy SAS Viya 4.x on AKS using the SAS Deployment Operator; configure persistent storage; integrate with Fabric/ADLS for data access       | 4--6 hours |
| [SAS Program to Python Notebook](tutorial-sas-to-python.md) | Convert a complete SAS program (data prep, analysis, reporting) to a Python notebook in Fabric; validate output equivalence; schedule in ADF | 2--4 hours |

---

## Government and federal

| Document                                              | Description                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Federal Migration Guide](federal-migration-guide.md) | SAS in federal agencies (FDA, CDC, Census, DoD, VA), SAS Viya on Azure Gov (January 2026), FedRAMP High, compliance analytics, statistical disclosure limitation, FISMA requirements |

---

## Technical references

| Document                                  | Description                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Benchmarks & Performance](benchmarks.md) | Statistical processing performance: SAS vs Python/PySpark for common procedures, model training times, data processing throughput, concurrent user handling  |
| [Best Practices](best-practices.md)       | Workforce reskilling program, dual-running validation, phased migration, output reconciliation framework, CSA-in-a-Box as the unified analytics landing zone |

---

## How CSA-in-a-Box fits

CSA-in-a-Box is the **unified analytics landing zone** that replaces or augments SAS capabilities. It provides the complete platform that a SAS-to-Azure migration lands on:

| SAS capability            | CSA-in-a-Box replacement                          | Platform component                                                                                    |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| SAS Data Integration      | **ADF + dbt + Fabric Data Pipelines**             | Data management landing zone with medallion architecture, data-quality contracts, and Purview lineage |
| Base SAS + DATA Step      | **Python/PySpark in Fabric/Databricks notebooks** | Compute layer with auto-scaling, notebook scheduling, and Git integration                             |
| SAS/STAT + SAS/ETS        | **Azure ML + scikit-learn + statsmodels**         | ML workspace with experiment tracking, model registry (MLflow), and managed endpoints                 |
| SAS Visual Analytics      | **Power BI + Direct Lake**                        | BI layer with semantic models over Fabric lakehouses; Copilot for natural-language analytics          |
| SAS Model Manager         | **MLflow + Azure ML model registry**              | Full MLOps: model versioning, champion/challenger, A/B testing, monitoring, and automated retraining  |
| SAS Formats               | **dbt seed tables + Delta reference data**        | Governed lookup tables registered in Unity Catalog with Purview classification                        |
| SAS Macro libraries       | **Python packages + dbt macros**                  | Version-controlled, tested, and CI/CD-deployed code libraries                                         |
| SAS Grid Manager          | **Databricks/Fabric auto-scaling compute**        | Elastic compute that scales to workload; no capacity planning required                                |
| SAS Governance (metadata) | **Purview + Unity Catalog**                       | Unified governance with automated classification, lineage, and data-product discovery                 |

### CSA-in-a-Box deployment for SAS migration

The standard csa-inabox deployment (`make deploy-dev` or Bicep modules) provisions the complete target platform:

1. **Data Management Landing Zone** --- ADLS Gen2 storage, Fabric capacity, networking, Purview
2. **Data Landing Zone** --- Domain-specific lakehouses, Unity Catalog, dbt project scaffolding
3. **ML Workspace** --- Azure ML, MLflow, compute clusters, managed endpoints
4. **BI Layer** --- Power BI Premium/Fabric capacity, semantic models, workspaces
5. **Governance** --- Purview classification policies, lineage scanning, data-product registry
6. **Compliance** --- NIST 800-53, FedRAMP, CMMC, HIPAA controls mapped in IaC

---

## SAS-Microsoft partnership context

The SAS-Microsoft partnership is deepening, which creates bridge opportunities for organizations not ready for a full replacement:

| Date           | Milestone                                   | Impact                                                               |
| -------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| 2020           | SAS on Azure Marketplace                    | SAS Viya deployable on Azure commercial                              |
| 2023           | SAS + Azure strategic partnership announced | Joint go-to-market; co-engineering investment                        |
| Dec 2025       | **SAS on Fabric**                           | SAS Viya reads/writes OneLake lakehouses natively; shared data layer |
| Jan 2026       | **SAS Viya on Azure Government**            | FedRAMP High authorized; federal lift-and-shift unlocked             |
| 2026 (roadmap) | SAS + Fabric deeper integration             | SAS procedures callable from Fabric notebooks (preview)              |

This partnership means organizations can pursue a phased migration --- running SAS and Azure ML side-by-side against the same data in Fabric lakehouses --- without the all-or-nothing pressure of earlier migration windows.

---

## Migration timeline by organization size

| Organization size         | SAS programs | SAS users | Recommended path    | Timeline      |
| ------------------------- | ------------ | --------- | ------------------- | ------------- |
| Small (department)        | 10--50       | 5--20     | Replace             | 3--6 months   |
| Medium (agency division)  | 50--200      | 20--100   | Hybrid              | 6--12 months  |
| Large (full agency)       | 200--1,000+  | 100--500+ | Hybrid (phased)     | 12--24 months |
| Enterprise (multi-agency) | 1,000+       | 500+      | Hybrid (multi-wave) | 18--36 months |

---

## Getting started

1. **Read the executive brief:** [Why Azure over SAS](why-azure-over-sas.md) --- understand the strategic case
2. **Build the business case:** [TCO Analysis](tco-analysis.md) --- quantify the financial impact
3. **Choose your path:** Use the decision matrix above to select lift-and-shift, replace, or hybrid
4. **Run the playbook:** [Migration Playbook](../sas-to-azure.md) --- phased execution plan
5. **Start with a tutorial:** [SAS to Python](tutorial-sas-to-python.md) or [SAS Viya on Azure](tutorial-sas-viya-azure.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
