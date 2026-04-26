# Migrations to Azure

Field-tested migration playbooks from common on-prem and other-cloud platforms onto the CSA-in-a-Box Azure stack. Each playbook covers **assessment → design → migration → cutover → decommission** with realistic timelines and pitfalls.

## Available playbooks

### From other clouds

| Source | Target | Playbook |
|--------|--------|----------|
| AWS (Redshift, S3, Glue, EMR) | Synapse, ADLS, ADF, Databricks | [aws-to-azure.md](aws-to-azure.md) |
| GCP (BigQuery, GCS, Dataflow) | Synapse/Fabric, ADLS, ADF | [gcp-to-azure.md](gcp-to-azure.md) |

### From specialty platforms

| Source | Target | Playbook |
|--------|--------|----------|
| Snowflake | Fabric / Synapse + Databricks | [snowflake.md](snowflake.md) |
| Databricks (other clouds or AWS) | Microsoft Fabric | [databricks-to-fabric.md](databricks-to-fabric.md) |
| Palantir Foundry | Azure data mesh + Purview | [palantir-foundry.md](palantir-foundry.md) |

### From legacy / on-prem

| Source | Target | Playbook |
|--------|--------|----------|
| Teradata | Synapse Dedicated SQL Pool / Fabric Warehouse | [teradata.md](teradata.md) |
| Hadoop / Hive (Cloudera, HDInsight, on-prem) | Synapse Spark + Delta / Fabric Lakehouse | [hadoop-hive.md](hadoop-hive.md) |
| Informatica PowerCenter / IICS | Azure Data Factory / Fabric Data Pipelines | [informatica.md](informatica.md) |
| IoT Hub + ADAL → Entra | Entra ID + Event Grid + Functions | [iot-hub-entra.md](iot-hub-entra.md) |

## What every migration has in common

Regardless of source, every migration follows the same **5 phases**:

```mermaid
flowchart LR
    A[1. Assessment<br/>2-4 weeks] --> B[2. Design<br/>2-3 weeks]
    B --> C[3. Migration<br/>4-16 weeks]
    C --> D[4. Cutover<br/>1-2 weeks]
    D --> E[5. Decommission<br/>4-8 weeks]
```

| Phase | Goal | Output |
|-------|------|--------|
| **Assessment** | Inventory current state — workloads, data sizes, dependencies, cost | Migration backlog (CSV / Azure Migrate output), workload tier, target architecture options |
| **Design** | Map source primitives to Azure primitives | Target architecture diagram, security model, network topology, sizing assumptions |
| **Migration** | Move data + code in waves | Working pipelines, dbt models, dashboards on Azure for each wave |
| **Cutover** | Stop writes to source, freeze, switch consumers | Read-only source, consumers on Azure |
| **Decommission** | Verify, archive, delete | Source archived, contracts cancelled, runbooks updated |

## Sequencing rule

We **always** migrate consumers before producers, going **upstream**:

1. First: **read-only consumers** (BI dashboards, downstream APIs) — point them at a shadow Azure copy
2. Then: **transformations** (dbt / SQL / Spark)
3. Then: **ingestion** (the actual writes from source systems)
4. Finally: **freeze the source** and decommission

This minimizes the window where any single workload depends on both clouds simultaneously.

## Cost during migration

Plan for **~140% of your steady-state Azure cost** during the migration window because both source and target run in parallel. Tag every resource created during migration with `purpose=migration-from-<source>` so you can report on it separately.

See also [Best Practices — Cost Optimization](../best-practices/cost-optimization.md) for tagging and reserved-capacity strategy.

## Compliance during migration

Migration is the highest-risk window for data exposure. Read these before starting:

- [Best Practices — Security & Compliance](../best-practices/security-compliance.md)
- [Compliance — your relevant framework](../compliance/README.md)
- [Runbook — Security Incident](../runbooks/security-incident.md)

Specifically: **never** open a public IP on the source side to "make it easier to copy data over." Use ExpressRoute / VPN / Private Link.

## Need a playbook for something not listed?

Open an issue at https://github.com/fgarofalo56/csa-inabox/issues with the source platform, approximate data volume, and target Azure services. We add playbooks based on demand.
