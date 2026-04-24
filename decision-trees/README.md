# Decision Trees — Machine-Readable Source of Truth


This directory is the **YAML source of truth** for every scenario-driven architecture decision in CSA-in-a-Box. Human-readable narratives with Mermaid diagrams live in [`docs/decisions/`](../docs/decisions/) and are kept in sync with these YAMLs.

## Why YAML + Markdown

- YAML is the machine-readable contract. A future Copilot skill `walk_tree(id)` will consume these files directly to guide interactive architect conversations.
- Markdown is the human-readable contract for architects browsing the repo.
- Finding **CSA-0010** required replacing the static "Technology Decision Matrix" in `docs/ARCHITECTURE.md` with real branching decisions.

## Catalog

| ID | YAML | Markdown | Summary |
|----|------|----------|---------|
| `fabric-vs-databricks-vs-synapse` | [yaml](fabric-vs-databricks-vs-synapse.yaml) | [md](../docs/decisions/fabric-vs-databricks-vs-synapse.md) | Primary analytics platform: Fabric vs Databricks vs Synapse. |
| `lakehouse-vs-warehouse-vs-lake` | [yaml](lakehouse-vs-warehouse-vs-lake.yaml) | [md](../docs/decisions/lakehouse-vs-warehouse-vs-lake.md) | Storage + compute pattern: lakehouse, warehouse, or data lake. |
| `etl-vs-elt` | [yaml](etl-vs-elt.yaml) | [md](../docs/decisions/etl-vs-elt.md) | Transform-before-load vs load-then-transform. |
| `batch-vs-streaming` | [yaml](batch-vs-streaming.yaml) | [md](../docs/decisions/batch-vs-streaming.md) | Batch, micro-batch, or true streaming ingestion. |
| `materialize-vs-virtualize` | [yaml](materialize-vs-virtualize.yaml) | [md](../docs/decisions/materialize-vs-virtualize.md) | Persist query results or query source on demand. |
| `delta-vs-iceberg-vs-parquet` | [yaml](delta-vs-iceberg-vs-parquet.yaml) | [md](../docs/decisions/delta-vs-iceberg-vs-parquet.md) | Lake table format selection. |
| `kafka-vs-eventhubs-vs-servicebus` | [yaml](kafka-vs-eventhubs-vs-servicebus.yaml) | [md](../docs/decisions/kafka-vs-eventhubs-vs-servicebus.md) | Messaging / streaming backbone. |
| `rag-vs-finetune-vs-agents` | [yaml](rag-vs-finetune-vs-agents.yaml) | [md](../docs/decisions/rag-vs-finetune-vs-agents.md) | AI integration pattern. |

## Schema

See [`fabric-vs-databricks-vs-synapse.yaml`](fabric-vs-databricks-vs-synapse.yaml) as the canonical example. Every tree conforms to:

```yaml
tree_id: "<slug>"
title: "<short human title>"
last_reviewed: "YYYY-MM-DD"
version: "1.0"
summary: "One sentence — when the question comes up."
links:
  decision_doc: "docs/decisions/<slug>.md"
  related_adrs: ["..."]
  related_architectures: ["docs/ARCHITECTURE.md#..."]
nodes:
  - id: "start"
    question: "Branching question"
    options:
      - label: "Option text"
        next: "<next-node-id>"
  - id: "rec-xxx"
    recommendation: "Name"
    rationale: "Why this is the answer"
    tradeoffs:
      cost: "..."
      latency: "..."
      compliance: "..."
      skill_match: "..."
    anti_patterns:
      - "..."
    linked_example: "examples/<vertical>/"
```

Two node shapes:
- **Branching node** — has `question` + `options` (each with `label` and `next`).
- **Terminal node** — has `recommendation`, `rationale`, `tradeoffs {cost, latency, compliance, skill_match}`, `anti_patterns`, `linked_example`.

## Copilot contract

The future Copilot skill `walk_tree(tree_id)` consumes these YAMLs directly. Contract:

1. Skill starts at node `id: "start"`.
2. Skill asks the user each `question`, offering the `options`.
3. On a selection, skill follows `next` to the next node.
4. At a terminal node, skill returns `recommendation`, `rationale`, `tradeoffs`, and `anti_patterns`, linking the `linked_example` path.

**Do not rename `tree_id`, node `id` values, or the terminal-node keys without coordinating with the skill author** — breaking changes to this schema break Copilot.

## Editing workflow

1. Edit the YAML first.
2. Regenerate or hand-update the matching Markdown in `docs/decisions/` so Mermaid + narrative match.
3. Bump `last_reviewed` and `version`.
4. Validate YAML: `python -c "import yaml; yaml.safe_load(open('decision-trees/<file>.yaml'))"`.

## Related

- Finding: CSA-0010 (ARCHITECTURE decision matrix lacks branching)
- Human index: [`docs/decisions/README.md`](../docs/decisions/README.md)
- Primary tech cheat sheet: [ARCHITECTURE.md#Primary Tech Choices](../docs/ARCHITECTURE.md#%EF%B8%8F-primary-tech-choices)
