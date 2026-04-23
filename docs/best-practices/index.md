---
title: "Best Practices"
description: "Engineering best practices for operating, securing, and optimizing the CSA-in-a-Box analytics platform."
---

# Best Practices

This section captures proven engineering practices for building and operating the CSA-in-a-Box platform. Each page distills guidance from real deployments into actionable recommendations with concrete examples.

The audience spans multiple roles: **platform engineers** responsible for infrastructure and CI/CD, **data engineers** building pipelines and models, **DevOps teams** managing deployments and monitoring, and **security teams** enforcing compliance and access controls. Each page calls out which roles benefit most from its content.

## Quick Reference

| Area                       | Page                                                      | Key Topics                                                                                         | Audience                                   |
| -------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Medallion Architecture     | [Medallion Architecture](medallion-architecture.md)       | Naming conventions, partitioning strategies, schema evolution, quality gates                       | Data Engineers, Platform Engineers         |
| Data Engineering           | [Data Engineering](data-engineering.md)                   | dbt patterns, ADF pipeline design, Spark best practices, testing, data contracts                   | Data Engineers                             |
| Data Governance            | [Data Governance](data-governance.md)                     | Purview integration, lineage tracking, classification policies, domain ownership                   | Data Engineers, Security Teams             |
| Security & Compliance      | [Security & Compliance](security-compliance.md)           | Network isolation, identity and access, encryption at rest and in transit, FedRAMP/CMMC alignment  | Security Teams, Platform Engineers         |
| IaC & CI/CD                | [IaC & CI/CD](iac-cicd.md)                                | Bicep module patterns, GitHub Actions workflows, PSRule and Checkov validation, secrets management | Platform Engineers, DevOps                 |
| Cost Optimization          | [Cost Optimization](cost-optimization.md)                 | Compute scaling, storage tiering, egress reduction, Fabric capacity management                     | Platform Engineers, DevOps                 |
| Monitoring & Observability | [Monitoring & Observability](monitoring-observability.md) | Azure Monitor configuration, alert design, SLO definitions, operational dashboards                 | DevOps, Platform Engineers                 |
| Performance Tuning         | [Performance Tuning](performance-tuning.md)               | Delta table optimization, Spark configuration, query tuning, caching strategies                    | Data Engineers, Platform Engineers         |
| Disaster Recovery          | [Disaster Recovery](disaster-recovery.md)                 | Multi-region deployment, RTO/RPO targets, DR drill procedures, failover automation                 | Platform Engineers, DevOps, Security Teams |

!!! tip "How to Use This Section"

    Start with this overview to identify the areas most relevant to your role and current work. Then dive into specific pages for detailed guidance, configuration examples, and checklists.

    Each page follows a consistent structure: context and rationale, concrete recommendations, configuration snippets, and common pitfalls to avoid. Pages cross-reference each other where topics overlap — for example, Security & Compliance links to IaC & CI/CD for policy-as-code patterns.

## Related Sections

- **[Guides](../guides/index.md)** — Step-by-step walkthroughs for common platform tasks
- **[Architecture Decision Records](../adr/index.md)** — Context and reasoning behind key design choices
- **[Compliance](../compliance/index.md)** — Control mappings, audit artifacts, and regulatory alignment details
- **[Runbooks](../runbooks/index.md)** — Operational procedures for incident response and routine maintenance
