# PRP-09 — Loom Data Agents (Extending apps/copilot)

## Context

Fabric Data Agents parity built by extending the existing csa-inabox
copilot scaffold (`apps/copilot/` PydanticAI agent +
`azure-functions/copilot-chat/` Function backend). Add NL2SQL /
NL2DAX / NL2KQL tools with per-source few-shot examples, identity-
passthrough execution, and Foundry integration (Commercial only).

PRD ref: `temp/fiab-prd/05-workload-parity.md` §5.7;
`temp/fiab-prd/06-custom-apps.md` §6.6; AMENDMENTS §A15.

## Goal

Loom Data Agents runtime delivers Fabric-equivalent NL-Q&A over
lakehouse / warehouse / semantic models / KQL DBs with per-agent
configuration (instructions, data sources, example queries,
verified answers, field descriptions). OBO identity throughout.

## Acceptance criteria

- [ ] Extend `apps/copilot/` PydanticAI agent with tools:
  - `nl2sql(question, data_source_id, user_token)` — SQL against
    lakehouse / warehouse via Databricks SQL Warehouse (Commercial)
    or Synapse Serverless (Gov)
  - `nl2dax(question, semantic_model_id, user_token)` — DAX against
    Power BI semantic model via XMLA
  - `nl2kql(question, adx_cluster, database, user_token)` — KQL against
    ADX
  - `graph_search(question, user_token)` — Microsoft Graph entities
  - `custom_search(question, search_index, user_token)` — AI Search index
- [ ] Per-agent config schema in Cosmos DB (per PRD §6.6 example):
  name, description, instructions, data sources (up to 5 in v1),
  example queries (Q→SQL/DAX/KQL pairs), verified answers, field
  descriptions, sensitivity policy
- [ ] Schema + sample data + business glossary embedded into Azure AI
  Search vector index per agent
- [ ] Agent "publish" workflow: makes agent callable via REST + Foundry
  Agent Service integration (Commercial only)
- [ ] OBO token flow for every tool call (per AMENDMENTS A15)
- [ ] Extends existing `azure-functions/copilot-chat/function_app.py`
  with `/api/loom-chat` + `/api/agent/{id}/chat` endpoints
- [ ] Reuses existing security (rate limiting, PII redaction, content
  safety, telemetry, feedback loops) from copilot-chat
- [ ] Audit log: per-invocation entry with user UPN, question, generated
  query, result row count, latency

## Validation gates

- Unit tests per `nl2X` tool with mocked engine clients
- E2E: published agent answers benchmark suite of 20 domain-specific
  questions across SQL/DAX/KQL with ≥ 85% accuracy
- Identity-passthrough test: agent invoked by user A and user B
  against same RLS'd table returns different result sets
- Foundry integration test: published agent surfaceable as tool in
  Foundry agent (Commercial only)

## Implementation outline

1. Extend `apps/copilot/` with NL2X tool definitions
2. Build prompt scaffolding (system prompts per data source + few-shot
   examples)
3. Implement OBO token flow in tool execution
4. Build the agent-config CRUD endpoints in azure-functions/copilot-chat
5. Build the schema + sample data embedding pipeline (nightly Databricks
   Job)
6. Wire Loom Console "Data Agents" pane (in PRP-03) → REST API
7. Wire Foundry Agent Service registration (Commercial only)
8. Telemetry + audit hooks

## File changes

```
apps/copilot/                                            modified (existing PydanticAI agent)
apps/copilot/tools/nl2sql.py                             created
apps/copilot/tools/nl2dax.py                             created
apps/copilot/tools/nl2kql.py                             created
apps/copilot/tools/graph_search.py                       created
apps/copilot/tools/custom_search.py                      created
apps/copilot/grounding/                                  created (schema embedder)
azure-functions/copilot-chat/function_app.py             modified (new endpoints)
azure-functions/copilot-chat/loom_agent_handler.py       created
azure-functions/copilot-chat/agent_config_handler.py     created
docs/fiab/workloads/data-agents-parity.md                created (by PRP-15)
```

## Open questions / risks

- NL2DAX maturity is materially lower than NL2SQL; flag accuracy
  expectations in the agent's system prompt
- "Prep for AI" semantic-model annotations equivalent (custom Cosmos
  DB store) requires user authoring; Fabric's UI is more polished;
  v1.1 invests
- Foundry integration in Gov unavailable (no Foundry Agent Service
  Gov-GA confirmed); document Commercial-only path

## References

- `temp/fiab-prd/05-workload-parity.md` §5.7
- `temp/fiab-prd/06-custom-apps.md` §6.6
- `temp/fiab-research/03-fabric-only-internals.md` §4
- Memory: [[copilot-chat-two-backends]]
