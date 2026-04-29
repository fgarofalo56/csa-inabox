# Patterns

Implementation patterns for cross-cutting scenarios. **Patterns** sit between **Best Practices** (the high-level "what we do and why") and **Examples** (full working implementations). Use a pattern when you need to solve a specific technical problem and want a vetted approach.

| Pattern                                                         | Use when                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Cosmos DB Patterns](cosmos-db-patterns.md)                     | Designing a Cosmos data model or choosing API/consistency                  |
| [AKS & Container Apps for Data](aks-container-apps-for-data.md) | Picking a container platform for Spark, Argo, KEDA-driven stream consumers |
| [LLMOps & Evaluation](llmops-evaluation.md)                     | Building eval harness, content safety, drift detection for AI features     |
| [Networking & DNS Strategy](networking-dns-strategy.md)         | Designing private endpoints, Private DNS zones, name resolution            |
| [Observability with OpenTelemetry](observability-otel.md)       | Instrumenting end-to-end tracing across portal → API → AI services         |
| [Streaming & CDC](streaming-cdc.md)                             | Choosing between Event Hubs / ASA / RTI / Debezium for change data         |
| [Power BI & Fabric Roadmap](power-bi-fabric-roadmap.md)         | Sequencing Power BI workloads onto Fabric Direct Lake                      |

## Why patterns are separate from Best Practices

| Document type     | Scope                 | Voice                                          |
| ----------------- | --------------------- | ---------------------------------------------- |
| **ADR**           | One decision          | "We chose X"                                   |
| **Best Practice** | Operational principle | "When you do Y, do it this way"                |
| **Pattern**       | Implementation        | "Here's the architecture + code for problem Z" |
| **Example**       | Working code          | "Here's a runnable end-to-end implementation"  |

If a pattern stabilizes and becomes the platform default, it usually graduates to a Best Practice (the _what_ and _why_) plus an Example (the runnable _how_).

## How to add a pattern

1. New file under `docs/patterns/<pattern-name>.md`
2. Use the templated structure: Problem → Pattern → Mermaid diagram → Implementation → Trade-offs → Variants → Related
3. Link to relevant ADRs, Best Practices, and Examples
4. Open a PR — pattern appears live on next docs deploy
