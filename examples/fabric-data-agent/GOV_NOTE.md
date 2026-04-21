# Fabric Availability — Gov vs Commercial

> **Status:** Microsoft Fabric is **pre-GA in Azure Government**. This example is a **reference pattern**, not a Gov-deployable workload today.

## Positioning

| Environment | Availability (2026-04) | Use this example? | Gov alternative |
|---|---|---|---|
| Azure Commercial | GA | Yes — deploy end-to-end via `deploy/bicep/main.bicep` once workspace identity is approved | n/a |
| Azure Government | **Pre-GA**, forecast-only | **No** — use the code as a *reference pattern* only | `csa_platform/streaming` spine (Event Hubs + ADLS Delta + Synapse SQL serverless + Azure OpenAI) |

## Gov alternative (available today)

The **streaming spine** already shipped in this monorepo provides feature parity for a grounded analytics Q&A surface:

1. **Ingestion:** Event Hubs → Event Hub Capture → ADLS Gen2 bronze Parquet/Delta.
2. **Silver/gold:** Databricks or Synapse Serverless dbt models over Delta.
3. **Query surface:** Synapse Serverless SQL endpoint *or* Databricks SQL warehouse — both have SQL surfaces functionally equivalent to the Fabric Lakehouse SQL endpoint used by `agent/retriever.py`.
4. **LLM:** Azure OpenAI in Azure Gov (available at both IL4 and IL5 regions).

The `Retriever` abstraction here is deliberately SDK-light; the only piece that would need to change for the Gov path is `_load_fabric_client` — swap in a DB-API 2.0 connection against Synapse Serverless or Databricks SQL. The SQL-generation, read-only guard, generator, and orchestrator code are all portable verbatim.

## What to do TODAY for Gov workloads

1. Read `examples/fabric-data-agent/` for the read-only grounded-Q&A *pattern*.
2. Implement the same pattern against the streaming spine:
   - Point `Retriever` at a Synapse Serverless SQL endpoint.
   - Keep `generator.py` and `agent.py` unchanged.
   - Point `deploy/bicep/main.bicep` at `deploy/bicep/DLZ/modules/synapse/synapse.bicep` instead of the Fabric resources.
3. File a Gov-GA watch ticket to migrate to Fabric once the forecast lands.

## What to do LATER (post-Gov-GA)

1. Swap the Retriever's SQL-executor for the real Fabric Lakehouse SQL client.
2. Re-run `examples/fabric-data-agent/agent/tests/` — they are all mocked so they will continue to pass without Fabric installed.
3. Re-run `deploy/bicep/main.bicep` in a Gov-available region.

## References

- Monorepo Gov positioning: `docs/AZURE_GOV_POSITIONING.md` (if present).
- Streaming spine reference: `csa_platform/streaming/README.md`.
- This example's Bicep callout: `deploy/bicep/main.bicep` header comment.
