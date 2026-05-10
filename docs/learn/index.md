---
title: Cloud Scale Analytics — Imported Reference Library
description: Comprehensive Azure analytics reference content imported from the standalone csa-inabox-docs repository on 2026-05-08, preserving its complete service catalogue, architecture patterns, tutorials, troubleshooting, and code examples in one searchable place alongside the platform's primary guides.
tags:
  - reference
  - azure-services
  - tutorials
  - troubleshooting
---

# Cloud Scale Analytics — Reference Library

This section is a comprehensive reference library covering Azure analytics
services, architecture patterns, implementation guides, code examples, and
tutorials, originally maintained as the separate
[`fgarofalo56/csa-inabox-docs`](https://github.com/fgarofalo56/csa-inabox-docs)
repository. It was merged into this repo on **2026-05-08** so the standalone
docs repo can be retired and the platform's primary guides
([`docs/guides/`](../guides/)) and the broader knowledge base live in one
searchable, versioned place.

!!! tip "Where to start"
    - **New to Azure analytics?** Begin with [the curriculum](01-overview/README.md).
    - **Looking up a specific service?** Jump to [Services](02-services/README.md).
    - **Designing a system?** Browse [Architecture Patterns](03-architecture-patterns/README.md).
    - **Debugging?** Use [Troubleshooting](07-troubleshooting/README.md).
    - **Looking for working code?** See [Code Examples](06-code-examples/README.md).
    - **Walking through a service?** Check the step-by-step
      [tutorials](tutorials/) for Data Factory, Synapse, and Stream Analytics.

## Layout

| Section | Contents |
|--|--|
| [`01-overview/`](01-overview/README.md) | Platform overview, quick-start guides |
| [`02-services/`](02-services/README.md) | Service-by-service reference: Synapse, Cosmos DB, Databricks, Storage, Event Hubs, Stream Analytics, Purview, ADF, HDInsight, Power BI, ML, Key Vault, Logic Apps, Functions, Cognitive Services |
| [`03-architecture-patterns/`](03-architecture-patterns/README.md) | Streaming, batch, ML, governance, hybrid, integration, reference architectures |
| [`04-implementation-guides/`](04-implementation-guides/README.md) | End-to-end solutions, Databricks deep-dives, integration scenarios, migration guides |
| [`05-best-practices/`](05-best-practices/README.md) | Cross-cutting concerns, operational excellence, service-specific tuning |
| [`06-code-examples/`](06-code-examples/README.md) | Working code by service, Delta Lake patterns, integration snippets |
| [`07-troubleshooting/`](07-troubleshooting/README.md) | Common errors, performance issues, service-specific diagnostics |
| [`08-reference/`](08-reference/README.md) | API references, limits, quotas |
| [`08-solutions/`](08-solutions/README.md) | Real-time analytics, change feed, ML pipeline, Logic Apps integration |
| [`09-monitoring/`](09-monitoring/README.md) | Service-specific monitoring runbooks |
| [`10-devops/`](10-devops/README.md) | DevOps practices for analytics workloads |
| [`tutorials/`](tutorials/README.md) | Step-by-step walkthroughs: Data Factory (19 lessons), Synapse (16), Stream Analytics (16), Power BI, code labs, certification prep, learning paths |
| [`reference/`](reference/README.md) | KQL reference, Spark configuration, regional compliance, security checklist, glossary |
| [`diagrams/`](diagrams/README.md) | Architecture diagrams in Mermaid + SVG |
| [`solutions/`](solutions/README.md) | Real-time analytics reference solution |

## Relationship to the platform guides

The content in [`docs/guides/`](../guides/) at the top of this repo is the
**opinionated** CSA-in-a-Box implementation: how this specific platform
deploys, configures, and integrates each service. The `learn/` reference
library is **service-agnostic** — generic Azure analytics knowledge,
patterns, and tutorials independent of CSA-in-a-Box's particular wiring.

Use the platform guides when you're working *inside* CSA-in-a-Box. Use the
reference library when you're learning the underlying Azure service or
hunting for a pattern to adapt.
