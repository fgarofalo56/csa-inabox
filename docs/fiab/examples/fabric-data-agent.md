# Fabric Data Agent on CSA Loom

Already Loom-shaped from `examples/fabric-data-agent/` — the read-only
Q&A pattern over a lakehouse lifts directly into Loom Data Agents.

## What you'll build

A Loom Data Agent that answers natural-language questions about a
lakehouse, with:
- Read-only guard (Cosmos + Spark SQL inspection)
- Identity passthrough (OBO)
- NL2SQL grounding via per-source few-shot examples
- Federation-aware (Commercial via Foundry; Gov via MAF + AOAI direct)

## Components

| Loom capability | Used for |
|---|---|
| `apps/copilot/` PydanticAI agent | Runtime |
| `azure-functions/copilot-chat/` | Chat backend + telemetry |
| Lakehouse (Delta tables) | Grounding data |
| Cosmos DB | Agent config + example queries |
| Azure AI Search | Vector index of schema + sample data |
| Azure OpenAI | LLM inference (gpt-4o + text-embedding-3-large) |

## Read-only guard pattern

From the original `fabric-data-agent` example, lifted into Loom:

```python
def _is_read_only(query: str, language: str) -> bool:
    """Reject queries with mutation keywords."""
    if language.upper() == "SQL":
        mutating_keywords = ["INSERT", "UPDATE", "DELETE", "DROP",
                              "TRUNCATE", "CREATE", "ALTER", "MERGE"]
    elif language.upper() == "DAX":
        # DAX is read-only by design
        return True
    elif language.upper() == "KQL":
        mutating_keywords = [".ingest", ".set", ".append", ".drop",
                              ".alter", ".create"]
    else:
        return False

    query_upper = query.upper()
    for kw in mutating_keywords:
        if kw.upper() in query_upper:
            return False
    return True
```

## Per-boundary notes

| Boundary | Notes |
|---|---|
| Commercial / GCC | Foundry Agent Service + Databricks SQL |
| GCC-High / IL4 | MAF + AOAI direct (Gov region) + Synapse Serverless |
| IL5 (v1.1) | Same as IL4 + Atlas catalog |

## Source code

[`examples/fiab-data-agent/`](https://github.com/fgarofalo56/csa-inabox/tree/csa-loom-pillar/examples/fiab-data-agent)

Includes:
- `retriever.py` with read-only guard
- Agent config JSON
- 20+ example queries
- Test harness

## Cost

Minimal beyond underlying AOAI tokens:
- ~$0.01 per Q&A turn (gpt-4o) for typical schema-grounded queries
- Plus underlying lakehouse compute (Synapse Serverless / Databricks
  SQL)

## Forward migration

Agent config exports to Fabric Data Agents REST API. Example queries
port 1:1.

## Related

- [Tutorial 05 — Data Agent over Lakehouse](../tutorials/05-data-agent.md)
- [Data Agents parity workload](../workloads/data-agents-parity.md)
- [Sovereign AI Agents use case](../use-cases/sovereign-ai-agents.md)
- Existing source: [`examples/fabric-data-agent/`](../../examples/index.md)
