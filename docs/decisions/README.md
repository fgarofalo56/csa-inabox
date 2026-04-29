# Architecture Decision Trees

Scenario-driven decision trees for the recurring architecture questions on CSA-in-a-Box. Each tree is a branching flowchart that leads to a specific recommendation with rationale, tradeoffs (cost / latency / compliance / skill match), anti-patterns, and a linked working example.

For the **machine-readable YAML source of truth** (consumed by the future Copilot `walk_tree` skill), see [`decision-trees/`](../../decision-trees/) at the repo root. Both shapes are kept in sync.

## How to use these

1. Scan the **TL;DR** for your scenario.
2. Walk the **Mermaid diagram** to your recommendation node.
3. Read the **Per-recommendation detail** — especially the **Anti-patterns**.
4. Open the **Linked example** to see the pattern in working code.

## Catalog

| Tree                                                                        | TL;DR                                                                                                                                    |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [Fabric vs. Databricks vs. Synapse](fabric-vs-databricks-vs-synapse.md)     | Primary analytics platform. Fabric for Commercial + Power BI, Databricks for Spark/ML/multi-cloud, Synapse for Gov / dedicated-pool SQL. |
| [Lakehouse vs. Warehouse vs. Lake](lakehouse-vs-warehouse-vs-lake.md)       | Storage + compute pattern. Lakehouse for mixed workloads >10 TB, Warehouse for pure BI at concurrency, Lake for raw exploration.         |
| [ETL vs. ELT](etl-vs-elt.md)                                                | Default ELT; ETL when sensitive data must be redacted pre-landing; hybrid when redaction is narrow.                                      |
| [Batch vs. Streaming](batch-vs-streaming.md)                                | SLA-driven. Streaming <1s, micro-batch <5min, batch hourly/daily.                                                                        |
| [Materialize vs. Virtualize](materialize-vs-virtualize.md)                  | Materialize hot BI paths; virtualize for ad-hoc or <1 min freshness; hybrid for most real workloads.                                     |
| [Delta vs. Iceberg vs. Parquet](delta-vs-iceberg-vs-parquet.md)             | Delta default in Microsoft ecosystem; Iceberg when multi-engine is a hard requirement; Parquet only for append-only bronze.              |
| [Kafka vs. Event Hubs vs. Service Bus](kafka-vs-eventhubs-vs-servicebus.md) | Event Hubs default (Kafka API); Service Bus for ordered messaging; self-host Kafka only when full ecosystem needed.                      |
| [RAG vs. Fine-Tuning vs. Agents](rag-vs-finetune-vs-agents.md)              | RAG default; fine-tune for style on stable corpus; agents for bounded tool workflows with human gates.                                   |

## Conventions

- **Last Updated** is always explicit.
- **Linked examples** always point to a real directory under [`examples/`](../../examples/). If a recommendation has no matching vertical, the tree notes that gap.
- **Anti-patterns** are prescriptive — they block common misuses, not rare edge cases.
- **Tradeoffs** always cover the same four axes: cost, latency, compliance, skill match. Missing axes are an authoring bug.

## Related

- Machine-readable source of truth: [`decision-trees/`](../../decision-trees/)
- Primary tech cheat sheet: [ARCHITECTURE.md#Primary Tech Choices](../ARCHITECTURE.md#%EF%B8%8F-primary-tech-choices)
- Finding: CSA-0010
