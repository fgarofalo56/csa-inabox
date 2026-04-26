# Best Practices

Nine field-tested guides for running cloud-scale analytics + AI on Azure. Each one is independent — read the ones relevant to your role.

| Guide | When to read | Length |
|-------|--------------|--------|
| [Medallion Architecture](medallion-architecture.md) | Designing your bronze/silver/gold lakehouse | 664 lines |
| [Data Engineering](data-engineering.md) | Authoring ADF + dbt + Spark pipelines | 800 lines |
| [Data Governance](data-governance.md) | Setting up Purview, contracts, lineage, classification | 573 lines |
| [Security & Compliance](security-compliance.md) | Hardening identities, secrets, network, encryption | 654 lines |
| [Infrastructure as Code & CI/CD](iac-cicd.md) | Bicep, what-if, GitHub Actions, environment promotion | 657 lines |
| [Cost Optimization](cost-optimization.md) | Tagging, reserved capacity, auto-pause, FinOps | 518 lines |
| [Monitoring & Observability](monitoring-observability.md) | Log Analytics, Workbooks, OTel, SLI/SLO | 520 lines |
| [Performance Tuning](performance-tuning.md) | Spark configs, Synapse SQL pools, AI Search shards | 705 lines |
| [Disaster Recovery](disaster-recovery.md) | RPO/RTO targets, geo-replication, runbook drills | 521 lines |

## How to use these

Each guide follows the same structure:

```
1. The problem (1-2 paragraphs)
2. The opinionated answer (this is what we do)
3. The reasoning (why — usually links to an ADR)
4. The mechanics (commands, code, configs)
5. The trade-offs (what we gave up to make this choice)
6. The escape hatches (when this advice does NOT apply)
```

If a guide ever reads as "do X because everyone does X," that's a bug — open an issue.

## Related

- [ADRs](../adr/README.md) — the 22 specific decisions these best-practices are built on
- [Reference Architectures](../reference-architecture/index.md) — how the pieces fit together
- [Patterns](../patterns/index.md) — implementation patterns for specific scenarios
- [Decision Trees](../decisions/README.md) — quick "which option do I pick" guides
